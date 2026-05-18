import { nanoid } from 'nanoid';
import { getBuiltInAgentTemplate, type RoomCrewTemplate } from '../crew-templates.js';
import { db, now } from '../db.js';
import type {
  AcpBackend,
  AcpPermissionMode,
  AgentDefaultRuntime,
  AgentMemoryScope,
  AgentRuntimeBackend,
  AgentToolCapability,
  AgentToolPolicy,
  AgentWorkspacePolicy,
  Room,
  RoomAgent,
  WorkflowRole,
} from '../types.js';
import { agentRepo } from './agents.js';

type RoomAgentRow = Omit<
  RoomAgent,
  | 'acp_writable_dirs'
  | 'acp_permission_mode'
  | 'capabilities'
  | 'default_runtime'
  | 'runtime_backend'
  | 'tool_policy'
  | 'workspace_policy'
  | 'memory_scope'
> & {
  acp_permission_mode?: string | null;
  acp_writable_dirs?: string | null;
  capabilities?: string | null;
  default_runtime?: string | null;
  runtime_backend?: string | null;
  tool_policy?: string | null;
  workspace_policy?: string | null;
  memory_scope?: string | null;
  runtime_profile_version?: number | null;
};

type RoomAgentWithRuntimeProfileVersion = RoomAgent & { runtime_profile_version?: number | null };

export interface RoomAgentRemovalImpact {
  active_run_count: number;
  open_task_count: number;
  historical_run_count: number;
  message_count: number;
}

const ACP_PERMISSION_MODES = new Set<AcpPermissionMode>(['bypass', 'workspace-write', 'read-only']);
const DEFAULT_RUNTIMES = new Set<AgentDefaultRuntime>(['acp', 'openclaw', 'none']);
const RUNTIME_BACKENDS = new Set<AgentRuntimeBackend>(['acp', 'model', 'none']);
const MEMORY_SCOPES = new Set<AgentMemoryScope>(['project', 'room', 'agent', 'task', 'none']);
const TOOL_CAPABILITIES = new Set<AgentToolCapability>([
  'read_files',
  'write_files',
  'run_shell',
  'browser',
  'search',
  'image_input',
  'commit',
]);
const DEFAULT_TOOL_POLICY: AgentToolPolicy = { allowed: [] };
const DEFAULT_WORKSPACE_POLICY: AgentWorkspacePolicy = { read: [], write: [] };
const BUILT_IN_RUNTIME_PROFILE_VERSION = 1;

function parseJsonObject<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeToolPolicy(value: string | null | undefined): AgentToolPolicy | null {
  if (!value) return null;
  const parsed = parseJsonObject<Partial<AgentToolPolicy> | null>(value, null);
  if (!parsed) return null;
  return {
    allowed: normalizeStringArray(parsed.allowed).filter((item): item is AgentToolCapability =>
      TOOL_CAPABILITIES.has(item as AgentToolCapability),
    ),
  };
}

function normalizeWorkspacePolicy(value: string | null | undefined): AgentWorkspacePolicy | null {
  if (!value) return null;
  const parsed = parseJsonObject<Partial<AgentWorkspacePolicy> | null>(value, null);
  if (!parsed) return null;
  return {
    read: normalizeStringArray(parsed.read),
    write: normalizeStringArray(parsed.write),
  };
}

function isLegacyToolPolicy(policy: AgentToolPolicy | null): boolean {
  return !!policy && policy.allowed.length === 0;
}

function isLegacyWorkspacePolicy(policy: AgentWorkspacePolicy | null): boolean {
  return !!policy && policy.read.length === 0 && policy.write.length === 0;
}

function isLegacyMemoryScope(scope: AgentMemoryScope | null): boolean {
  return scope === 'agent';
}

function resolveBuiltInRoomRuntimeBoundary(
  existing: RoomAgentWithRuntimeProfileVersion,
  template: NonNullable<ReturnType<typeof getBuiltInAgentTemplate>>,
) {
  if (existing.runtime_profile_version === BUILT_IN_RUNTIME_PROFILE_VERSION) {
    return {
      acp_permission_mode: existing.acp_permission_mode,
      runtime_backend: existing.runtime_backend,
      tool_policy: existing.tool_policy,
      workspace_policy: existing.workspace_policy,
      memory_scope: existing.memory_scope,
    };
  }

  return {
    acp_permission_mode: existing.acp_permission_mode === 'bypass'
      ? template.acp_permission_mode
      : existing.acp_permission_mode,
    runtime_backend: existing.runtime_backend ?? template.runtime_backend,
    tool_policy: existing.tool_policy === null || isLegacyToolPolicy(existing.tool_policy)
      ? template.tool_policy
      : existing.tool_policy,
    workspace_policy: existing.workspace_policy === null || isLegacyWorkspacePolicy(existing.workspace_policy)
      ? template.workspace_policy
      : existing.workspace_policy,
    memory_scope: existing.memory_scope === null || isLegacyMemoryScope(existing.memory_scope)
      ? template.memory_scope
      : existing.memory_scope,
  };
}

