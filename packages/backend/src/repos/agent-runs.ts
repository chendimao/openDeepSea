import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  AcpBackend,
  AgentRun,
  AgentRunStatus,
  CollaborationStage,
  SuperpowersBootstrapOwner,
  WorkflowStage,
} from '../types.js';

const ACTIVE_AGENT_RUN_STATUSES = ['running', 'queued', 'retrying'] as const;
const CLIENT_PROMPT_PREVIEW_CHARS = 120;

export const agentRunRepo = {
  create(input: {
    room_id: string;
    room_agent_id: string;
    agent_id: string;
    backend: 'openclaw' | AcpBackend;
    status?: AgentRunStatus;
    session_key?: string | null;
    acp_session_id?: string | null;
    task_id?: string | null;
    workflow_run_id?: string | null;
    workflow_step_id?: string | null;
    workflow_stage?: WorkflowStage | null;
    collaboration_run_id?: string | null;
    collaboration_stage?: CollaborationStage | null;
    superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
    superpowers_bootstrap_injected?: boolean;
    superpowers_bootstrap_skill?: string | null;
    superpowers_bootstrap_skip_reason?: string | null;
    prompt: string;
  }): AgentRun {
    const id = nanoid(16);
    const timestamp = now();
    db.prepare(
      `INSERT INTO agent_runs (
        id, room_id, room_agent_id, agent_id, backend, status, session_key, acp_session_id,
        task_id, workflow_run_id, workflow_step_id, workflow_stage, collaboration_run_id, collaboration_stage,
        superpowers_bootstrap_owner, superpowers_bootstrap_injected, superpowers_bootstrap_skill,
        superpowers_bootstrap_skip_reason, prompt, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.room_id,
      input.room_agent_id,
      input.agent_id,
      input.backend,
      input.status ?? 'running',
      input.session_key ?? null,
      input.acp_session_id ?? null,
      input.task_id ?? null,
      input.workflow_run_id ?? null,
      input.workflow_step_id ?? null,
      input.workflow_stage ?? null,
      input.collaboration_run_id ?? null,
      input.collaboration_stage ?? null,
      input.superpowers_bootstrap_owner ?? null,
      input.superpowers_bootstrap_injected ? 1 : 0,
      input.superpowers_bootstrap_skill ?? null,
      input.superpowers_bootstrap_skip_reason ?? null,
      input.prompt,
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  },

  get(id: string): AgentRun | undefined {
    return db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRun | undefined;
  },

  listByRoom(roomId: string, limit = 50): AgentRun[] {
    return db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM agent_runs
           WHERE room_id = ?
             AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(', ')})
           UNION
           SELECT * FROM (
             SELECT * FROM agent_runs
             WHERE room_id = ?
             ORDER BY started_at DESC
             LIMIT ?
           )
         ) ORDER BY started_at DESC`,
      )
      .all(roomId, ...ACTIVE_AGENT_RUN_STATUSES, roomId, limit) as AgentRun[];
  },

  listForClientByRoom(roomId: string, limit = 50): AgentRun[] {
    return this.listByRoom(roomId, limit).map(compactAgentRunForClient);
  },

  listActiveByWorkflow(workflowRunId: string): AgentRun[] {
    return db
      .prepare(
        `SELECT * FROM agent_runs
         WHERE workflow_run_id = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(', ')})
         ORDER BY started_at DESC`,
      )
      .all(workflowRunId, ...ACTIVE_AGENT_RUN_STATUSES) as AgentRun[];
  },

  listActive(): AgentRun[] {
    return db
      .prepare(
        `SELECT * FROM agent_runs
         WHERE status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(', ')})
         ORDER BY started_at ASC`,
      )
      .all(...ACTIVE_AGENT_RUN_STATUSES) as AgentRun[];
  },

  interruptRun(id: string, error: string): AgentRun | undefined {
    const timestamp = now();
    db.prepare(
      `UPDATE agent_runs
       SET status = 'interrupted',
           error = COALESCE(error, ?),
           stderr = CASE
             WHEN stderr = '' THEN ?
             ELSE stderr || ?
           END,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
    ).run(error, error, `\n${error}`, timestamp, timestamp, id);
    return this.get(id);
  },

  appendStdout(id: string, chunk: string): AgentRun | undefined {
    db.prepare('UPDATE agent_runs SET stdout = stdout || ?, updated_at = ? WHERE id = ?').run(
      chunk,
      now(),
      id,
    );
    return this.get(id);
  },

  updateStdout(id: string, stdout: string): AgentRun | undefined {
    db.prepare('UPDATE agent_runs SET stdout = ?, updated_at = ? WHERE id = ?').run(
      stdout,
      now(),
      id,
    );
    return this.get(id);
  },

  appendStderr(id: string, chunk: string): AgentRun | undefined {
    db.prepare('UPDATE agent_runs SET stderr = stderr || ?, updated_at = ? WHERE id = ?').run(
      chunk,
      now(),
      id,
    );
    return this.get(id);
  },

  appendActivity(id: string, chunk: string): AgentRun | undefined {
    db.prepare('UPDATE agent_runs SET activity_log = activity_log || ?, updated_at = ? WHERE id = ?').run(
      chunk,
      now(),
      id,
    );
    return this.get(id);
  },

  touchActive(id: string): AgentRun | undefined {
    db.prepare(
      `UPDATE agent_runs
       SET updated_at = ?
       WHERE id = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES.map(() => '?').join(', ')})`,
    ).run(now(), id, ...ACTIVE_AGENT_RUN_STATUSES);
    return this.get(id);
  },

  updateStatus(
    id: string,
    status: AgentRunStatus,
    patch: Partial<Pick<AgentRun, 'session_key' | 'acp_session_id' | 'error' | 'stdout' | 'stderr' | 'activity_log'>> = {},
  ): AgentRun | undefined {
    const completedAt = ACTIVE_AGENT_RUN_STATUSES.includes(status as typeof ACTIVE_AGENT_RUN_STATUSES[number]) ? null : now();
    db.prepare(
      `UPDATE agent_runs
       SET status = ?,
           session_key = COALESCE(?, session_key),
           acp_session_id = COALESCE(?, acp_session_id),
           error = COALESCE(?, error),
           stdout = COALESCE(?, stdout),
           stderr = COALESCE(?, stderr),
           activity_log = COALESCE(?, activity_log),
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
    ).run(
      status,
      patch.session_key ?? null,
      patch.acp_session_id ?? null,
      patch.error ?? null,
      patch.stdout ?? null,
      patch.stderr ?? null,
      patch.activity_log ?? null,
      now(),
      completedAt,
      id,
    );
    return this.get(id);
  },
};

function compactAgentRunForClient(run: AgentRun): AgentRun {
  return {
    ...run,
    prompt: truncateText(run.prompt, CLIENT_PROMPT_PREVIEW_CHARS),
  };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}
