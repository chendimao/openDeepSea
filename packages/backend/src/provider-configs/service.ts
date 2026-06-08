import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { AcpBackend } from '../types.js';
import { discoverProviderConfig } from './parser.js';
import {
  ACP_PROVIDERS,
  defaultProviderConfigDir,
  isAcpProvider,
  type ProviderApiKeyEnvVar,
  type ManagedProviderProfile,
  type ProviderConfigList,
  type ProviderConfigSource,
  type ProviderDiscoveredSnapshot,
  type ProviderRuntimeConfig,
  type ProviderRuntimeSummary,
  type ProviderSnapshotInput,
  type ProviderSyncStatus,
} from './types.js';

interface SourceRow {
  provider: AcpBackend;
  config_dir: string | null;
  use_default_config_dir: 0 | 1;
  auto_sync_enabled: 0 | 1;
  last_sync_at: number | null;
  last_sync_status: ProviderSyncStatus;
  last_sync_error: string | null;
  updated_at: number;
}

interface SnapshotRow {
  provider: AcpBackend;
  config_dir: string;
  config_file: string | null;
  detected_model: string | null;
  detected_base_url: string | null;
  api_key_set: 0 | 1;
  api_key_preview: string | null;
  api_key_env_var: string | null;
  reasoning_effort: string | null;
  raw_summary_json: string;
  synced_at: number;
}

interface ProfileRow {
  id: string;
  name: string;
  provider: AcpBackend;
  model: string | null;
  base_url: string | null;
  api_key: string | null;
  api_key_env_var: string | null;
  reasoning_effort: string | null;
  run_overrides_enabled: 0 | 1;
  is_active: 0 | 1;
  created_from_snapshot_at: number | null;
  created_at: number;
  updated_at: number;
}

