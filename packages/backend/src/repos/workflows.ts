import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  GraphNodeName,
  TaskArtifact,
  TaskArtifactType,
  WorkflowDetail,
  WorkflowRun,
  WorkflowStage,
  WorkflowStatus,
  WorkflowStep,
  WorkflowStepStatus,
} from '../types.js';

const ACTIVE_STATUSES: WorkflowStatus[] = ['draft', 'running', 'awaiting_decision', 'awaiting_approval', 'blocked'];
const WORKFLOW_TERMINAL_STATUSES: WorkflowStatus[] = ['completed', 'failed', 'cancelled'];
const STEP_TERMINAL_STATUSES: WorkflowStepStatus[] = ['completed', 'failed', 'cancelled', 'interrupted', 'skipped'];

type WorkflowRunRow = WorkflowRun;
type WorkflowStepRow = Omit<WorkflowStep, 'scope_read' | 'scope_write' | 'node_name'> & {
  node_name: string | null;
  scope_read: string;
  scope_write: string;
};

function hasPatchKey<T extends object>(patch: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}

function normalizeGraphNodeName(value: string | null | undefined): GraphNodeName | null {
  if (!value) return null;
  const allowed = new Set<GraphNodeName>([
    'context',
    'planning',
    'approval',
    'dispatch',
    'execute',
    'review',
    'repair_decision',
    'verify',
    'acceptance',
    'memory',
  ]);
  return allowed.has(value as GraphNodeName) ? (value as GraphNodeName) : null;
}

function normalizeWorkflowStep(row: WorkflowStepRow): WorkflowStep {
  return {
    ...row,
    node_name: normalizeGraphNodeName(row.node_name),
    scope_read: parseStringArray(row.scope_read),
    scope_write: parseStringArray(row.scope_write),
  };
}

