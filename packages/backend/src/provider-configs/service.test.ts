import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-provider-configs-')), 'test.db');

const { providerConfigService } = await import('./service.js');
const { db } = await import('../db.js');

test.afterEach(() => {
  db.prepare('DELETE FROM provider_profiles').run();
  db.prepare('DELETE FROM provider_config_snapshots').run();
  db.prepare('DELETE FROM provider_config_sources').run();
});

test('syncProviderConfig reads selected directories without exposing raw api keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-configs-'));
  const codexDir = join(root, 'codex');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'config.toml'), [
    'model_provider = "wecoding"',
    'model = "gpt-5.5"',
    'model_reasoning_effort = "xhigh"',
    '[model_providers.wecoding]',
    'base_url = "https://yuzapi.fun"',
    'api_key = "sk-codex-secret1234"',
  ].join('\n'));

  providerConfigService.updateSource('codex', {
    use_default_config_dir: false,
    config_dir: codexDir,
  });
  const synced = await providerConfigService.syncProvider('codex');

  assert.equal(synced.snapshot?.detected_model, 'gpt-5.5');
  assert.equal(synced.snapshot?.reasoning_effort, 'xhigh');
  assert.equal(synced.snapshot?.detected_base_url, 'https://yuzapi.fun');
  assert.equal(synced.snapshot?.api_key_set, true);
  assert.equal(synced.snapshot?.api_key_preview, 'sk-...1234');
  assert.equal(JSON.stringify(synced).includes('sk-codex-secret1234'), false);
});

test('syncProviderConfig preserves previous snapshot when parsing fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-configs-preserve-'));
  const openCodeDir = join(root, 'opencode');
  mkdirSync(openCodeDir, { recursive: true });
  writeFileSync(join(openCodeDir, 'opencode.json'), JSON.stringify({
    model: 'gwenapi/gpt-5.5',
    provider: {
      gwenapi: {
        baseURL: 'https://yuzapi.fun',
        apiKey: 'sk-opencode-secret1234',
      },
    },
  }));

  providerConfigService.updateSource('opencode', {
    use_default_config_dir: false,
    config_dir: openCodeDir,
  });
  const first = await providerConfigService.syncProvider('opencode');
  assert.equal(first.snapshot?.detected_model, 'gwenapi/gpt-5.5');

  writeFileSync(join(openCodeDir, 'opencode.json'), '{broken json');
  const failed = await providerConfigService.syncProvider('opencode');

  assert.equal(failed.source.last_sync_status, 'failed');
  assert.match(failed.source.last_sync_error ?? '', /invalid_json|Unexpected/);
  assert.equal(failed.snapshot?.detected_model, 'gwenapi/gpt-5.5');
  assert.equal(failed.snapshot?.api_key_preview, 'sk-...1234');
});

test('syncProviderConfig reads OpenCode provider options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-configs-opencode-options-'));
  const openCodeDir = join(root, 'opencode');
  mkdirSync(openCodeDir, { recursive: true });
  writeFileSync(join(openCodeDir, 'opencode.json'), JSON.stringify({
    model: 'gwenapi/gpt-5.5',
    provider: {
      gwenapi: {
        models: {
          'gpt-5.5': {
            options: { reasoningEffort: 'high' },
          },
        },
        options: {
          baseURL: 'https://yuzapi.fun',
          apiKey: 'sk-opencode-options1234',
        },
      },
    },
  }));

  providerConfigService.updateSource('opencode', {
    use_default_config_dir: false,
    config_dir: openCodeDir,
  });
  const synced = await providerConfigService.syncProvider('opencode');

  assert.equal(synced.snapshot?.detected_model, 'gwenapi/gpt-5.5');
  assert.equal(synced.snapshot?.reasoning_effort, 'high');
  assert.equal(synced.snapshot?.detected_base_url, 'https://yuzapi.fun');
  assert.equal(synced.snapshot?.api_key_set, true);
  assert.equal(synced.snapshot?.api_key_preview, 'sk-...1234');
  assert.equal(JSON.stringify(synced).includes('sk-opencode-options1234'), false);
});