export const providerConfigService = {
  listProviderConfigs(): ProviderConfigList {
    const profiles = listProfileRows().map(toSafeProfile);
    return {
      sources: ACP_PROVIDERS.map((provider) => toSource(getSourceRow(provider), provider)),
      snapshots: listSnapshotRows().map(toSnapshot),
      profiles,
      runtime: ACP_PROVIDERS.map((provider) => toRuntimeSummary(this.resolveProviderRuntimeConfig(provider))),
    };
  },

  updateSource(
    provider: AcpBackend,
    patch: {
      config_dir?: string | null;
      use_default_config_dir?: boolean;
      auto_sync_enabled?: boolean;
    },
  ): ProviderConfigSource {
    const current = toSource(getSourceRow(provider), provider);
    const updatedAt = now();
    db.prepare(
      `INSERT INTO provider_config_sources (
        provider, config_dir, use_default_config_dir, auto_sync_enabled,
        last_sync_at, last_sync_status, last_sync_error, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         config_dir = excluded.config_dir,
         use_default_config_dir = excluded.use_default_config_dir,
         auto_sync_enabled = excluded.auto_sync_enabled,
         last_sync_at = excluded.last_sync_at,
         last_sync_status = excluded.last_sync_status,
         last_sync_error = excluded.last_sync_error,
         updated_at = excluded.updated_at`,
    ).run(
      provider,
      patch.config_dir === undefined ? current.config_dir : normalizedOptionalString(patch.config_dir),
      patch.use_default_config_dir === undefined ? (current.use_default_config_dir ? 1 : 0) : patch.use_default_config_dir ? 1 : 0,
      patch.auto_sync_enabled === undefined ? (current.auto_sync_enabled ? 1 : 0) : patch.auto_sync_enabled ? 1 : 0,
      current.last_sync_at,
      current.last_sync_status,
      current.last_sync_error,
      updatedAt,
    );
    return toSource(getSourceRow(provider), provider);
  },

  async syncProvider(provider: AcpBackend): Promise<{
    source: ProviderConfigSource;
    snapshot: ProviderDiscoveredSnapshot | null;
  }> {
    const source = toSource(getSourceRow(provider), provider);
    const configDir = resolveConfigDir(source);
    try {
      const discovered = await discoverProviderConfig({ provider, configDir });
      const syncedAt = now();
      upsertSnapshot(discovered, syncedAt);
      updateSyncState(provider, {
        last_sync_at: syncedAt,
        last_sync_status: 'success',
        last_sync_error: null,
      });
    } catch (error) {
      updateSyncState(provider, {
        last_sync_at: now(),
        last_sync_status: 'failed',
        last_sync_error: (error as Error).message,
      });
    }
    return {
      source: toSource(getSourceRow(provider), provider),
      snapshot: getSnapshot(provider),
    };
  },

  async syncAll(): Promise<ProviderConfigList> {
    for (const provider of ACP_PROVIDERS) {
      await this.syncProvider(provider);
    }
    return this.listProviderConfigs();
  },

  async syncAutoEnabledProviders(): Promise<ProviderConfigList> {
    for (const provider of ACP_PROVIDERS) {
      const source = toSource(getSourceRow(provider), provider);
      if (source.auto_sync_enabled) {
        await this.syncProvider(provider);
      }
    }
    return this.listProviderConfigs();
  },

  async importProfileFromSnapshot(provider: AcpBackend): Promise<ManagedProviderProfile | null> {
    const snapshot = getSnapshot(provider);
    if (!snapshot) return null;
    const source = toSource(getSourceRow(provider), provider);
    const configDir = resolveConfigDir(source);
    const discovered = await discoverProviderConfig({ provider, configDir }).catch((): ProviderSnapshotInput => ({
      provider,
      config_dir: snapshot.config_dir,
      config_file: snapshot.config_file,
      detected_model: snapshot.detected_model,
      detected_base_url: snapshot.detected_base_url,
      api_key: null,
      api_key_env_var: snapshot.api_key_env_var,
      reasoning_effort: snapshot.reasoning_effort,
      raw_summary: parseSummary(snapshot.raw_summary_json),
    }));
    return this.createProfile({
      name: `${providerLabel(provider)} ${discovered.detected_model ?? 'profile'}`,
      provider,
      model: discovered.detected_model,
      base_url: discovered.detected_base_url,
      api_key: discovered.api_key,
      api_key_env_var: discovered.api_key_env_var,
      reasoning_effort: discovered.reasoning_effort,
      run_overrides_enabled: true,
      activate: true,
      created_from_snapshot_at: snapshot.synced_at,
    });
  },

  createProfile(input: {
    name: string;
    provider: AcpBackend;
    model?: string | null;
    base_url?: string | null;
    api_key?: string | null;
    api_key_env_var?: ProviderApiKeyEnvVar | null;
    reasoning_effort?: string | null;
    run_overrides_enabled?: boolean;
    activate?: boolean;
    created_from_snapshot_at?: number | null;
  }): ManagedProviderProfile {
    const id = `provider-profile-${nanoid(10)}`;
    const createdAt = now();
    const isActive = input.activate ? 1 : 0;
    db.transaction(() => {
      if (isActive) deactivateProviderProfiles(input.provider);
      db.prepare(
        `INSERT INTO provider_profiles (
          id, name, provider, model, base_url, api_key, api_key_env_var, reasoning_effort,
          run_overrides_enabled, is_active, created_from_snapshot_at, created_at, updated_at
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        requireString(input.name, 'name'),
        input.provider,
        normalizedOptionalString(input.model),
        normalizedOptionalString(input.base_url),
        normalizedOptionalString(input.api_key),
        normalizeApiKeyEnvVar(input.provider, input.api_key_env_var),
        normalizedOptionalString(input.reasoning_effort),
        input.run_overrides_enabled === false ? 0 : 1,
        isActive,
        input.created_from_snapshot_at ?? null,
        createdAt,
        createdAt,
      );
    })();
    return toSafeProfile(getProfileRow(id)!);
  },

  updateProfile(
    id: string,
    patch: {
      name?: string | null;
      model?: string | null;
      base_url?: string | null;
      api_key?: string | null;
      api_key_env_var?: ProviderApiKeyEnvVar | null;
      reasoning_effort?: string | null;
      run_overrides_enabled?: boolean;
      activate?: boolean;
    },
  ): ManagedProviderProfile | null {
    const existing = getProfileRow(id);
    if (!existing) return null;
    const updatedAt = now();
    db.transaction(() => {
      if (patch.activate) deactivateProviderProfiles(existing.provider);
      db.prepare(
        `UPDATE provider_profiles
         SET name = ?,
             model = ?,
             base_url = ?,
             api_key = ?,
             api_key_env_var = ?,
             reasoning_effort = ?,
             run_overrides_enabled = ?,
             is_active = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        patch.name === undefined ? existing.name : requireString(patch.name, 'name'),
        patch.model === undefined ? existing.model : normalizedOptionalString(patch.model),
        patch.base_url === undefined ? existing.base_url : normalizedOptionalString(patch.base_url),
        patch.api_key === undefined ? existing.api_key : normalizedOptionalString(patch.api_key),
        patch.api_key_env_var === undefined
          ? normalizeApiKeyEnvVar(existing.provider, existing.api_key_env_var)
          : normalizeApiKeyEnvVar(existing.provider, patch.api_key_env_var),
        patch.reasoning_effort === undefined ? existing.reasoning_effort : normalizedOptionalString(patch.reasoning_effort),
        patch.run_overrides_enabled === undefined ? existing.run_overrides_enabled : patch.run_overrides_enabled ? 1 : 0,
        patch.activate ? 1 : existing.is_active,
        updatedAt,
        id,
      );
    })();
    return toSafeProfile(getProfileRow(id)!);
  },

  activateProfile(id: string): ManagedProviderProfile | null {
    const profile = getProfileRow(id);
    if (!profile) return null;
    db.transaction(() => {
      deactivateProviderProfiles(profile.provider);
      db.prepare('UPDATE provider_profiles SET is_active = 1, updated_at = ? WHERE id = ?').run(now(), id);
    })();
    return toSafeProfile(getProfileRow(id)!);
  },

  deleteProfile(id: string): boolean {
    const result = db.prepare('DELETE FROM provider_profiles WHERE id = ?').run(id);
    return result.changes > 0;
  },

  resolveProviderRuntimeConfig(provider: AcpBackend): ProviderRuntimeConfig {
    const active = getActiveProfileRow(provider);
    if (active && active.run_overrides_enabled) {
      return {
        provider,
        source: 'managed_profile',
        profile_id: active.id,
        model: normalizedOptionalString(active.model),
        base_url: normalizedOptionalString(active.base_url),
        api_key: normalizedOptionalString(active.api_key),
        api_key_env_var: normalizeApiKeyEnvVar(provider, active.api_key_env_var),
        reasoning_effort: normalizedOptionalString(active.reasoning_effort),
        run_overrides_enabled: true,
      };
    }

    const snapshot = getSnapshot(provider);
    if (snapshot) {
      return {
        provider,
        source: 'discovered_snapshot',
        profile_id: null,
        model: snapshot.detected_model,
        base_url: snapshot.detected_base_url,
        api_key: null,
        api_key_env_var: snapshot.api_key_env_var,
        reasoning_effort: snapshot.reasoning_effort,
        run_overrides_enabled: false,
      };
    }

    return {
      provider,
      source: 'cli_default',
      profile_id: null,
      model: null,
      base_url: null,
      api_key: null,
      api_key_env_var: defaultApiKeyEnvVar(provider),
      reasoning_effort: null,
      run_overrides_enabled: false,
    };
  },
};

