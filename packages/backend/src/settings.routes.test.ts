import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-settings-routes-')), 'test.db');

const { router } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
