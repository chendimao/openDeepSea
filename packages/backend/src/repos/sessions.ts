import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  AcpBackend,
  Session,
  SessionAgentEvent,
  SessionAgentRuntime,
  SessionAgentRuntimeStatus,
  SessionMessage,
  SessionMessageRole,
  SessionMode,
  SessionPhase,
  SessionPlanItem,
  SessionPlanItemStatus,
  SessionRun,
  SessionRunStatus,
} from '../types.js';

export const DEFAULT_SESSION_AGENT_ID = 'planner';

const ACTIVE_SESSION_RUN_STATUSES = ['queued', 'running', 'retrying', 'paused'] as const;

export const sessionRepo = {
  create(input: {
    project_id: string;
    title?: string;
    current_goal?: string | null;
    mode?: SessionMode;
    provider?: AcpBackend | null;
    model?: string | null;
    workspace_path?: string | null;
    worktree_path?: string | null;
    branch_name?: string | null;
    forked_from_session_id?: string | null;
    forked_from_history_record_id?: string | null;
  }): Session {
    const timestamp = now();
    const id = nanoid(16);
    db.prepare(`
      INSERT INTO sessions (
        id, project_id, title, current_goal, mode, phase, status,
        provider, model, workspace_path, worktree_path, branch_name,
        forked_from_session_id, forked_from_history_record_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'idle', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.project_id,
      input.title?.trim() || 'New Session',
      input.current_goal ?? null,
      input.mode ?? 'ask',
      input.provider ?? null,
      input.model ?? null,
      input.workspace_path ?? null,
      input.worktree_path ?? null,
      input.branch_name ?? null,
      input.forked_from_session_id ?? null,
      input.forked_from_history_record_id ?? null,
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  },

  get(id: string): Session | undefined {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  },

  listByProject(projectId: string, input: { includeArchived?: boolean } = {}): Session[] {
    const archivedFilter = input.includeArchived ? '' : "AND status != 'archived'";
    return db.prepare(`
      SELECT * FROM sessions
      WHERE project_id = ? ${archivedFilter}
      ORDER BY updated_at DESC
    `).all(projectId) as Session[];
  },

  update(
    id: string,
    patch: Partial<Pick<
      Session,
      | 'title'
      | 'current_goal'
      | 'mode'
      | 'phase'
      | 'status'
      | 'provider'
      | 'model'
      | 'workspace_path'
      | 'worktree_path'
      | 'branch_name'
      | 'latest_compaction_id'
      | 'latest_context_manifest_id'
      | 'archived_at'
    >>,
  ): Session | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of [
      'title',
      'current_goal',
      'mode',
      'phase',
      'status',
      'provider',
      'model',
      'workspace_path',
      'worktree_path',
      'branch_name',
      'latest_compaction_id',
      'latest_context_manifest_id',
      'archived_at',
    ] as const) {
      if (patch[key] !== undefined) {
        setClauses.push(`${key} = ?`);
        values.push(patch[key]);
      }
    }
    if (setClauses.length === 0) return existing;
    setClauses.push('updated_at = ?');
    values.push(now());
    db.prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`).run(...values, id);
    return this.get(id);
  },

  archive(id: string): Session | undefined {
    const timestamp = now();
    return this.update(id, { status: 'archived', phase: 'archived', archived_at: timestamp });
  },
};

