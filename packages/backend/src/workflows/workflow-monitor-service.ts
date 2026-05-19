import { agentRunRepo } from '../repos/agent-runs.js';
import { workflowIncidentRepo } from '../repos/workflow-incidents.js';
import { workflowOrchestrator } from './orchestrator.js';
import { decideRecovery, type WorkflowRecoveryDecision, type WorkflowRecoveryInput } from './recovery-supervisor.js';
import { executeRecoveryDecision, type WorkflowRecoveryExecutionResult } from './recovery-executor.js';
import { scanWorkflowIncidents, type WorkflowMonitorScanOptions } from './workflow-monitor.js';
import { projectRepo } from '../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../repos/rooms.js';
import { taskRepo } from '../repos/tasks.js';
import { workflowRepo } from '../repos/workflows.js';
import { wsHub } from '../ws-hub.js';
import type { AgentRun, WorkflowIncident } from '../types.js';

const DEFAULT_INTERVAL_MS = 20_000;

export interface WorkflowMonitorServiceOptions extends WorkflowMonitorScanOptions {
  intervalMs?: number;
  disableModel?: boolean;
  scanner?: (options: WorkflowMonitorScanOptions) => WorkflowIncident[];
  recoveryHandler?: (incident: WorkflowIncident) => Promise<WorkflowRecoveryExecutionResult>;
}

export interface WorkflowMonitorService {
  runOnce(): Promise<number>;
  stop(): void;
}

export function startWorkflowMonitorService(options: WorkflowMonitorServiceOptions = {}): WorkflowMonitorService {
  let running = false;
  const runOnce = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    try {
      return await runWorkflowMonitorOnce(options);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => {
    void runOnce().catch((err) => {
      console.warn(`[workflow-monitor] scan failed: ${(err as Error).message}`);
    });
  }, Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS));
  return {
    runOnce,
    stop() {
      clearInterval(interval);
    },
  };
}

export async function runWorkflowMonitorOnce(options: WorkflowMonitorServiceOptions = {}): Promise<number> {
  const scanner = options.scanner ?? scanWorkflowIncidents;
  const incidents = scanner({
    now: options.now,
    staleAgentRunMs: options.staleAgentRunMs,
    limit: options.limit,
  });
  let handled = 0;
  for (const incident of incidents) {
    if (incident.status === 'resolved' || incident.status === 'blocked' || incident.status === 'ignored') continue;
    const latest = workflowIncidentRepo.markDeciding(incident.id) ?? incident;
    if (options.recoveryHandler) {
      await options.recoveryHandler(latest);
      handled += 1;
      continue;
    }
    const input = buildRecoveryInput(latest);
    if (!input) {
      workflowIncidentRepo.markBlocked(latest.id, {
        action: 'mark_blocked',
        reason: '恢复上下文不完整，无法自动处理。',
        confidence: 0.5,
      });
      handled += 1;
      continue;
    }
    const decision = await decideRecovery(input, { disableModel: options.disableModel });
    await executeRecoveryDecision({ incident: latest, decision });
    handled += 1;
  }
  return handled;
}

export async function recoverWorkflowStartupOrphans(options: {
  buildInterruptedRunReason: (run: AgentRun) => Promise<string>;
}): Promise<{ interruptedAgentRuns: number; orphanedSteps: number; incidents: number }> {
  let interruptedAgentRuns = 0;
  for (const run of agentRunRepo.listActive()) {
    const reason = await options.buildInterruptedRunReason(run);
    const updated = agentRunRepo.interruptRun(run.id, reason);
    if (!updated) continue;
    wsHub.broadcast(updated.room_id, {
      type: 'agent_run:updated',
      roomId: updated.room_id,
      run: updated,
    });
    interruptedAgentRuns += 1;
  }

  const orphanedSteps = workflowOrchestrator.recoverOrphanedSteps('Backend restarted before workflow step completed');
  const incidents = scanWorkflowIncidents().length;
  return { interruptedAgentRuns, orphanedSteps, incidents };
}

function buildRecoveryInput(incident: WorkflowIncident): WorkflowRecoveryInput | null {
  const run = workflowRepo.getRun(incident.workflow_run_id);
  if (!run) return null;
  const room = roomRepo.get(run.room_id);
  const project = projectRepo.get(run.project_id);
  const task = taskRepo.get(run.task_id);
  if (!room || !project || !task) return null;
  const childTask = incident.child_task_id ? taskRepo.get(incident.child_task_id) ?? null : null;
  const workflowStep = incident.workflow_step_id ? workflowRepo.getStep(incident.workflow_step_id) ?? null : null;
  return {
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      description: project.description,
    },
    room: {
      id: room.id,
      name: room.name,
      description: room.description,
    },
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
    },
    childTask: childTask
      ? {
        id: childTask.id,
        title: childTask.title,
        description: childTask.description,
        status: childTask.status,
      }
      : null,
    workflowStep: workflowStep
      ? {
        id: workflowStep.id,
        stage: workflowStep.stage,
        status: workflowStep.status,
        error: workflowStep.error,
      }
      : null,
    incident,
    agents: roomAgentRepo.listByRoom(room.id),
    previousDecisions: workflowIncidentRepo.listByWorkflow(run.id)
      .filter((item) => item.decision_json && item.id !== incident.id)
      .map((item) => parseDecision(item.decision_json))
      .filter((item): item is WorkflowRecoveryDecision => item !== null),
  };
}

function parseDecision(raw: string | null): WorkflowRecoveryDecision | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WorkflowRecoveryDecision;
    return parsed && typeof parsed.action === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
