import { db, now } from '../db.js';
import type {
  EffectiveSettings,
  MessageRoutingMode,
  ScopedSettings,
  SettingsResolution,
  SettingsScope,
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
    .prepare('SELECT * FROM settings WHERE scope = ? AND scope_id = ?')
    .get(scope, scopeId) as ScopedSettings | undefined ?? null;
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

function normalizeSystem(settings: ScopedSettings | null): EffectiveSettings {
  return {
    message_routing_mode: settings?.message_routing_mode ?? DEFAULT_SETTINGS.message_routing_mode,
    fallback_agent_id: settings?.message_routing_mode === 'mentions_only' ? null : settings?.fallback_agent_id ?? null,
    interaction_mode: settings?.interaction_mode ?? DEFAULT_SETTINGS.interaction_mode,
    auto_distill_enabled: settings?.auto_distill_enabled === null || settings?.auto_distill_enabled === undefined
      ? DEFAULT_SETTINGS.auto_distill_enabled
      : Boolean(settings.auto_distill_enabled),
  };
}

export const settingsRepo = {
  getSystem(): EffectiveSettings {
    return normalizeSystem(getScoped('system', SYSTEM_SCOPE_ID));
  },

  updateSystem(patch: {
    message_routing_mode?: MessageRoutingMode;
    fallback_agent_id?: string | null;
    interaction_mode?: TaskInteractionMode;
    auto_distill_enabled?: boolean;
  }): EffectiveSettings {
    return normalizeSystem(upsertScoped('system', SYSTEM_SCOPE_ID, patch));
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
