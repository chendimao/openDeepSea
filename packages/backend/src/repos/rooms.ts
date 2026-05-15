import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { AcpBackend, AcpPermissionMode, Room, RoomAgent, WorkflowRole } from '../types.js';

type RoomAgentRow = Omit<RoomAgent, 'acp_writable_dirs' | 'acp_permission_mode'> & {
  acp_permission_mode?: string | null;
  acp_writable_dirs?: string | null;
};

const ACP_PERMISSION_MODES = new Set<AcpPermissionMode>(['bypass', 'workspace-write', 'read-only']);

function parseWritableDirs(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}

function normalizeRoomAgent(row: RoomAgentRow): RoomAgent {
  const mode = row.acp_permission_mode;
  return {
    ...row,
    acp_permission_mode: mode && ACP_PERMISSION_MODES.has(mode as AcpPermissionMode)
      ? (mode as AcpPermissionMode)
      : 'bypass',
    acp_writable_dirs: parseWritableDirs(row.acp_writable_dirs),
  };
}

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
    const rows = db
      .prepare('SELECT * FROM room_agents WHERE room_id = ? ORDER BY joined_at ASC')
      .all(roomId) as RoomAgentRow[];
    return rows.map(normalizeRoomAgent);
  },

  get(id: string): RoomAgent | undefined {
    const row = db.prepare('SELECT * FROM room_agents WHERE id = ?').get(id) as RoomAgentRow | undefined;
    return row ? normalizeRoomAgent(row) : undefined;
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
      acp_permission_mode?: AcpPermissionMode | null;
      acp_writable_dirs?: string[] | null;
    },
  ): RoomAgent | undefined {
    db.prepare(
      `UPDATE room_agents
       SET acp_enabled = ?, acp_backend = ?, acp_session_id = ?, acp_session_label = ?,
           acp_permission_mode = ?, acp_writable_dirs = ?
       WHERE id = ?`,
    ).run(
      config.acp_enabled ? 1 : 0,
      config.acp_backend,
      config.acp_session_id,
      config.acp_session_label,
      config.acp_permission_mode ?? 'bypass',
      JSON.stringify(config.acp_writable_dirs ?? []),
      id,
    );
    return this.get(id);
  },

  setWorkflowRole(id: string, workflowRole: WorkflowRole | null): RoomAgent | undefined {
    db.prepare('UPDATE room_agents SET workflow_role = ? WHERE id = ?').run(workflowRole, id);
    return this.get(id);
  },
};