test('importDiscoveredProfile reads Claude Code auth token without exposing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-configs-claude-auth-token-'));
  const claudeDir = join(root, 'claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_MODEL: 'claude-sonnet-4.5',
      ANTHROPIC_BASE_URL: 'https://anthropic.example',
      ANTHROPIC_AUTH_TOKEN: 'sk-claude-token1234',
    },
  }));

  providerConfigService.updateSource('claudecode', {
    use_default_config_dir: false,
    config_dir: claudeDir,
  });
  const synced = await providerConfigService.syncProvider('claudecode');
  assert.equal(synced.snapshot?.api_key_set, true);
  assert.equal(synced.snapshot?.api_key_preview, 'sk-...1234');
  assert.equal(JSON.stringify(synced).includes('sk-claude-token1234'), false);

  const imported = await providerConfigService.importProfileFromSnapshot('claudecode');
  assert.equal(imported?.provider, 'claudecode');
  assert.equal(imported?.model, 'claude-sonnet-4.5');
  assert.equal(imported?.base_url, 'https://anthropic.example');
  assert.equal(imported?.api_key_set, true);
  assert.equal(imported?.api_key_preview, 'sk-...1234');
  assert.equal(imported?.api_key_env_var, 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(JSON.stringify(imported).includes('sk-claude-token1234'), false);

  const runtime = providerConfigService.resolveProviderRuntimeConfig('claudecode');
  assert.equal(runtime.api_key, 'sk-claude-token1234');
  assert.equal(runtime.api_key_env_var, 'ANTHROPIC_AUTH_TOKEN');
});

test('importDiscoveredProfile creates active managed profile only when requested', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-configs-import-'));
  const claudeDir = join(root, 'claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_MODEL: 'claude-sonnet-4.5',
      ANTHROPIC_BASE_URL: 'https://anthropic.example',
      ANTHROPIC_API_KEY: 'sk-claude-secret1234',
    },
  }));

  providerConfigService.updateSource('claudecode', {
    use_default_config_dir: false,
    config_dir: claudeDir,
  });
  await providerConfigService.syncProvider('claudecode');

  const beforeImport = providerConfigService.listProviderConfigs();
  assert.equal(beforeImport.profiles.length, 0);

  const imported = await providerConfigService.importProfileFromSnapshot('claudecode');
  assert.equal(imported?.provider, 'claudecode');
  assert.equal(imported?.model, 'claude-sonnet-4.5');
  assert.equal(imported?.base_url, 'https://anthropic.example');
  assert.equal(imported?.api_key_set, true);
  assert.equal(imported?.api_key_preview, 'sk-...1234');
  assert.equal(imported?.is_active, true);
  assert.equal(JSON.stringify(imported).includes('sk-claude-secret1234'), false);
});

test('setActiveProviderProfile keeps one active profile per provider', () => {
  const first = providerConfigService.createProfile({
    name: 'Codex first',
    provider: 'codex',
    model: 'gpt-5.1',
    base_url: null,
    api_key: null,
    reasoning_effort: 'high',
    run_overrides_enabled: true,
    activate: true,
  });
  const second = providerConfigService.createProfile({
    name: 'Codex second',
    provider: 'codex',
    model: 'gpt-5.5',
    base_url: null,
    api_key: null,
    reasoning_effort: 'xhigh',
    run_overrides_enabled: true,
  });

  providerConfigService.activateProfile(second.id);
  const listed = providerConfigService.listProviderConfigs().profiles.filter((profile) => profile.provider === 'codex');

  assert.equal(listed.find((profile) => profile.id === first.id)?.is_active, false);
  assert.equal(listed.find((profile) => profile.id === second.id)?.is_active, true);
});

test('resolveProviderRuntimeConfig prefers active managed profile over snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-configs-runtime-'));
  const codexDir = join(root, 'codex');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'config.toml'), [
    'model = "snapshot-model"',
    'model_reasoning_effort = "medium"',
  ].join('\n'));

  providerConfigService.updateSource('codex', {
    use_default_config_dir: false,
    config_dir: codexDir,
  });
  await providerConfigService.syncProvider('codex');

  assert.deepEqual(providerConfigService.resolveProviderRuntimeConfig('codex'), {
    provider: 'codex',
    source: 'discovered_snapshot',
    profile_id: null,
    model: 'snapshot-model',
    base_url: null,
    api_key: null,
    api_key_env_var: 'OPENAI_API_KEY',
    reasoning_effort: 'medium',
    run_overrides_enabled: false,
  });

  const profile = providerConfigService.createProfile({
    name: 'Managed Codex',
    provider: 'codex',
    model: 'managed-model',
    base_url: 'https://managed.example/v1',
    api_key: 'sk-managed1234',
    reasoning_effort: 'xhigh',
    run_overrides_enabled: true,
    activate: true,
  });

  assert.deepEqual(providerConfigService.resolveProviderRuntimeConfig('codex'), {
    provider: 'codex',
    source: 'managed_profile',
    profile_id: profile.id,
    model: 'managed-model',
    base_url: 'https://managed.example/v1',
    api_key: 'sk-managed1234',
    api_key_env_var: 'OPENAI_API_KEY',
    reasoning_effort: 'xhigh',
    run_overrides_enabled: true,
  });
});
