import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { AcpBackend, AcpPermissionMode, Agent, AgentReference } from '../types.js';

type AgentRow = Omit<Agent, 'reference_count' | 'references' | 'default_acp_permission_mode'> & {
  default_acp_permission_mode?: string | null;
  reference_count?: number;
};

export type AgentDeleteResult =
  | { ok: true }
  | { ok: false; reason: 'not_found'; references: [] }
  | { ok: false; reason: 'in_use'; references: AgentReference[] };

const ACP_PERMISSION_MODES = new Set<AcpPermissionMode>(['bypass', 'workspace-write', 'read-only']);

function normalizeAgent(row: AgentRow): Agent {
  const permissionMode = row.default_acp_permission_mode;
  return {
    ...row,
    default_acp_permission_mode:
      permissionMode && ACP_PERMISSION_MODES.has(permissionMode as AcpPermissionMode)
        ? (permissionMode as AcpPermissionMode)
        : 'bypass',
    reference_count: row.reference_count ?? 0,
  };
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export const agentRepo = {
  list(): Agent[] {
    const rows = db.prepare(
      `SELECT agents.*,
              COUNT(room_agents.id) AS reference_count
       FROM agents
       LEFT JOIN room_agents ON room_agents.global_agent_id = agents.id
       GROUP BY agents.id
       ORDER BY agents.updated_at DESC`,
    ).all() as AgentRow[];
    return rows.map(normalizeAgent);
  },

  get(id: string): Agent | undefined {
    const row = db.prepare(
      `SELECT agents.*,
              COUNT(room_agents.id) AS reference_count
       FROM agents
       LEFT JOIN room_agents ON room_agents.global_agent_id = agents.id
       WHERE agents.id = ?
       GROUP BY agents.id`,
    ).get(id) as AgentRow | undefined;
    if (!row) return undefined;
    return {
      ...normalizeAgent(row),
      references: this.getReferences(id),
    };
  },

  getByAgentId(agentId: string): Agent | undefined {
    const row = db.prepare(
      `SELECT agents.*,
              COUNT(room_agents.id) AS reference_count
       FROM agents
       LEFT JOIN room_agents ON room_agents.global_agent_id = agents.id
       WHERE agents.agent_id = ?
       GROUP BY agents.id`,
    ).get(agentId) as AgentRow | undefined;
    if (!row) return undefined;
    return {
      ...normalizeAgent(row),
      references: this.getReferences(row.id),
    };
  },

  create(input: {
    agent_id: string;
    name: string;
    description?: string | null;
    preferred_user_name?: string | null;
    personality?: string | null;
    rules?: string | null;
    responsibilities?: string | null;
    default_acp_backend?: AcpBackend | null;
    default_acp_permission_mode?: AcpPermissionMode | null;
  }): Agent {
    const id = nanoid(12);
    const ts = now();
    db.prepare(
      `INSERT INTO agents (
        id, agent_id, name, description, preferred_user_name, personality, rules,
        responsibilities, default_acp_backend, default_acp_permission_mode, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.agent_id.trim(),
      input.name.trim(),
      trimmedOrNull(input.description),
      trimmedOrNull(input.preferred_user_name),
      trimmedOrNull(input.personality),
      trimmedOrNull(input.rules),
      trimmedOrNull(input.responsibilities),
      input.default_acp_backend ?? null,
      input.default_acp_permission_mode ?? 'bypass',
      ts,
      ts,
    );
    return this.get(id)!;
  },

  update(
    id: string,
    patch: Partial<{
      agent_id: string;
      name: string;
      description: string | null;
      preferred_user_name: string | null;
      personality: string | null;
      rules: string | null;
      responsibilities: string | null;
      default_acp_backend: AcpBackend | null;
      default_acp_permission_mode: AcpPermissionMode | null;
    }>,
  ): Agent | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    db.prepare(
      `UPDATE agents
       SET agent_id = ?, name = ?, description = ?, preferred_user_name = ?,
           personality = ?, rules = ?, responsibilities = ?,
           default_acp_backend = ?, default_acp_permission_mode = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.agent_id === undefined ? existing.agent_id : patch.agent_id.trim(),
      patch.name === undefined ? existing.name : patch.name.trim(),
      patch.description === undefined ? existing.description : trimmedOrNull(patch.description),
      patch.preferred_user_name === undefined
        ? existing.preferred_user_name
        : trimmedOrNull(patch.preferred_user_name),
      patch.personality === undefined ? existing.personality : trimmedOrNull(patch.personality),
      patch.rules === undefined ? existing.rules : trimmedOrNull(patch.rules),
      patch.responsibilities === undefined ? existing.responsibilities : trimmedOrNull(patch.responsibilities),
      patch.default_acp_backend === undefined ? existing.default_acp_backend : patch.default_acp_backend,
      patch.default_acp_permission_mode === undefined
        ? existing.default_acp_permission_mode
        : patch.default_acp_permission_mode ?? 'bypass',
      now(),
      id,
    );
    return this.get(id);
  },

  delete(id: string): AgentDeleteResult {
    const existing = this.get(id);
    if (!existing) return { ok: false, reason: 'not_found', references: [] };

    const references = this.getReferences(id);
    if (references.length > 0) return { ok: false, reason: 'in_use', references };

    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    return { ok: true };
  },

  getReferences(id: string): AgentReference[] {
    return db.prepare(
      `SELECT rooms.id AS room_id, rooms.name AS room_name
       FROM room_agents
       JOIN rooms ON rooms.id = room_agents.room_id
       WHERE room_agents.global_agent_id = ?
       ORDER BY rooms.created_at DESC`,
    ).all(id) as AgentReference[];
  },

  createOrReuseFromRoomAgent(input: {
    agent_id: string;
    agent_name: string;
    agent_role?: string | null;
    acp_backend?: AcpBackend | null;
    acp_permission_mode?: AcpPermissionMode | null;
  }): Agent {
    const existing = this.getByAgentId(input.agent_id);
    if (existing) return existing;
    return this.create({
      agent_id: input.agent_id,
      name: input.agent_name,
      description: input.agent_role ?? null,
      responsibilities: input.agent_role ?? null,
      default_acp_backend: input.acp_backend ?? null,
      default_acp_permission_mode: input.acp_permission_mode ?? 'bypass',
    });
  },
};
