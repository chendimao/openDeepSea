import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { AgentRunLink, AgentRunRelationship, AgentRunLinkRole } from '../types.js';

export interface AgentRunLinkCreateInput {
  room_id: string;
  task_id?: string | null;
  parent_run_id: string;
  child_run_id: string;
  relationship: AgentRunRelationship;
  role: AgentRunLinkRole;
}

export const agentRunLinkRepo = {
  create(input: AgentRunLinkCreateInput): AgentRunLink {
    const id = nanoid();
    const createdAt = now();
    db.prepare(
      `INSERT INTO agent_run_links (
        id, room_id, task_id, parent_run_id, child_run_id, relationship, role, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.room_id,
      input.task_id ?? null,
      input.parent_run_id,
      input.child_run_id,
      input.relationship,
      input.role,
      createdAt,
    );
    return this.get(id)!;
  },

  get(id: string): AgentRunLink | undefined {
    return db.prepare('SELECT * FROM agent_run_links WHERE id = ?').get(id) as AgentRunLink | undefined;
  },

  listByParentRun(parentRunId: string): AgentRunLink[] {
    return db
      .prepare('SELECT * FROM agent_run_links WHERE parent_run_id = ? ORDER BY created_at ASC')
      .all(parentRunId) as AgentRunLink[];
  },

  listByTask(taskId: string): AgentRunLink[] {
    return db
      .prepare('SELECT * FROM agent_run_links WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as AgentRunLink[];
  },
};
