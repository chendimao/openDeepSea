import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-skill-runs-')), 'test.db');

const { db } = await import('../db.js');
const { skillRepo } = await import('./repo.js');
const { skillRunRepo } = await import('./run-repo.js');

function resetRuns(): void {
  db.prepare('DELETE FROM skill_runs').run();
  db.prepare('DELETE FROM skills').run();
}

function createExecutableSkill(): void {
  skillRepo.createSkill({
    id: 'skill-executable',
    name: 'executable-skill',
    description: 'Runs in a project sandbox.',
    source_type: 'skills_sh',
    source_uri: 'skills.sh/example/executable-skill',
    install_path: '/managed/executable',
    manifest_path: 'skill.json',
    runtime_scopes: ['workflow'],
    trigger_mode: 'manual',
    trigger_keywords: [],
    enabled: true,
    priority: 60,
    checksum: 'sha256:abc',
    package_version: '1.0.0',
    package_revision: 'rev-a',
    runtime_type: 'node',
    entrypoint: 'scripts/main.js',
    permissions: {
      filesystem: 'project',
      network: true,
      commands: ['node'],
    },
    install_source_label: 'example/executable-skill',
    update_check_mode: 'startup',
    update_apply_mode: 'prompt',
  });
}

test('skillRunRepo creates, updates, and lists execution records', () => {
  resetRuns();
  createExecutableSkill();

  const created = skillRunRepo.createRun({
    id: 'run-1',
    skill_id: 'skill-executable',
    project_id: 'project-1',
    room_id: 'room-1',
    agent_id: 'agent-1',
    invoked_by: 'workflow',
    runtime: 'node',
    entrypoint: 'scripts/main.js',
    input: { prompt: 'summarize' },
    allowed_paths: ['/project'],
    network_enabled: true,
    status: 'running',
  });

  assert.equal(created.id, 'run-1');
  assert.equal(created.status, 'running');
  assert.deepEqual(created.input, { prompt: 'summarize' });
  assert.deepEqual(created.allowed_paths, ['/project']);
  assert.equal(created.network_enabled, 1);
  assert.equal(Object.hasOwn(created, 'input_json'), false, 'does not expose raw input_json');
  assert.equal(Object.hasOwn(created, 'allowed_paths_json'), false, 'does not expose raw allowed_paths_json');

  const finished = skillRunRepo.updateRun('run-1', {
    status: 'completed',
    exit_code: 0,
    stdout: 'done',
    stderr: '',
    result: { ok: true },
    error: null,
  });

  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.exit_code, 0);
  assert.equal(finished?.stdout, 'done');
  assert.equal(finished?.stderr, '');
  assert.deepEqual(finished?.result, { ok: true });
  assert.equal(Object.hasOwn(finished ?? {}, 'result_json'), false, 'does not expose raw result_json');
  assert.equal(finished?.error, null);

  const bySkill = skillRunRepo.listRuns({ skill_id: 'skill-executable' });
  assert.equal(bySkill.length, 1);
  assert.equal(bySkill[0]?.id, 'run-1');

  const byProject = skillRunRepo.listRuns({ project_id: 'project-1' });
  assert.equal(byProject.length, 1);
  assert.equal(byProject[0]?.skill_id, 'skill-executable');
});

test('skillRunRepo records failed execution details', () => {
  resetRuns();
  createExecutableSkill();

  skillRunRepo.createRun({
    id: 'run-failed',
    skill_id: 'skill-executable',
    project_id: 'project-1',
    invoked_by: 'agent',
    runtime: 'shell',
    entrypoint: 'scripts/run.sh',
    input: null,
    allowed_paths: ['/project'],
    network_enabled: false,
    status: 'running',
  });

  const failed = skillRunRepo.updateRun('run-failed', {
    status: 'failed',
    exit_code: 2,
    stdout: 'partial output',
    stderr: 'boom',
    result: null,
    error: 'script failed',
  });

  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.exit_code, 2);
  assert.equal(failed?.stderr, 'boom');
  assert.equal(failed?.error, 'script failed');
  assert.equal(failed?.network_enabled, 0);
});
