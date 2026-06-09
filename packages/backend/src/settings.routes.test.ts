import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-settings-routes-')), 'test.db');

const { settingsRepo } = await import('./repos/settings.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
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

test('system knowledge embedding settings patch accepts safe fields only', async () => {
  const unsafeRes = await request('/api/settings/system/knowledge-embedding', {
    method: 'PATCH',
    body: JSON.stringify({
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      baseUrl: 'https://embedding.example/v1',
      apiKeyEnvVar: 'OPENDEEPSEA_EMBEDDING_API_KEY',
      apiKey: 'sk-must-not-be-accepted',
    }),
  });

  assert.equal(unsafeRes.status, 400);

  const safeRes = await request('/api/settings/system/knowledge-embedding', {
    method: 'PATCH',
    body: JSON.stringify({
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      baseUrl: 'https://embedding.example/v1',
      apiKeyEnvVar: 'OPENDEEPSEA_EMBEDDING_API_KEY',
    }),
  });
  assert.equal(safeRes.status, 200);
  const body = await safeRes.json() as Record<string, unknown>;
  assert.equal(body.knowledge_embedding_provider, 'openai-compatible');
  assert.equal(body.knowledge_embedding_model, 'text-embedding-3-small');
  assert.equal(body.knowledge_embedding_dimensions, 1536);
  assert.equal(body.knowledge_embedding_base_url, 'https://embedding.example/v1');
  assert.equal(body.knowledge_embedding_api_key_env_var, 'OPENDEEPSEA_EMBEDDING_API_KEY');
  assert.equal('knowledge_embedding_api_key' in body, false);
  assert.equal(JSON.stringify(body).includes('sk-must-not-be-accepted'), false);

  const credentialedBaseUrlRes = await request('/api/settings/system/knowledge-embedding', {
    method: 'PATCH',
    body: JSON.stringify({
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      baseUrl: 'https://user:secret@embedding.example/v1',
      apiKeyEnvVar: 'OPENDEEPSEA_EMBEDDING_API_KEY',
    }),
  });
  assert.equal(credentialedBaseUrlRes.status, 400);

  const fetched = settingsRepo.getSystem();
  assert.equal(fetched.knowledge_embedding_base_url, 'https://embedding.example/v1');
  assert.equal(JSON.stringify(fetched).includes('secret@embedding.example'), false);
});

test('system settings route stores global session prompt and rejects oversized prompt', async () => {
  const patchRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({
      global_session_prompt: '  全局优先：先说明计划。\n',
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as Record<string, unknown>;
  assert.equal(patched.global_session_prompt, '全局优先：先说明计划。');

  const getRes = await request('/api/settings/system');
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json() as Record<string, unknown>;
  assert.equal(fetched.global_session_prompt, '全局优先：先说明计划。');

  const clearRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({ global_session_prompt: '   ' }),
  });
  assert.equal(clearRes.status, 200);
  const cleared = await clearRes.json() as Record<string, unknown>;
  assert.equal(cleared.global_session_prompt, null);

  const oversizedRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({ global_session_prompt: 'x'.repeat(12001) }),
  });
  assert.equal(oversizedRes.status, 400);
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

test('project settings route saves session planner backend and used agents route returns planner', async () => {
  const project = projectRepo.create({
    name: 'Settings Route Planner Backend',
    path: mkdtempSync(join(tmpdir(), 'settings-route-planner-backend-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Planner Route Room', ensureDefaultPlanner: false });
  roomAgentRepo.add({ room_id: room.id, agent_id: 'local-reviewer', agent_name: 'Local Reviewer' });

  const patchRes = await request(`/api/projects/${project.id}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ session_planner_acp_backend: 'opencode' }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as {
    effective: { session_planner_acp_backend: unknown };
    sources: { session_planner_acp_backend: unknown };
  };
  assert.equal(patched.effective.session_planner_acp_backend, 'opencode');
  assert.equal(patched.sources.session_planner_acp_backend, 'project');

  const usedRes = await request(`/api/projects/${project.id}/agents/used`);
  assert.equal(usedRes.status, 200);
  const used = await usedRes.json() as {
    planner: { agent_id: string; effective_acp_backend: string; backend_source: string };
    agents: Array<{ agent_id: string; room_bindings: unknown[] }>;
  };
  assert.equal(used.planner.agent_id, 'planner');
  assert.equal(used.planner.effective_acp_backend, 'opencode');
  assert.equal(used.planner.backend_source, 'project');
  assert.deepEqual(used.agents.map((agent) => agent.agent_id), ['local-reviewer']);
  assert.equal(used.agents[0]?.room_bindings.length, 1);
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
