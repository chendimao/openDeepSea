import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { AcpSessionHandoffReason, TaskExecutor } from '../types.js';

export const taskExecutorRepo = {
  ensure(input: {
    task_id: string;
    room_id: string;
    room_agent_id: string;
    agent_id: string;
    acp_session_id?: string | null;
  }): TaskExecutor {
    const existing = this.getByTaskAndAgent(input.task_id, input.room_agent_id);
    if (existing) {
      if (input.acp_session_id !== undefined && input.acp_session_id !== existing.acp_session_id) {
        return this.updateSession(existing.id, input.acp_session_id) ?? existing;
      }
      return existing;
    }
    const id = nanoid(16);
    const timestamp = now();
    db.prepare(
      `INSERT INTO task_executors (
        id, task_id, room_id, room_agent_id, agent_id, acp_session_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    ).run(
      id,
      input.task_id,
      input.room_id,
      input.room_agent_id,
      input.agent_id,
      input.acp_session_id ?? null,
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  },

  get(id: string): TaskExecutor | undefined {
    return db.prepare('SELECT * FROM task_executors WHERE id = ?').get(id) as TaskExecutor | undefined;
  },

  getByTaskAndAgent(taskId: string, roomAgentId: string): TaskExecutor | undefined {
    return db
      .prepare('SELECT * FROM task_executors WHERE task_id = ? AND room_agent_id = ?')
      .get(taskId, roomAgentId) as TaskExecutor | undefined;
  },

  updateSession(id: string, acpSessionId: string | null): TaskExecutor | undefined {
    db.prepare(
      `UPDATE task_executors
       SET acp_session_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(acpSessionId, now(), id);
    return this.get(id);
  },

  setHandoffPending(
    id: string,
    pending: boolean,
    reason: AcpSessionHandoffReason | null,
  ): TaskExecutor | undefined {
    db.prepare(
      `UPDATE task_executors
       SET acp_session_handoff_pending = ?, acp_session_handoff_reason = ?, updated_at = ?
       WHERE id = ?`,
    ).run(pending ? 1 : 0, pending ? reason : null, now(), id);
    return this.get(id);
  },

  updateStatus(id: string, status: TaskExecutor['status']): TaskExecutor | undefined {
    db.prepare('UPDATE task_executors SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    return this.get(id);
  },
};
