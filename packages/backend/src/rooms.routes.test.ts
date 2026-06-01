import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-rooms-routes-')), 'test.db');

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

test('patch room supports sort_order', async () => {
  const { room } = createRoomFixture('patch-sort-order');
  const res = await request(`/api/rooms/${room.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ sort_order: 7 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { id: string; sort_order: number | null };
  assert.equal(body.id, room.id);
  assert.equal(body.sort_order, 7);
});

test('reorder rooms updates order within project', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-rooms-reorder-'));
  const project = projectRepo.create({ name: 'Rooms Reorder Project', path: projectPath });
  const roomA = roomRepo.create({ project_id: project.id, name: 'Room A', ensureDefaultPlanner: false });
  const roomB = roomRepo.create({ project_id: project.id, name: 'Room B', ensureDefaultPlanner: false });
  roomRepo.update(roomA.id, { pinned_at: 1 });
  roomRepo.update(roomB.id, { pinned_at: 2 });

  const res = await request(`/api/projects/${project.id}/rooms/reorder`, {
    method: 'PUT',
    body: JSON.stringify({ ids: [roomB.id, roomA.id], pinned: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ id: string; sort_order: number | null }>;
  const bRow = body.find((item) => item.id === roomB.id);
  const aRow = body.find((item) => item.id === roomA.id);
  assert.equal(bRow?.sort_order, 1);
  assert.equal(aRow?.sort_order, 2);
});

function createRoomFixture(name: string) {
  const projectPath = mkdtempSync(join(tmpdir(), `openclaw-room-room-fixture-${name}-`));
  const project = projectRepo.create({ name: `Project ${name}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: `${name} Room`, ensureDefaultPlanner: false });
  return { project, room };
}
