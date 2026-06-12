import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  WorkflowArtifactVersion,
  WorkflowArtifactVersionType,
} from '../types.js';

type WorkflowArtifactVersionRow = WorkflowArtifactVersion;

interface CreateDraftInput {
  workflow_run_id: string;
  artifact_type: WorkflowArtifactVersionType;
  title: string;
  content: string;
  structured_data?: unknown;
  created_by_agent_id: string;
  change_request_message_id?: string | null;
  supersedes_artifact_version_id?: string | null;
}

interface ApproveInput {
  approved_by: string;
  approval_message_id?: string | null;
}

function nextVersion(workflowRunId: string, artifactType: WorkflowArtifactVersionType): number {
  const row = db.prepare(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM workflow_artifact_versions WHERE workflow_run_id = ? AND artifact_type = ?',
  ).get(workflowRunId, artifactType) as { next: number };
  return row.next;
}

function stringifyStructuredData(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function assertSupersedesTarget(
  target: WorkflowArtifactVersion | null,
  input: Pick<CreateDraftInput, 'workflow_run_id' | 'artifact_type' | 'supersedes_artifact_version_id'>,
): void {
  if (!input.supersedes_artifact_version_id) return;
  if (
    !target ||
    target.workflow_run_id !== input.workflow_run_id ||
    target.artifact_type !== input.artifact_type
  ) {
    throw new Error('supersedes artifact version must belong to the same workflow run and artifact type');
  }
}

export const workflowArtifactVersionRepo = {
  createDraft(input: CreateDraftInput): WorkflowArtifactVersion {
    const id = nanoid(14);
    const ts = now();
    const supersedesId = input.supersedes_artifact_version_id ?? null;

    const insert = db.transaction(() => {
      const supersedesTarget = supersedesId ? this.get(supersedesId) : null;
      assertSupersedesTarget(supersedesTarget, input);
      const version = nextVersion(input.workflow_run_id, input.artifact_type);
      if (supersedesId) {
        db.prepare(
          `UPDATE workflow_artifact_versions
           SET status = 'superseded', updated_at = ?
           WHERE id = ?`,
        ).run(ts, supersedesId);
      }
      db.prepare(
        `UPDATE workflow_artifact_versions
         SET status = 'superseded', updated_at = ?
         WHERE workflow_run_id = ? AND artifact_type = ? AND status = 'approved'`,
      ).run(ts, input.workflow_run_id, input.artifact_type);
      db.prepare(
        `INSERT INTO workflow_artifact_versions (
          id, workflow_run_id, artifact_type, version, status, title, content, structured_data,
          created_by_agent_id, change_request_message_id, supersedes_artifact_version_id,
          approved_by, approval_message_id, approved_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.workflow_run_id,
        input.artifact_type,
        version,
        'draft',
        input.title,
        input.content,
        stringifyStructuredData(input.structured_data),
        input.created_by_agent_id,
        input.change_request_message_id ?? null,
        supersedesId,
        null,
        null,
        null,
        ts,
        ts,
      );
    });

    insert();
    return this.get(id)!;
  },

  get(id: string): WorkflowArtifactVersion | null {
    return db
      .prepare('SELECT * FROM workflow_artifact_versions WHERE id = ?')
      .get(id) as WorkflowArtifactVersionRow | undefined ?? null;
  },

  listByRun(workflowRunId: string): WorkflowArtifactVersion[] {
    return db
      .prepare(
        `SELECT * FROM workflow_artifact_versions
         WHERE workflow_run_id = ?
         ORDER BY artifact_type ASC, version ASC`,
      )
      .all(workflowRunId) as WorkflowArtifactVersionRow[];
  },

  getLatest(workflowRunId: string, artifactType: WorkflowArtifactVersionType): WorkflowArtifactVersion | null {
    return db
      .prepare(
        `SELECT * FROM workflow_artifact_versions
         WHERE workflow_run_id = ? AND artifact_type = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(workflowRunId, artifactType) as WorkflowArtifactVersionRow | undefined ?? null;
  },

  getApproved(workflowRunId: string, artifactType: WorkflowArtifactVersionType): WorkflowArtifactVersion | null {
    return db
      .prepare(
        `SELECT * FROM workflow_artifact_versions
         WHERE workflow_run_id = ? AND artifact_type = ? AND status = 'approved'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(workflowRunId, artifactType) as WorkflowArtifactVersionRow | undefined ?? null;
  },

  updateDraftContent(
    id: string,
    input: {
      content: string;
      structured_data?: unknown;
    },
  ): WorkflowArtifactVersion | null {
    const existing = this.get(id);
    if (!existing || (existing.status !== 'draft' && existing.status !== 'reviewing')) return null;
    db.prepare(
      `UPDATE workflow_artifact_versions
       SET content = ?, structured_data = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.content, stringifyStructuredData(input.structured_data), now(), id);
    return this.get(id);
  },

  approve(id: string, input: ApproveInput): WorkflowArtifactVersion | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (existing.status !== 'draft' && existing.status !== 'reviewing') return null;
    const latest = this.getLatest(existing.workflow_run_id, existing.artifact_type);
    if (latest?.id !== existing.id) return null;
    const ts = now();
    const update = db.transaction(() => {
      db.prepare(
        `UPDATE workflow_artifact_versions
         SET status = 'superseded', updated_at = ?
         WHERE workflow_run_id = ? AND artifact_type = ? AND status = 'approved' AND id <> ?`,
      ).run(ts, existing.workflow_run_id, existing.artifact_type, id);
      db.prepare(
        `UPDATE workflow_artifact_versions
         SET status = 'approved', approved_by = ?, approval_message_id = ?, approved_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.approved_by, input.approval_message_id ?? null, ts, ts, id);
    });
    update();
    return this.get(id);
  },
};
