import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { AcpBackend, AgentRun, AgentRunStatus } from '../types.js';

export const agentRunRepo = {
  create(input: {
    room_id: string;
    room_agent_id: string;
    agent_id: string;
    backend: 'openclaw' | AcpBackend;
    status?: AgentRunStatus;
    session_key?: string | null;
    acp_session_id?: string | null;
    prompt: string;
  }): AgentRun {
    const id = nanoid(16);
    const timestamp = now();
    db.prepare(
      `INSERT INTO agent_runs (
        id, room_id, room_agent_id, agent_id, backend, status, session_key, acp_session_id,
        prompt, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.room_id,
      input.room_agent_id,
      input.agent_id,
      input.backend,
      input.status ?? 'running',
      input.session_key ?? null,
      input.acp_session_id ?? null,
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
      .prepare('SELECT * FROM agent_runs WHERE room_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(roomId, limit) as AgentRun[];
  },

  appendStdout(id: string, chunk: string): AgentRun | undefined {
    db.prepare('UPDATE agent_runs SET stdout = stdout || ?, updated_at = ? WHERE id = ?').run(
      chunk,
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

  updateStatus(
    id: string,
    status: AgentRunStatus,
    patch: Partial<Pick<AgentRun, 'session_key' | 'acp_session_id' | 'error' | 'stdout' | 'stderr'>> = {},
  ): AgentRun | undefined {
    const completedAt = status === 'running' || status === 'queued' ? null : now();
    db.prepare(
      `UPDATE agent_runs
       SET status = ?,
           session_key = COALESCE(?, session_key),
           acp_session_id = COALESCE(?, acp_session_id),
           error = COALESCE(?, error),
           stdout = COALESCE(?, stdout),
           stderr = COALESCE(?, stderr),
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
      now(),
      completedAt,
      id,
    );
    return this.get(id);
  },
};
