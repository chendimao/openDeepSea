import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-settings-routes-')), 'test.db');

const { settingsRepo } = await import('./repos/settings.js');
const { router, setAiConfigTestRouteDeps } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

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
  if (body) {
    req.headers['content-length'] = String(body.byteLength);
  }

  const res = new ServerResponse(req);
  res.assignSocket(socket as unknown as import('node:net').Socket);

  const chunks: Buffer[] = [];
  res.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    }
    if (typeof encoding === 'function') encoding();
    if (callback) callback();
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    }
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

  if (body) {
    req.push(body);
  }
  req.push(null);
  req.complete = true;

  return responsePromise;
}

test.afterEach(() => {
  setAiConfigTestRouteDeps({});
});

function clearAiConfigs(): void {
  for (const config of settingsRepo.listAiConfigs()) {
    settingsRepo.deleteAiConfig(config.id);
  }
}

test('system settings route trims planner fields and never returns raw api key', async () => {
  const patchRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({
      langchain_planner_model: ' gpt-4.1 ',
      openai_base_url: ' https://openai.example/v1 ',
      openai_api_key: ' sk-route-secret1234 ',
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as Record<string, unknown>;
  assert.equal(patched.langchain_planner_model, 'gpt-4.1');
  assert.equal(patched.openai_base_url, 'https://openai.example/v1');
  assert.equal(patched.openai_api_key_set, true);
  assert.equal(patched.openai_api_key_preview, 'sk-...1234');
  assert.equal('openai_api_key' in patched, false);

  const preserveRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({
      langchain_planner_model: ' gpt-4o-mini ',
    }),
  });
  assert.equal(preserveRes.status, 200);
  const preserved = await preserveRes.json() as Record<string, unknown>;
  assert.equal(preserved.langchain_planner_model, 'gpt-4o-mini');
  assert.equal(preserved.openai_api_key_set, true);
  assert.equal(preserved.openai_api_key_preview, 'sk-...1234');
  assert.equal('openai_api_key' in preserved, false);

  const clearRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({
      langchain_planner_model: '   ',
      openai_base_url: '',
      openai_api_key: '',
    }),
  });
  assert.equal(clearRes.status, 200);
  const cleared = await clearRes.json() as Record<string, unknown>;
  assert.equal(cleared.langchain_planner_model, null);
  assert.equal(cleared.openai_base_url, null);
  assert.equal(cleared.openai_api_key_set, false);
  assert.equal(cleared.openai_api_key_preview, null);
  assert.equal('openai_api_key' in cleared, false);

  const getRes = await request('/api/settings/system');
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json() as Record<string, unknown>;
  assert.equal(fetched.openai_api_key_set, false);
  assert.equal('openai_api_key' in fetched, false);
});

test('settings routes persist superpowers bootstrap owner without affecting AI config secrets', async () => {
  const systemRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({
      superpowers_bootstrap_owner: 'project',
      openai_api_key: 'test-route-secret',
    }),
  });
  assert.equal(systemRes.status, 200);
  const system = await systemRes.json() as Record<string, unknown>;
  assert.equal(system.superpowers_bootstrap_owner, 'project');
  assert.equal(system.openai_api_key_set, true);
  assert.equal(system.openai_api_key, undefined);

  const invalidRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({ superpowers_bootstrap_owner: 'both' }),
  });
  assert.equal(invalidRes.status, 400);
});

test('settings routes reject removed fallback_route mode', async () => {
  const res = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({
      message_routing_mode: 'fallback_route',
      fallback_agent_id: 'planner',
    }),
  });

  assert.equal(res.status, 400);
});

