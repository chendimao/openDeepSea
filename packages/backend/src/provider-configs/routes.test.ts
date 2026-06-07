import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-provider-config-routes-')), 'test.db');

const { db } = await import('../db.js');
const { router } = await import('../routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);
app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

class InMemorySocket extends Duplex {
  _read(): void {}

  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function toResponseHeaders(headers: OutgoingHttpHeaders): Headers {
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(name, item);
    } else {
      responseHeaders.set(name, String(value));
    }
  }
  return responseHeaders;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const serializedRequest = new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = init.body === undefined || init.body === null
    ? null
    : Buffer.from(await serializedRequest.arrayBuffer());
  const socket = new InMemorySocket();
  const req = new IncomingMessage(socket as unknown as import('node:net').Socket);
  req.method = init.method ?? 'GET';
  req.url = path;
  req.headers = Object.fromEntries(serializedRequest.headers);
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  if (body) req.headers['content-length'] = String(body.byteLength);

  const res = new ServerResponse(req);
  res.assignSocket(socket as unknown as import('node:net').Socket);

  const chunks: Buffer[] = [];
  res.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    if (typeof encoding === 'function') encoding();
    if (callback) callback();
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    if (typeof encoding === 'function') encoding();
    if (callback) callback();
    res.emit('finish');
    res.emit('close');
    return res;
  }) as typeof res.end;

  const responsePromise = new Promise<Response>((resolve, reject) => {
    res.once('finish', () => {
      const responseBody = res.statusCode === 204 || res.statusCode === 304 ? null : Buffer.concat(chunks);
      resolve(new Response(responseBody, {
        status: res.statusCode,
        headers: toResponseHeaders(res.getHeaders()),
      }));
    });
    (app as unknown as { handle: (...args: unknown[]) => void }).handle(req, res, (error: unknown) => {
      if (error) reject(error);
    });
  });

  if (body) req.push(body);
  req.push(null);
  req.complete = true;

  return responsePromise;
}

test.afterEach(() => {
  db.prepare('DELETE FROM provider_profiles').run();
  db.prepare('DELETE FROM provider_config_snapshots').run();
  db.prepare('DELETE FROM provider_config_sources').run();
});

test('provider config routes sync selected config directory and redact secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-config-routes-'));
  const openCodeDir = join(root, 'opencode');
  mkdirSync(openCodeDir, { recursive: true });
  writeFileSync(join(openCodeDir, 'opencode.json'), JSON.stringify({
    model: 'gwenapi/gpt-5.5',
    provider: {
      gwenapi: {
        baseURL: 'https://yuzapi.fun',
        apiKey: 'sk-opencode-secret1234',
        models: {
          'gpt-5.5': {
            options: { reasoningEffort: 'high' },
          },
        },
      },
    },
  }));

  const sourceRes = await request('/api/settings/provider-configs/opencode/source', {
    method: 'PATCH',
    body: JSON.stringify({ use_default_config_dir: false, config_dir: openCodeDir }),
  });
  assert.equal(sourceRes.status, 200);

  const syncRes = await request('/api/settings/provider-configs/opencode/sync', { method: 'POST' });
  assert.equal(syncRes.status, 200);
  const payload = await syncRes.json() as { snapshot: Record<string, unknown> };
  assert.equal(payload.snapshot.detected_model, 'gwenapi/gpt-5.5');
  assert.equal(payload.snapshot.detected_base_url, 'https://yuzapi.fun');
  assert.equal(payload.snapshot.reasoning_effort, 'high');
  assert.equal(payload.snapshot.api_key_preview, 'sk-...1234');
  assert.equal(JSON.stringify(payload).includes('sk-opencode-secret1234'), false);
});

test('provider profile routes activate one profile per provider', async () => {
  const firstRes = await request('/api/settings/provider-profiles', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Codex first',
      provider: 'codex',
      model: 'gpt-5.1',
      activate: true,
    }),
  });
  assert.equal(firstRes.status, 201);
  const first = await firstRes.json() as Record<string, unknown>;

  const secondRes = await request('/api/settings/provider-profiles', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Codex second',
      provider: 'codex',
      model: 'gpt-5.5',
    }),
  });
  assert.equal(secondRes.status, 201);
  const second = await secondRes.json() as Record<string, unknown>;

  const activateRes = await request(`/api/settings/provider-profiles/${second.id}/activate`, { method: 'POST' });
  assert.equal(activateRes.status, 200);

  const listRes = await request('/api/settings/provider-configs');
  assert.equal(listRes.status, 200);
  const list = await listRes.json() as { profiles: Array<Record<string, unknown>> };
  assert.equal(list.profiles.find((profile) => profile.id === first.id)?.is_active, false);
  assert.equal(list.profiles.find((profile) => profile.id === second.id)?.is_active, true);
});

test('provider config routes import snapshot into managed profile explicitly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-config-import-route-'));
  const claudeDir = join(root, 'claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_MODEL: 'claude-sonnet-4.5',
      ANTHROPIC_BASE_URL: 'https://claude.example',
      ANTHROPIC_API_KEY: 'sk-claude-secret1234',
    },
  }));

  await request('/api/settings/provider-configs/claudecode/source', {
    method: 'PATCH',
    body: JSON.stringify({ use_default_config_dir: false, config_dir: claudeDir }),
  });
  const syncRes = await request('/api/settings/provider-configs/claudecode/sync', { method: 'POST' });
  assert.equal(syncRes.status, 200);

  const listBefore = await (await request('/api/settings/provider-configs')).json() as { profiles: unknown[] };
  assert.equal(listBefore.profiles.length, 0);

  const importRes = await request('/api/settings/provider-configs/claudecode/import-profile', { method: 'POST' });
  assert.equal(importRes.status, 201);
  const imported = await importRes.json() as Record<string, unknown>;
  assert.equal(imported.provider, 'claudecode');
  assert.equal(imported.model, 'claude-sonnet-4.5');
  assert.equal(imported.base_url, 'https://claude.example');
  assert.equal(imported.api_key_set, true);
  assert.equal(imported.api_key_preview, 'sk-...1234');
  assert.equal(JSON.stringify(imported).includes('sk-claude-secret1234'), false);
});

test('provider config routes keep old snapshot on failed sync', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-config-failed-route-'));
  const codexDir = join(root, 'codex');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'config.toml'), 'model = "gpt-5.5"\n');

  await request('/api/settings/provider-configs/codex/source', {
    method: 'PATCH',
    body: JSON.stringify({ use_default_config_dir: false, config_dir: codexDir }),
  });
  assert.equal((await request('/api/settings/provider-configs/codex/sync', { method: 'POST' })).status, 200);
  await request('/api/settings/provider-configs/codex/source', {
    method: 'PATCH',
    body: JSON.stringify({ use_default_config_dir: false, config_dir: join(root, 'missing') }),
  });

  const failedRes = await request('/api/settings/provider-configs/codex/sync', { method: 'POST' });
  assert.equal(failedRes.status, 200);
  const failed = await failedRes.json() as {
    source: Record<string, unknown>;
    snapshot: Record<string, unknown> | null;
  };
  assert.equal(failed.source.last_sync_status, 'failed');
  assert.match(String(failed.source.last_sync_error), /missing_dir/);
  assert.equal(failed.snapshot?.detected_model, 'gpt-5.5');
});
