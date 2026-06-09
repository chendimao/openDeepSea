import type { KnowledgeEmbeddingProvider } from './knowledge-embedding.js';
import { createLocalHashEmbeddingProvider } from './knowledge-embedding.js';
import { settingsRepo } from './repos/settings.js';
import type { KnowledgeEmbeddingProviderId, KnowledgeEmbeddingSettings } from './types.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatibleEmbeddingProviderInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number | null;
  fetchImpl?: FetchLike;
}

export interface OpenAICompatibleEmbeddingProvider extends KnowledgeEmbeddingProvider {
  id: 'openai-compatible';
  embed(text: string, options?: { signal?: AbortSignal }): Promise<number[]>;
}

export interface KnowledgeEmbeddingRuntime {
  provider: KnowledgeEmbeddingProviderId;
  model: string;
  dimensions: number | null;
  base_url: string | null;
  api_key_set: boolean;
  api_key_env_var: string | null;
  available: boolean;
  unavailable_reason: string | null;
}

interface OpenAIEmbeddingPayload {
  data?: unknown;
  error?: unknown;
  message?: unknown;
}

interface OpenAIEmbeddingPayloadItem {
  embedding?: unknown;
}

const OPENAI_COMPATIBLE_UNAVAILABLE_REASON = 'embedding provider requires model, base URL, and API key';

export function getKnowledgeEmbeddingRuntime(env: NodeJS.ProcessEnv = process.env): KnowledgeEmbeddingRuntime {
  const settings = settingsRepo.getKnowledgeEmbeddingSettings();

  if (settings.provider === 'local-hash') {
    return {
      provider: 'local-hash',
      model: settings.model ?? 'local-hash-v1',
      dimensions: settings.dimensions ?? 256,
      base_url: null,
      api_key_set: false,
      api_key_env_var: null,
      available: true,
      unavailable_reason: null,
    };
  }

  const apiKey = resolveEmbeddingApiKey(settings, env);
  const available = Boolean(settings.model && settings.base_url && apiKey);
  return {
    provider: 'openai-compatible',
    model: settings.model ?? '',
    dimensions: settings.dimensions,
    base_url: settings.base_url,
    api_key_set: Boolean(apiKey),
    api_key_env_var: settings.api_key_env_var,
    available,
    unavailable_reason: available ? null : OPENAI_COMPATIBLE_UNAVAILABLE_REASON,
  };
}

export function getKnowledgeEmbeddingProvider(input: {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
} = {}): KnowledgeEmbeddingProvider {
  const settings = settingsRepo.getKnowledgeEmbeddingSettings();
  if (settings.provider === 'local-hash') {
    return createLocalHashEmbeddingProvider({ dimensions: settings.dimensions ?? 256 });
  }

  const apiKey = resolveEmbeddingApiKey(settings, input.env ?? process.env);
  if (!settings.model || !settings.base_url || !apiKey) {
    throw new Error(OPENAI_COMPATIBLE_UNAVAILABLE_REASON);
  }

  return createOpenAICompatibleEmbeddingProvider({
    baseUrl: settings.base_url,
    apiKey,
    model: settings.model,
    dimensions: settings.dimensions,
    fetchImpl: input.fetchImpl,
  });
}