test('settings routes persist AI configs and keep the selected config after refetch', async () => {
  clearAiConfigs();

  const createPrimaryRes = await request('/api/settings/ai-configs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Primary',
      langchain_planner_model: ' gpt-4.1 ',
      openai_base_url: ' https://primary.example ',
      openai_api_key: ' sk-primary1234 ',
      activate: true,
    }),
  });
  assert.equal(createPrimaryRes.status, 201);
  const primary = await createPrimaryRes.json() as Record<string, unknown>;
  assert.equal(primary.name, 'Primary');
  assert.equal(primary.langchain_planner_model, 'gpt-4.1');
  assert.equal(primary.openai_base_url, 'https://primary.example');
  assert.equal(primary.openai_api_key_set, true);
  assert.equal(primary.openai_api_key_preview, 'sk-...1234');
  assert.equal('openai_api_key' in primary, false);

  const createSecondaryRes = await request('/api/settings/ai-configs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Secondary',
      langchain_planner_model: 'gpt-4o-mini',
      openai_base_url: 'https://secondary.example/v1',
      openai_api_key: 'sk-secondary1234',
    }),
  });
  assert.equal(createSecondaryRes.status, 201);
  const secondary = await createSecondaryRes.json() as Record<string, unknown>;

  const activateRes = await request(`/api/settings/ai-configs/${secondary.id}/activate`, { method: 'POST' });
  assert.equal(activateRes.status, 200);

  const getRes = await request('/api/settings/system');
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json() as Record<string, unknown> & {
    ai_configs: Array<Record<string, unknown>>;
  };
  assert.equal(fetched.active_ai_config_id, secondary.id);
  assert.equal(fetched.langchain_planner_model, 'gpt-4o-mini');
  assert.equal(fetched.openai_base_url, 'https://secondary.example/v1');
  assert.equal(fetched.openai_api_key_set, true);
  assert.equal(fetched.ai_configs.length, 2);
  assert.equal(fetched.ai_configs.some((item) => 'openai_api_key' in item), false);

  const listRes = await request('/api/settings/ai-configs');
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as {
    active_ai_config_id: unknown;
    items: Array<Record<string, unknown>>;
  };
  assert.equal(listed.active_ai_config_id, secondary.id);
  assert.equal(listed.items.length, 2);
  assert.equal(listed.items.some((item) => 'openai_api_key' in item), false);
});

