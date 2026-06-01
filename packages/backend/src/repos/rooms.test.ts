import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-rooms-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');
const { taskRepo } = await import('./tasks.js');
const { db } = await import('../db.js');

function createProject(namePrefix: string) {
  return projectRepo.create({
    name: `${namePrefix}-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), `${namePrefix}-project-`)),
  });
}

test('roomRepo listByProject puts pinned rooms first and falls back to created_at desc', () => {
  const project = createProject('rooms-sort');
  const older = roomRepo.create({ project_id: project.id, name: '旧房间', ensureDefaultPlanner: false });
  const newer = roomRepo.create({ project_id: project.id, name: '新房间', ensureDefaultPlanner: false });
  const pinnedOld = roomRepo.create({ project_id: project.id, name: '置顶旧', ensureDefaultPlanner: false });
  const pinnedNew = roomRepo.create({ project_id: project.id, name: '置顶新', ensureDefaultPlanner: false });

  roomRepo.update(older.id, { last_opened_at: 100 });
  roomRepo.update(newer.id, { last_opened_at: 300 });
  roomRepo.update(pinnedOld.id, { pinned_at: 200, last_opened_at: 50 });
  roomRepo.update(pinnedNew.id, { pinned_at: 400, last_opened_at: 10 });
  db.prepare('UPDATE rooms SET created_at = ? WHERE id = ?').run(100, older.id);
  db.prepare('UPDATE rooms SET created_at = ? WHERE id = ?').run(200, newer.id);
  db.prepare('UPDATE rooms SET created_at = ? WHERE id = ?').run(300, pinnedOld.id);
  db.prepare('UPDATE rooms SET created_at = ? WHERE id = ?').run(400, pinnedNew.id);

  assert.deepEqual(roomRepo.listByProject(project.id).map((room) => room.id), [
    pinnedNew.id,
    pinnedOld.id,
    newer.id,
    older.id,
  ]);
});

test('roomRepo listByProject uses sort_order within pinned and normal layers', () => {
  const project = createProject('rooms-manual-sort');
  const normalA = roomRepo.create({ project_id: project.id, name: '普通 A', ensureDefaultPlanner: false });
  const normalB = roomRepo.create({ project_id: project.id, name: '普通 B', ensureDefaultPlanner: false });
  const pinnedA = roomRepo.create({ project_id: project.id, name: '置顶 A', ensureDefaultPlanner: false });
  const pinnedB = roomRepo.create({ project_id: project.id, name: '置顶 B', ensureDefaultPlanner: false });

  roomRepo.update(normalA.id, { sort_order: 20 });
  roomRepo.update(normalB.id, { sort_order: 10 });
  roomRepo.update(pinnedA.id, { pinned_at: 100, sort_order: 2 });
  roomRepo.update(pinnedB.id, { pinned_at: 200, sort_order: 1 });

  assert.deepEqual(roomRepo.listByProject(project.id).map((room) => room.id), [
    pinnedB.id,
    pinnedA.id,
    normalB.id,
    normalA.id,
  ]);
});

test('roomRepo reorder rejects rooms from another project or layer', () => {
  const project = createProject('rooms-reorder');
  const otherProject = createProject('rooms-reorder-other');
  const normalA = roomRepo.create({ project_id: project.id, name: '普通 A', ensureDefaultPlanner: false });
  const normalB = roomRepo.create({ project_id: project.id, name: '普通 B', ensureDefaultPlanner: false });
  const pinned = roomRepo.create({ project_id: project.id, name: '置顶', ensureDefaultPlanner: false });
  const otherRoom = roomRepo.create({ project_id: otherProject.id, name: '其他项目', ensureDefaultPlanner: false });
  roomRepo.update(pinned.id, { pinned_at: 0 });

  assert.throws(() => roomRepo.reorder(project.id, [normalA.id, pinned.id], false), /room layer mismatch/);
  assert.throws(() => roomRepo.reorder(project.id, [normalA.id, otherRoom.id], false), /room project mismatch/);
  assert.throws(() => roomRepo.reorder(project.id, [normalA.id, normalA.id], false), /duplicate room ids/);
  assert.throws(() => roomRepo.reorder(project.id, ['missing-room'], false), /room not found/);

  roomRepo.reorder(project.id, [normalB.id, normalA.id], false);
  assert.deepEqual(roomRepo.listByProject(project.id).filter((room) => room.id === normalA.id || room.id === normalB.id).map((room) => room.id), [
    normalB.id,
    normalA.id,
  ]);
  assert.equal(roomRepo.get(pinned.id)?.pinned_at, 0);
});

test('roomRepo update trims room name and rejects blank name', () => {
  const project = createProject('rooms-rename');
  const room = roomRepo.create({ project_id: project.id, name: '原名称', ensureDefaultPlanner: false });

  const renamed = roomRepo.update(room.id, { name: '  新名称  ' });
  assert.equal(renamed?.name, '新名称');
  assert.throws(() => roomRepo.update(room.id, { name: '   ' }), /room name is required/);
  assert.equal(roomRepo.update('not-found-room', { name: '任意名称' }), undefined);
});

test('roomRepo update only writes fields present in the patch', () => {
  const project = createProject('rooms-partial-update');
  const room = roomRepo.create({ project_id: project.id, name: '原名称', ensureDefaultPlanner: false });

  roomRepo.update(room.id, { pinned_at: 200, last_opened_at: 100 });
  roomRepo.update(room.id, { sort_order: 4 });
  const renamed = roomRepo.update(room.id, { name: '新名称' });
  assert.equal(renamed?.name, '新名称');
  assert.equal(renamed?.pinned_at, 200);
  assert.equal(renamed?.last_opened_at, 100);
  assert.equal(renamed?.sort_order, 4);

  const opened = roomRepo.update(room.id, { last_opened_at: 300 });
  assert.equal(opened?.name, '新名称');
  assert.equal(opened?.pinned_at, 200);
  assert.equal(opened?.last_opened_at, 300);
  assert.equal(opened?.sort_order, 4);
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

test('roomRepo delete removes room settings when room is idle', () => {
  const project = createProject('rooms-delete-settings');
  const room = roomRepo.create({ project_id: project.id, name: '待删除房间', ensureDefaultPlanner: false });
  db.prepare("INSERT INTO settings (scope, scope_id, updated_at) VALUES ('room', ?, ?)").run(room.id, 1);

  assert.deepEqual(roomRepo.delete(room.id), { ok: true });
  assert.equal(roomRepo.get(room.id), undefined);
  const settingsCount = db
    .prepare("SELECT COUNT(*) AS count FROM settings WHERE scope = 'room' AND scope_id = ?")
    .get(room.id) as { count: number };
  assert.equal(settingsCount.count, 0);
});

test('roomRepo delete rejects rooms with active agent runs', () => {
  const project = createProject('rooms-delete-agent-run');
  const room = roomRepo.create({ project_id: project.id, name: '运行中房间', ensureDefaultPlanner: false });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'runner', agent_name: 'Runner' });
  db.prepare(
    `INSERT INTO agent_runs (
      id, room_id, room_agent_id, agent_id, backend, status, prompt, started_at, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('agent-run-active', room.id, agent.id, agent.agent_id, 'codex', 'running', 'prompt', 1, 1);

  const result = roomRepo.delete(room.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'active_runs');
  if (!result.ok && result.reason === 'active_runs') {
    assert.equal(result.activeAgentRunCount, 1);
    assert.equal(result.activeWorkflowRunCount, 0);
  }
  assert.ok(roomRepo.get(room.id));
});

test('roomRepo delete rejects rooms with active workflow runs', () => {
  const project = createProject('rooms-delete-workflow-run');
  const room = roomRepo.create({ project_id: project.id, name: '工作流房间', ensureDefaultPlanner: false });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '运行中任务',
  });
  db.prepare(
    `INSERT INTO workflow_runs (
      id, room_id, project_id, task_id, status, created_at, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('workflow-run-active', room.id, project.id, task.id, 'running', 1, 1);

  const result = roomRepo.delete(room.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'active_runs');
  if (!result.ok && result.reason === 'active_runs') {
    assert.equal(result.activeAgentRunCount, 0);
    assert.equal(result.activeWorkflowRunCount, 1);
  }
  assert.ok(roomRepo.get(room.id));
});