function getSourceRow(provider: AcpBackend): SourceRow | null {
  return db.prepare('SELECT * FROM provider_config_sources WHERE provider = ?').get(provider) as SourceRow | undefined ?? null;
}

function listSnapshotRows(): SnapshotRow[] {
  return db.prepare('SELECT * FROM provider_config_snapshots ORDER BY provider ASC').all() as SnapshotRow[];
}

function getSnapshot(provider: AcpBackend): ProviderDiscoveredSnapshot | null {
  const row = db.prepare('SELECT * FROM provider_config_snapshots WHERE provider = ?').get(provider) as SnapshotRow | undefined;
  return row ? toSnapshot(row) : null;
}

function listProfileRows(): ProfileRow[] {
  return db.prepare('SELECT * FROM provider_profiles ORDER BY provider ASC, is_active DESC, updated_at DESC').all() as ProfileRow[];
}

function getProfileRow(id: string): ProfileRow | null {
  return db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(id) as ProfileRow | undefined ?? null;
}

function getActiveProfileRow(provider: AcpBackend): ProfileRow | null {
  return db
    .prepare('SELECT * FROM provider_profiles WHERE provider = ? AND is_active = 1')
    .get(provider) as ProfileRow | undefined ?? null;
}

function deactivateProviderProfiles(provider: AcpBackend): void {
  db.prepare('UPDATE provider_profiles SET is_active = 0, updated_at = ? WHERE provider = ? AND is_active = 1')
    .run(now(), provider);
}

function upsertSnapshot(input: ProviderSnapshotInput, syncedAt: number): void {
  const apiKey = normalizedOptionalString(input.api_key);
  db.prepare(
    `INSERT INTO provider_config_snapshots (
      provider, config_dir, config_file, detected_model, detected_base_url,
      api_key_set, api_key_preview, api_key_env_var, reasoning_effort, raw_summary_json, synced_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       config_dir = excluded.config_dir,
       config_file = excluded.config_file,
       detected_model = excluded.detected_model,
       detected_base_url = excluded.detected_base_url,
       api_key_set = excluded.api_key_set,
       api_key_preview = excluded.api_key_preview,
       api_key_env_var = excluded.api_key_env_var,
       reasoning_effort = excluded.reasoning_effort,
       raw_summary_json = excluded.raw_summary_json,
       synced_at = excluded.synced_at`,
  ).run(
    input.provider,
    input.config_dir,
    input.config_file,
    normalizedOptionalString(input.detected_model),
    normalizedOptionalString(input.detected_base_url),
    apiKey ? 1 : 0,
    apiKeyPreview(apiKey),
    normalizeApiKeyEnvVar(input.provider, input.api_key_env_var),
    normalizedOptionalString(input.reasoning_effort),
    JSON.stringify(input.raw_summary),
    syncedAt,
  );
}

