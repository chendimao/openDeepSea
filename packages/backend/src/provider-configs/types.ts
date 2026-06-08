import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AcpBackend } from '../types.js';

export const ACP_PROVIDERS = ['codex', 'claudecode', 'opencode'] as const satisfies AcpBackend[];

export type ProviderSyncStatus = 'idle' | 'success' | 'failed';
export type ProviderRuntimeConfigSource = 'managed_profile' | 'discovered_snapshot' | 'cli_default';
export type ProviderApiKeyEnvVar = 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';

export interface ProviderConfigSource {
  provider: AcpBackend;
  config_dir: string | null;
  use_default_config_dir: boolean;
  auto_sync_enabled: boolean;
  last_sync_at: number | null;
  last_sync_status: ProviderSyncStatus;
  last_sync_error: string | null;
  updated_at: number;
}

export interface ProviderDiscoveredSnapshot {
  provider: AcpBackend;
  config_dir: string;
  config_file: string | null;
  detected_model: string | null;
  detected_base_url: string | null;
  api_key_set: boolean;
  api_key_preview: string | null;
  api_key_env_var: ProviderApiKeyEnvVar;
  reasoning_effort: string | null;
  raw_summary_json: string;
  synced_at: number;
}

export interface ProviderSnapshotInput {
  provider: AcpBackend;
  config_dir: string;
  config_file: string | null;
  detected_model: string | null;
  detected_base_url: string | null;
  api_key: string | null;
  api_key_env_var: ProviderApiKeyEnvVar;
  reasoning_effort: string | null;
  raw_summary: Record<string, unknown>;
}

export interface ManagedProviderProfile {
  id: string;
  name: string;
  provider: AcpBackend;
  model: string | null;
  base_url: string | null;
  api_key_set: boolean;
  api_key_preview: string | null;
  api_key_env_var: ProviderApiKeyEnvVar;
  reasoning_effort: string | null;
  run_overrides_enabled: boolean;
  is_active: boolean;
  created_from_snapshot_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderRuntimeConfig {
  provider: AcpBackend;
  source: ProviderRuntimeConfigSource;
  profile_id: string | null;
  model: string | null;
  base_url: string | null;
  api_key: string | null;
  api_key_env_var: ProviderApiKeyEnvVar;
  reasoning_effort: string | null;
  run_overrides_enabled: boolean;
}

export interface ProviderRuntimeSummary {
  provider: AcpBackend;
  source: ProviderRuntimeConfigSource;
  profile_id: string | null;
  model: string | null;
  base_url: string | null;
  api_key_set: boolean;
  api_key_preview: string | null;
  api_key_env_var: ProviderApiKeyEnvVar;
  reasoning_effort: string | null;
  run_overrides_enabled: boolean;
}

export interface ProviderConfigList {
  sources: ProviderConfigSource[];
  snapshots: ProviderDiscoveredSnapshot[];
  profiles: ManagedProviderProfile[];
  runtime: ProviderRuntimeSummary[];
}

export function defaultProviderConfigDir(provider: AcpBackend): string {
  if (provider === 'codex') return join(homedir(), '.codex');
  if (provider === 'claudecode') return join(homedir(), '.claude');
  return join(homedir(), '.config', 'opencode');
}

export function isAcpProvider(value: string | null | undefined): value is AcpBackend {
  return value === 'codex' || value === 'claudecode' || value === 'opencode';
}
