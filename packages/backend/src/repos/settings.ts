import { db, now } from '../db.js';
import type {
  AiConfig,
  EffectiveSettings,
  LangChainPlannerSettings,
  MessageRoutingMode,
  ScopedSettings,
  SettingsResolution,
  SettingsScope,
  SuperpowersBootstrapOwner,
  SystemSettings,
  TaskInteractionMode,
} from '../types.js';
import { projectRepo } from './projects.js';
import { roomRepo } from './rooms.js';
import { workflowDefinitionRepo } from './workflow-definitions.js';

const SYSTEM_SCOPE_ID = 'default';
const DEFAULT_FALLBACK_AGENT_ID = 'planner';

const DEFAULT_SETTINGS: EffectiveSettings = {
  message_routing_mode: 'fallback_reply',
  fallback_agent_id: DEFAULT_FALLBACK_AGENT_ID,
  interaction_mode: 'ask_user',
  auto_distill_enabled: true,
  default_workflow_definition_id: null,
  superpowers_bootstrap_owner: 'project',
};

interface SystemSettingsRow extends ScopedSettings {
  langchain_planner_model: string | null;
  openai_api_key: string | null;
  openai_base_url: string | null;
  active_ai_config_id: string | null;
}

interface AiConfigRow {
  id: string;
  name: string;
  langchain_planner_model: string;
  openai_api_key: string | null;
  openai_base_url: string;
  created_at: number;
  updated_at: number;
}

function emptyScoped(scope: SettingsScope, scopeId: string): ScopedSettings {
  return {
    scope,
    scope_id: scopeId,
    message_routing_mode: null,
    fallback_agent_id: null,
    interaction_mode: null,
    auto_distill_enabled: null,
    default_workflow_definition_id: null,
    superpowers_bootstrap_owner: null,
    updated_at: 0,
  };
}

function getScoped(scope: SettingsScope, scopeId: string): ScopedSettings | null {
  return db
    .prepare(
      `SELECT
        scope,
        scope_id,
        message_routing_mode,
        fallback_agent_id,
        interaction_mode,
        auto_distill_enabled,
        default_workflow_definition_id,
        superpowers_bootstrap_owner,
        updated_at
      FROM settings
      WHERE scope = ? AND scope_id = ?`,
    )
    .get(scope, scopeId) as ScopedSettings | undefined ?? null;
}

function getSystemRow(): SystemSettingsRow | null {
  return db
    .prepare(
      `SELECT
        scope,
        scope_id,
        message_routing_mode,
        fallback_agent_id,
        interaction_mode,
        auto_distill_enabled,
        default_workflow_definition_id,
        superpowers_bootstrap_owner,
        langchain_planner_model,
        openai_api_key,
        openai_base_url,
        active_ai_config_id,
        updated_at
      FROM settings
      WHERE scope = 'system' AND scope_id = ?`,
    )
    .get(SYSTEM_SCOPE_ID) as SystemSettingsRow | undefined ?? null;
}