test('settings routes preserve config api key on edit and auto-switch when deleting active config', async () => {
  clearAiConfigs();

  const firstRes = await request('/api/settings/ai-configs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'First',
      langchain_planner_model: 'first-model',
      openai_base_url: 'https://first.example/v1',
      openai_api_key: 'sk-first1234',
      activate: true,
    }),
  });
  assert.equal(firstRes.status, 201);
  const first = await firstRes.json() as Record<string, unknown>;

  const secondRes = await request('/api/settings/ai-configs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Second',
      langchain_planner_model: 'second-model',
      openai_base_url: 'https://second.example/v1',
      openai_api_key: 'sk-second1234',
    }),
  });
  assert.equal(secondRes.status, 201);
  const second = await secondRes.json() as Record<string, unknown>;

  const editSecondRes = await request(`/api/settings/ai-configs/${second.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: 'Second edited',
      langchain_planner_model: 'second-edited-model',
    }),
  });
  assert.equal(editSecondRes.status, 200);
  const editedSecond = await editSecondRes.json() as Record<string, unknown>;
  assert.equal(editedSecond.openai_api_key_set, true);

  const deleteFirstRes = await request(`/api/settings/ai-configs/${first.id}`, { method: 'DELETE' });
  assert.equal(deleteFirstRes.status, 204);

  const getRes = await request('/api/settings/system');
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json() as Record<string, unknown> & {
    ai_configs: Array<Record<string, unknown>>;
  };
  assert.equal(fetched.active_ai_config_id, second.id);
  assert.equal(fetched.langchain_planner_model, 'second-edited-model');
  assert.equal(fetched.ai_configs.length, 1);
});

test('settings route tests a saved AI config without exposing api key or activating it', async () => {
  clearAiConfigs();

  const invocations: string[] = [];
  setAiConfigTestRouteDeps({
    tester: {
      async invoke(messages) {
        invocations.push(String(messages[1]?.content ?? ''));
        return ' route model ok ';
      },
    },
  });

  const createActiveRes = await request('/api/settings/ai-configs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Active route test',
      langchain_planner_model: 'active-route-model',
      openai_base_url: 'https://active-route.example/v1',
      openai_api_key: 'sk-active-route1234',
      activate: true,
    }),
  });
  assert.equal(createActiveRes.status, 201);
  const active = await createActiveRes.json() as Record<string, unknown>;

  const createCandidateRes = await request('/api/settings/ai-configs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Candidate route test',
      langchain_planner_model: 'candidate-route-model',
      openai_base_url: 'https://candidate-route.example/v1',
      openai_api_key: 'sk-candidate-route5678',
    }),
  });
  assert.equal(createCandidateRes.status, 201);
  const candidate = await createCandidateRes.json() as Record<string, unknown>;

  const testRes = await request(`/api/settings/ai-configs/${candidate.id}/test`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'route connectivity check' }),
  });
  assert.equal(testRes.status, 200);
  const result = await testRes.json() as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'success');
  assert.equal(result.model, 'candidate-route-model');
  assert.equal(result.baseURL, 'https://candidate-route.example/v1');
  assert.equal(result.output, 'route model ok');
  assert.equal(typeof result.tested_at, 'number');
  assert.deepEqual(invocations, ['route connectivity check']);
  assert.equal('openai_api_key' in result, false);
  assert.equal(JSON.stringify(result).includes('sk-candidate-route5678'), false);

  const systemRes = await request('/api/settings/system');
  assert.equal(systemRes.status, 200);
  const system = await systemRes.json() as Record<string, unknown>;
  assert.equal(system.active_ai_config_id, active.id);
});

test('settings route returns sanitized model test failures and missing configs', async () => {
  clearAiConfigs();

  setAiConfigTestRouteDeps({
    tester: {
      async invoke() {
        throw new Error('Authorization: Bearer sk-failing-route9999 failed');
      },
    },
  });

  const createRes = await request('/api/settings/ai-configs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Failing route test',
      langchain_planner_model: 'failing-route-model',
      openai_base_url: 'https://failing-route.example/v1',
      openai_api_key: 'sk-failing-route9999',
    }),
  });
  assert.equal(createRes.status, 201);
  const config = await createRes.json() as Record<string, unknown>;

  const testRes = await request(`/api/settings/ai-configs/${config.id}/test`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'fail with sk-failing-route9999' }),
  });
  assert.equal(testRes.status, 502);
  const failure = await testRes.json() as Record<string, unknown>;
  assert.equal(failure.ok, false);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.model, 'failing-route-model');
  assert.equal(failure.output, null);
  assert.equal(typeof failure.tested_at, 'number');
  assert.match(String(failure.error), /\[REDACTED/);
  assert.equal(String(failure.error).includes('sk-failing-route9999'), false);

  const missingRes = await request('/api/settings/ai-configs/missing-config/test', {
    method: 'POST',
  });
  assert.equal(missingRes.status, 404);
});

test('settings route reports missing API key without invoking model tester', async () => {
  clearAiConfigs();

  let invoked = false;
  setAiConfigTestRouteDeps({
    tester: {
      async invoke() {
        invoked = true;
        return 'unexpected';
      },
    },
  });

  const createRes = await request('/api/settings/ai-configs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'No key route test',
      langchain_planner_model: 'no-key-route-model',
      openai_base_url: 'https://no-key-route.example/v1',
      openai_api_key: null,
    }),
  });
  assert.equal(createRes.status, 201);
  const config = await createRes.json() as Record<string, unknown>;

  const testRes = await request(`/api/settings/ai-configs/${config.id}/test`, {
    method: 'POST',
  });
  assert.equal(testRes.status, 400);
  const result = await testRes.json() as Record<string, unknown>;
  assert.equal(invoked, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'missing_credentials');
  assert.equal(result.model, 'no-key-route-model');
  assert.equal(result.baseURL, 'https://no-key-route.example/v1');
  assert.equal(result.output, null);
  assert.equal(result.error, 'AI config requires both model and API key');
  assert.equal(typeof result.tested_at, 'number');
  assert.equal('openai_api_key' in result, false);
});
