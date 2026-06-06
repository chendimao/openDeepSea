import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-commands-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { sessionRepo } = await import('./repos/sessions.js');
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

test('SessionOS command HTTP endpoints are removed', async () => {
  const project = projectRepo.create({
    name: 'removed session commands',
    path: mkdtempSync(join(tmpdir(), 'session-command-removed-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Removed Session Commands',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  const endpoints: Array<{ path: string; method: string }> = [
    { path: `/api/sessions/${session.id}/new`, method: 'POST' },
    { path: `/api/sessions/${session.id}/compact/preview`, method: 'POST' },
    { path: `/api/sessions/${session.id}/compact/apply`, method: 'POST' },
    { path: `/api/sessions/${session.id}/compact/discard`, method: 'POST' },
    { path: `/api/sessions/${session.id}/contract`, method: 'PATCH' },
    { path: `/api/sessions/${session.id}/status`, method: 'GET' },
    { path: `/api/sessions/${session.id}/context`, method: 'GET' },
    { path: `/api/sessions/${session.id}/evidence`, method: 'GET' },
    { path: `/api/sessions/${session.id}/checkpoints`, method: 'POST' },
    { path: `/api/sessions/${session.id}/fork`, method: 'POST' },
    { path: `/api/projects/${project.id}/history-records`, method: 'GET' },
  ];

  for (const endpoint of endpoints) {
    const res = await request(endpoint.path, { method: endpoint.method });
    assert.equal(res.status, 404, `${endpoint.method} ${endpoint.path}`);
  }
});
