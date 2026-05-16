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

test('settingsRepo stores system planner settings while redacting api key responses', () => {
  const updated = settingsRepo.updateSystem({
    langchain_planner_model: ' gpt-4.1 ',
    openai_base_url: ' https://openai.example/v1 ',
    openai_api_key: ' sk-system-secret1234 ',
  });

  assert.equal(updated.langchain_planner_model, 'gpt-4.1');
  assert.equal(updated.openai_base_url, 'https://openai.example/v1');
  assert.equal(updated.openai_api_key_set, true);
  assert.equal(updated.openai_api_key_preview, 'sk-...1234');
  assert.equal('openai_api_key' in updated, false);

  assert.deepEqual(settingsRepo.getLangChainPlannerSettings(), {
    langchain_planner_model: 'gpt-4.1',
    openai_api_key: 'sk-system-secret1234',
    openai_base_url: 'https://openai.example/v1',
  });

  const preserved = settingsRepo.updateSystem({ langchain_planner_model: 'gpt-4o-mini' });
  assert.equal(preserved.openai_api_key_set, true);
  assert.equal(settingsRepo.getLangChainPlannerSettings().openai_api_key, 'sk-system-secret1234');

  const cleared = settingsRepo.updateSystem({
    langchain_planner_model: '',
    openai_base_url: '',
    openai_api_key: null,
  });

  assert.equal(cleared.langchain_planner_model, null);
  assert.equal(cleared.openai_base_url, null);
  assert.equal(cleared.openai_api_key_set, false);
  assert.equal(cleared.openai_api_key_preview, null);
  assert.equal(settingsRepo.getLangChainPlannerSettings().openai_api_key, null);
});
