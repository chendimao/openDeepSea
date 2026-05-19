import { db } from '../db.js';
import { workflowIncidentRepo } from '../repos/workflow-incidents.js';
import type {
  AgentRun,
  Task,
  WorkflowIncident,
  WorkflowIncidentSeverity,
  WorkflowIncidentType,
  WorkflowRun,
  WorkflowStep,
} from '../types.js';

const DEFAULT_STALE_AGENT_RUN_MS = 120_000;
const DEFAULT_LIMIT = 100;
const ACTIVE_WORKFLOW_STATUSES = ['draft', 'running', 'awaiting_decision', 'awaiting_approval', 'blocked'];
const ACTIVE_AGENT_RUN_STATUSES = ['running', 'queued'];
const CHILD_TERMINAL_FAILURE_STATUSES = ['failed', 'cancelled'];

export interface WorkflowMonitorScanOptions {
  now?: number;
  staleAgentRunMs?: number;
  limit?: number;
}

type JoinedWorkflowRow = {
  run_id: string;
  run_room_id: string;
  run_project_id: string;
  run_task_id: string;
  run_status: string;
  run_current_stage: string | null;
  run_error: string | null;
  step_id: string | null;
  step_task_id: string | null;
  step_stage: string | null;
  step_status: string | null;
  step_room_agent_id: string | null;
  step_assigned_room_agent_id: string | null;
  step_scope_read: string | null;
  step_scope_write: string | null;
  step_agent_run_id: string | null;
  step_error: string | null;
  step_updated_at: number | null;
  agent_run_id: string | null;
  agent_run_room_agent_id: string | null;
  agent_run_agent_id: string | null;
  agent_run_status: string | null;
  agent_run_stdout: string | null;
  agent_run_stderr: string | null;
  agent_run_activity_log: string | null;
  agent_run_error: string | null;
  agent_run_updated_at: number | null;
  parent_title: string | null;
  parent_description: string | null;
  parent_status: string | null;
  child_id: string | null;
  child_title: string | null;
  child_description: string | null;
  child_status: string | null;
  child_assigned_agent_id: string | null;
};

export function scanWorkflowIncidents(options: WorkflowMonitorScanOptions = {}): WorkflowIncident[] {
  const detected: WorkflowIncident[] = [];
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const scanNow = options.now ?? Date.now();
  const staleAgentRunMs = options.staleAgentRunMs ?? DEFAULT_STALE_AGENT_RUN_MS;

  detected.push(...detectInterruptedAgentRuns(limit));
  if (detected.length < limit) {
    detected.push(...detectStaleAgentRuns(scanNow, staleAgentRunMs, limit - detected.length));
  }
  if (detected.length < limit) {
    detected.push(...detectRunningStepsWithoutActiveRun(limit - detected.length));
  }
  if (detected.length < limit) {
    detected.push(...detectFailedChildTasks(limit - detected.length));
  }
  if (detected.length < limit) {
    detected.push(...detectBlockedWorkflowErrors(limit - detected.length));
  }

  return detected;
}

function detectInterruptedAgentRuns(limit: number): WorkflowIncident[] {
  const rows = db.prepare(
    `SELECT
       wr.id AS run_id, wr.room_id AS run_room_id, wr.project_id AS run_project_id, wr.task_id AS run_task_id,
       wr.status AS run_status, wr.current_stage AS run_current_stage, wr.error AS run_error,
       ws.id AS step_id, ws.task_id AS step_task_id, ws.stage AS step_stage, ws.status AS step_status,
       ws.room_agent_id AS step_room_agent_id, ws.assigned_room_agent_id AS step_assigned_room_agent_id,
       ws.scope_read AS step_scope_read, ws.scope_write AS step_scope_write, ws.agent_run_id AS step_agent_run_id,
       ws.error AS step_error, ws.updated_at AS step_updated_at,
       ar.id AS agent_run_id, ar.room_agent_id AS agent_run_room_agent_id, ar.agent_id AS agent_run_agent_id,
       ar.status AS agent_run_status, ar.stdout AS agent_run_stdout, ar.stderr AS agent_run_stderr,
       ar.activity_log AS agent_run_activity_log, ar.error AS agent_run_error, ar.updated_at AS agent_run_updated_at,
       parent.title AS parent_title, parent.description AS parent_description, parent.status AS parent_status,
       child.id AS child_id, child.title AS child_title, child.description AS child_description, child.status AS child_status,
       child.assigned_agent_id AS child_assigned_agent_id
     FROM agent_runs ar
     JOIN workflow_runs wr ON wr.id = ar.workflow_run_id
     LEFT JOIN workflow_steps ws ON ws.id = ar.workflow_step_id
     LEFT JOIN tasks parent ON parent.id = wr.task_id
     LEFT JOIN tasks child ON child.id = COALESCE(ar.task_id, ws.task_id)
     WHERE ar.status = 'interrupted'
       AND ar.workflow_run_id IS NOT NULL
       AND (ar.error LIKE '%Backend restarted%' OR ar.stderr LIKE '%Backend restarted%')
     ORDER BY ar.updated_at ASC
     LIMIT ?`,
  ).all(limit) as JoinedWorkflowRow[];

  return rows.map((row) => createIncident(row, 'backend_restart_interrupted', row.agent_run_error ?? row.agent_run_stderr));
}

