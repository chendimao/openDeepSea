import { nanoid } from 'nanoid';
import {
  DEFAULT_AGENT_MEMORY_SCOPE,
  DEFAULT_AGENT_TOOL_POLICY,
  DEFAULT_AGENT_WORKSPACE_POLICY,
  normalizeAgentToolPolicy,
  normalizeAgentWorkspacePolicy,
} from '../agent-runtime.js';
import { listBuiltInAgentTemplates } from '../agent-templates.js';
import { db, now } from '../db.js';
import type {
  AcpBackend,
  AcpPermissionMode,
  Agent,
  AgentMemoryScope,
  AgentReference,
  AgentRuntimeBackend,
  AgentToolPolicy,
  AgentWorkspacePolicy,
} from '../types.js';

const LEGACY_BUILT_IN_AGENT_NAMES: Record<string, string> = {
  planner: 'Planner',
  'backend-executor': 'Backend Executor',
  'frontend-executor': 'Frontend Executor',
  'ui-designer': 'UI Designer',
  'data-analyst': 'Data Analyst',
  'computer-assistant': 'Computer Assistant',
  'product-manager': 'Product Manager',
  'qa-tester': 'QA Tester',
  'devops-engineer': 'DevOps Engineer',
  'security-reviewer': 'Security Reviewer',
  'technical-writer': 'Technical Writer',
  reviewer: 'Reviewer',
  acceptor: 'Acceptor',
  'accounting-advisor': 'Accounting Advisor',
  'legal-assistant': 'Legal Assistant',
  'medical-assistant': 'Medical Assistant',
  'marketing-strategist': 'Marketing Strategist',
  'sales-assistant': 'Sales Assistant',
};

type AgentRow = Omit<
  Agent,
  | 'reference_count'
  | 'references'
  | 'default_acp_permission_mode'
  | 'default_runtime_backend'
  | 'default_tool_policy'
  | 'default_workspace_policy'
  | 'default_memory_scope'
> & {
  default_acp_permission_mode?: string | null;
  default_runtime_backend?: string | null;
  default_tool_policy?: string | null;
  default_workspace_policy?: string | null;
  default_memory_scope?: string | null;
  reference_count?: number;
  runtime_profile_version?: number | null;
};

type AgentWithRuntimeProfileVersion = Agent & { runtime_profile_version?: number | null };

export type AgentDeleteResult =
  | { ok: true }
  | { ok: false; reason: 'not_found'; references: [] }
  | { ok: false; reason: 'builtin'; references: [] }
  | { ok: false; reason: 'in_use'; references: AgentReference[] };

const ACP_PERMISSION_MODES = new Set<AcpPermissionMode>(['bypass', 'workspace-write', 'read-only']);
const RUNTIME_BACKENDS = new Set<AgentRuntimeBackend>(['acp', 'model', 'none']);
const MEMORY_SCOPES = new Set<AgentMemoryScope>(['project', 'room', 'agent', 'task', 'none']);
const BUILT_IN_RUNTIME_PROFILE_VERSION = 3;
const LEGACY_RUNTIME_BOUNDARY = {
  default_acp_permission_mode: 'bypass',
  default_runtime_backend: 'acp',
  default_tool_policy: DEFAULT_AGENT_TOOL_POLICY,
  default_workspace_policy: DEFAULT_AGENT_WORKSPACE_POLICY,
  default_memory_scope: DEFAULT_AGENT_MEMORY_SCOPE,
} satisfies Pick<
  Agent,
  | 'default_acp_permission_mode'
  | 'default_runtime_backend'
  | 'default_tool_policy'
  | 'default_workspace_policy'
  | 'default_memory_scope'
>;

function parseJsonObject<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeToolPolicy(value: string | null | undefined): AgentToolPolicy {
  return normalizeAgentToolPolicy(parseJsonObject<Partial<AgentToolPolicy>>(value, DEFAULT_AGENT_TOOL_POLICY));
}

