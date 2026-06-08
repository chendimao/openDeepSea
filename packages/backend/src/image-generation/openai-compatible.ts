import { Buffer } from 'node:buffer';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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

export type ChatCompletionsImageRequest = ImageGenerationRuntimeRequest;

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

interface ChatCompletionsPayload {
  choices?: unknown;
}

const MAX_DOWNLOADED_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_DOWNLOAD_REDIRECTS = 5;
const MAX_RUNTIME_RESPONSE_OVERHEAD_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_IMAGE_COUNT = 6;

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

  return parseImageRuntimeResponse(response, fetcher, input.signal, input.apiKey, input.count);
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

  return parseImageRuntimeResponse(response, fetcher, input.signal, input.apiKey, input.count);
}

export async function requestChatCompletionsImageGeneration(
  input: ChatCompletionsImageRequest,
): Promise<ImageGenerationRuntimeResponse> {
  const fetcher = input.fetchImpl ?? fetch;
  const normalizedBaseUrl = normalizeImageBaseUrl(input.baseUrl);
  const response = await requestImageRuntimeEndpoint(`${normalizedBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: 'user', content: input.prompt }],
      modalities: ['image', 'text'],
    }),
    signal: input.signal,
  }, fetcher, input.apiKey);

  return parseChatCompletionImageResponse(response, fetcher, input.signal, input.apiKey, input.count);
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
  maxImages: number,
): Promise<ImageGenerationRuntimeResponse> {
  const responseText = await readRuntimeResponseText(response, apiKey, maxImages);

  if (!response.ok) {
    throw new Error(normalizeImageGenerationError(responseText, response.status, apiKey));
  }

  const payload = parseImageRuntimePayload(responseText, apiKey);
  const images: ImageGenerationRuntimeImage[] = [];
  let totalImageBytes = 0;
  const items = Array.isArray(payload.data) ? payload.data : [];

  for (const rawItem of items) {
    if (images.length >= clampRuntimeImageCount(maxImages)) break;
    if (!isImageRuntimePayloadItem(rawItem)) continue;

    if (typeof rawItem.b64_json === 'string' && rawItem.b64_json) {
      totalImageBytes = appendRuntimeImage(
        images,
        { data: decodeBase64ImageData(rawItem.b64_json, apiKey), mimeType: 'image/png' },
        totalImageBytes,
        maxImages,
      );
      continue;
    }

    if (typeof rawItem.url !== 'string' || !rawItem.url) continue;

    if (rawItem.url.startsWith('data:')) {
      totalImageBytes = appendRuntimeImage(
        images,
        decodeDataUrlImage(rawItem.url, apiKey),
        totalImageBytes,
        maxImages,
      );
      continue;
    }

    totalImageBytes = appendRuntimeImage(
      images,
      await downloadImageUrl(rawItem.url, fetchImpl, signal, apiKey),
      totalImageBytes,
      maxImages,
    );
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

async function parseChatCompletionImageResponse(
  response: Response,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  apiKey: string,
  maxImages: number,
): Promise<ImageGenerationRuntimeResponse> {
  const responseText = await readRuntimeResponseText(response, apiKey, maxImages);

  if (!response.ok) {
    throw new Error(normalizeImageGenerationError(responseText, response.status, apiKey));
  }

  const payload = parseChatCompletionsPayload(responseText, apiKey);
  const images: ImageGenerationRuntimeImage[] = [];
  let totalImageBytes = 0;
  for (const url of extractChatCompletionImageUrls(payload)) {
    if (images.length >= clampRuntimeImageCount(maxImages)) break;
    if (url.startsWith('data:')) {
      totalImageBytes = appendRuntimeImage(
        images,
        decodeDataUrlImage(url, apiKey),
        totalImageBytes,
        maxImages,
      );
      continue;
    }
    totalImageBytes = appendRuntimeImage(
      images,
      await downloadImageUrl(url, fetchImpl, signal, apiKey),
      totalImageBytes,
      maxImages,
    );
  }
  return { images };
}

function parseChatCompletionsPayload(responseText: string, apiKey: string): ChatCompletionsPayload {
  try {
    return responseText ? JSON.parse(responseText) as ChatCompletionsPayload : {};
  } catch (err) {
    const detail = sanitizeRuntimeError(err, apiKey);
    throw new Error(`图片生成响应不是有效 JSON：${detail}`);
  }
}

function extractChatCompletionImageUrls(payload: ChatCompletionsPayload): string[] {
  const urls: string[] = [];
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const content = choice.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const url = extractChatImageUrl(item);
      if (url) urls.push(url);
    }
  }
  return urls;
}

function extractChatImageUrl(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const imageUrl = value.image_url;
  if (typeof imageUrl === 'string') return imageUrl;
  if (isRecord(imageUrl) && typeof imageUrl.url === 'string') return imageUrl.url;
  return null;
}

async function downloadImageUrl(
  url: string,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  apiKey: string,
): Promise<ImageGenerationRuntimeImage> {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MAX_IMAGE_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    await assertSafeImageDownloadUrl(currentUrl, fetchImpl);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, { signal, redirect: 'manual' });
    } catch (err) {
      throw new Error(`图片资源下载失败：${sanitizeRuntimeError(err, apiKey)}`);
    }

    if (isRedirectStatus(response.status)) {
      if (redirectCount >= MAX_IMAGE_DOWNLOAD_REDIRECTS) {
        throw new Error('图片资源下载失败：重定向次数过多');
      }
      currentUrl = resolveImageRedirectUrl(currentUrl, response.headers.get('location'));
      continue;
    }

    if (!response.ok) {
      throw new Error(`图片资源下载失败：HTTP ${response.status}`);
    }
    const mimeType = normalizeContentType(response.headers.get('content-type'));
    if (!mimeType.startsWith('image/')) {
      throw new Error('图片资源下载失败：响应不是图片');
    }

    return {
      data: await readImageResponseBuffer(response, apiKey),
      mimeType,
    };
  }

  throw new Error('图片资源下载失败：重定向次数过多');
}

async function assertSafeImageDownloadUrl(rawUrl: string, fetchImpl: FetchLike): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('图片资源下载地址不是有效 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('图片资源下载地址只允许 http(s) 协议');
  }
  assertPublicHostname(parsed.hostname);

  if (fetchImpl !== fetch || isIP(normalizeHostname(parsed.hostname)) !== 0) return;
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch {
    throw new Error('图片资源下载地址无法解析');
  }
  for (const address of addresses) {
    assertPublicHostname(address.address);
  }
}

function assertPublicHostname(hostname: string): void {
  const normalized = normalizeHostname(hostname);
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw new Error('图片资源下载地址不允许访问本机或私网地址');
  }
  const version = isIP(normalized);
  if (version === 0) return;
  if (isPrivateOrLocalIp(normalized, version === 4 ? 4 : 6)) {
    throw new Error('图片资源下载地址不允许访问本机或私网地址');
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function isPrivateOrLocalIp(ip: string, version: 0 | 4 | 6): boolean {
  if (version === 4) return isPrivateOrLocalIpv4(ip);
  if (version === 6) return isPrivateOrLocalIpv6(ip);
  return false;
}

function isPrivateOrLocalIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function isPrivateOrLocalIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateOrLocalIpv4(mappedIpv4) : false;
}

async function readImageResponseBuffer(response: Response, apiKey: string): Promise<Buffer> {
  const contentLength = parseContentLength(response.headers.get('content-length'));
  if (contentLength !== null && contentLength > MAX_DOWNLOADED_IMAGE_BYTES) {
    throw new Error('图片资源下载失败：响应超过大小限制');
  }

  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > MAX_DOWNLOADED_IMAGE_BYTES) {
      throw new Error('图片资源下载失败：响应超过大小限制');
    }
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > MAX_DOWNLOADED_IMAGE_BYTES) {
        throw new Error('图片资源下载失败：响应超过大小限制');
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('响应超过大小限制')) throw err;
    throw new Error(`图片资源下载失败：${sanitizeRuntimeError(err, apiKey)}`);
  }
  return Buffer.concat(chunks, total);
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function decodeDataUrlImage(url: string, apiKey: string): ImageGenerationRuntimeImage {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(url);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error('图片生成响应包含无效 data URL');
  }

  try {
    return {
      data: decodeBase64ImageData(match[2], apiKey),
      mimeType: match[1].toLowerCase(),
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('超过大小限制')) throw err;
    throw new Error(`图片生成响应包含无效 base64：${sanitizeRuntimeError(err, apiKey)}`);
  }
}

async function readRuntimeResponseText(response: Response, apiKey: string, maxImages: number): Promise<string> {
  const maxBytes = maxRuntimeResponseTextBytes(maxImages);
  const contentLength = parseContentLength(response.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBytes) {
    throw new Error('图片生成响应超过大小限制');
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('图片生成响应超过大小限制');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error('图片生成响应超过大小限制');
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('超过大小限制')) throw err;
    throw new Error(`图片生成响应读取失败：${sanitizeRuntimeError(err, apiKey)}`);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function maxRuntimeResponseTextBytes(maxImages: number): number {
  const imageCount = clampRuntimeImageCount(maxImages);
  const maxBase64BytesPerImage = Math.ceil(MAX_DOWNLOADED_IMAGE_BYTES / 3) * 4;
  return (maxBase64BytesPerImage * imageCount) + MAX_RUNTIME_RESPONSE_OVERHEAD_BYTES;
}

function appendRuntimeImage(
  images: ImageGenerationRuntimeImage[],
  image: ImageGenerationRuntimeImage,
  currentTotalBytes: number,
  maxImages: number,
): number {
  assertInlineImageSize(image.data.byteLength);
  const nextTotalBytes = currentTotalBytes + image.data.byteLength;
  if (nextTotalBytes > MAX_DOWNLOADED_IMAGE_BYTES * clampRuntimeImageCount(maxImages)) {
    throw new Error('图片生成响应包含超过大小限制的图片');
  }
  images.push(image);
  return nextTotalBytes;
}

function decodeBase64ImageData(value: string, apiKey: string): Buffer {
  assertInlineImageSize(estimateBase64DecodedBytes(value));
  try {
    const data = Buffer.from(value, 'base64');
    assertInlineImageSize(data.byteLength);
    return data;
  } catch (err) {
    if (err instanceof Error && err.message.includes('超过大小限制')) throw err;
    throw new Error(`图片生成响应包含无效 base64：${sanitizeRuntimeError(err, apiKey)}`);
  }
}

function estimateBase64DecodedBytes(value: string): number {
  let meaningfulLength = 0;
  let padding = 0;
  for (const char of value) {
    if (/\s/.test(char)) continue;
    meaningfulLength += 1;
    if (char === '=') padding += 1;
  }
  if (meaningfulLength === 0) return 0;
  return Math.max(0, Math.floor((meaningfulLength * 3) / 4) - Math.min(padding, 2));
}

function assertInlineImageSize(size: number): void {
  if (size > MAX_DOWNLOADED_IMAGE_BYTES) {
    throw new Error('图片生成响应包含超过大小限制的图片');
  }
}

function clampRuntimeImageCount(maxImages: number): number {
  if (!Number.isFinite(maxImages)) return 1;
  return Math.min(Math.max(Math.floor(maxImages), 1), MAX_RUNTIME_IMAGE_COUNT);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveImageRedirectUrl(currentUrl: string, location: string | null): string {
  if (!location?.trim()) {
    throw new Error('图片资源下载失败：重定向缺少 Location');
  }
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    throw new Error('图片资源下载失败：重定向地址不是有效 URL');
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
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
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
