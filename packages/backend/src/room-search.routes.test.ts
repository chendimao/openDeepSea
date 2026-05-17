import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-search-routes-')), 'test.db');

const projectDir = join(tmpdir(), `openclaw-room-search-routes-project-${Date.now()}`);
mkdirSync(projectDir, { recursive: true });

const { messageRepo } = await import('./repos/messages.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { router } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

function createProjectPath(name: string): string {
  const path = `${projectDir}-${name}`;
  mkdirSync(path, { recursive: true });
  return path;
}

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

test('room search route returns keyword results across room content', async () => {
  const project = projectRepo.create({ name: 'Route Search', path: createProjectPath('route') });
  const target = roomRepo.create({ project_id: project.id, name: '页面修复' });
  const other = roomRepo.create({ project_id: project.id, name: '部署讨论' });
  const foreignProject = projectRepo.create({ name: 'Foreign Route Search', path: createProjectPath('foreign') });
  const foreign = roomRepo.create({ project_id: foreignProject.id, name: '页面显示不完整' });

  messageRepo.create({
    room_id: target.id,
    sender_type: 'user',
    sender_id: 'user',
    content: '页面显示不完整，需要修复。',
  });
  messageRepo.create({
    room_id: other.id,
    sender_type: 'user',
    sender_id: 'user',
    content: '部署配置',
  });
  messageRepo.create({
    room_id: foreign.id,
    sender_type: 'user',
    sender_id: 'user',
    content: '这个外部项目不能出现在结果里。',
  });

  const res = await request(`/api/projects/${project.id}/rooms/search?q=${encodeURIComponent('页面显示不完整')}`);
  assert.equal(res.status, 200);
  const body = await res.json() as {
    query: string;
    total: number;
    results: Array<{ room: { id: string } }>;
  };
  assert.equal(body.query, '页面显示不完整');
  assert.equal(body.total, 1);
  assert.deepEqual(body.results.map((item) => item.room.id), [target.id]);
});

test('room search route validates query and project', async () => {
  const project = projectRepo.create({ name: 'Route Validation', path: createProjectPath('validation') });

  const emptyQuery = await request(`/api/projects/${project.id}/rooms/search?q=`);
  assert.equal(emptyQuery.status, 400);

  const missingProject = await request('/api/projects/missing-project/rooms/search?q=anything');
  assert.equal(missingProject.status, 404);
  assert.deepEqual(await missingProject.json(), { error: 'project not found' });
});