function normalizeRoomAgent(row: RoomAgentRow): RoomAgent {
  const mode = row.acp_permission_mode;
  const runtime = row.default_runtime;
  const runtimeBackend = row.runtime_backend;
  const memoryScope = row.memory_scope;
  const { runtime_profile_version: _runtimeProfileVersion, ...publicRow } = row;
  return {
    ...publicRow,
    acp_permission_mode: mode && ACP_PERMISSION_MODES.has(mode as AcpPermissionMode)
      ? (mode as AcpPermissionMode)
      : 'bypass',
    acp_writable_dirs: parseStringArray(row.acp_writable_dirs),
    capabilities: parseStringArray(row.capabilities),
    default_runtime: runtime && DEFAULT_RUNTIMES.has(runtime as AgentDefaultRuntime)
      ? (runtime as AgentDefaultRuntime)
      : 'none',
    runtime_backend: runtimeBackend && RUNTIME_BACKENDS.has(runtimeBackend as AgentRuntimeBackend)
      ? (runtimeBackend as AgentRuntimeBackend)
      : null,
    tool_policy: normalizeToolPolicy(row.tool_policy),
    workspace_policy: normalizeWorkspacePolicy(row.workspace_policy),
    memory_scope: memoryScope && MEMORY_SCOPES.has(memoryScope as AgentMemoryScope)
      ? (memoryScope as AgentMemoryScope)
      : null,
  };
}

function normalizeRoomAgentWithRuntimeProfileVersion(row: RoomAgentRow): RoomAgentWithRuntimeProfileVersion {
  return {
    ...normalizeRoomAgent(row),
    runtime_profile_version: row.runtime_profile_version ?? 0,
  };
}

function getRoomAgentRuntimeProfileVersion(id: string): number {
  const row = db.prepare('SELECT runtime_profile_version FROM room_agents WHERE id = ?').get(id) as
    | { runtime_profile_version?: number | null }
    | undefined;
  return row?.runtime_profile_version ?? 0;
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

  create(input: { project_id: string; name: string; description?: string; ensureDefaultPlanner?: boolean }): Room {
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO rooms (id, project_id, name, description, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.project_id, input.name, input.description ?? null, now());
    if (input.ensureDefaultPlanner !== false) {
      roomAgentRepo.ensureDefaultPlanner(id);
    }
    return this.get(id)!;
  },

  delete(id: string): boolean {
    return db.prepare('DELETE FROM rooms WHERE id = ?').run(id).changes > 0;
  },
};

