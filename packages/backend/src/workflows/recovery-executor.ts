import { agentRunRepo } from '../repos/agent-runs.js';
import { db } from '../db.js';
import { messageRepo } from '../repos/messages.js';
import { roomAgentRepo } from '../repos/rooms.js';
import { taskRepo } from '../repos/tasks.js';
import { workflowIncidentRepo } from '../repos/workflow-incidents.js';
import { workflowRepo } from '../repos/workflows.js';
import {
  recordTaskCreatedEvent,
  recordTaskEvent,
  recordTaskStatusChanged,
  recordTaskUpdated,
} from '../task-conversation.js';
import type { Task, WorkflowIncident, WorkflowRun } from '../types.js';
import { ensureGlobalExecutorForRecovery } from './agent-provisioning.js';
import type { WorkflowRecoveryDecision } from './recovery-supervisor.js';
import { workflowOrchestrator } from './orchestrator.js';

export interface WorkflowRecoveryExecutionResult {
  status: 'executed' | 'blocked' | 'noop';
  messageId?: string | null;
  detail?: string;
}

export async function executeRecoveryDecision(input: {
  incident: WorkflowIncident;
  decision: WorkflowRecoveryDecision;
}): Promise<WorkflowRecoveryExecutionResult> {
  const latestIncident = workflowIncidentRepo.get(input.incident.id) ?? input.incident;
  if (latestIncident.status === 'resolved' || latestIncident.status === 'blocked') {
    return { status: 'noop', messageId: latestIncident.last_message_id };
  }

  const run = workflowRepo.getRun(latestIncident.workflow_run_id);
  if (!run) {
    workflowIncidentRepo.markBlocked(latestIncident.id, decisionToJson(input.decision), null);
    return { status: 'blocked', detail: 'workflow not found' };
  }

  const task = taskRepo.get(run.task_id);
  if (!task) {
    workflowIncidentRepo.markBlocked(latestIncident.id, decisionToJson(input.decision), null);
    return { status: 'blocked', detail: 'task not found' };
  }

  workflowIncidentRepo.markExecuting(latestIncident.id, decisionToJson(input.decision));
  const context = parseContext(latestIncident.context_json);

  switch (input.decision.action) {
    case 'retry_same_agent':
      return retryWorkflow(latestIncident, input.decision, run, task);
    case 'retry_with_global_agent':
      ensureGlobalExecutorForRecovery({
        roomId: run.room_id,
        context,
        globalAgentTemplateId: input.decision.globalAgentTemplateId,
      });
      return retryWorkflow(latestIncident, input.decision, run, task);
    case 'reassign_agent':
      reassignChildTask(latestIncident, input.decision);
      return retryWorkflow(latestIncident, input.decision, run, task);
    case 'split_task':
      return splitTask(latestIncident, input.decision, run, task);
    case 'ask_user':
      return askUser(latestIncident, input.decision, run, task);
    case 'mark_blocked':
      return markBlocked(latestIncident, input.decision, run, task);
  }
}

async function retryWorkflow(
  incident: WorkflowIncident,
  decision: WorkflowRecoveryDecision,
  run: WorkflowRun,
  task: Task,
): Promise<WorkflowRecoveryExecutionResult> {
  if (agentRunRepo.listActiveByWorkflow(run.id).length > 0) {
    const recorded = writeRecoveryMessage(incident, decision, run, task, '检测到已有运行中的智能体，本次恢复不重复启动。');
    workflowIncidentRepo.markResolved(incident.id, recorded.message.id);
    return { status: 'noop', messageId: recorded.message.id, detail: 'active agent run exists' };
  }

  const refreshedRun = workflowRepo.getRun(run.id) ?? run;
  if (refreshedRun.status !== 'blocked' && refreshedRun.status !== 'failed' && refreshedRun.status !== 'cancelled') {
    workflowRepo.updateRun(run.id, { status: 'blocked', error: incident.error ?? decision.reason });
  }

  workflowIncidentRepo.incrementAttempt(incident.id);
  const retryableStep = findRetryableStep(incident, run.id);
  if (retryableStep && retryableStep.status !== 'skipped') {
    workflowRepo.updateStep(retryableStep.id, {
      status: retryableStep.status,
      error: retryableStep.error ?? incident.error ?? decision.reason,
    });
  }
  const childTaskId = incident.child_task_id ?? retryableStep?.task_id ?? null;
  if (childTaskId) {
    db.transaction(() => {
      const before = taskRepo.get(childTaskId);
      const after = taskRepo.updateStatus(childTaskId, 'todo');
      if (before && after) {
        recordTaskStatusChanged({
          before,
          after,
          metadata: {
            incident_id: incident.id,
            recovery_action: decision.action,
            workflow_run_id: run.id,
          },
        });
      }
    })();
  }

  await workflowOrchestrator.retryStep(run.id);
  const recorded = writeRecoveryMessage(incident, decision, run, task, '已决定恢复执行并重新推进工作流。');
  workflowIncidentRepo.markResolved(incident.id, recorded.message.id);
  return { status: 'executed', messageId: recorded.message.id };
}

function reassignChildTask(incident: WorkflowIncident, decision: WorkflowRecoveryDecision): void {
  if (!decision.targetRoomAgentId) throw new Error('targetRoomAgentId is required for reassign_agent');
  const target = roomAgentRepo.get(decision.targetRoomAgentId);
  if (!target) throw new Error('target room agent not found');
  const childTaskId = incident.child_task_id;
  if (!childTaskId) throw new Error('child_task_id is required for reassign_agent');
  db.transaction(() => {
    const before = taskRepo.get(childTaskId);
    const after = taskRepo.update(childTaskId, { assigned_agent_id: target.id });
    if (before && after) {
      recordTaskUpdated({
        before,
        after,
        changedFields: ['assigned_agent_id'],
        metadata: {
          incident_id: incident.id,
          recovery_action: decision.action,
        },
      });
    }
  })();
}