function upsertScoped(
  scope: SettingsScope,
  scopeId: string,
  patch: {
    message_routing_mode?: MessageRoutingMode | null;
    fallback_agent_id?: string | null;
    interaction_mode?: TaskInteractionMode | null;
    auto_distill_enabled?: boolean | null;
    default_workflow_definition_id?: string | null;
    superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
  },
): ScopedSettings {
  const existing = getScoped(scope, scopeId) ?? emptyScoped(scope, scopeId);
  const routingMode =
    patch.message_routing_mode === undefined ? existing.message_routing_mode : patch.message_routing_mode;
  const interactionMode =
    patch.interaction_mode === undefined ? existing.interaction_mode : patch.interaction_mode;
  const autoDistillEnabled =
    patch.auto_distill_enabled === undefined
      ? existing.auto_distill_enabled
      : patch.auto_distill_enabled === null
        ? null
        : patch.auto_distill_enabled
          ? 1
          : 0;
  const defaultWorkflowDefinitionId =
    patch.default_workflow_definition_id === undefined
      ? existing.default_workflow_definition_id
      : validateDefaultWorkflowDefinition(scope, scopeId, patch.default_workflow_definition_id);
  const superpowersBootstrapOwner =
    patch.superpowers_bootstrap_owner === undefined
      ? existing.superpowers_bootstrap_owner
      : normalizeSuperpowersBootstrapOwner(patch.superpowers_bootstrap_owner);
  const rawFallbackAgentId = patch.fallback_agent_id === undefined
    ? existing.fallback_agent_id
    : patch.fallback_agent_id;
  const fallbackAgentId = normalizeFallbackAgentId(routingMode, rawFallbackAgentId);
  const updatedAt = now();

  db.prepare(
    `INSERT INTO settings (
      scope, scope_id, message_routing_mode, fallback_agent_id, interaction_mode, auto_distill_enabled,
      default_workflow_definition_id, superpowers_bootstrap_owner, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_id) DO UPDATE SET
       message_routing_mode = excluded.message_routing_mode,
       fallback_agent_id = excluded.fallback_agent_id,
       interaction_mode = excluded.interaction_mode,
       auto_distill_enabled = excluded.auto_distill_enabled,
       default_workflow_definition_id = excluded.default_workflow_definition_id,
       superpowers_bootstrap_owner = excluded.superpowers_bootstrap_owner,
       updated_at = excluded.updated_at`,
  ).run(
    scope,
    scopeId,
    routingMode,
    fallbackAgentId,
    interactionMode,
    autoDistillEnabled,
    defaultWorkflowDefinitionId,
    superpowersBootstrapOwner,
    updatedAt,
  );
  return getScoped(scope, scopeId)!;
}

function apiKeyPreview(apiKey: string | null | undefined): string | null {
  const trimmed = apiKey?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('sk-') ? `sk-...${trimmed.slice(-4)}` : `...${trimmed.slice(-4)}`;
}

