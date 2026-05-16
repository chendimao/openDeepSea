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
  const server = app.listen(0);
  try {
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
