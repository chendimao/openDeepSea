import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-settings-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { roomRepo } = await import('./rooms.js');
const { settingsRepo } = await import('./settings.js');

test('settingsRepo resolves auto_distill_enabled with project and room overrides', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-settings-project-'));
  const project = projectRepo.create({ name: 'Settings Memory', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Settings Room' });

  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.auto_distill_enabled, true);

  settingsRepo.updateProject(project.id, { auto_distill_enabled: false });
  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.auto_distill_enabled, false);

  settingsRepo.updateRoom(room.id, { auto_distill_enabled: true });
  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.auto_distill_enabled, true);
});