export const roomAgentRepo = {
  listByRoom(roomId: string, options: { includeRemoved?: boolean } = {}): RoomAgent[] {
    if (!options.includeRemoved && roomRepo.get(roomId)) {
      this.ensureDefaultPlanner(roomId);
      this.migrateBuiltInRuntimeProfiles(roomId);
    }
    const rows = db
      .prepare(
        `${roomAgentSelectSql()} WHERE room_agents.room_id = ?${options.includeRemoved ? '' : ' AND room_agents.left_at IS NULL'} ORDER BY room_agents.joined_at ASC`,
      )
      .all(roomId) as RoomAgentRow[];
    return rows.map(normalizeRoomAgent);
  },

  migrateBuiltInRuntimeProfiles(roomId: string): void {
    const rows = db.prepare(
      `SELECT room_agents.id, agents.id AS global_agent_id, agents.builtin_key
       FROM room_agents
       JOIN agents ON agents.id = room_agents.global_agent_id
         OR (
           room_agents.global_agent_id IS NULL
           AND agents.is_builtin = 1
           AND agents.agent_id = room_agents.agent_id
         )
       WHERE room_agents.room_id = ?
         AND room_agents.left_at IS NULL
         AND room_agents.runtime_profile_version = 0
         AND agents.builtin_key IS NOT NULL`,
    ).all(roomId) as Array<{ id: string; global_agent_id: string; builtin_key: string }>;
    for (const row of rows) {
      this.addFromGlobalAgent({ room_id: roomId, global_agent_id: row.global_agent_id });
    }
  },

  ensureDefaultPlanner(roomId: string): RoomAgent | undefined {
    if (!roomRepo.get(roomId)) return undefined;
    const planner = agentRepo.getByBuiltinKey('planner') ?? agentRepo.getByAgentId('planner');
    if (!planner) return undefined;
    const agent = this.addFromGlobalAgent({ room_id: roomId, global_agent_id: planner.id });
    return this.applyBuiltInTemplate(agent.id, 'planner') ?? agent;
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

    const existing = db.prepare(
      `SELECT id
       FROM room_agents
       WHERE room_id = ?
         AND (global_agent_id = ? OR agent_id = ?)
       ORDER BY CASE WHEN global_agent_id = ? THEN 0 ELSE 1 END, joined_at ASC
       LIMIT 1`,
    ).get(input.room_id, agent.id, agent.agent_id, agent.id) as { id: string } | undefined;
    if (existing) {
      const existingRow = db.prepare(`${roomAgentSelectSql()} WHERE room_agents.id = ?`)
        .get(existing.id) as RoomAgentRow | undefined;
      const existingRoomAgent = existingRow ? normalizeRoomAgentWithRuntimeProfileVersion(existingRow) : undefined;
      const template = agent.builtin_key ? getBuiltInAgentTemplate(agent.builtin_key) : undefined;
      const runtimeBoundary = existingRoomAgent && template
        ? resolveBuiltInRoomRuntimeBoundary(existingRoomAgent, template)
        : {
          acp_permission_mode: existingRoomAgent?.acp_permission_mode ?? agent.default_acp_permission_mode,
          runtime_backend: existingRoomAgent?.runtime_backend ?? agent.default_runtime_backend,
          tool_policy: existingRoomAgent?.tool_policy ?? agent.default_tool_policy,
          workspace_policy: existingRoomAgent?.workspace_policy ?? agent.default_workspace_policy,
          memory_scope: existingRoomAgent?.memory_scope ?? agent.default_memory_scope,
        };
      db.prepare(
        `UPDATE room_agents
         SET global_agent_id = ?, agent_name = ?, agent_role = ?, left_at = NULL,
             acp_enabled = ?, acp_backend = ?, acp_permission_mode = ?, default_runtime = ?,
             runtime_backend = ?, tool_policy = ?, workspace_policy = ?, memory_scope = ?,
             runtime_profile_version = ?
         WHERE id = ?`,
      ).run(
        agent.id,
        agent.name,
        agent.description,
        agent.default_acp_backend ? 1 : 0,
        agent.default_acp_backend,
        runtimeBoundary.acp_permission_mode,
        agent.default_acp_backend ? 'acp' : 'none',
        runtimeBoundary.runtime_backend,
        JSON.stringify(runtimeBoundary.tool_policy),
        JSON.stringify(runtimeBoundary.workspace_policy),
        runtimeBoundary.memory_scope,
        template ? BUILT_IN_RUNTIME_PROFILE_VERSION : (existingRoomAgent?.runtime_profile_version ?? 0),
        existing.id,
      );
      return this.get(existing.id)!;
    }

    const id = nanoid(12);
    db.prepare(
      `INSERT INTO room_agents (
        id, room_id, global_agent_id, agent_id, agent_name, agent_role, joined_at,
        acp_enabled, acp_backend, acp_permission_mode, default_runtime,
        runtime_backend, tool_policy, workspace_policy, memory_scope, runtime_profile_version
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      agent.default_runtime_backend,
      JSON.stringify(agent.default_tool_policy),
      JSON.stringify(agent.default_workspace_policy),
      agent.default_memory_scope,
      agent.is_builtin ? 0 : BUILT_IN_RUNTIME_PROFILE_VERSION,
    );
    const roomAgent = this.get(id)!;
    return agent.builtin_key ? this.applyBuiltInTemplate(roomAgent.id, agent.builtin_key) ?? roomAgent : roomAgent;
  },

  applyCrewTemplate(roomId: string, template: RoomCrewTemplate): RoomAgent[] {
    if (!roomRepo.get(roomId)) throw new Error('room not found');
    return template.agent_template_ids.map((templateId) => {
      const templateAgent = getBuiltInAgentTemplate(templateId);
      if (!templateAgent) throw new Error(`agent template not found: ${templateId}`);
      const globalAgent = agentRepo.createOrReuseFromRoomAgent({
        agent_id: templateAgent.id,
        agent_name: templateAgent.name,
        agent_role: templateAgent.description,
        acp_backend: templateAgent.acp_backend,
        acp_permission_mode: templateAgent.acp_permission_mode,
      });
      const agent = this.addFromGlobalAgent({
        room_id: roomId,
        global_agent_id: globalAgent.id,
      });
      return this.applyBuiltInTemplate(agent.id, templateId) ?? agent;
    });
  },

  applyBuiltInTemplate(id: string, templateId: string): RoomAgent | undefined {
    const template = getBuiltInAgentTemplate(templateId);
    if (!template) return undefined;
    const existingRow = db.prepare(`${roomAgentSelectSql()} WHERE room_agents.id = ?`).get(id) as
      | RoomAgentRow
      | undefined;
    const existing = existingRow ? normalizeRoomAgentWithRuntimeProfileVersion(existingRow) : undefined;
    if (!existing) return undefined;
    const runtimeBoundary = resolveBuiltInRoomRuntimeBoundary(existing, template);
    const withRole = this.setWorkflowRole(id, template.workflow_role) ?? existing;
    const withAcp = this.setAcp(withRole.id, {
      acp_enabled: template.acp_enabled,
      acp_backend: template.acp_backend,
      acp_session_id: withRole.acp_session_id,
      acp_session_label: withRole.acp_session_label,
      acp_permission_mode: runtimeBoundary.acp_permission_mode,
      acp_writable_dirs: withRole.acp_writable_dirs,
    }) ?? withRole;
    return this.setCapabilitiesAndRuntime(withAcp.id, {
      capabilities: template.capabilities,
      default_runtime: 'acp',
      runtime_backend: runtimeBoundary.runtime_backend,
      tool_policy: runtimeBoundary.tool_policy,
      workspace_policy: runtimeBoundary.workspace_policy,
      memory_scope: runtimeBoundary.memory_scope,
      runtime_profile_version: BUILT_IN_RUNTIME_PROFILE_VERSION,
    }) ?? withAcp;
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
    return db.prepare('UPDATE room_agents SET left_at = ? WHERE id = ? AND left_at IS NULL').run(now(), id).changes > 0;
  },

  getRemovalImpact(id: string): RoomAgentRemovalImpact {
    const activeRuns = db.prepare(
      "SELECT COUNT(*) AS count FROM agent_runs WHERE room_agent_id = ? AND status IN ('queued', 'running')",
    ).get(id) as { count: number };
    const openTasks = db.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE assigned_agent_id = ? AND status <> 'done'",
    ).get(id) as { count: number };
    const historicalRuns = db.prepare(
      'SELECT COUNT(*) AS count FROM agent_runs WHERE room_agent_id = ?',
    ).get(id) as { count: number };
    const agent = this.get(id);
    const messages = agent
      ? db.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE room_id = ? AND sender_type = 'agent' AND sender_id = ?",
      ).get(agent.room_id, agent.agent_id) as { count: number }
      : { count: 0 };
    return {
      active_run_count: activeRuns.count,
      open_task_count: openTasks.count,
      historical_run_count: historicalRuns.count,
      message_count: messages.count,
    };
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
    input: {
      capabilities: string[];
      default_runtime: AgentDefaultRuntime;
      runtime_backend?: AgentRuntimeBackend | null;
      tool_policy?: AgentToolPolicy | null;
      workspace_policy?: AgentWorkspacePolicy | null;
      memory_scope?: AgentMemoryScope | null;
      runtime_profile_version?: number;
    },
  ): RoomAgent | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    db.prepare(
      `UPDATE room_agents
       SET capabilities = ?, default_runtime = ?, runtime_backend = ?,
           tool_policy = ?, workspace_policy = ?, memory_scope = ?,
           runtime_profile_version = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify(input.capabilities),
      input.default_runtime,
      input.runtime_backend === undefined ? existing.runtime_backend : input.runtime_backend,
      input.tool_policy === undefined
        ? JSON.stringify(existing.tool_policy)
        : input.tool_policy === null
          ? null
          : JSON.stringify(input.tool_policy),
      input.workspace_policy === undefined
        ? JSON.stringify(existing.workspace_policy)
        : input.workspace_policy === null
          ? null
          : JSON.stringify(input.workspace_policy),
      input.memory_scope === undefined ? existing.memory_scope : input.memory_scope,
      input.runtime_profile_version ?? getRoomAgentRuntimeProfileVersion(id),
      id,
    );
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
