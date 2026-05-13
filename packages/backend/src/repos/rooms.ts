import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { AcpBackend, Room, RoomAgent, WorkflowRole } from '../types.js';

export const roomRepo = {
  listByProject(projectId: string): Room[] {
    return db
      .prepare('SELECT * FROM rooms WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Room[];
  },

  get(id: string): Room | undefined {
    return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Room | undefined;
  },

  create(input: { project_id: string; name: string; description?: string }): Room {
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO rooms (id, project_id, name, description, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.project_id, input.name, input.description ?? null, now());
    return this.get(id)!;
  },

  delete(id: string): boolean {
    return db.prepare('DELETE FROM rooms WHERE id = ?').run(id).changes > 0;
  },
};

export const roomAgentRepo = {
  listByRoom(roomId: string): RoomAgent[] {
    return db
      .prepare('SELECT * FROM room_agents WHERE room_id = ? ORDER BY joined_at ASC')
      .all(roomId) as RoomAgent[];
  },

  get(id: string): RoomAgent | undefined {
    return db.prepare('SELECT * FROM room_agents WHERE id = ?').get(id) as RoomAgent | undefined;
  },

  add(input: {
    room_id: string;
    agent_id: string;
    agent_name: string;
    agent_role?: string;
  }): RoomAgent {
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO room_agents (id, room_id, agent_id, agent_name, agent_role, joined_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.room_id, input.agent_id, input.agent_name, input.agent_role ?? null, now());
    return this.get(id)!;
  },

  remove(id: string): boolean {
    return db.prepare('DELETE FROM room_agents WHERE id = ?').run(id).changes > 0;
  },

  setAcp(
    id: string,
    config: {
      acp_enabled: boolean;
      acp_backend: AcpBackend | null;
      acp_session_id: string | null;
      acp_session_label: string | null;
    },
  ): RoomAgent | undefined {
    db.prepare(
      `UPDATE room_agents SET acp_enabled = ?, acp_backend = ?, acp_session_id = ?, acp_session_label = ? WHERE id = ?`,
    ).run(
      config.acp_enabled ? 1 : 0,
      config.acp_backend,
      config.acp_session_id,
      config.acp_session_label,
      id,
    );
    return this.get(id);
  },

  setWorkflowRole(id: string, workflowRole: WorkflowRole | null): RoomAgent | undefined {
    db.prepare('UPDATE room_agents SET workflow_role = ? WHERE id = ?').run(workflowRole, id);
    return this.get(id);
  },
};