export const sessionMessageRepo = {
  create(input: {
    session_id: string;
    role: SessionMessageRole;
    sender_id: string;
    sender_name?: string | null;
    content: string;
    message_type?: SessionMessage['message_type'];
    status?: SessionMessage['status'];
    metadata?: Record<string, unknown> | string | null;
  }): SessionMessage {
    const id = nanoid(16);
    db.prepare(`
      INSERT INTO session_messages (
        id, session_id, role, sender_id, sender_name, content,
        message_type, status, metadata, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.session_id,
      input.role,
      input.sender_id,
      input.sender_name ?? null,
      input.content,
      input.message_type ?? 'text',
      input.status ?? 'completed',
      stringifyMetadata(input.metadata),
      now(),
    );
    return this.get(id)!;
  },

  get(id: string): SessionMessage | undefined {
    return db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as SessionMessage | undefined;
  },

  listBySession(sessionId: string, input: { limit?: number } = {}): SessionMessage[] {
    const limit = input.limit ?? 500;
    return db.prepare(`
      SELECT * FROM (
        SELECT * FROM session_messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      ) ORDER BY created_at ASC
    `).all(sessionId, limit) as SessionMessage[];
  },
};

export const sessionRunRepo = {
  create(input: {
    session_id: string;
    agent_id?: string;
    provider: AcpBackend;
    model?: string | null;
    status?: SessionRunStatus;
    mode: SessionMode;
    phase?: SessionPhase | null;
    prompt: string;
    acp_session_id?: string | null;
  }): SessionRun {
    const id = nanoid(16);
    const timestamp = now();
    db.prepare(`
      INSERT INTO session_runs (
        id, session_id, agent_id, provider, model, status, mode, phase,
        prompt, acp_session_id, started_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.session_id,
      input.agent_id ?? DEFAULT_SESSION_AGENT_ID,
      input.provider,
      input.model ?? null,
      input.status ?? 'running',
      input.mode,
      input.phase ?? null,
      input.prompt,
      input.acp_session_id ?? null,
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  },

  get(id: string): SessionRun | undefined {
    return db.prepare('SELECT * FROM session_runs WHERE id = ?').get(id) as SessionRun | undefined;
  },

  findReusableAcpSessionId(input: {
    session_id: string;
    agent_id: string;
    provider: AcpBackend;
  }): string | null {
    const row = db.prepare(`
      SELECT acp_session_id
      FROM session_runs
      WHERE session_id = ?
        AND agent_id = ?
        AND provider = ?
        AND acp_session_id IS NOT NULL
        AND status IN ('running', 'completed', 'paused', 'cancelled', 'interrupted')
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(input.session_id, input.agent_id, input.provider) as { acp_session_id: string } | undefined;
    return row?.acp_session_id ?? null;
  },

  listBySession(sessionId: string, input: { limit?: number } = {}): SessionRun[] {
    const limit = input.limit ?? 100;
    return db.prepare(`
      SELECT * FROM (
        SELECT * FROM session_runs
        WHERE session_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      ) ORDER BY started_at ASC
    `).all(sessionId, limit) as SessionRun[];
  },

  appendStdout(id: string, chunk: string): SessionRun | undefined {
    db.prepare('UPDATE session_runs SET stdout = stdout || ?, updated_at = ? WHERE id = ?').run(chunk, now(), id);
    return this.get(id);
  },

  appendStderr(id: string, chunk: string): SessionRun | undefined {
    db.prepare('UPDATE session_runs SET stderr = stderr || ?, updated_at = ? WHERE id = ?').run(chunk, now(), id);
    return this.get(id);
  },

  appendActivity(id: string, chunk: string): SessionRun | undefined {
    db.prepare('UPDATE session_runs SET activity_log = activity_log || ?, updated_at = ? WHERE id = ?').run(
      chunk,
      now(),
      id,
    );
    return this.get(id);
  },

  updateStatus(
    id: string,
    status: SessionRunStatus,
    patch: Partial<Pick<SessionRun, 'model' | 'phase' | 'stdout' | 'stderr' | 'activity_log' | 'error' | 'acp_session_id'>> = {},
  ): SessionRun | undefined {
    const completedAt = isActiveSessionRunStatus(status) ? null : now();
    db.prepare(`
      UPDATE session_runs
      SET status = ?,
          model = COALESCE(?, model),
          phase = COALESCE(?, phase),
          stdout = COALESCE(?, stdout),
          stderr = COALESCE(?, stderr),
          activity_log = COALESCE(?, activity_log),
          error = COALESCE(?, error),
          acp_session_id = COALESCE(?, acp_session_id),
          updated_at = ?,
          completed_at = ?
      WHERE id = ?
    `).run(
      status,
      patch.model ?? null,
      patch.phase ?? null,
      patch.stdout ?? null,
      patch.stderr ?? null,
      patch.activity_log ?? null,
      patch.error ?? null,
      patch.acp_session_id ?? null,
      now(),
      completedAt,
      id,
    );
    return this.get(id);
  },
};

export const sessionAgentRuntimeRepo = {
  getByAgent(sessionId: string, agentId: string, provider: AcpBackend): SessionAgentRuntime | undefined {
    return db.prepare(`
      SELECT * FROM session_agent_runtimes
      WHERE session_id = ? AND agent_id = ? AND provider = ?
    `).get(sessionId, agentId, provider) as SessionAgentRuntime | undefined;
  },

  upsert(input: {
    session_id: string;
    agent_id: string;
    provider: AcpBackend;
    model?: string | null;
    provider_session_id?: string | null;
    status: SessionAgentRuntimeStatus;
    current_run_id?: string | null;
    latest_checkpoint_id?: string | null;
  }): SessionAgentRuntime {
    const id = this.getByAgent(input.session_id, input.agent_id, input.provider)?.id ?? nanoid(16);
    const timestamp = now();
    db.prepare(`
      INSERT INTO session_agent_runtimes (
        id, session_id, agent_id, provider, model, provider_session_id,
        status, current_run_id, latest_checkpoint_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, agent_id, provider) DO UPDATE SET
        model = excluded.model,
        provider_session_id = COALESCE(excluded.provider_session_id, session_agent_runtimes.provider_session_id),
        status = excluded.status,
        current_run_id = excluded.current_run_id,
        latest_checkpoint_id = COALESCE(excluded.latest_checkpoint_id, session_agent_runtimes.latest_checkpoint_id),
        updated_at = excluded.updated_at
    `).run(
      id,
      input.session_id,
      input.agent_id,
      input.provider,
      input.model ?? null,
      input.provider_session_id ?? null,
      input.status,
      input.current_run_id ?? null,
      input.latest_checkpoint_id ?? null,
      timestamp,
      timestamp,
    );
    return this.getByAgent(input.session_id, input.agent_id, input.provider)!;
  },
};

export const sessionAgentEventRepo = {
  create(input: {
    session_id: string;
    agent_id: string;
    run_id: string;
    channel: SessionAgentEvent['channel'];
    event_type: string;
    content: string;
    payload?: Record<string, unknown> | null;
  }): SessionAgentEvent {
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_agent_events WHERE run_id = ?')
      .get(input.run_id) as { seq: number };
    const id = nanoid(16);
    db.prepare(`
      INSERT INTO session_agent_events (
        id, session_id, agent_id, run_id, seq, channel, event_type,
        content, payload_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.session_id,
      input.agent_id,
      input.run_id,
      row.seq,
      input.channel,
      input.event_type,
      input.content,
      input.payload ? JSON.stringify(input.payload) : null,
      now(),
    );
    return this.get(id)!;
  },

  get(id: string): SessionAgentEvent | undefined {
    return db.prepare('SELECT * FROM session_agent_events WHERE id = ?').get(id) as SessionAgentEvent | undefined;
  },

  listByRun(runId: string): SessionAgentEvent[] {
    return db.prepare(`
      SELECT * FROM session_agent_events
      WHERE run_id = ?
      ORDER BY seq ASC
    `).all(runId) as SessionAgentEvent[];
  },
};

export const sessionPlanItemRepo = {
  upsertMany(
    sessionId: string,
    items: Array<{
      id?: string;
      parent_id?: string | null;
      title: string;
      description?: string | null;
      status?: SessionPlanItemStatus;
      priority?: number;
      source?: string | null;
      evidence_event_id?: string | null;
      completed_at?: number | null;
    }>,
  ): SessionPlanItem[] {
    const upsert = db.transaction(() => {
      const timestamp = now();
      for (const item of items) {
        const id = item.id ?? nanoid(16);
        db.prepare(`
          INSERT INTO session_plan_items (
            id, session_id, parent_id, title, description, status,
            priority, source, evidence_event_id, created_at, updated_at, completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            parent_id = excluded.parent_id,
            title = excluded.title,
            description = excluded.description,
            status = excluded.status,
            priority = excluded.priority,
            source = excluded.source,
            evidence_event_id = excluded.evidence_event_id,
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at
        `).run(
          id,
          sessionId,
          item.parent_id ?? null,
          item.title,
          item.description ?? null,
          item.status ?? 'pending',
          item.priority ?? 0,
          item.source ?? null,
          item.evidence_event_id ?? null,
          timestamp,
          timestamp,
          item.completed_at ?? null,
        );
      }
    });
    upsert();
    return this.listBySession(sessionId);
  },

  listBySession(sessionId: string): SessionPlanItem[] {
    return db.prepare(`
      SELECT * FROM session_plan_items
      WHERE session_id = ?
      ORDER BY priority ASC, created_at ASC
    `).all(sessionId) as SessionPlanItem[];
  },
};

function stringifyMetadata(value: Record<string, unknown> | string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isActiveSessionRunStatus(status: SessionRunStatus): boolean {
  return ACTIVE_SESSION_RUN_STATUSES.includes(status as typeof ACTIVE_SESSION_RUN_STATUSES[number]);
}

export function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
