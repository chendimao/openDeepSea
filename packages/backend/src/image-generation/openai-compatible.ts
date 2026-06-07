import { Buffer } from 'node:buffer';

export interface ImageGenerationRuntimeRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  count: number;
  quality: string;
  size: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

export interface ImageGenerationEditRuntimeRequest extends ImageGenerationRuntimeRequest {
  sourceImages: ImageGenerationRuntimeSourceImage[];
}

export interface ImageGenerationRuntimeSourceImage {
  data: Buffer | Uint8Array | ArrayBuffer;
  mimeType: string;
  name: string;
}

export interface ImageGenerationRuntimeImage {
  data: Buffer;
  mimeType: string;
}

export interface ImageGenerationRuntimeResponse {
  images: ImageGenerationRuntimeImage[];
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface ImageRuntimePayload {
  data?: unknown;
}

interface ImageRuntimePayloadItem {
  b64_json?: unknown;
  url?: unknown;
}

export async function requestOpenAICompatibleImageGeneration(
  input: ImageGenerationRuntimeRequest,
): Promise<ImageGenerationRuntimeResponse> {
  const fetcher = input.fetchImpl ?? fetch;
  const normalizedBaseUrl = normalizeImageBaseUrl(input.baseUrl);
  const response = await requestImageRuntimeEndpoint(`${normalizedBaseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildImageGenerationPayload(input)),
    signal: input.signal,
  }, fetcher, input.apiKey);

  return parseImageRuntimeResponse(response, fetcher, input.signal, input.apiKey);
}

export async function requestOpenAICompatibleImageEdit(
  input: ImageGenerationEditRuntimeRequest,
): Promise<ImageGenerationRuntimeResponse> {
  const fetcher = input.fetchImpl ?? fetch;
  const normalizedBaseUrl = normalizeImageBaseUrl(input.baseUrl);
  const body = new FormData();
  body.set('model', input.model);
  body.set('prompt', input.prompt);
  body.set('n', String(input.count));
  if (input.quality !== 'auto') body.set('quality', input.quality);
  if (input.size !== 'auto') body.set('size', input.size);

  for (const source of input.sourceImages) {
    body.append('image[]', new Blob([toArrayBuffer(source.data)], { type: source.mimeType }), source.name);
  }

  const response = await requestImageRuntimeEndpoint(`${normalizedBaseUrl}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}` },
    body,
    signal: input.signal,
  }, fetcher, input.apiKey);

  return parseImageRuntimeResponse(response, fetcher, input.signal, input.apiKey);
}

function buildImageGenerationPayload(input: ImageGenerationRuntimeRequest): Record<string, string | number> {
  return {
    model: input.model,
    prompt: input.prompt,
    n: input.count,
    ...(input.quality === 'auto' ? {} : { quality: input.quality }),
    ...(input.size === 'auto' ? {} : { size: input.size }),
  };
}

async function requestImageRuntimeEndpoint(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  apiKey: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error(`图片生成请求失败：${sanitizeRuntimeError(err, apiKey)}`);
  }
}

async function parseImageRuntimeResponse(
  response: Response,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  apiKey: string,
): Promise<ImageGenerationRuntimeResponse> {
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(normalizeImageGenerationError(responseText, response.status, apiKey));
  }

  const payload = parseImageRuntimePayload(responseText, apiKey);
  const images: ImageGenerationRuntimeImage[] = [];
  const items = Array.isArray(payload.data) ? payload.data : [];

  for (const rawItem of items) {
    if (!isImageRuntimePayloadItem(rawItem)) continue;

    if (typeof rawItem.b64_json === 'string' && rawItem.b64_json) {
      images.push({ data: Buffer.from(rawItem.b64_json, 'base64'), mimeType: 'image/png' });
      continue;
    }

    if (typeof rawItem.url !== 'string' || !rawItem.url) continue;

    if (rawItem.url.startsWith('data:')) {
      images.push(decodeDataUrlImage(rawItem.url, apiKey));
      continue;
    }

    images.push(await downloadImageUrl(rawItem.url, fetchImpl, signal, apiKey));
  }

  return { images };
}

function parseImageRuntimePayload(responseText: string, apiKey: string): ImageRuntimePayload {
  try {
    return responseText ? JSON.parse(responseText) as ImageRuntimePayload : {};
  } catch (err) {
    const detail = sanitizeRuntimeError(err, apiKey);
    throw new Error(`图片生成响应不是有效 JSON：${detail}`);
  }
}

async function downloadImageUrl(
  url: string,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  apiKey: string,
): Promise<ImageGenerationRuntimeImage> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (err) {
    throw new Error(`图片资源下载失败：${sanitizeRuntimeError(err, apiKey)}`);
  }

  if (!response.ok) {
    throw new Error(`图片资源下载失败：HTTP ${response.status}`);
  }

  return {
    data: Buffer.from(await response.arrayBuffer()),
    mimeType: normalizeContentType(response.headers.get('content-type')),
  };
}

function decodeDataUrlImage(url: string, apiKey: string): ImageGenerationRuntimeImage {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(url);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error('图片生成响应包含无效 data URL');
  }

  try {
    return {
      data: Buffer.from(match[2], 'base64'),
      mimeType: match[1].toLowerCase(),
    };
  } catch (err) {
    throw new Error(`图片生成响应包含无效 base64：${sanitizeRuntimeError(err, apiKey)}`);
  }
}

function normalizeImageGenerationError(responseText: string, status: number, apiKey: string): string {
  const extracted = extractErrorMessage(responseText);
  const detail = extracted ? `：${redactCredentials(extracted, apiKey)}` : '';
  return `图片生成失败：HTTP ${status}${detail}`;
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

function isImageRuntimePayloadItem(value: unknown): value is ImageRuntimePayloadItem {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function normalizeContentType(value: string | null): string {
  const mimeType = value?.split(';', 1)[0]?.trim();
  return mimeType || 'image/png';
}

function normalizeImageBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('base_url is required');

  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new Error('base_url must be a valid http(s) URL');
  }
}

function toArrayBuffer(data: Buffer | Uint8Array | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0);

  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function sanitizeRuntimeError(err: unknown, apiKey: string): string {
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
