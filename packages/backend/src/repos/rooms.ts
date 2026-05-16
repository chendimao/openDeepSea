import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { AcpBackend, AcpPermissionMode, AgentDefaultRuntime, Room, RoomAgent, WorkflowRole } from '../types.js';
import { agentRepo } from './agents.js';

type RoomAgentRow = Omit<RoomAgent, 'acp_writable_dirs' | 'acp_permission_mode' | 'capabilities' | 'default_runtime'> & {
  acp_permission_mode?: string | null;
  acp_writable_dirs?: string | null;
  capabilities?: string | null;
  default_runtime?: string | null;
};

const ACP_PERMISSION_MODES = new Set<AcpPermissionMode>(['bypass', 'workspace-write', 'read-only']);
const DEFAULT_RUNTIMES = new Set<AgentDefaultRuntime>(['acp', 'openclaw', 'none']);

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

function normalizeRoomAgent(row: RoomAgentRow): RoomAgent {
  const mode = row.acp_permission_mode;
  const runtime = row.default_runtime;
  return {
    ...row,
    acp_permission_mode: mode && ACP_PERMISSION_MODES.has(mode as AcpPermissionMode)
      ? (mode as AcpPermissionMode)
      : 'bypass',
    acp_writable_dirs: parseStringArray(row.acp_writable_dirs),
    capabilities: parseStringArray(row.capabilities),
    default_runtime: runtime && DEFAULT_RUNTIMES.has(runtime as AgentDefaultRuntime)
      ? (runtime as AgentDefaultRuntime)
      : 'none',
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
      .prepare(`${roomAgentSelectSql()} WHERE room_agents.room_id = ? ORDER BY room_agents.joined_at ASC`)
      .all(roomId) as RoomAgentRow[];
    return rows.map(normalizeRoomAgent);
  },

  get(id: string): RoomAgent | undefined {
    const row = db.prepare(`${roomAgentSelectSql()} WHERE room_agents.id = ?`).get(id) as RoomAgentRow | undefined;
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
      `INSERT INTO room_agents (id, room_id, global_agent_id, agent_id, agent_name, agent_role, joined_at, default_runtime)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 'none')`,
    ).run(id, input.room_id, input.agent_id, input.agent_name, input.agent_role ?? null, now());
    return this.get(id)!;
  },

  addFromGlobalAgent(input: { room_id: string; global_agent_id: string }): RoomAgent {
    const agent = agentRepo.get(input.global_agent_id);
    if (!agent) throw new Error('global agent not found');

    const id = nanoid(12);
    db.prepare(
      `INSERT INTO room_agents (
        id, room_id, global_agent_id, agent_id, agent_name, agent_role, joined_at,
        acp_enabled, acp_backend, acp_permission_mode, default_runtime
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.room_id,
      agent.id,
      agent.agent_id,
      agent.name,
      agent.description,
      now(),
      agent.default_acp_backend ? 1 : 0,
      agent.default_acp_backend,
      agent.default_acp_permission_mode,
      agent.default_acp_backend ? 'acp' : 'none',
    );
    return this.get(id)!;
  },

  ensureGlobalAgent(id: string): RoomAgent | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.global_agent_id) return existing;

    const agent = agentRepo.createOrReuseFromRoomAgent({
      agent_id: existing.agent_id,
      agent_name: existing.agent_name,
      agent_role: existing.agent_role,
      acp_backend: existing.acp_backend,
      acp_permission_mode: existing.acp_permission_mode,
    });
    db.prepare('UPDATE room_agents SET global_agent_id = ? WHERE id = ?').run(agent.id, id);
    return this.get(id);
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

  setCapabilitiesAndRuntime(
    id: string,
    input: { capabilities: string[]; default_runtime: AgentDefaultRuntime },
  ): RoomAgent | undefined {
    db.prepare('UPDATE room_agents SET capabilities = ?, default_runtime = ? WHERE id = ?')
      .run(JSON.stringify(input.capabilities), input.default_runtime, id);
    return this.get(id);
  },
};

function roomAgentSelectSql(): string {
  return `
    SELECT
      room_agents.*,
      COALESCE(agents.agent_id, room_agents.agent_id) AS agent_id,
      COALESCE(agents.name, room_agents.agent_name) AS agent_name,
      agents.preferred_user_name AS preferred_user_name,
      agents.personality AS personality,
      agents.rules AS rules,
      COALESCE(agents.responsibilities, room_agents.agent_role) AS responsibilities
    FROM room_agents
    LEFT JOIN agents ON agents.id = room_agents.global_agent_id
  `;
}
