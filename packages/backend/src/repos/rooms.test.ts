import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-rooms-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { roomRepo } = await import('./rooms.js');

function createProject(namePrefix: string) {
  return projectRepo.create({
    name: `${namePrefix}-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), `${namePrefix}-project-`)),
  });
}

test('roomRepo listByProject puts pinned rooms first and sorts by usage', () => {
  const project = createProject('rooms-sort');
  const older = roomRepo.create({ project_id: project.id, name: '旧房间', ensureDefaultPlanner: false });
  const newer = roomRepo.create({ project_id: project.id, name: '新房间', ensureDefaultPlanner: false });
  const pinnedOld = roomRepo.create({ project_id: project.id, name: '置顶旧', ensureDefaultPlanner: false });
  const pinnedNew = roomRepo.create({ project_id: project.id, name: '置顶新', ensureDefaultPlanner: false });

  roomRepo.update(older.id, { last_opened_at: 100 });
  roomRepo.update(newer.id, { last_opened_at: 300 });
  roomRepo.update(pinnedOld.id, { pinned_at: 200, last_opened_at: 50 });
  roomRepo.update(pinnedNew.id, { pinned_at: 400, last_opened_at: 10 });

  assert.deepEqual(roomRepo.listByProject(project.id).map((room) => room.id), [
    pinnedNew.id,
    pinnedOld.id,
    newer.id,
    older.id,
  ]);
});

test('roomRepo update trims room name and rejects blank name', () => {
  const project = createProject('rooms-rename');
  const room = roomRepo.create({ project_id: project.id, name: '原名称', ensureDefaultPlanner: false });

  const renamed = roomRepo.update(room.id, { name: '  新名称  ' });
  assert.equal(renamed?.name, '新名称');
  assert.throws(() => roomRepo.update(room.id, { name: '   ' }), /room name is required/);
  assert.equal(roomRepo.update('not-found-room', { name: '任意名称' }), undefined);
});

test('roomRepo create trims room name and rejects blank name', () => {
  const project = createProject('rooms-create');

  const room = roomRepo.create({ project_id: project.id, name: '  可用名称  ', ensureDefaultPlanner: false });
  assert.equal(room.name, '可用名称');
  assert.throws(
    () => roomRepo.create({ project_id: project.id, name: '   ', ensureDefaultPlanner: false }),
    /room name is required/,
  );
});
