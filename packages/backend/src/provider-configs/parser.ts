import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcpBackend } from '../types.js';
import type { ProviderSnapshotInput } from './types.js';

export async function discoverProviderConfig(input: {
  provider: AcpBackend;
  configDir: string;
}): Promise<ProviderSnapshotInput> {
  try {
    const dirStat = await stat(input.configDir);
    if (!dirStat.isDirectory()) throw new Error('missing_dir: config path is not a directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('missing_dir: config directory not found');
    throw error;
  }

  if (input.provider === 'codex') return discoverCodexConfig(input.configDir);
  if (input.provider === 'claudecode') return discoverClaudeCodeConfig(input.configDir);
  return discoverOpenCodeConfig(input.configDir);
}

async function discoverCodexConfig(configDir: string): Promise<ProviderSnapshotInput> {
  const configFile = join(configDir, 'config.toml');
  const text = await readConfigText(configFile);
  const modelProvider = readTomlScalar(text, 'model_provider');
  const providerBlock = modelProvider ? readTomlSection(text, `model_providers.${modelProvider}`) : '';
  const baseUrl = readTomlScalar(providerBlock, 'base_url');
  const apiKey =
    readTomlScalar(providerBlock, 'api_key')
    ?? readTomlScalar(providerBlock, 'apiKey')
    ?? readTomlScalar(text, 'api_key')
    ?? readTomlScalar(text, 'OPENAI_API_KEY');
  const model = readTomlScalar(text, 'model');
  const reasoning = readTomlScalar(text, 'model_reasoning_effort');
  return {
    provider: 'codex',
    config_dir: configDir,
    config_file: configFile,
    detected_model: model,
    detected_base_url: baseUrl,
    api_key: apiKey,
    api_key_env_var: 'OPENAI_API_KEY',
    reasoning_effort: reasoning,
    raw_summary: compactObject({
      model_provider: modelProvider,
      model,
      base_url: baseUrl,
      reasoning_effort: reasoning,
      api_key_set: Boolean(normalizedString(apiKey)),
      api_key_env_var: 'OPENAI_API_KEY',
    }),
  };
}

async function discoverClaudeCodeConfig(configDir: string): Promise<ProviderSnapshotInput> {
  const configFile = join(configDir, 'settings.json');
  const parsed = await readJsonConfig(configFile);
  const env = isRecord(parsed.env) ? parsed.env : parsed;
  const model = readJsonString(env, 'ANTHROPIC_MODEL')
    ?? readJsonString(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL')
    ?? readJsonString(env, 'ANTHROPIC_REASONING_MODEL');
  const baseUrl = readJsonString(env, 'ANTHROPIC_BASE_URL');
  const anthropicApiKey = readJsonString(env, 'ANTHROPIC_API_KEY');
  const anthropicAuthToken = readJsonString(env, 'ANTHROPIC_AUTH_TOKEN');
  const apiKey = anthropicApiKey ?? anthropicAuthToken;
  const apiKeyEnvVar = anthropicAuthToken && !anthropicApiKey ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  const reasoning = readJsonString(parsed, 'effortLevel') ?? readJsonString(parsed, 'reasoning_effort');
  return {
    provider: 'claudecode',
    config_dir: configDir,
    config_file: configFile,
    detected_model: model,
    detected_base_url: baseUrl,
    api_key: apiKey,
    api_key_env_var: apiKeyEnvVar,
    reasoning_effort: reasoning,
    raw_summary: compactObject({
      model,
      base_url: baseUrl,
      reasoning_effort: reasoning,
      api_key_set: Boolean(normalizedString(apiKey)),
      api_key_env_var: apiKeyEnvVar,
    }),
  };
}

async function discoverOpenCodeConfig(configDir: string): Promise<ProviderSnapshotInput> {
  const configFile = join(configDir, 'opencode.json');
  const parsed = await readJsonConfig(configFile);
  const model = readJsonString(parsed, 'model');
  const providerName = model?.includes('/') ? model.split('/')[0] : readJsonString(parsed, 'providerID');
  const modelName = model?.includes('/') ? model.split('/').slice(1).join('/') : model;
  const providers = isRecord(parsed.provider) ? parsed.provider : {};
  const providerConfig = providerName && isRecord(providers[providerName]) ? providers[providerName] : {};
  const providerOptions = isRecord(providerConfig.options) ? providerConfig.options : {};
  const baseUrl = readJsonString(providerConfig, 'baseURL')
    ?? readJsonString(providerConfig, 'baseUrl')
    ?? readJsonString(providerOptions, 'baseURL')
    ?? readJsonString(providerOptions, 'baseUrl');
  const apiKey = readJsonString(providerConfig, 'apiKey')
    ?? readJsonString(providerConfig, 'api_key')
    ?? readJsonString(providerOptions, 'apiKey')
    ?? readJsonString(providerOptions, 'api_key');
  const models = isRecord(providerConfig.models) ? providerConfig.models : {};
  const modelConfig = modelName && isRecord(models[modelName]) ? models[modelName] : {};
  const options = isRecord(modelConfig.options) ? modelConfig.options : modelConfig;
  const reasoning = readJsonString(options, 'reasoningEffort') ?? readJsonString(options, 'reasoning_effort');
  return {
    provider: 'opencode',
    config_dir: configDir,
    config_file: configFile,
    detected_model: model,
    detected_base_url: baseUrl,
    api_key: apiKey,
    api_key_env_var: 'OPENAI_API_KEY',
    reasoning_effort: reasoning,
    raw_summary: compactObject({
      provider: providerName,
      model,
      base_url: baseUrl,
      reasoning_effort: reasoning,
      api_key_set: Boolean(normalizedString(apiKey)),
      api_key_env_var: 'OPENAI_API_KEY',
    }),
  };
}

async function readConfigText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('missing_config: config file not found');
    throw error;
  }
}

async function readJsonConfig(filePath: string): Promise<Record<string, unknown>> {
  const text = await readConfigText(filePath);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error('invalid_json: config root must be an object');
    return parsed;
  } catch (error) {
    if ((error as Error).message.startsWith('invalid_json:')) throw error;
    throw new Error(`invalid_json: ${(error as Error).message}`);
  }
}

function readTomlScalar(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\n#]+))`, 'm'));
  return normalizedString(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function readTomlSection(text: string, section: string): string {
  const lines = text.split(/\r?\n/);
  const target = `[${section}]`;
  const captured: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inSection) break;
      inSection = trimmed === target;
      continue;
    }
    if (inSection) captured.push(line);
  }
  return captured.join('\n');
}

function readJsonString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === 'string' ? normalizedString(item) : null;
}

function normalizedString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ''));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
