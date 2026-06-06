import type { IncomingHttpHeaders } from 'node:http';
import { getLocalAccessToken, isTrustedOrigin } from './local-access.js';

type WebSocketAccessRequest = {
  headers: IncomingHttpHeaders;
  url?: string | null;
};

export type WebSocketAccessResult =
  | { ok: true }
  | { ok: false; status: 403; reason: string };

export function validateWebSocketAccess(req: WebSocketAccessRequest): WebSocketAccessResult {
  const origin = readHeader(req.headers, 'origin');
  const token = readWebSocketLocalToken(req);

  if (origin && !isTrustedOrigin(origin)) {
    return { ok: false, status: 403, reason: 'origin is not trusted' };
  }

  if (token && token !== getLocalAccessToken()) {
    return { ok: false, status: 403, reason: 'invalid local access token' };
  }

  if (!origin && token !== getLocalAccessToken()) {
    return { ok: false, status: 403, reason: 'invalid local access token' };
  }

  return { ok: true };
}

function readWebSocketLocalToken(req: WebSocketAccessRequest): string | null {
  const protocolToken = readProtocolToken(req.headers);
  if (protocolToken) return protocolToken;

  const url = req.url ?? '';
  try {
    const parsed = new URL(url, 'ws://localhost');
    const token = parsed.searchParams.get('localToken')?.trim();
    return token || null;
  } catch {
    return null;
  }
}

function readProtocolToken(headers: IncomingHttpHeaders): string | null {
  const value = readHeader(headers, 'sec-websocket-protocol');
  if (!value) return null;
  const token = value
    .split(',')
    .map((item) => item.trim())
    .find((item) => item.startsWith('opendeepsea.local-token.'));
  return token ? token.slice('opendeepsea.local-token.'.length).trim() || null : null;
}

function readHeader(headers: IncomingHttpHeaders, key: string): string | null {
  const value = headers[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