function updateSyncState(
  provider: AcpBackend,
  patch: {
    last_sync_at: number;
    last_sync_status: ProviderSyncStatus;
    last_sync_error: string | null;
  },
): void {
  const source = toSource(getSourceRow(provider), provider);
  db.prepare(
    `INSERT INTO provider_config_sources (
      provider, config_dir, use_default_config_dir, auto_sync_enabled,
      last_sync_at, last_sync_status, last_sync_error, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       last_sync_at = excluded.last_sync_at,
       last_sync_status = excluded.last_sync_status,
       last_sync_error = excluded.last_sync_error,
       updated_at = excluded.updated_at`,
  ).run(
    provider,
    source.config_dir,
    source.use_default_config_dir ? 1 : 0,
    source.auto_sync_enabled ? 1 : 0,
    patch.last_sync_at,
    patch.last_sync_status,
    patch.last_sync_error,
    now(),
  );
}

function toSource(row: SourceRow | null, provider: AcpBackend): ProviderConfigSource {
  return {
    provider,
    config_dir: row?.config_dir ?? null,
    use_default_config_dir: row?.use_default_config_dir === undefined ? true : Boolean(row.use_default_config_dir),
    auto_sync_enabled: row?.auto_sync_enabled === undefined ? true : Boolean(row.auto_sync_enabled),
    last_sync_at: row?.last_sync_at ?? null,
    last_sync_status: row?.last_sync_status ?? 'idle',
    last_sync_error: row?.last_sync_error ?? null,
    updated_at: row?.updated_at ?? 0,
  };
}

function toSnapshot(row: SnapshotRow): ProviderDiscoveredSnapshot {
  return {
    provider: row.provider,
    config_dir: row.config_dir,
    config_file: row.config_file,
    detected_model: row.detected_model,
    detected_base_url: row.detected_base_url,
    api_key_set: Boolean(row.api_key_set),
    api_key_preview: row.api_key_preview,
    api_key_env_var: normalizeApiKeyEnvVar(row.provider, row.api_key_env_var),
    reasoning_effort: row.reasoning_effort,
    raw_summary_json: row.raw_summary_json,
    synced_at: row.synced_at,
  };
}

function toSafeProfile(row: ProfileRow): ManagedProviderProfile {
  const apiKey = normalizedOptionalString(row.api_key);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    base_url: row.base_url,
    api_key_set: Boolean(apiKey),
    api_key_preview: apiKeyPreview(apiKey),
    api_key_env_var: normalizeApiKeyEnvVar(row.provider, row.api_key_env_var),
    reasoning_effort: row.reasoning_effort,
    run_overrides_enabled: Boolean(row.run_overrides_enabled),
    is_active: Boolean(row.is_active),
    created_from_snapshot_at: row.created_from_snapshot_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function resolveConfigDir(source: ProviderConfigSource): string {
  if (source.use_default_config_dir) return defaultProviderConfigDir(source.provider);
  return normalizedOptionalString(source.config_dir) ?? defaultProviderConfigDir(source.provider);
}

function apiKeyPreview(apiKey: string | null): string | null {
  if (!apiKey) return null;
  return apiKey.startsWith('sk-') ? `sk-...${apiKey.slice(-4)}` : `...${apiKey.slice(-4)}`;
}

function normalizeApiKeyEnvVar(provider: AcpBackend, value: string | null | undefined): ProviderApiKeyEnvVar {
  const normalized = normalizedOptionalString(value);
  if (provider === 'claudecode' && normalized === 'ANTHROPIC_AUTH_TOKEN') return 'ANTHROPIC_AUTH_TOKEN';
  if (provider === 'claudecode') return 'ANTHROPIC_API_KEY';
  return 'OPENAI_API_KEY';
}

function defaultApiKeyEnvVar(provider: AcpBackend): ProviderApiKeyEnvVar {
  return normalizeApiKeyEnvVar(provider, null);
}

function normalizedOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function requireString(value: string | null | undefined, field: string): string {
  const normalized = normalizedOptionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function parseSummary(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function providerLabel(provider: AcpBackend): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claudecode') return 'Claude Code';
  return 'OpenCode';
}

function toRuntimeSummary(config: ProviderRuntimeConfig): ProviderRuntimeSummary {
  return {
    provider: config.provider,
    source: config.source,
    profile_id: config.profile_id,
    model: config.model,
    base_url: config.base_url,
    api_key_set: Boolean(normalizedOptionalString(config.api_key)),
    api_key_preview: apiKeyPreview(normalizedOptionalString(config.api_key)),
    api_key_env_var: config.api_key_env_var,
    reasoning_effort: config.reasoning_effort,
    run_overrides_enabled: config.run_overrides_enabled,
  };
}

export { isAcpProvider };