function detectStaleAgentRuns(scanNow: number, staleAgentRunMs: number, limit: number): WorkflowIncident[] {
  const staleBefore = scanNow - staleAgentRunMs;
  const rows = db.prepare(
    `SELECT
       wr.id AS run_id, wr.room_id AS run_room_id, wr.project_id AS run_project_id, wr.task_id AS run_task_id,
       wr.status AS run_status, wr.current_stage AS run_current_stage, wr.error AS run_error,
       ws.id AS step_id, ws.task_id AS step_task_id, ws.stage AS step_stage, ws.status AS step_status,
       ws.room_agent_id AS step_room_agent_id, ws.assigned_room_agent_id AS step_assigned_room_agent_id,
       ws.scope_read AS step_scope_read, ws.scope_write AS step_scope_write, ws.agent_run_id AS step_agent_run_id,
       ws.error AS step_error, ws.updated_at AS step_updated_at,
       ar.id AS agent_run_id, ar.room_agent_id AS agent_run_room_agent_id, ar.agent_id AS agent_run_agent_id,
       ar.status AS agent_run_status, ar.stdout AS agent_run_stdout, ar.stderr AS agent_run_stderr,
       ar.activity_log AS agent_run_activity_log, ar.error AS agent_run_error, ar.updated_at AS agent_run_updated_at,
       parent.title AS parent_title, parent.description AS parent_description, parent.status AS parent_status,
       child.id AS child_id, child.title AS child_title, child.description AS child_description, child.status AS child_status,
       child.assigned_agent_id AS child_assigned_agent_id
     FROM agent_runs ar
     JOIN workflow_runs wr ON wr.id = ar.workflow_run_id
     LEFT JOIN workflow_steps ws ON ws.id = ar.workflow_step_id
     LEFT JOIN tasks parent ON parent.id = wr.task_id
     LEFT JOIN tasks child ON child.id = COALESCE(ar.task_id, ws.task_id)
     WHERE ar.status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
       AND ar.workflow_run_id IS NOT NULL
       AND wr.status IN (${ACTIVE_WORKFLOW_STATUSES.map(() => '?').join(',')})
       AND ar.updated_at < ?
     ORDER BY ar.updated_at ASC
     LIMIT ?`,
  ).all(...ACTIVE_AGENT_RUN_STATUSES, ...ACTIVE_WORKFLOW_STATUSES, staleBefore, limit) as JoinedWorkflowRow[];

  return rows.map((row) => createIncident(
    row,
    'agent_run_stale',
    `Agent run has not updated for ${Math.max(0, scanNow - (row.agent_run_updated_at ?? scanNow))}ms`,
  ));
}

function detectRunningStepsWithoutActiveRun(limit: number): WorkflowIncident[] {
  const rows = db.prepare(
    `SELECT
       wr.id AS run_id, wr.room_id AS run_room_id, wr.project_id AS run_project_id, wr.task_id AS run_task_id,
       wr.status AS run_status, wr.current_stage AS run_current_stage, wr.error AS run_error,
       ws.id AS step_id, ws.task_id AS step_task_id, ws.stage AS step_stage, ws.status AS step_status,
       ws.room_agent_id AS step_room_agent_id, ws.assigned_room_agent_id AS step_assigned_room_agent_id,
       ws.scope_read AS step_scope_read, ws.scope_write AS step_scope_write, ws.agent_run_id AS step_agent_run_id,
       ws.error AS step_error, ws.updated_at AS step_updated_at,
       ar.id AS agent_run_id, ar.room_agent_id AS agent_run_room_agent_id, ar.agent_id AS agent_run_agent_id,
       ar.status AS agent_run_status, ar.stdout AS agent_run_stdout, ar.stderr AS agent_run_stderr,
       ar.activity_log AS agent_run_activity_log, ar.error AS agent_run_error, ar.updated_at AS agent_run_updated_at,
       parent.title AS parent_title, parent.description AS parent_description, parent.status AS parent_status,
       child.id AS child_id, child.title AS child_title, child.description AS child_description, child.status AS child_status,
       child.assigned_agent_id AS child_assigned_agent_id
     FROM workflow_steps ws
     JOIN workflow_runs wr ON wr.id = ws.workflow_run_id
     LEFT JOIN agent_runs ar ON ar.workflow_step_id = ws.id AND ar.status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(',')})
     LEFT JOIN tasks parent ON parent.id = wr.task_id
     LEFT JOIN tasks child ON child.id = ws.task_id
     WHERE ws.status = 'running'
       AND wr.status IN (${ACTIVE_WORKFLOW_STATUSES.map(() => '?').join(',')})
       AND ar.id IS NULL
     ORDER BY ws.updated_at ASC
     LIMIT ?`,
  ).all(...ACTIVE_AGENT_RUN_STATUSES, ...ACTIVE_WORKFLOW_STATUSES, limit) as JoinedWorkflowRow[];

  return rows.map((row) => createIncident(row, 'step_without_active_run', 'Workflow step is running without an active agent run'));
}

