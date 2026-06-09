import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-terminal-routes-db-')), 'test.db');
process.env.OPENDEEPSEA_LOCAL_TOKEN = 'terminal-routes-token';
process.env.OPENDEEPSEA_TERMINAL_CWD = mkdtempSync(join(tmpdir(), 'opendeepsea-terminal-routes-cwd-'));

const LOCAL_TOKEN = process.env.OPENDEEPSEA_LOCAL_TOKEN;

const express = (await import('express')).default;
const { router } = await import('../routes.js');
const { projectRepo } = await import('../repos/projects.js');

const app = express();
app.use(express.json());
app.use('/api', router);

async function request(path: string, init: RequestInit = {}, options: { localToken?: boolean } = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (options.localToken !== false) headers.set('X-OpenDeepSea-Local-Token', LOCAL_TOKEN);
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('terminal routes require local access token', async () => {
  const res = await request('/api/terminals', {
    method: 'POST',
    body: JSON.stringify({ profile: 'skills_install', cols: 80, rows: 24 }),
  }, { localToken: false });
  assert.equal(res.status, 403);
});

test('terminal routes create, get, and kill skills install sessions', async () => {
  const createRes = await request('/api/terminals', {
    method: 'POST',
    body: JSON.stringify({ profile: 'skills_install', cols: 80, rows: 24 }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as {
    id: string;
    profile: string;
    cwd: string;
    status: string;
  };
  assert.equal(created.profile, 'skills_install');
  assert.equal(created.cwd, process.env.OPENDEEPSEA_TERMINAL_CWD);
  assert.equal(created.status, 'running');

  const getRes = await request(`/api/terminals/${created.id}`);
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json() as { id: string };
  assert.equal(fetched.id, created.id);

  const killRes = await request(`/api/terminals/${created.id}/kill`, { method: 'POST' });
  assert.equal(killRes.status, 204);

  const killedRes = await request(`/api/terminals/${created.id}`);
  assert.equal(killedRes.status, 200);
  const killed = await killedRes.json() as { status: string };
  assert.equal(killed.status, 'killed');
});

test('terminal routes create project shell sessions in the project directory', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'opendeepsea-terminal-project-shell-'));
  const project = projectRepo.create({ name: 'Terminal Project Shell', path: projectPath });

  const createRes = await request('/api/terminals', {
    method: 'POST',
    body: JSON.stringify({
      profile: 'project_shell',
      projectId: project.id,
      cols: 80,
      rows: 24,
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as {
    id: string;
    profile: string;
    cwd: string;
    status: string;
  };
  assert.equal(created.profile, 'project_shell');
  assert.equal(created.cwd, projectPath);
  assert.equal(created.status, 'running');

  const killRes = await request(`/api/terminals/${created.id}/kill`, { method: 'POST' });
  assert.equal(killRes.status, 204);
});
