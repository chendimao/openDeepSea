import { normalizeImageBaseUrl } from './validation.js';

export type ImageProviderModel = {
  id: string;
  category: 'image' | 'other';
};

export interface ListImageProviderModelsInput {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}

export interface ListImageProviderModelsResult {
  normalized_base_url: string;
  models: ImageProviderModel[];
  warning: string | null;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function listImageProviderModels(input: ListImageProviderModelsInput): Promise<ListImageProviderModelsResult> {
  const normalizedBaseUrl = normalizeImageBaseUrl(input.baseUrl);
  const fetcher = input.fetchImpl ?? fetch;

  try {
    const response = await fetcher(`${normalizedBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });

    if (!response.ok) {
      return {
        normalized_base_url: normalizedBaseUrl,
        models: [],
        warning: `模型列表拉取失败：HTTP ${response.status}`,
      };
    }

    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    const models = (payload.data ?? [])
      .map((item) => String(item.id ?? '').trim())
      .filter(Boolean)
      .map((id): ImageProviderModel => ({ id, category: inferImageModelCategory(id) }));

    return { normalized_base_url: normalizedBaseUrl, models, warning: null };
  } catch (err) {
    return {
      normalized_base_url: normalizedBaseUrl,
      models: [],
      warning: `模型列表拉取失败：${sanitizeProviderModelError(err, input.apiKey)}`,
    };
  }
}

export function inferImageModelCategory(modelId: string): ImageProviderModel['category'] {
  const normalized = modelId.toLowerCase();
  if (
    normalized.includes('gpt-image') ||
    normalized.includes('dall-e') ||
    normalized.includes('imagen') ||
    normalized.includes('stable-diffusion') ||
    normalized.includes('sdxl') ||
    normalized.includes('flux') ||
    /\bimage\b/.test(normalized)
  ) {
    return 'image';
  }
  return 'other';
}

function sanitizeProviderModelError(err: unknown, apiKey: string): string {
  const rawMessage = err instanceof Error ? err.message : String(err);
  return redactCredentials(rawMessage, apiKey);
}

function redactCredentials(value: string, apiKey: string): string {
  let redacted = value;
  if (apiKey) {
    redacted = redacted.split(apiKey).join('[REDACTED_CREDENTIAL]');
  }

  return redacted
    .replace(/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_CREDENTIAL]')
    .replace(/\bapi[_-]?key\s*=\s*[^&\s]+/gi, 'api_key=[REDACTED_CREDENTIAL]');
}