function detectFailedChildTasks(limit: number): WorkflowIncident[] {
  const rows = db.prepare(
    `SELECT
       wr.id AS run_id, wr.room_id AS run_room_id, wr.project_id AS run_project_id, wr.task_id AS run_task_id,
       wr.status AS run_status, wr.current_stage AS run_current_stage, wr.error AS run_error,
       ws.id AS step_id, ws.task_id AS step_task_id, ws.stage AS step_stage, ws.status AS step_status,
       ws.room_agent_id AS step_room_agent_id, ws.assigned_room_agent_id AS step_assigned_room_agent_id,
       ws.scope_read AS step_scope_read, ws.scope_write AS step_scope_write, ws.agent_run_id AS step_agent_run_id,
       ws.error AS step_error, ws.updated_at AS step_updated_at,
       ar.id AS agent_run_id, ar.room_agent_id AS agent_run_room_agent_id, ar.agent_id AS agent_run_agent_id,
       ar.status AS agent_run_status, ar.stdout AS agent_run_stdout, ar.stderr AS agent_run_stderr,
       ar.activity_log AS agent_run_activity_log, ar.error AS agent_run_error, ar.updated_at AS agent_run_updated_at,
       parent.title AS parent_title, parent.description AS parent_description, parent.status AS parent_status,
       child.id AS child_id, child.title AS child_title, child.description AS child_description, child.status AS child_status,
       child.assigned_agent_id AS child_assigned_agent_id
     FROM workflow_runs wr
     JOIN tasks parent ON parent.id = wr.task_id
     JOIN tasks child ON child.parent_task_id = parent.id
     LEFT JOIN workflow_steps ws ON ws.workflow_run_id = wr.id AND ws.task_id = child.id
     LEFT JOIN agent_runs ar ON ar.workflow_run_id = wr.id AND ar.task_id = child.id
     WHERE wr.status IN (${ACTIVE_WORKFLOW_STATUSES.map(() => '?').join(',')})
       AND child.status IN (${CHILD_TERMINAL_FAILURE_STATUSES.map(() => '?').join(',')})
     ORDER BY child.updated_at ASC
     LIMIT ?`,
  ).all(...ACTIVE_WORKFLOW_STATUSES, ...CHILD_TERMINAL_FAILURE_STATUSES, limit) as JoinedWorkflowRow[];

  return rows.map((row) => createIncident(row, 'child_task_failed', `Child task status is ${row.child_status}`));
}

