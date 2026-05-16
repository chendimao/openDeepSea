import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
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

test('global agent routes create, list, update, protect referenced deletes, and delete unused agents', async () => {
  const createRes = await request('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: 'frontend-lead',
      name: '前端执行官',
      description: '负责前端实现和验收。',
      preferred_user_name: '陈工',
      personality: '严谨、直接。',
      rules: '完成前必须验证。',
      responsibilities: '前端实现。',
      default_acp_backend: 'codex',
      default_acp_permission_mode: 'workspace-write',
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as { id: string; agent_id: string; reference_count: number };
  assert.equal(created.agent_id, 'frontend-lead');
  assert.equal(created.reference_count, 0);

  const listRes = await request('/api/agents');
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as Array<{ id: string; name: string }>;
  assert.ok(listed.some((agent) => agent.id === created.id && agent.name === '前端执行官'));

  const patchRes = await request(`/api/agents/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      personality: '冷静、务实。',
      rules: '不要修改无关文件。',
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as { personality: string; rules: string };
  assert.equal(patched.personality, '冷静、务实。');
  assert.equal(patched.rules, '不要修改无关文件。');

  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-agent-routes-project-'));
  const project = projectRepo.create({ name: 'Agent API Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Agent API Room' });

  const inviteRes = await request(`/api/rooms/${room.id}/agents`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_id: created.id }),
  });
  assert.equal(inviteRes.status, 201);
  const roomAgent = await inviteRes.json() as {
    global_agent_id: string;
    agent_id: string;
    agent_name: string;
    personality: string;
    acp_backend: string;
  };
  assert.equal(roomAgent.global_agent_id, created.id);
  assert.equal(roomAgent.agent_id, 'frontend-lead');
  assert.equal(roomAgent.agent_name, '前端执行官');
  assert.equal(roomAgent.personality, '冷静、务实。');
  assert.equal(roomAgent.acp_backend, 'codex');

  const blockedDeleteRes = await request(`/api/agents/${created.id}`, { method: 'DELETE' });
  assert.equal(blockedDeleteRes.status, 409);
  const blocked = await blockedDeleteRes.json() as { error: string; references: Array<{ room_id: string; room_name: string }> };
  assert.equal(blocked.error, 'agent is in use');
  assert.deepEqual(blocked.references, [{ room_id: room.id, room_name: 'Agent API Room' }]);

  const unusedRes = await request('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: 'unused',
      name: 'Unused',
      default_acp_permission_mode: 'bypass',
    }),
  });
  assert.equal(unusedRes.status, 201);
  const unused = await unusedRes.json() as { id: string };

  const deleteUnusedRes = await request(`/api/agents/${unused.id}`, { method: 'DELETE' });
  assert.equal(deleteUnusedRes.status, 204);
});
