import { db, now } from '../db.js';
import type {
  EffectiveSettings,
  LangChainPlannerSettings,
  MessageRoutingMode,
  ScopedSettings,
  SettingsResolution,
  SettingsScope,
  SystemSettings,
  TaskInteractionMode,
} from '../types.js';
import { projectRepo } from './projects.js';
import { roomRepo } from './rooms.js';

const SYSTEM_SCOPE_ID = 'default';

const DEFAULT_SETTINGS: EffectiveSettings = {
  message_routing_mode: 'mentions_only',
  fallback_agent_id: null,
  interaction_mode: 'ask_user',
  auto_distill_enabled: true,
};

interface SystemSettingsRow extends ScopedSettings {
  langchain_planner_model: string | null;
  openai_api_key: string | null;
  openai_base_url: string | null;
}

function emptyScoped(scope: SettingsScope, scopeId: string): ScopedSettings {
  return {
    scope,
    scope_id: scopeId,
    message_routing_mode: null,
    fallback_agent_id: null,
    interaction_mode: null,
    auto_distill_enabled: null,
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
        langchain_planner_model,
        openai_api_key,
        openai_base_url,
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
  const fallbackAgentId =
    routingMode === null || routingMode === 'mentions_only'
      ? null
      : patch.fallback_agent_id === undefined
        ? existing.fallback_agent_id
        : patch.fallback_agent_id;
  const updatedAt = now();

  db.prepare(
    `INSERT INTO settings (
      scope, scope_id, message_routing_mode, fallback_agent_id, interaction_mode, auto_distill_enabled, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_id) DO UPDATE SET
       message_routing_mode = excluded.message_routing_mode,
       fallback_agent_id = excluded.fallback_agent_id,
       interaction_mode = excluded.interaction_mode,
       auto_distill_enabled = excluded.auto_distill_enabled,
       updated_at = excluded.updated_at`,
  ).run(scope, scopeId, routingMode, fallbackAgentId, interactionMode, autoDistillEnabled, updatedAt);
  return getScoped(scope, scopeId)!;
}

function apiKeyPreview(apiKey: string | null | undefined): string | null {
  const trimmed = apiKey?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('sk-') ? `sk-...${trimmed.slice(-4)}` : `...${trimmed.slice(-4)}`;
}

function normalizedOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeSystem(settings: SystemSettingsRow | null): SystemSettings {
  const openaiApiKey = normalizedOptionalString(settings?.openai_api_key);
  const openaiApiKeyPreview = apiKeyPreview(openaiApiKey);
  return {
    message_routing_mode: settings?.message_routing_mode ?? DEFAULT_SETTINGS.message_routing_mode,
    fallback_agent_id: settings?.message_routing_mode === 'mentions_only' ? null : settings?.fallback_agent_id ?? null,
    interaction_mode: settings?.interaction_mode ?? DEFAULT_SETTINGS.interaction_mode,
    auto_distill_enabled: settings?.auto_distill_enabled === null || settings?.auto_distill_enabled === undefined
      ? DEFAULT_SETTINGS.auto_distill_enabled
      : Boolean(settings.auto_distill_enabled),
    langchain_planner_model: normalizedOptionalString(settings?.langchain_planner_model),
    openai_base_url: normalizedOptionalString(settings?.openai_base_url),
    openai_api_key_set: Boolean(openaiApiKey),
    openai_api_key_preview: openaiApiKeyPreview,
  };
}

export const settingsRepo = {
  getSystem(): SystemSettings {
    return normalizeSystem(getSystemRow());
  },

  updateSystem(patch: {
    message_routing_mode?: MessageRoutingMode;
    fallback_agent_id?: string | null;
    interaction_mode?: TaskInteractionMode;
    auto_distill_enabled?: boolean;
    langchain_planner_model?: string | null;
    openai_api_key?: string | null;
    openai_base_url?: string | null;
  }): SystemSettings {
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
    const fallbackAgentId =
      routingMode === null || routingMode === 'mentions_only'
        ? null
        : patch.fallback_agent_id === undefined
          ? existing?.fallback_agent_id ?? null
          : patch.fallback_agent_id;
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
    const updatedAt = now();

    db.prepare(
      `INSERT INTO settings (
        scope,
        scope_id,
        message_routing_mode,
        fallback_agent_id,
        interaction_mode,
        auto_distill_enabled,
        langchain_planner_model,
        openai_api_key,
        openai_base_url,
        updated_at
      )
       VALUES ('system', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id) DO UPDATE SET
         message_routing_mode = excluded.message_routing_mode,
         fallback_agent_id = excluded.fallback_agent_id,
         interaction_mode = excluded.interaction_mode,
         auto_distill_enabled = excluded.auto_distill_enabled,
         langchain_planner_model = excluded.langchain_planner_model,
         openai_api_key = excluded.openai_api_key,
         openai_base_url = excluded.openai_base_url,
         updated_at = excluded.updated_at`,
    ).run(
      SYSTEM_SCOPE_ID,
      routingMode,
      fallbackAgentId,
      interactionMode,
      autoDistillEnabled,
      plannerModel,
      openaiApiKey,
      openaiBaseUrl,
      updatedAt,
    );

    return normalizeSystem(getSystemRow());
  },

  getLangChainPlannerSettings(): LangChainPlannerSettings {
    const settings = getSystemRow();
    return {
      langchain_planner_model: normalizedOptionalString(settings?.langchain_planner_model),
      openai_api_key: normalizedOptionalString(settings?.openai_api_key),
      openai_base_url: normalizedOptionalString(settings?.openai_base_url),
    };
  },

  getProject(projectId: string): ScopedSettings | null {
    return getScoped('project', projectId);
  },

  updateProject(
    projectId: string,
    patch: {
      message_routing_mode?: MessageRoutingMode | null;
      fallback_agent_id?: string | null;
      interaction_mode?: TaskInteractionMode | null;
      auto_distill_enabled?: boolean | null;
    },
  ): ScopedSettings | null {
    if (!projectRepo.get(projectId)) return null;
    return upsertScoped('project', projectId, patch);
  },

  getRoom(roomId: string): ScopedSettings | null {
    return getScoped('room', roomId);
  },

  updateRoom(
    roomId: string,
    patch: {
      message_routing_mode?: MessageRoutingMode | null;
      fallback_agent_id?: string | null;
      interaction_mode?: TaskInteractionMode | null;
      auto_distill_enabled?: boolean | null;
    },
  ): ScopedSettings | null {
    if (!roomRepo.get(roomId)) return null;
    return upsertScoped('room', roomId, patch);
  },

  resolveForProject(projectId: string): SettingsResolution | null {
    if (!projectRepo.get(projectId)) return null;
    const system = this.getSystem();
    const project = getScoped('project', projectId);
    const messageRoutingSource: SettingsScope = project?.message_routing_mode ? 'project' : 'system';
    const interactionSource: SettingsScope = project?.interaction_mode ? 'project' : 'system';
    const autoDistillSource: SettingsScope = project?.auto_distill_enabled === null || project?.auto_distill_enabled === undefined
      ? 'system'
      : 'project';
    return {
      system,
      project,
      room: null,
      effective: {
        message_routing_mode: project?.message_routing_mode ?? system.message_routing_mode,
        fallback_agent_id: project?.message_routing_mode
          ? project.message_routing_mode === 'mentions_only'
            ? null
            : project.fallback_agent_id
          : system.fallback_agent_id,
        interaction_mode: project?.interaction_mode ?? system.interaction_mode,
        auto_distill_enabled: project?.auto_distill_enabled === null || project?.auto_distill_enabled === undefined
          ? system.auto_distill_enabled
          : Boolean(project.auto_distill_enabled),
      },
      sources: {
        message_routing: messageRoutingSource,
        interaction_mode: interactionSource,
        auto_distill: autoDistillSource,
      },
    };
  },

  resolveForRoom(roomId: string): SettingsResolution | null {
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
    const inheritedRoutingMode = projectResolution.effective.message_routing_mode;
    return {
      ...projectResolution,
      room: roomSettings,
      effective: {
        message_routing_mode: roomSettings?.message_routing_mode ?? inheritedRoutingMode,
        fallback_agent_id: roomSettings?.message_routing_mode
          ? roomSettings.message_routing_mode === 'mentions_only'
            ? null
            : roomSettings.fallback_agent_id
          : projectResolution.effective.fallback_agent_id,
        interaction_mode: roomSettings?.interaction_mode ?? projectResolution.effective.interaction_mode,
        auto_distill_enabled:
          roomSettings?.auto_distill_enabled === null || roomSettings?.auto_distill_enabled === undefined
            ? projectResolution.effective.auto_distill_enabled
            : Boolean(roomSettings.auto_distill_enabled),
      },
      sources: {
        message_routing: messageRoutingSource,
        interaction_mode: interactionSource,
        auto_distill: autoDistillSource,
      },
    };
  },
};