function detectBlockedWorkflowErrors(limit: number): WorkflowIncident[] {
  const rows = db.prepare(
    `SELECT
       wr.id AS run_id, wr.room_id AS run_room_id, wr.project_id AS run_project_id, wr.task_id AS run_task_id,
       wr.status AS run_status, wr.current_stage AS run_current_stage, wr.error AS run_error,
       ws.id AS step_id, ws.task_id AS step_task_id, ws.stage AS step_stage, ws.status AS step_status,
       ws.room_agent_id AS step_room_agent_id, ws.assigned_room_agent_id AS step_assigned_room_agent_id,
       ws.scope_read AS step_scope_read, ws.scope_write AS step_scope_write, ws.agent_run_id AS step_agent_run_id,
       ws.error AS step_error, ws.updated_at AS step_updated_at,
       ar.id AS agent_run_id, ar.room_agent_id AS agent_run_room_agent_id, ar.agent_id AS agent_run_agent_id,
       ar.status AS agent_run_status, ar.stdout AS agent_run_stdout, ar.stderr AS agent_run_stderr,
       ar.activity_log AS agent_run_activity_log, ar.error AS agent_run_error, ar.updated_at AS agent_run_updated_at,
       parent.title AS parent_title, parent.description AS parent_description, parent.status AS parent_status,
       child.id AS child_id, child.title AS child_title, child.description AS child_description, child.status AS child_status,
       child.assigned_agent_id AS child_assigned_agent_id
     FROM workflow_runs wr
     LEFT JOIN workflow_steps ws ON ws.workflow_run_id = wr.id
       AND ws.sort_order = (SELECT MAX(inner_ws.sort_order) FROM workflow_steps inner_ws WHERE inner_ws.workflow_run_id = wr.id)
     LEFT JOIN agent_runs ar ON ar.id = ws.agent_run_id
     LEFT JOIN tasks parent ON parent.id = wr.task_id
     LEFT JOIN tasks child ON child.id = ws.task_id
     WHERE wr.status = 'blocked'
       AND wr.error IS NOT NULL
     ORDER BY wr.updated_at ASC
     LIMIT ?`,
  ).all(limit) as JoinedWorkflowRow[];

  return rows.map((row) => {
    const error = row.run_error ?? row.step_error ?? 'Workflow is blocked';
    return createIncident(row, classifyBlockedWorkflowError(error), error);
  });
}

function createIncident(
  row: JoinedWorkflowRow,
  incidentType: WorkflowIncidentType,
  error: string | null | undefined,
): WorkflowIncident {
  return workflowIncidentRepo.upsertDetected({
    room_id: row.run_room_id,
    project_id: row.run_project_id,
    workflow_run_id: row.run_id,
    workflow_step_id: row.step_id,
    task_id: row.run_task_id,
    child_task_id: getChildTaskId(row),
    agent_run_id: row.agent_run_id,
    room_agent_id: row.agent_run_room_agent_id ?? row.step_room_agent_id ?? row.step_assigned_room_agent_id,
    incident_type: incidentType,
    severity: severityForIncident(incidentType),
    error: excerpt(error),
    context: buildIncidentContext(row),
  });
}

function buildIncidentContext(row: JoinedWorkflowRow): Record<string, unknown> {
  return {
    workflowRun: {
      id: row.run_id,
      status: row.run_status,
      currentStage: row.run_current_stage,
      error: row.run_error,
    } satisfies Partial<WorkflowRun>,
    workflowStep: row.step_id
      ? {
        id: row.step_id,
        stage: row.step_stage,
        status: row.step_status,
        error: row.step_error,
        scopeRead: parseStringArray(row.step_scope_read),
        scopeWrite: parseStringArray(row.step_scope_write),
      } satisfies Partial<WorkflowStep>
      : null,
    task: {
      id: row.run_task_id,
      title: row.parent_title,
      description: row.parent_description,
      status: row.parent_status,
    } satisfies Partial<Task>,
    childTask: getChildTaskId(row)
      ? {
        id: getChildTaskId(row),
        title: row.child_title,
        description: row.child_description,
        status: row.child_status,
        assignedAgentId: row.child_assigned_agent_id,
      }
      : null,
    agentRun: row.agent_run_id
      ? {
        id: row.agent_run_id,
        roomAgentId: row.agent_run_room_agent_id,
        agentId: row.agent_run_agent_id,
        status: row.agent_run_status,
        error: row.agent_run_error,
        updatedAt: row.agent_run_updated_at,
      } satisfies Partial<AgentRun>
      : null,
    stdout: excerpt(row.agent_run_stdout),
    stderr: excerpt(row.agent_run_stderr),
    activityLog: excerpt(row.agent_run_activity_log),
  };
}

function getChildTaskId(row: JoinedWorkflowRow): string | null {
  const candidate = row.child_id ?? row.step_task_id;
  return candidate && candidate !== row.run_task_id ? candidate : null;
}

function classifyBlockedWorkflowError(error: string): WorkflowIncidentType {
  const normalized = error.toLowerCase();
  if (normalized.includes('no executor available')) return 'executor_unavailable';
  if (normalized.includes('runtime boundary') || normalized.includes('workspace') || normalized.includes('permission')) {
    return 'runtime_boundary_mismatch';
  }
  return 'unknown';
}

function severityForIncident(incidentType: WorkflowIncidentType): WorkflowIncidentSeverity {
  if (incidentType === 'unknown' || incidentType === 'child_task_failed') return 'critical';
  return 'warning';
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function excerpt(value: string | null | undefined, maxLength = 4_000): string | null {
  if (!value) return null;
  return value.length <= maxLength ? value : value.slice(-maxLength);
}