function toSafeAiConfig(row: AiConfigRow): AiConfig {
  const apiKey = normalizedOptionalString(row.openai_api_key);
  return {
    id: row.id,
    name: row.name,
    langchain_planner_model: row.langchain_planner_model,
    openai_base_url: row.openai_base_url,
    openai_api_key_set: Boolean(apiKey),
    openai_api_key_preview: apiKeyPreview(apiKey),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listAiConfigRows(): AiConfigRow[] {
  return db
    .prepare(
      `SELECT id, name, langchain_planner_model, openai_api_key, openai_base_url, created_at, updated_at
       FROM ai_configs
       ORDER BY updated_at DESC, created_at DESC, id DESC`,
    )
    .all() as AiConfigRow[];
}

function getAiConfigRow(id: string | null | undefined): AiConfigRow | null {
  const normalizedId = normalizedOptionalString(id);
  if (!normalizedId) return null;
  return db
    .prepare(
      `SELECT id, name, langchain_planner_model, openai_api_key, openai_base_url, created_at, updated_at
       FROM ai_configs
       WHERE id = ?`,
    )
    .get(normalizedId) as AiConfigRow | undefined ?? null;
}

function setActiveAiConfigId(id: string | null): void {
  const existing = getSystemRow();
  const updatedAt = now();
  db.prepare(
    `INSERT INTO settings (
      scope,
      scope_id,
      message_routing_mode,
      fallback_agent_id,
      interaction_mode,
      auto_distill_enabled,
      default_workflow_definition_id,
      langchain_planner_model,
      openai_api_key,
      openai_base_url,
      active_ai_config_id,
      superpowers_bootstrap_owner,
      updated_at
    )
     VALUES ('system', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_id) DO UPDATE SET
       message_routing_mode = excluded.message_routing_mode,
       fallback_agent_id = excluded.fallback_agent_id,
       interaction_mode = excluded.interaction_mode,
       auto_distill_enabled = excluded.auto_distill_enabled,
       default_workflow_definition_id = excluded.default_workflow_definition_id,
       langchain_planner_model = excluded.langchain_planner_model,
       openai_api_key = excluded.openai_api_key,
       openai_base_url = excluded.openai_base_url,
       active_ai_config_id = excluded.active_ai_config_id,
       superpowers_bootstrap_owner = excluded.superpowers_bootstrap_owner,
       updated_at = excluded.updated_at`,
  ).run(
    SYSTEM_SCOPE_ID,
    existing?.message_routing_mode ?? null,
    existing?.fallback_agent_id ?? null,
    existing?.interaction_mode ?? null,
    existing?.auto_distill_enabled ?? null,
    existing?.default_workflow_definition_id ?? null,
    existing?.langchain_planner_model ?? null,
    existing?.openai_api_key ?? null,
    existing?.openai_base_url ?? null,
    id,
    normalizeSuperpowersBootstrapOwner(existing?.superpowers_bootstrap_owner),
    updatedAt,
  );
}

function resolveActiveAiConfig(settings: SystemSettingsRow | null, rows = listAiConfigRows()): AiConfigRow | null {
  if (settings?.active_ai_config_id) {
    const active = rows.find((row) => row.id === settings.active_ai_config_id);
    if (active) return active;
    const fallback = rows[0] ?? null;
    setActiveAiConfigId(fallback?.id ?? null);
    return fallback;
  }
  return null;
}

function normalizedOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeSuperpowersBootstrapOwner(
  value: SuperpowersBootstrapOwner | string | null | undefined,
): SuperpowersBootstrapOwner | null {
  if (value === 'project' || value === 'provider' || value === 'disabled') return value;
  return null;
}

function validateDefaultWorkflowDefinition(
  scope: SettingsScope,
  scopeId: string,
  workflowDefinitionId: string | null | undefined,
): string | null {
  const id = normalizedOptionalString(workflowDefinitionId);
  if (!id) return null;
  const definition = workflowDefinitionRepo.get(id);
  if (!definition) throw new Error('default workflow definition not found');
  if (definition.status !== 'published') throw new Error('default workflow definition must be published');

  if (scope === 'system' && !workflowDefinitionRepo.isVisibleForSystem(id)) {
    throw new Error('default workflow definition is not visible for system settings');
  }
  if (scope === 'project' && !workflowDefinitionRepo.isVisibleForProject(id, scopeId)) {
    throw new Error('default workflow definition is not visible for project settings');
  }
  if (scope === 'room' && !workflowDefinitionRepo.isVisibleForRoom(id, scopeId)) {
    throw new Error('default workflow definition is not visible for room settings');
  }
  return id;
}

function normalizeFallbackAgentId(mode: MessageRoutingMode | null, fallbackAgentId: string | null | undefined): string | null {
  if (mode === null || mode === 'mentions_only') return null;
  return normalizedOptionalString(fallbackAgentId) ?? DEFAULT_FALLBACK_AGENT_ID;
}

function normalizeLegacyRouting(): void {
  db.exec(`
    UPDATE projects
    SET message_routing_mode = 'fallback_reply',
        fallback_agent_id = COALESCE(NULLIF(TRIM(fallback_agent_id), ''), 'planner')
    WHERE message_routing_mode = 'fallback_route'
       OR (message_routing_mode = 'fallback_reply' AND (fallback_agent_id IS NULL OR TRIM(fallback_agent_id) = ''));

    UPDATE settings
    SET message_routing_mode = 'fallback_reply',
        fallback_agent_id = COALESCE(NULLIF(TRIM(fallback_agent_id), ''), 'planner')
    WHERE message_routing_mode = 'fallback_route'
       OR (message_routing_mode = 'fallback_reply' AND (fallback_agent_id IS NULL OR TRIM(fallback_agent_id) = ''));
  `);
}

function normalizeSystem(settings: SystemSettingsRow | null): SystemSettings {
  const aiConfigRows = listAiConfigRows();
  const activeAiConfig = resolveActiveAiConfig(settings, aiConfigRows);
  const openaiApiKey = normalizedOptionalString(activeAiConfig?.openai_api_key ?? settings?.openai_api_key);
  const openaiApiKeyPreview = apiKeyPreview(openaiApiKey);
  const routingMode = settings?.message_routing_mode ?? DEFAULT_SETTINGS.message_routing_mode;
  const defaultWorkflowDefinitionId = workflowDefinitionRepo.getSuperpowersDefinition().id;
  const superpowersBootstrapOwner =
    normalizeSuperpowersBootstrapOwner(settings?.superpowers_bootstrap_owner)
    ?? DEFAULT_SETTINGS.superpowers_bootstrap_owner;
  return {
    message_routing_mode: routingMode,
    fallback_agent_id: normalizeFallbackAgentId(routingMode, settings?.fallback_agent_id),
    interaction_mode: settings?.interaction_mode ?? DEFAULT_SETTINGS.interaction_mode,
    auto_distill_enabled: settings?.auto_distill_enabled === null || settings?.auto_distill_enabled === undefined
      ? DEFAULT_SETTINGS.auto_distill_enabled
      : Boolean(settings.auto_distill_enabled),
    default_workflow_definition_id: defaultWorkflowDefinitionId,
    superpowers_bootstrap_owner: superpowersBootstrapOwner,
    active_ai_config_id: activeAiConfig?.id ?? null,
    ai_configs: aiConfigRows.map(toSafeAiConfig),
    langchain_planner_model: normalizedOptionalString(activeAiConfig?.langchain_planner_model ?? settings?.langchain_planner_model),
    openai_base_url: normalizedOptionalString(activeAiConfig?.openai_base_url ?? settings?.openai_base_url),
    openai_api_key_set: Boolean(openaiApiKey),
    openai_api_key_preview: openaiApiKeyPreview,
  };
}

function generateAiConfigId(): string {
  return `ai-config-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeAiConfigInput(input: {
  name?: string | null;
  langchain_planner_model?: string | null;
  openai_base_url?: string | null;
}): {
  name?: string | null;
  langchain_planner_model?: string | null;
  openai_base_url?: string | null;
} {
  const name = input.name === undefined ? undefined : normalizedOptionalString(input.name);
  const model = input.langchain_planner_model === undefined
    ? undefined
    : normalizedOptionalString(input.langchain_planner_model);
  const baseUrl = input.openai_base_url === undefined
    ? undefined
    : normalizedOptionalString(input.openai_base_url);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(model !== undefined ? { langchain_planner_model: model } : {}),
    ...(baseUrl !== undefined ? { openai_base_url: baseUrl } : {}),
  };
}

function requireAiConfigString(value: string | null | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}

export const settingsRepo = {
  getSystem(): SystemSettings {
    normalizeLegacyRouting();
    return normalizeSystem(getSystemRow());
  },

  updateSystem(patch: {
    message_routing_mode?: MessageRoutingMode;
    fallback_agent_id?: string | null;
    interaction_mode?: TaskInteractionMode;
    auto_distill_enabled?: boolean;
    default_workflow_definition_id?: string | null;
    langchain_planner_model?: string | null;
    openai_api_key?: string | null;
    openai_base_url?: string | null;
    superpowers_bootstrap_owner?: SuperpowersBootstrapOwner;
  }): SystemSettings {
    normalizeLegacyRouting();
    const existing = getSystemRow();
    const routingMode =
      patch.message_routing_mode === undefined ? existing?.message_routing_mode ?? null : patch.message_routing_mode;
    const interactionMode =
      patch.interaction_mode === undefined ? existing?.interaction_mode ?? null : patch.interaction_mode;
    const autoDistillEnabled =
      patch.auto_distill_enabled === undefined
        ? existing?.auto_distill_enabled ?? null
        : patch.auto_distill_enabled
          ? 1
          : 0;
    const defaultWorkflowDefinitionId = patch.default_workflow_definition_id === undefined
      ? normalizedOptionalString(existing?.default_workflow_definition_id)
      : validateDefaultWorkflowDefinition('system', SYSTEM_SCOPE_ID, patch.default_workflow_definition_id);
    const rawFallbackAgentId = patch.fallback_agent_id === undefined
      ? existing?.fallback_agent_id ?? null
      : patch.fallback_agent_id;
    const fallbackAgentId = normalizeFallbackAgentId(routingMode as MessageRoutingMode | null, rawFallbackAgentId);
    const plannerModel =
      patch.langchain_planner_model === undefined
        ? normalizedOptionalString(existing?.langchain_planner_model)
        : normalizedOptionalString(patch.langchain_planner_model);
    const openaiApiKey =
      patch.openai_api_key === undefined
        ? normalizedOptionalString(existing?.openai_api_key)
        : normalizedOptionalString(patch.openai_api_key);
    const openaiBaseUrl =
      patch.openai_base_url === undefined
        ? normalizedOptionalString(existing?.openai_base_url)
        : normalizedOptionalString(patch.openai_base_url);
    const superpowersBootstrapOwner =
      patch.superpowers_bootstrap_owner === undefined
        ? normalizeSuperpowersBootstrapOwner(existing?.superpowers_bootstrap_owner)
        : normalizeSuperpowersBootstrapOwner(patch.superpowers_bootstrap_owner);
    const shouldClearActiveAiConfig =
      patch.langchain_planner_model !== undefined ||
      patch.openai_api_key !== undefined ||
      patch.openai_base_url !== undefined;
    const updatedAt = now();

    db.prepare(
      `INSERT INTO settings (
        scope,
        scope_id,
        message_routing_mode,
        fallback_agent_id,
        interaction_mode,
        auto_distill_enabled,
        default_workflow_definition_id,
        langchain_planner_model,
        openai_api_key,
        openai_base_url,
        active_ai_config_id,
        superpowers_bootstrap_owner,
        updated_at
      )
       VALUES ('system', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id) DO UPDATE SET
         message_routing_mode = excluded.message_routing_mode,
         fallback_agent_id = excluded.fallback_agent_id,
         interaction_mode = excluded.interaction_mode,
         auto_distill_enabled = excluded.auto_distill_enabled,
         default_workflow_definition_id = excluded.default_workflow_definition_id,
         langchain_planner_model = excluded.langchain_planner_model,
         openai_api_key = excluded.openai_api_key,
         openai_base_url = excluded.openai_base_url,
         active_ai_config_id = excluded.active_ai_config_id,
         superpowers_bootstrap_owner = excluded.superpowers_bootstrap_owner,
         updated_at = excluded.updated_at`,
    ).run(
      SYSTEM_SCOPE_ID,
      routingMode,
      fallbackAgentId,
      interactionMode,
      autoDistillEnabled,
      defaultWorkflowDefinitionId,
      plannerModel,
      openaiApiKey,
      openaiBaseUrl,
      shouldClearActiveAiConfig ? null : existing?.active_ai_config_id ?? null,
      superpowersBootstrapOwner ?? DEFAULT_SETTINGS.superpowers_bootstrap_owner,
      updatedAt,
    );

    return normalizeSystem(getSystemRow());
  },

  getLangChainPlannerSettings(): LangChainPlannerSettings {
    normalizeLegacyRouting();
    const settings = getSystemRow();
    const activeAiConfig = resolveActiveAiConfig(settings);
    if (activeAiConfig) {
      return {
        langchain_planner_model: normalizedOptionalString(activeAiConfig.langchain_planner_model),
        openai_api_key: normalizedOptionalString(activeAiConfig.openai_api_key),
        openai_base_url: normalizedOptionalString(activeAiConfig.openai_base_url),
      };
    }
    return {
      langchain_planner_model: normalizedOptionalString(settings?.langchain_planner_model),
      openai_api_key: normalizedOptionalString(settings?.openai_api_key),
      openai_base_url: normalizedOptionalString(settings?.openai_base_url),
    };
  },

  listAiConfigs(): AiConfig[] {
    return listAiConfigRows().map(toSafeAiConfig);
  },

  getAiConfig(id: string): AiConfig | null {
    const row = getAiConfigRow(id);
    return row ? toSafeAiConfig(row) : null;
  },

  createAiConfig(input: {
    name: string;
    langchain_planner_model: string;
    openai_base_url: string;
    openai_api_key?: string | null;
    activate?: boolean;
  }): AiConfig {
    const normalized = normalizeAiConfigInput(input);
    const id = generateAiConfigId();
    const createdAt = now();
    const apiKey = normalizedOptionalString(input.openai_api_key);
    db.prepare(
      `INSERT INTO ai_configs (
        id, name, langchain_planner_model, openai_api_key, openai_base_url, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      requireAiConfigString(normalized.name, 'name'),
      requireAiConfigString(normalized.langchain_planner_model, 'langchain_planner_model'),
      apiKey,
      requireAiConfigString(normalized.openai_base_url, 'openai_base_url'),
      createdAt,
      createdAt,
    );
    const row = getAiConfigRow(id)!;
    if (input.activate) {
      setActiveAiConfigId(id);
    }
    return toSafeAiConfig(row);
  },

  updateAiConfig(
    id: string,
    patch: {
      name?: string | null;
      langchain_planner_model?: string | null;
      openai_base_url?: string | null;
      openai_api_key?: string | null;
      activate?: boolean;
    },
  ): AiConfig | null {
    const existing = getAiConfigRow(id);
    if (!existing) return null;
    const normalized = normalizeAiConfigInput(patch);
    const updatedAt = now();
    const apiKey = patch.openai_api_key === undefined
      ? normalizedOptionalString(existing.openai_api_key)
      : normalizedOptionalString(patch.openai_api_key);
    db.prepare(
      `UPDATE ai_configs
       SET name = ?,
           langchain_planner_model = ?,
           openai_api_key = ?,
           openai_base_url = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      requireAiConfigString(normalized.name ?? existing.name, 'name'),
      requireAiConfigString(
        normalized.langchain_planner_model ?? existing.langchain_planner_model,
        'langchain_planner_model',
      ),
      apiKey,
      requireAiConfigString(normalized.openai_base_url ?? existing.openai_base_url, 'openai_base_url'),
      updatedAt,
      id,
    );
    if (patch.activate) {
      setActiveAiConfigId(id);
    }
    return toSafeAiConfig(getAiConfigRow(id)!);
  },

  setActiveAiConfig(id: string): AiConfig | null {
    const row = getAiConfigRow(id);
    if (!row) return null;
    setActiveAiConfigId(row.id);
    return toSafeAiConfig(row);
  },

  deleteAiConfig(id: string): boolean {
    const existing = getAiConfigRow(id);
    if (!existing) return false;
    const wasActive = getSystemRow()?.active_ai_config_id === id;
    db.prepare('DELETE FROM ai_configs WHERE id = ?').run(id);
    if (wasActive) {
      const fallback = listAiConfigRows()[0] ?? null;
      setActiveAiConfigId(fallback?.id ?? null);
      if (!fallback) {
        this.updateSystem({
          langchain_planner_model: null,
          openai_api_key: null,
          openai_base_url: null,
        });
      }
    }
    return true;
  },

  getProject(projectId: string): ScopedSettings | null {
    normalizeLegacyRouting();
    return getScoped('project', projectId);
  },

  updateProject(
    projectId: string,
    patch: {
      message_routing_mode?: MessageRoutingMode | null;
      fallback_agent_id?: string | null;
      interaction_mode?: TaskInteractionMode | null;
      auto_distill_enabled?: boolean | null;
      default_workflow_definition_id?: string | null;
      superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
    },
  ): ScopedSettings | null {
    normalizeLegacyRouting();
    if (!projectRepo.get(projectId)) return null;
    return upsertScoped('project', projectId, patch);
  },

  getRoom(roomId: string): ScopedSettings | null {
    normalizeLegacyRouting();
    return getScoped('room', roomId);
  },

  updateRoom(
    roomId: string,
    patch: {
      message_routing_mode?: MessageRoutingMode | null;
      fallback_agent_id?: string | null;
      interaction_mode?: TaskInteractionMode | null;
      auto_distill_enabled?: boolean | null;
      default_workflow_definition_id?: string | null;
      superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
    },
  ): ScopedSettings | null {
    normalizeLegacyRouting();
    if (!roomRepo.get(roomId)) return null;
    return upsertScoped('room', roomId, patch);
  },

  resolveForProject(projectId: string): SettingsResolution | null {
    normalizeLegacyRouting();
    if (!projectRepo.get(projectId)) return null;
    const system = this.getSystem();
    const project = getScoped('project', projectId);
    const messageRoutingSource: SettingsScope = project?.message_routing_mode ? 'project' : 'system';
    const interactionSource: SettingsScope = project?.interaction_mode ? 'project' : 'system';
    const autoDistillSource: SettingsScope = project?.auto_distill_enabled === null || project?.auto_distill_enabled === undefined
      ? 'system'
      : 'project';
    const workflowSource: SettingsScope = 'system';
    const projectSuperpowersBootstrapOwner = normalizeSuperpowersBootstrapOwner(project?.superpowers_bootstrap_owner);
    const superpowersBootstrapOwner = projectSuperpowersBootstrapOwner ?? system.superpowers_bootstrap_owner;
    const superpowersBootstrapOwnerSource: SettingsScope = projectSuperpowersBootstrapOwner ? 'project' : 'system';
    const defaultWorkflowDefinitionId = workflowDefinitionRepo.getSuperpowersDefinition().id;
    return {
      system,
      project,
      room: null,
      effective: {
        message_routing_mode: project?.message_routing_mode ?? system.message_routing_mode,
        fallback_agent_id: project?.message_routing_mode
          ? normalizeFallbackAgentId(project.message_routing_mode, project.fallback_agent_id)
          : system.fallback_agent_id,
        interaction_mode: project?.interaction_mode ?? system.interaction_mode,
        auto_distill_enabled: project?.auto_distill_enabled === null || project?.auto_distill_enabled === undefined
          ? system.auto_distill_enabled
          : Boolean(project.auto_distill_enabled),
        default_workflow_definition_id: defaultWorkflowDefinitionId,
        superpowers_bootstrap_owner: superpowersBootstrapOwner,
      },
      sources: {
        message_routing: messageRoutingSource,
        interaction_mode: interactionSource,
        auto_distill: autoDistillSource,
        default_workflow_definition: workflowSource,
        superpowers_bootstrap_owner: superpowersBootstrapOwnerSource,
      },
    };
  },

  resolveForRoom(roomId: string): SettingsResolution | null {
    normalizeLegacyRouting();
    const room = roomRepo.get(roomId);
    if (!room) return null;
    const projectResolution = this.resolveForProject(room.project_id);
    if (!projectResolution) return null;
    const roomSettings = getScoped('room', roomId);
    const messageRoutingSource: SettingsScope = roomSettings?.message_routing_mode
      ? 'room'
      : projectResolution.sources.message_routing;
    const interactionSource: SettingsScope = roomSettings?.interaction_mode
      ? 'room'
      : projectResolution.sources.interaction_mode;
    const autoDistillSource: SettingsScope =
      roomSettings?.auto_distill_enabled === null || roomSettings?.auto_distill_enabled === undefined
        ? projectResolution.sources.auto_distill
        : 'room';
    const workflowSource: SettingsScope = 'system';
    const roomSuperpowersBootstrapOwner = normalizeSuperpowersBootstrapOwner(roomSettings?.superpowers_bootstrap_owner);
    const superpowersBootstrapOwner = roomSuperpowersBootstrapOwner
      ?? projectResolution.effective.superpowers_bootstrap_owner;
    const superpowersBootstrapOwnerSource: SettingsScope = roomSuperpowersBootstrapOwner
      ? 'room'
      : projectResolution.sources.superpowers_bootstrap_owner;
    const defaultWorkflowDefinitionId = workflowDefinitionRepo.getSuperpowersDefinition().id;
    const inheritedRoutingMode = projectResolution.effective.message_routing_mode;
    return {
      ...projectResolution,
      room: roomSettings,
      effective: {
        message_routing_mode: roomSettings?.message_routing_mode ?? inheritedRoutingMode,
        fallback_agent_id: roomSettings?.message_routing_mode
          ? normalizeFallbackAgentId(roomSettings.message_routing_mode, roomSettings.fallback_agent_id)
          : projectResolution.effective.fallback_agent_id,
        interaction_mode: roomSettings?.interaction_mode ?? projectResolution.effective.interaction_mode,
        auto_distill_enabled:
          roomSettings?.auto_distill_enabled === null || roomSettings?.auto_distill_enabled === undefined
            ? projectResolution.effective.auto_distill_enabled
            : Boolean(roomSettings.auto_distill_enabled),
        default_workflow_definition_id: defaultWorkflowDefinitionId,
        superpowers_bootstrap_owner: superpowersBootstrapOwner,
      },
      sources: {
        message_routing: messageRoutingSource,
        interaction_mode: interactionSource,
        auto_distill: autoDistillSource,
        default_workflow_definition: workflowSource,
        superpowers_bootstrap_owner: superpowersBootstrapOwnerSource,
      },
    };
  },
};
