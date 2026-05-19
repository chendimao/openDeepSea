import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  WorkflowIncident,
  WorkflowIncidentSeverity,
  WorkflowIncidentType,
  WorkflowRecoveryAction,
} from '../types.js';

type JsonObject = Record<string, unknown>;

export interface WorkflowIncidentDetectionInput {
  room_id: string;
  project_id: string;
  workflow_run_id: string;
  workflow_step_id?: string | null;
  task_id: string;
  child_task_id?: string | null;
  agent_run_id?: string | null;
  room_agent_id?: string | null;
  incident_type: WorkflowIncidentType;
  severity?: WorkflowIncidentSeverity;
  error?: string | null;
  context: JsonObject;
}

export const workflowIncidentRepo = {
  upsertDetected(input: WorkflowIncidentDetectionInput): WorkflowIncident {
    const timestamp = now();
    const fingerprint = buildWorkflowIncidentFingerprint(input);
    const existing = db.prepare(
      'SELECT * FROM workflow_incidents WHERE workflow_run_id = ? AND fingerprint = ?',
    ).get(input.workflow_run_id, fingerprint) as WorkflowIncident | undefined;

    if (existing) {
      db.prepare(
        `UPDATE workflow_incidents
         SET workflow_step_id = ?, child_task_id = ?, agent_run_id = ?, room_agent_id = ?,
             severity = ?, error = ?, context_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        input.workflow_step_id ?? null,
        input.child_task_id ?? null,
        input.agent_run_id ?? null,
        input.room_agent_id ?? null,
        input.severity ?? existing.severity,
        input.error ?? null,
        JSON.stringify(input.context ?? {}),
        timestamp,
        existing.id,
      );
      return this.get(existing.id)!;
    }

    const id = nanoid(14);
    db.prepare(
      `INSERT INTO workflow_incidents (
        id, room_id, project_id, workflow_run_id, workflow_step_id, task_id, child_task_id,
        agent_run_id, room_agent_id, incident_type, status, severity, fingerprint, error,
        context_json, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.room_id,
      input.project_id,
      input.workflow_run_id,
      input.workflow_step_id ?? null,
      input.task_id,
      input.child_task_id ?? null,
      input.agent_run_id ?? null,
      input.room_agent_id ?? null,
      input.incident_type,
      input.severity ?? 'warning',
      fingerprint,
      input.error ?? null,
      JSON.stringify(input.context ?? {}),
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  },

  get(id: string): WorkflowIncident | undefined {
    return db.prepare('SELECT * FROM workflow_incidents WHERE id = ?').get(id) as WorkflowIncident | undefined;
  },

  listOpen(limit = 100): WorkflowIncident[] {
    return db.prepare(
      `SELECT * FROM workflow_incidents
       WHERE status IN ('open', 'deciding', 'executing')
       ORDER BY updated_at ASC
       LIMIT ?`,
    ).all(limit) as WorkflowIncident[];
  },

  listByWorkflow(workflowRunId: string): WorkflowIncident[] {
    return db.prepare(
      'SELECT * FROM workflow_incidents WHERE workflow_run_id = ? ORDER BY created_at ASC',
    ).all(workflowRunId) as WorkflowIncident[];
  },

  markDeciding(id: string): WorkflowIncident | undefined {
    return updateIncident(id, {
      status: 'deciding',
      action_status: 'pending',
    });
  },

  markExecuting(id: string, decision: { action: WorkflowRecoveryAction } & JsonObject): WorkflowIncident | undefined {
    return updateIncident(id, {
      status: 'executing',
      decision_json: JSON.stringify(decision),
      action: decision.action,
      action_status: 'running',
    });
  },

  markResolved(id: string, messageId?: string | null): WorkflowIncident | undefined {
    return updateIncident(id, {
      status: 'resolved',
      action_status: 'succeeded',
      last_message_id: messageId ?? null,
      resolved_at: now(),
    });
  },

  markBlocked(id: string, decision: JsonObject, messageId?: string | null): WorkflowIncident | undefined {
    return updateIncident(id, {
      status: 'blocked',
      decision_json: JSON.stringify(decision),
      action: typeof decision.action === 'string' ? decision.action : 'mark_blocked',
      action_status: 'failed',
      last_message_id: messageId ?? null,
      resolved_at: now(),
    });
  },

  incrementAttempt(id: string): WorkflowIncident | undefined {
    db.prepare(
      'UPDATE workflow_incidents SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?',
    ).run(now(), id);
    return this.get(id);
  },

  countAttemptsForChild(input: {
    workflowRunId: string;
    childTaskId: string;
    incidentType?: WorkflowIncidentType;
  }): number {
    const row = input.incidentType
      ? db.prepare(
        `SELECT COALESCE(SUM(attempt_count), 0) AS count
         FROM workflow_incidents
         WHERE workflow_run_id = ? AND child_task_id = ? AND incident_type = ?`,
      ).get(input.workflowRunId, input.childTaskId, input.incidentType) as { count: number }
      : db.prepare(
        `SELECT COALESCE(SUM(attempt_count), 0) AS count
         FROM workflow_incidents
         WHERE workflow_run_id = ? AND child_task_id = ?`,
      ).get(input.workflowRunId, input.childTaskId) as { count: number };
    return row.count;
  },
};

function updateIncident(
  id: string,
  patch: Partial<Pick<
    WorkflowIncident,
    'status' | 'decision_json' | 'action' | 'action_status' | 'last_message_id' | 'resolved_at'
  >>,
): WorkflowIncident | undefined {
  const existing = workflowIncidentRepo.get(id);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE workflow_incidents
     SET status = ?, decision_json = ?, action = ?, action_status = ?, last_message_id = ?,
         resolved_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.status ?? existing.status,
    patch.decision_json ?? existing.decision_json,
    patch.action ?? existing.action,
    patch.action_status ?? existing.action_status,
    patch.last_message_id ?? existing.last_message_id,
    patch.resolved_at ?? existing.resolved_at,
    now(),
    id,
  );
  return workflowIncidentRepo.get(id);
}

export function buildWorkflowIncidentFingerprint(input: Pick<
  WorkflowIncidentDetectionInput,
  'workflow_run_id' | 'workflow_step_id' | 'task_id' | 'child_task_id' | 'incident_type' | 'error'
>): string {
  const raw = [
    input.workflow_run_id,
    input.workflow_step_id ?? '',
    input.child_task_id ?? input.task_id,
    input.incident_type,
    normalizeIncidentError(input.error),
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function normalizeIncidentError(error: string | null | undefined): string {
  return (error ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[0-9a-z_-]{10,}/g, '<id>')
    .trim();
}
