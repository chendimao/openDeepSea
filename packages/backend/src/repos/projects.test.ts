import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-projects-')), 'test.db');

const { projectRepo } = await import('./projects.js');

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `${name}-`)),
  });
}

test('projectRepo list puts pinned projects first and uses sort_order within each layer', () => {
  const normalA = createProject('normal-a');
  const normalB = createProject('normal-b');
  const pinnedA = createProject('pinned-a');
  const pinnedB = createProject('pinned-b');

  projectRepo.update(normalA.id, { sort_order: 20 });
  projectRepo.update(normalB.id, { sort_order: 10 });
  projectRepo.update(pinnedA.id, { pinned_at: 100, sort_order: 2 });
  projectRepo.update(pinnedB.id, { pinned_at: 200, sort_order: 1 });

  assert.deepEqual(projectRepo.list().map((project) => project.id), [
    pinnedB.id,
    pinnedA.id,
    normalB.id,
    normalA.id,
  ]);
});

test('projectRepo reorder only updates projects from the requested layer', () => {
  const normalA = createProject('normal-layer-a');
  const normalB = createProject('normal-layer-b');
  const pinned = createProject('pinned-layer');
  projectRepo.update(pinned.id, { pinned_at: 0 });

  assert.throws(() => projectRepo.reorder([normalA.id, pinned.id], false), /project layer mismatch/);

  projectRepo.reorder([normalB.id, normalA.id], false);
  const ids = projectRepo.list().filter((project) => project.id === normalA.id || project.id === normalB.id).map((project) => project.id);
  assert.deepEqual(ids, [normalB.id, normalA.id]);
  assert.equal(projectRepo.get(pinned.id)?.pinned_at, 0);
});

test('projectRepo reorder rejects duplicate and missing ids', () => {
  const normalA = createProject('normal-duplicate-a');

  assert.throws(() => projectRepo.reorder([normalA.id, normalA.id], false), /duplicate project ids/);
  assert.throws(() => projectRepo.reorder(['missing-project'], false), /project not found/);
});