function splitTask(
  incident: WorkflowIncident,
  decision: WorkflowRecoveryDecision,
  run: WorkflowRun,
  task: Task,
): WorkflowRecoveryExecutionResult {
  const splitTasks = decision.splitTasks ?? [];
  for (const split of splitTasks) {
    const title = split.title.trim();
    if (!title || splitChildExists(task.id, incident.id, title)) continue;
    db.transaction(() => {
      const child = taskRepo.create({
        room_id: task.room_id,
        project_id: task.project_id,
        parent_task_id: task.id,
        title,
        description: [
          split.description,
          '',
          `恢复事件：${incident.id}`,
          `读取范围：${split.scopeRead.join(', ') || '未指定'}`,
          `写入范围：${split.scopeWrite.join(', ') || '未指定'}`,
        ].join('\n'),
        interaction_mode: 'auto_recommended',
        created_from: 'workflow_assignment',
      });
      recordTaskCreatedEvent({
        roomId: task.room_id,
        task: child,
        origin: 'workflow_assignment',
        metadata: {
          incident_id: incident.id,
          recovery_action: decision.action,
        },
      });
    })();
  }
  workflowRepo.updateRun(run.id, { status: 'awaiting_decision', error: decision.reason });
  const recorded = writeRecoveryMessage(incident, decision, run, task, '已拆分子任务，等待用户确认后继续推进。');
  workflowIncidentRepo.markResolved(incident.id, recorded.message.id);
  return { status: 'executed', messageId: recorded.message.id };
}

function askUser(
  incident: WorkflowIncident,
  decision: WorkflowRecoveryDecision,
  run: WorkflowRun,
  task: Task,
): WorkflowRecoveryExecutionResult {
  const existing = findExistingRecoveryMessage(run.room_id, incident.id);
  workflowRepo.updateRun(run.id, { status: 'awaiting_decision', error: decision.reason });
  if (existing) {
    workflowIncidentRepo.markResolved(incident.id, existing.id);
    return { status: 'noop', messageId: existing.id };
  }
  const recorded = writeRecoveryMessage(incident, decision, run, task, decision.userQuestion ?? '需要用户确认下一步恢复策略。');
  workflowIncidentRepo.markResolved(incident.id, recorded.message.id);
  return { status: 'executed', messageId: recorded.message.id };
}

function markBlocked(
  incident: WorkflowIncident,
  decision: WorkflowRecoveryDecision,
  run: WorkflowRun,
  task: Task,
): WorkflowRecoveryExecutionResult {
  workflowRepo.updateRun(run.id, { status: 'blocked', error: decision.reason });
  const recorded = writeRecoveryMessage(incident, decision, run, task, '已将工作流标记为阻塞，等待人工处理。');
  workflowIncidentRepo.markBlocked(incident.id, decisionToJson(decision), recorded.message.id);
  return { status: 'blocked', messageId: recorded.message.id };
}

function writeRecoveryMessage(
  incident: WorkflowIncident,
  decision: WorkflowRecoveryDecision,
  run: WorkflowRun,
  task: Task,
  outcome: string,
) {
  const childTask = incident.child_task_id ? taskRepo.get(incident.child_task_id) : null;
  const attemptCount = (workflowIncidentRepo.get(incident.id)?.attempt_count ?? incident.attempt_count);
  return recordTaskEvent({
    roomId: run.room_id,
    taskId: task.id,
    taskTitle: task.title,
    workflowRunId: run.id,
    workflowStepId: incident.workflow_step_id,
    eventType: 'workflow_recovery_decided',
    content: [
      `产品经理检测到子任务「${childTask?.title ?? task.title}」异常：${incident.error ?? incident.incident_type}`,
      `诊断：${decision.reason}`,
      `决策：${decision.action}`,
      `恢复次数：${attemptCount}/2。`,
      outcome,
    ].join('\n'),
    metadata: {
      incident_id: incident.id,
      incident_type: incident.incident_type,
      recovery_action: decision.action,
      confidence: decision.confidence,
    },
  });
}

function findRetryableStep(incident: WorkflowIncident, workflowRunId: string) {
  const explicit = incident.workflow_step_id ? workflowRepo.getStep(incident.workflow_step_id) : undefined;
  if (explicit) return explicit;
  return [...workflowRepo.listSteps(workflowRunId)]
    .reverse()
    .find((step) => step.status === 'failed' || step.status === 'cancelled' || step.status === 'interrupted');
}

function splitChildExists(parentTaskId: string, incidentId: string, title: string): boolean {
  return taskRepo.listChildren(parentTaskId).some((task) =>
    task.title === title && (task.description ?? '').includes(`恢复事件：${incidentId}`),
  );
}

function findExistingRecoveryMessage(roomId: string, incidentId: string) {
  return messageRepo.listByRoom(roomId, 200).find((message) => {
    if (!message.metadata) return false;
    try {
      const metadata = JSON.parse(message.metadata) as Record<string, unknown>;
      return metadata.event_type === 'workflow_recovery_decided' && metadata.incident_id === incidentId;
    } catch {
      return false;
    }
  }) ?? null;
}

function parseContext(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function decisionToJson(decision: WorkflowRecoveryDecision): { action: WorkflowRecoveryDecision['action'] } & Record<string, unknown> {
  return { ...decision };
}