export const workflowRepo = {
  createRun(input: {
    room_id: string;
    project_id: string;
    task_id: string;
    status?: WorkflowStatus;
    current_stage?: WorkflowStage | null;
    approval_required?: boolean;
    openclaw_flow_id?: string | null;
    graph_version?: string | null;
    graph_state?: string | null;
  }): WorkflowRun {
    const id = nanoid(14);
    const ts = now();
    db.prepare(
      `INSERT INTO workflow_runs (
        id, room_id, project_id, task_id, status, current_stage, approval_required,
        openclaw_flow_id, graph_version, graph_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.room_id,
      input.project_id,
      input.task_id,
      input.status ?? 'running',
      input.current_stage ?? null,
      input.approval_required === false ? 0 : 1,
      input.openclaw_flow_id ?? null,
      input.graph_version ?? null,
      input.graph_state ?? null,
      ts,
      ts,
    );
    return this.getRun(id)!;
  },

  getRun(id: string): WorkflowRun | undefined {
    return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined;
  },

  getActiveByTask(taskId: string): WorkflowRun | undefined {
    return db
      .prepare(
        `SELECT * FROM workflow_runs
         WHERE task_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId, ...ACTIVE_STATUSES) as WorkflowRun | undefined;
  },

  listByTask(taskId: string): WorkflowRun[] {
    return db
      .prepare('SELECT * FROM workflow_runs WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as WorkflowRun[];
  },

  updateRun(
    id: string,
    patch: Partial<Pick<WorkflowRun, 'status' | 'current_stage' | 'approved_by' | 'error' | 'graph_version' | 'graph_state'>>,
  ): WorkflowRun | undefined {
    const existing = this.getRun(id);
    if (!existing) return undefined;
    const status = patch.status ?? existing.status;
    const completedAt = WORKFLOW_TERMINAL_STATUSES.includes(status) ? existing.completed_at ?? now() : null;
    const approvedAt = patch.status === 'running' && existing.status === 'awaiting_approval' ? now() : existing.approved_at;
    const currentStage = hasPatchKey(patch, 'current_stage') ? patch.current_stage ?? null : existing.current_stage;
    const approvedBy = hasPatchKey(patch, 'approved_by') ? patch.approved_by ?? null : existing.approved_by;
    const error = hasPatchKey(patch, 'error') ? patch.error ?? null : existing.error;
    const graphVersion = hasPatchKey(patch, 'graph_version') ? patch.graph_version ?? null : existing.graph_version;
    const graphState = hasPatchKey(patch, 'graph_state') ? patch.graph_state ?? null : existing.graph_state;
    db.prepare(
      `UPDATE workflow_runs
       SET status = ?, current_stage = ?, approved_at = ?, approved_by = ?, error = ?, graph_version = ?, graph_state = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ?`,
    ).run(
      status,
      currentStage,
      approvedAt,
      approvedBy,
      error,
      graphVersion,
      graphState,
      now(),
      completedAt,
      id,
    );
    return this.getRun(id);
  },

  updateGraphState(id: string, graph_state: string | null): WorkflowRun | undefined {
    return this.updateRun(id, { graph_state });
  },

  createStep(input: {
    workflow_run_id: string;
    task_id: string;
    stage: WorkflowStage;
    node_name?: GraphNodeName | null;
    status?: WorkflowStepStatus;
    room_agent_id?: string | null;
    assigned_room_agent_id?: string | null;
    scope_read?: string[];
    scope_write?: string[];
    prompt?: string;
    sort_order: number;
  }): WorkflowStep {
    const id = nanoid(14);
    const ts = now();
    db.prepare(
      `INSERT INTO workflow_steps (
        id, workflow_run_id, task_id, stage, node_name, status, room_agent_id, assigned_room_agent_id,
        scope_read, scope_write, prompt, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workflow_run_id,
      input.task_id,
      input.stage,
      input.node_name ?? null,
      input.status ?? 'pending',
      input.room_agent_id ?? null,
      input.assigned_room_agent_id ?? null,
      JSON.stringify(input.scope_read ?? []),
      JSON.stringify(input.scope_write ?? []),
      input.prompt ?? '',
      input.sort_order,
      ts,
      ts,
    );
    return this.getStep(id)!;
  },

  getStep(id: string): WorkflowStep | undefined {
    const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(id) as WorkflowStepRow | undefined;
    return row ? normalizeWorkflowStep(row) : undefined;
  },

  listSteps(workflowRunId: string): WorkflowStep[] {
    const rows = db
      .prepare('SELECT * FROM workflow_steps WHERE workflow_run_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(workflowRunId) as WorkflowStepRow[];
    return rows.map(normalizeWorkflowStep);
  },

  listRunningSteps(): WorkflowStep[] {
    const rows = db
      .prepare('SELECT * FROM workflow_steps WHERE status = ? ORDER BY created_at ASC')
      .all('running') as WorkflowStepRow[];
    return rows.map(normalizeWorkflowStep);
  },

  updateStep(
    id: string,
    patch: Partial<
      Pick<
        WorkflowStep,
        | 'status'
        | 'room_agent_id'
        | 'assigned_room_agent_id'
        | 'node_name'
        | 'scope_read'
        | 'scope_write'
        | 'agent_run_id'
        | 'prompt'
        | 'result'
        | 'result_message_id'
        | 'error'
      >
    >,
  ): WorkflowStep | undefined {
    const existing = this.getStep(id);
    if (!existing) return undefined;
    const status = patch.status ?? existing.status;
    const startedAt = status === 'running' && !existing.started_at ? now() : existing.started_at;
    const completedAt = STEP_TERMINAL_STATUSES.includes(status) ? existing.completed_at ?? now() : null;
    const roomAgentId = hasPatchKey(patch, 'room_agent_id') ? patch.room_agent_id ?? null : existing.room_agent_id;
    const assignedRoomAgentId = hasPatchKey(patch, 'assigned_room_agent_id')
      ? patch.assigned_room_agent_id ?? null
      : existing.assigned_room_agent_id;
    const nodeName = hasPatchKey(patch, 'node_name') ? patch.node_name ?? null : existing.node_name;
    const scopeRead = hasPatchKey(patch, 'scope_read') ? patch.scope_read ?? [] : existing.scope_read;
    const scopeWrite = hasPatchKey(patch, 'scope_write') ? patch.scope_write ?? [] : existing.scope_write;
    const agentRunId = hasPatchKey(patch, 'agent_run_id') ? patch.agent_run_id ?? null : existing.agent_run_id;
    const resultMessageId = hasPatchKey(patch, 'result_message_id')
      ? patch.result_message_id ?? null
      : existing.result_message_id;
    const error = hasPatchKey(patch, 'error') ? patch.error ?? null : existing.error;
    db.prepare(
      `UPDATE workflow_steps
       SET status = ?, room_agent_id = ?, assigned_room_agent_id = ?, node_name = ?, scope_read = ?, scope_write = ?,
           agent_run_id = ?, prompt = ?, result = ?, result_message_id = ?, error = ?, started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      roomAgentId,
      assignedRoomAgentId,
      nodeName,
      JSON.stringify(scopeRead),
      JSON.stringify(scopeWrite),
      agentRunId,
      patch.prompt ?? existing.prompt,
      patch.result ?? existing.result,
      resultMessageId,
      error,
      startedAt,
      completedAt,
      now(),
      id,
    );
    return this.getStep(id);
  },

  createArtifact(input: {
    task_id: string;
    workflow_run_id: string;
    workflow_step_id?: string | null;
    artifact_type: TaskArtifactType;
    title: string;
    content: string;
    metadata?: Record<string, unknown> | null;
  }): TaskArtifact {
    const id = nanoid(14);
    db.prepare(
      `INSERT INTO task_artifacts (
        id, task_id, workflow_run_id, workflow_step_id, artifact_type, title, content, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.task_id,
      input.workflow_run_id,
      input.workflow_step_id ?? null,
      input.artifact_type,
      input.title,
      input.content,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now(),
    );
    return this.getArtifact(id)!;
  },

  getArtifact(id: string): TaskArtifact | undefined {
    return db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id) as TaskArtifact | undefined;
  },

  listArtifacts(workflowRunId: string): TaskArtifact[] {
    return db
      .prepare('SELECT * FROM task_artifacts WHERE workflow_run_id = ? ORDER BY created_at ASC')
      .all(workflowRunId) as TaskArtifact[];
  },

  detail(id: string): WorkflowDetail | undefined {
    const run = this.getRun(id);
    if (!run) return undefined;
    return {
      run,
      steps: this.listSteps(id),
      artifacts: this.listArtifacts(id),
    };
  },

  blockRun(id: string, error: string): WorkflowRun | undefined {
    return this.updateRun(id, { status: 'blocked', error });
  },
};