function normalizeWorkspacePolicy(value: string | null | undefined): AgentWorkspacePolicy {
  return normalizeAgentWorkspacePolicy(
    parseJsonObject<Partial<AgentWorkspacePolicy>>(value, DEFAULT_AGENT_WORKSPACE_POLICY),
  );
}

function normalizeAgent(row: AgentRow): Agent {
  const permissionMode = row.default_acp_permission_mode;
  const runtimeBackend = row.default_runtime_backend;
  const memoryScope = row.default_memory_scope;
  const { runtime_profile_version: _runtimeProfileVersion, ...publicRow } = row;
  return {
    ...publicRow,
    default_acp_permission_mode:
      permissionMode && ACP_PERMISSION_MODES.has(permissionMode as AcpPermissionMode)
        ? (permissionMode as AcpPermissionMode)
        : 'bypass',
    default_runtime_backend:
      runtimeBackend && RUNTIME_BACKENDS.has(runtimeBackend as AgentRuntimeBackend)
        ? (runtimeBackend as AgentRuntimeBackend)
        : 'acp',
    default_tool_policy: normalizeToolPolicy(row.default_tool_policy),
    default_workspace_policy: normalizeWorkspacePolicy(row.default_workspace_policy),
    default_memory_scope:
      memoryScope && MEMORY_SCOPES.has(memoryScope as AgentMemoryScope)
        ? (memoryScope as AgentMemoryScope)
        : DEFAULT_AGENT_MEMORY_SCOPE,
    reference_count: row.reference_count ?? 0,
  };
}

function normalizeAgentWithRuntimeProfileVersion(row: AgentRow): AgentWithRuntimeProfileVersion {
  return {
    ...normalizeAgent(row),
    runtime_profile_version: row.runtime_profile_version ?? 0,
  };
}

function getAgentRuntimeProfileVersion(id: string): number {
  const row = db.prepare('SELECT runtime_profile_version FROM agents WHERE id = ?').get(id) as
    | { runtime_profile_version?: number | null }
    | undefined;
  return row?.runtime_profile_version ?? 0;
}

function getAgentRowByAgentId(agentId: string): AgentRow | undefined {
  return db.prepare(
    `SELECT agents.*,
            COUNT(room_agents.id) AS reference_count
     FROM agents
     LEFT JOIN room_agents ON room_agents.global_agent_id = agents.id
     WHERE agents.agent_id = ?
     GROUP BY agents.id`,
  ).get(agentId) as AgentRow | undefined;
}

