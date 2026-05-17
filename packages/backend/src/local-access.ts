import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const LOCAL_ACCESS_TOKEN_HEADER = 'x-opendeepsea-local-token';

type HeaderValue = string | string[] | undefined;
type HeaderReader = IncomingHttpHeaders | Headers;

export type LocalAccessRequest = {
  method?: string;
  headers?: IncomingHttpHeaders | Headers;
};

export type LocalAccessValidationResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string };

let generatedLocalAccessToken: string | null = null;

export function createLocalAccessToken(): string {
  return randomBytes(24).toString('base64url');
}

export function getLocalAccessToken(): string {
  const configured = process.env.OPENDEEPSEA_LOCAL_TOKEN?.trim();
  if (configured) return configured;
  if (!generatedLocalAccessToken) {
    generatedLocalAccessToken = createLocalAccessToken();
  }
  return generatedLocalAccessToken;
}

export function readLocalAccessTokenHeader(headers?: HeaderReader): string | null {
  const value = readHeader(headers, LOCAL_ACCESS_TOKEN_HEADER);
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function isTrustedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
}

export function validateLocalAccess(
  req: LocalAccessRequest,
  expectedToken: string = getLocalAccessToken(),
): LocalAccessValidationResult {
  const origin = readHeader(req.headers, 'origin');
  if (origin && !isTrustedOrigin(origin)) {
    return { ok: false, status: 403, error: 'origin is not trusted' };
  }

  const providedToken = readLocalAccessTokenHeader(req.headers);
  if (!providedToken || providedToken !== expectedToken) {
    return { ok: false, status: 401, error: 'invalid local access token' };
  }

  return { ok: true };
}

function readHeader(headers: HeaderReader | undefined, key: string): string | null {
  if (!headers) return null;

  if (headers instanceof Headers) {
    const value = headers.get(key);
    return value === null ? null : value;
  }

  const value = headers[key] as HeaderValue;
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