export function createOpenAICompatibleEmbeddingProvider(
  input: OpenAICompatibleEmbeddingProviderInput,
): OpenAICompatibleEmbeddingProvider {
  const normalizedBaseUrl = normalizeEmbeddingBaseUrl(input.baseUrl);
  const fetcher = input.fetchImpl ?? fetch;

  return {
    id: 'openai-compatible',
    model: input.model,
    dimensions: input.dimensions ?? 0,
    async embed(text: string, options?: { signal?: AbortSignal }): Promise<number[]> {
      const response = await requestEmbeddingEndpoint(`${normalizedBaseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: input.model, input: text }),
        signal: options?.signal,
      }, fetcher, input.apiKey);

      const responseText = await readEmbeddingResponseText(response, input.apiKey);
      if (!response.ok) {
        throw new Error(normalizeEmbeddingHttpError(responseText, response.status, input.apiKey));
      }

      return extractEmbeddingVector(parseEmbeddingPayload(responseText, input.apiKey));
    },
  };
}

export function normalizeEmbeddingBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('base_url is required');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('base_url must be a valid http(s) URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('base_url must be a valid http(s) URL');
  }
  if (url.username || url.password) {
    throw new Error('base_url must not include credentials');
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function sanitizeEmbeddingProviderError(errorTextOrError: unknown, apiKey: string): string {
  const rawMessage = errorTextOrError instanceof Error ? errorTextOrError.message : String(errorTextOrError);
  return redactCredentials(rawMessage, apiKey);
}

export async function testEmbeddingProvider(
  provider: KnowledgeEmbeddingProvider,
): Promise<{ ok: boolean; dimensions: number | null; error: string | null }> {
  try {
    const vector = await provider.embed('OpenDeepSea embedding provider health check');
    assertFiniteNumberVector(vector);
    return { ok: true, dimensions: vector.length, error: null };
  } catch (err) {
    return { ok: false, dimensions: null, error: sanitizeEmbeddingProviderError(err, '') };
  }
}

export async function testKnowledgeEmbeddingProvider(input: {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{
  ok: boolean;
  runtime: KnowledgeEmbeddingRuntime;
  dimensions: number | null;
  error: string | null;
}> {
  const runtime = getKnowledgeEmbeddingRuntime(input.env ?? process.env);
  try {
    const provider = getKnowledgeEmbeddingProvider(input);
    const vector = await provider.embed('OpenDeepSea knowledge embedding smoke test.');
    assertFiniteNumberVector(vector);
    return { ok: true, runtime, dimensions: vector.length, error: null };
  } catch (err) {
    return {
      ok: false,
      runtime,
      dimensions: null,
      error: sanitizeEmbeddingProviderError(err, ''),
    };
  }
}

async function requestEmbeddingEndpoint(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  apiKey: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error(`embedding request failed: ${sanitizeEmbeddingProviderError(err, apiKey)}`);
  }
}

async function readEmbeddingResponseText(response: Response, apiKey: string): Promise<string> {
  try {
    return await response.text();
  } catch (err) {
    throw new Error(`embedding response read failed: ${sanitizeEmbeddingProviderError(err, apiKey)}`);
  }
}

function parseEmbeddingPayload(responseText: string, apiKey: string): OpenAIEmbeddingPayload {
  try {
    return (responseText ? JSON.parse(responseText) : {}) as OpenAIEmbeddingPayload;
  } catch (err) {
    throw new Error(`embedding response is not valid JSON: ${sanitizeEmbeddingProviderError(err, apiKey)}`);
  }
}

function extractEmbeddingVector(payload: OpenAIEmbeddingPayload): number[] {
  if (!Array.isArray(payload.data) || !isRecord(payload.data[0])) {
    throw new Error('embedding response must include data[0].embedding');
  }

  const item = payload.data[0] as OpenAIEmbeddingPayloadItem;
  if (!Array.isArray(item.embedding)) {
    throw new Error('embedding response must include data[0].embedding');
  }

  return assertFiniteNumberVector(item.embedding);
}

function assertFiniteNumberVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error('embedding vector must contain only finite numbers');
  }
  return value;
}

function normalizeEmbeddingHttpError(responseText: string, status: number, apiKey: string): string {
  const extracted = extractErrorMessage(responseText);
  const detail = extracted ? `: ${sanitizeEmbeddingProviderError(extracted, apiKey)}` : '';
  return `embedding request failed: HTTP ${status}${detail}`;
}

function extractErrorMessage(responseText: string): string {
  const trimmed = responseText.trim();
  if (!trimmed) return '';

  try {
    const payload = JSON.parse(trimmed) as unknown;
    if (isRecord(payload)) {
      const error = payload.error;
      if (typeof error === 'string') return error;
      if (isRecord(error) && typeof error.message === 'string') return error.message;
      if (typeof payload.message === 'string') return payload.message;
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

function redactCredentials(value: string, apiKey: string): string {
  let redacted = value
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;)}]+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bBearer\s+[^\s,;)}]+/gi, 'Bearer [REDACTED_CREDENTIAL]')
    .replace(/\bapi[_-]?key\s*=\s*[^&\s]+/gi, 'api_key=[REDACTED_CREDENTIAL]')
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{6,}/g, '[REDACTED_CREDENTIAL]');

  if (apiKey) {
    redacted = redacted.split(apiKey).join('[REDACTED_CREDENTIAL]');
  }

  return redacted;
}

function resolveEmbeddingApiKey(settings: KnowledgeEmbeddingSettings, env: NodeJS.ProcessEnv): string | null {
  if (settings.api_key_env_var) {
    return normalizeOptionalString(env[settings.api_key_env_var]);
  }
  return normalizeOptionalString(settings.api_key);
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