function getAgentRowByBuiltinKey(builtinKey: string): AgentRow | undefined {
  return db.prepare(
    `SELECT agents.*,
            COUNT(room_agents.id) AS reference_count
     FROM agents
     LEFT JOIN room_agents ON room_agents.global_agent_id = agents.id
     WHERE agents.builtin_key = ?
     GROUP BY agents.id`,
  ).get(builtinKey) as AgentRow | undefined;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function shouldUpdateBuiltInName(agent: Agent, templateId: string): boolean {
  if (!agent.is_builtin) return true;
  return agent.name === LEGACY_BUILT_IN_AGENT_NAMES[templateId];
}

function isLegacyRuntimeBoundary(agent: Agent): boolean {
  return agent.default_acp_permission_mode === LEGACY_RUNTIME_BOUNDARY.default_acp_permission_mode
    && agent.default_runtime_backend === LEGACY_RUNTIME_BOUNDARY.default_runtime_backend
    && agent.default_memory_scope === LEGACY_RUNTIME_BOUNDARY.default_memory_scope
    && agent.default_tool_policy.allowed.length === 0
    && agent.default_workspace_policy.read.length === 0
    && agent.default_workspace_policy.write.length === 0;
}

function isLegacyToolPolicy(policy: AgentToolPolicy): boolean {
  return policy.allowed.length === 0;
}

function isLegacyWorkspacePolicy(policy: AgentWorkspacePolicy): boolean {
  return policy.read.length === 0 && policy.write.length === 0;
}

function isTechnicalWriterDefaultBoundary(agent: AgentWithRuntimeProfileVersion): boolean {
  const isReadOnlyDefault = agent.default_acp_permission_mode === 'read-only'
    && agent.default_runtime_backend === 'acp'
    && agent.default_memory_scope === 'room'
    && agent.default_tool_policy.allowed.length === 1
    && agent.default_tool_policy.allowed[0] === 'read_files'
    && agent.default_workspace_policy.read.length === 1
    && agent.default_workspace_policy.read[0] === '.'
    && agent.default_workspace_policy.write.length === 0;
  const isDocsOnlyDefault = agent.default_acp_permission_mode === 'workspace-write'
    && agent.default_runtime_backend === 'acp'
    && agent.default_memory_scope === 'agent'
    && agent.default_tool_policy.allowed.join('\n') === ['read_files', 'write_files', 'run_shell'].join('\n')
    && agent.default_workspace_policy.read.join('\n') === ['.'].join('\n')
    && agent.default_workspace_policy.write.join('\n') === ['docs'].join('\n');
  return agent.builtin_key === 'technical-writer'
    && (isReadOnlyDefault || isDocsOnlyDefault);
}

function resolveBuiltInRuntimeBoundary(
  existing: AgentWithRuntimeProfileVersion,
  template: ReturnType<typeof listBuiltInAgentTemplates>[number],
) {
  if ((existing.runtime_profile_version ?? 0) >= BUILT_IN_RUNTIME_PROFILE_VERSION) {
    return {
      default_acp_permission_mode: existing.default_acp_permission_mode,
      default_runtime_backend: existing.default_runtime_backend,
      default_tool_policy: existing.default_tool_policy,
      default_workspace_policy: existing.default_workspace_policy,
      default_memory_scope: existing.default_memory_scope,
    };
  }

  const shouldRefreshAll = isLegacyRuntimeBoundary(existing);
  const shouldUpgradeTechnicalWriter = isTechnicalWriterDefaultBoundary(existing);
  const shouldRefreshPermission = shouldRefreshAll || shouldUpgradeTechnicalWriter;
  const shouldRefreshRuntimeBackend = existing.default_runtime_backend === LEGACY_RUNTIME_BOUNDARY.default_runtime_backend;
  const shouldRefreshToolPolicy = isLegacyToolPolicy(existing.default_tool_policy) || shouldUpgradeTechnicalWriter;
  const shouldRefreshWorkspacePolicy = isLegacyWorkspacePolicy(existing.default_workspace_policy) || shouldUpgradeTechnicalWriter;
  const shouldRefreshMemoryScope = existing.default_memory_scope === LEGACY_RUNTIME_BOUNDARY.default_memory_scope
    || shouldUpgradeTechnicalWriter;

  return {
    default_acp_permission_mode: shouldRefreshAll || shouldRefreshPermission
      ? template.acp_permission_mode
      : existing.default_acp_permission_mode,
    default_runtime_backend: shouldRefreshAll || shouldRefreshRuntimeBackend
      ? template.runtime_backend
      : existing.default_runtime_backend,
    default_tool_policy: shouldRefreshAll || shouldRefreshToolPolicy
      ? template.tool_policy
      : existing.default_tool_policy,
    default_workspace_policy: shouldRefreshAll || shouldRefreshWorkspacePolicy
      ? template.workspace_policy
      : existing.default_workspace_policy,
    default_memory_scope: shouldRefreshAll || shouldRefreshMemoryScope
      ? template.memory_scope
      : existing.default_memory_scope,
  };
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
    const row = getAgentRowByAgentId(agentId);
    if (!row) return undefined;
    return {
      ...normalizeAgent(row),
      references: this.getReferences(row.id),
    };
  },

  getByBuiltinKey(builtinKey: string): Agent | undefined {
    const row = getAgentRowByBuiltinKey(builtinKey);
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
    default_runtime_backend?: AgentRuntimeBackend | null;
    default_tool_policy?: AgentToolPolicy | null;
    default_workspace_policy?: AgentWorkspacePolicy | null;
    default_memory_scope?: AgentMemoryScope | null;
    is_builtin?: boolean;
    builtin_key?: string | null;
  }): Agent {
    const id = nanoid(12);
    const ts = now();
    db.prepare(
      `INSERT INTO agents (
        id, agent_id, name, description, preferred_user_name, personality, rules,
        responsibilities, default_acp_backend, default_acp_permission_mode,
        default_runtime_backend, default_tool_policy, default_workspace_policy, default_memory_scope,
        is_builtin, builtin_key, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.default_runtime_backend ?? 'acp',
      JSON.stringify(input.default_tool_policy ?? DEFAULT_AGENT_TOOL_POLICY),
      JSON.stringify(input.default_workspace_policy ?? DEFAULT_AGENT_WORKSPACE_POLICY),
      input.default_memory_scope ?? DEFAULT_AGENT_MEMORY_SCOPE,
      input.is_builtin ? 1 : 0,
      trimmedOrNull(input.builtin_key),
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
      default_runtime_backend: AgentRuntimeBackend | null;
      default_tool_policy: AgentToolPolicy | null;
      default_workspace_policy: AgentWorkspacePolicy | null;
      default_memory_scope: AgentMemoryScope | null;
    }>,
  ): Agent | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const nextAgentId = patch.agent_id === undefined ? existing.agent_id : patch.agent_id.trim();
    if (existing.is_builtin && nextAgentId !== existing.agent_id) {
      throw new Error('builtin agent id cannot be changed');
    }

    db.prepare(
      `UPDATE agents
       SET agent_id = ?, name = ?, description = ?, preferred_user_name = ?,
           personality = ?, rules = ?, responsibilities = ?,
           default_acp_backend = ?, default_acp_permission_mode = ?,
           default_runtime_backend = ?, default_tool_policy = ?, default_workspace_policy = ?,
           default_memory_scope = ?, runtime_profile_version = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      nextAgentId,
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
      patch.default_runtime_backend === undefined
        ? existing.default_runtime_backend
        : patch.default_runtime_backend ?? 'acp',
      JSON.stringify(
        patch.default_tool_policy === undefined
          ? existing.default_tool_policy
          : patch.default_tool_policy ?? DEFAULT_AGENT_TOOL_POLICY,
      ),
      JSON.stringify(
        patch.default_workspace_policy === undefined
          ? existing.default_workspace_policy
          : patch.default_workspace_policy ?? DEFAULT_AGENT_WORKSPACE_POLICY,
      ),
      patch.default_memory_scope === undefined
        ? existing.default_memory_scope
        : patch.default_memory_scope ?? DEFAULT_AGENT_MEMORY_SCOPE,
      getAgentRuntimeProfileVersion(existing.id),
      now(),
      id,
    );
    return this.get(id);
  },

  delete(id: string): AgentDeleteResult {
    const existing = this.get(id);
    if (!existing) return { ok: false, reason: 'not_found', references: [] };
    if (existing.is_builtin) return { ok: false, reason: 'builtin', references: [] };

    const references = this.getReferences(id);
    if (references.length > 0) return { ok: false, reason: 'in_use', references };

    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    return { ok: true };
  },

  getReferences(id: string): AgentReference[] {
    return db.prepare(
      `SELECT rooms.id AS room_id, rooms.name AS room_name,
              CASE WHEN MAX(CASE WHEN room_agents.left_at IS NULL THEN 1 ELSE 0 END) = 1 THEN 1 ELSE 0 END AS active
       FROM room_agents
       JOIN rooms ON rooms.id = room_agents.room_id
       WHERE room_agents.global_agent_id = ?
       GROUP BY rooms.id, rooms.name
       ORDER BY rooms.created_at DESC`,
    ).all(id) as AgentReference[];
  },

  ensureBuiltInAgents(): void {
    const ts = now();
    const insert = db.prepare(
      `INSERT INTO agents (
        id, agent_id, name, description, preferred_user_name, personality, rules,
        responsibilities, default_acp_backend, default_acp_permission_mode,
        default_runtime_backend, default_tool_policy, default_workspace_policy, default_memory_scope,
        runtime_profile_version, is_builtin, builtin_key, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    const markExisting = db.prepare(
      `UPDATE agents
       SET is_builtin = 1,
           builtin_key = ?,
           name = ?,
           description = COALESCE(description, ?),
           preferred_user_name = COALESCE(preferred_user_name, ?),
           personality = COALESCE(personality, ?),
           rules = COALESCE(rules, ?),
           responsibilities = COALESCE(responsibilities, ?),
           default_acp_backend = COALESCE(default_acp_backend, ?),
           default_acp_permission_mode = ?,
           default_runtime_backend = ?,
           default_tool_policy = ?,
           default_workspace_policy = ?,
           default_memory_scope = ?,
           runtime_profile_version = ?,
           updated_at = ?
       WHERE id = ?`,
    );
    const transaction = db.transaction(() => {
      for (const template of listBuiltInAgentTemplates()) {
        const existingRow = getAgentRowByBuiltinKey(template.id) ?? getAgentRowByAgentId(template.id);
        const existing = existingRow ? normalizeAgentWithRuntimeProfileVersion(existingRow) : undefined;
        if (existing) {
          const runtimeBoundary = resolveBuiltInRuntimeBoundary(existing, template);
          markExisting.run(
            template.id,
            shouldUpdateBuiltInName(existing, template.id) ? template.name : existing.name,
            template.description,
            template.preferred_user_name,
            template.personality,
            template.rules,
            template.responsibilities,
            template.acp_backend,
            runtimeBoundary.default_acp_permission_mode,
            runtimeBoundary.default_runtime_backend,
            JSON.stringify(runtimeBoundary.default_tool_policy),
            JSON.stringify(runtimeBoundary.default_workspace_policy),
            runtimeBoundary.default_memory_scope,
            BUILT_IN_RUNTIME_PROFILE_VERSION,
            ts,
            existing.id,
          );
          continue;
        }
        insert.run(
          nanoid(12),
          template.id,
          template.name,
          template.description,
          template.preferred_user_name,
          template.personality,
          template.rules,
          template.responsibilities,
          template.acp_backend,
          template.acp_permission_mode,
          template.runtime_backend,
          JSON.stringify(template.tool_policy),
          JSON.stringify(template.workspace_policy),
          template.memory_scope,
          BUILT_IN_RUNTIME_PROFILE_VERSION,
          template.id,
          ts,
          ts,
        );
      }
    });
    transaction();
  },

  restoreBuiltInDefaults(id: string): Agent | undefined {
    const existing = this.get(id);
    if (!existing?.is_builtin || !existing.builtin_key) return undefined;
    const template = listBuiltInAgentTemplates().find((item) => item.id === existing.builtin_key);
    if (!template) return undefined;

    db.prepare(
      `UPDATE agents
       SET agent_id = ?, name = ?, description = ?, preferred_user_name = ?,
           personality = ?, rules = ?, responsibilities = ?,
           default_acp_backend = ?, default_acp_permission_mode = ?,
           default_runtime_backend = ?, default_tool_policy = ?, default_workspace_policy = ?,
           default_memory_scope = ?, runtime_profile_version = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      template.id,
      template.name,
      template.description,
      template.preferred_user_name,
      template.personality,
      template.rules,
      template.responsibilities,
      template.acp_backend,
      template.acp_permission_mode,
      template.runtime_backend,
      JSON.stringify(template.tool_policy),
      JSON.stringify(template.workspace_policy),
      template.memory_scope,
      BUILT_IN_RUNTIME_PROFILE_VERSION,
      now(),
      id,
    );
    return this.get(id);
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

agentRepo.ensureBuiltInAgents();
