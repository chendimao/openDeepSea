import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-skills-repo-')), 'test.db');

const { db } = await import('../db.js');
const { skillRepo } = await import('./repo.js');

function resetSkills(): void {
  db.prepare('DELETE FROM skill_bindings').run();
  db.prepare('DELETE FROM skills').run();
}

test('skillRepo creates, reads, updates, lists, and deletes skills with JSON fields', () => {
  resetSkills();

  const created = skillRepo.createSkill({
    id: 'skill-tdd',
    name: 'test-driven-development',
    description: 'Use when behavior changes need tests.',
    source_type: 'local_directory',
    source_uri: '/source/tdd',
    install_path: '/managed/tdd',
    manifest_path: 'SKILL.md',
    runtime_scopes: ['planner', 'workflow'],
    trigger_mode: 'keyword',
    trigger_keywords: ['TDD', 'test-driven'],
    enabled: true,
    priority: 80,
    checksum: 'abc123',
  });

  assert.equal(created.id, 'skill-tdd');
  assert.deepEqual(created.runtime_scopes, ['planner', 'workflow']);
  assert.deepEqual(created.trigger_keywords, ['TDD', 'test-driven']);
  assert.equal(created.enabled, 1);

  const fetched = skillRepo.getSkill('skill-tdd');
  assert.deepEqual(fetched?.runtime_scopes, ['planner', 'workflow']);
  assert.deepEqual(fetched?.trigger_keywords, ['TDD', 'test-driven']);

  const updated = skillRepo.updateSkill('skill-tdd', {
    enabled: false,
    priority: 50,
    trigger_keywords: ['red-green-refactor'],
  });
  assert.equal(updated?.enabled, 0);
  assert.equal(updated?.priority, 50);
  assert.deepEqual(updated?.trigger_keywords, ['red-green-refactor']);

  assert.deepEqual(skillRepo.listSkills().map((skill) => skill.id), ['skill-tdd']);
  assert.equal(skillRepo.deleteSkill('skill-tdd'), true);
  assert.equal(skillRepo.getSkill('skill-tdd'), null);
  assert.equal(skillRepo.deleteSkill('skill-tdd'), false);
});


test('skills table includes executable metadata columns for existing database migration', () => {
  const columns = db.prepare('PRAGMA table_info(skills)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  for (const expected of [
    'package_version',
    'package_revision',
    'runtime_type',
    'entrypoint',
    'permissions_json',
    'install_source_label',
    'update_check_mode',
    'update_apply_mode',
    'last_update_checked_at',
    'available_version',
    'available_revision',
  ]) {
    assert.equal(names.has(expected), true, expected);
  }
});

test('skillRepo persists executable skill metadata and update policy fields', () => {
  resetSkills();

  const created = skillRepo.createSkill({
    id: 'skill-executable-meta',
    name: 'executable-meta-skill',
    description: 'Installed from skills.sh.',
    source_type: 'skills_sh',
    source_uri: 'skills.sh/example/executable-meta-skill',
    install_path: '/managed/executable-meta',
    manifest_path: 'skill.json',
    runtime_scopes: ['workflow'],
    trigger_mode: 'manual',
    trigger_keywords: [],
    enabled: true,
    priority: 70,
    checksum: 'sha256:def',
    package_version: '1.2.3',
    package_revision: 'rev-1',
    runtime_type: 'python',
    entrypoint: 'scripts/main.py',
    permissions: {
      filesystem: 'project',
      network: true,
      commands: ['python3'],
    },
    install_source_label: 'example/executable-meta-skill',
    update_check_mode: 'startup',
    update_apply_mode: 'prompt',
  });

  assert.equal(created.source_type, 'skills_sh');
  assert.equal(created.package_version, '1.2.3');
  assert.equal(created.package_revision, 'rev-1');
  assert.equal(created.runtime_type, 'python');
  assert.equal(created.entrypoint, 'scripts/main.py');
  assert.deepEqual(created.permissions, {
    filesystem: 'project',
    network: true,
    commands: ['python3'],
  });
  assert.equal(created.install_source_label, 'example/executable-meta-skill');
  assert.equal(created.update_check_mode, 'startup');
  assert.equal(created.update_apply_mode, 'prompt');
  assert.equal(Object.hasOwn(created, 'permissions_json'), false, 'does not expose raw permissions_json');

  const updated = skillRepo.updateSkill('skill-executable-meta', {
    package_version: '1.2.4',
    package_revision: 'rev-2',
    update_check_mode: 'manual',
    update_apply_mode: 'prompt',
    last_update_checked_at: 12345,
    available_version: '1.3.0',
    available_revision: 'rev-3',
  });

  assert.equal(updated?.package_version, '1.2.4');
  assert.equal(updated?.package_revision, 'rev-2');
  assert.equal(updated?.update_check_mode, 'manual');
  assert.equal(updated?.update_apply_mode, 'prompt');
  assert.equal(updated?.last_update_checked_at, 12345);
  assert.equal(updated?.available_version, '1.3.0');
  assert.equal(updated?.available_revision, 'rev-3');
});

test('skillRepo rejects duplicate skill names', () => {
  resetSkills();

  skillRepo.createSkill({
    id: 'skill-one',
    name: 'duplicate-skill',
    description: null,
    source_type: 'manual',
    source_uri: null,
    install_path: '/managed/one',
    manifest_path: null,
    runtime_scopes: ['planner'],
    trigger_mode: 'manual',
    trigger_keywords: [],
    enabled: true,
    priority: 100,
    checksum: null,
  });

  assert.throws(() => skillRepo.createSkill({
    id: 'skill-two',
    name: 'Duplicate-Skill',
    description: null,
    source_type: 'manual',
    source_uri: null,
    install_path: '/managed/two',
    manifest_path: null,
    runtime_scopes: ['planner'],
    trigger_mode: 'manual',
    trigger_keywords: [],
    enabled: true,
    priority: 100,
    checksum: null,
  }), /same name/i);
});

test('skillRepo resolves bindings from narrow scopes over wider scopes', () => {
  resetSkills();

  skillRepo.createSkill({
    id: 'skill-planner',
    name: 'planner-skill',
    description: null,
    source_type: 'manual',
    source_uri: null,
    install_path: '/managed/planner',
    manifest_path: null,
    runtime_scopes: ['planner'],
    trigger_mode: 'always_for_scope',
    trigger_keywords: [],
    enabled: true,
    priority: 100,
    checksum: null,
  });

  skillRepo.upsertBinding({
    id: 'binding-system',
    skill_id: 'skill-planner',
    scope: 'system',
    scope_id: 'ignored-for-system',
    enabled: true,
    priority_override: 90,
  });
  skillRepo.upsertBinding({
    id: 'binding-project',
    skill_id: 'skill-planner',
    scope: 'project',
    scope_id: 'project-1',
    enabled: true,
    priority_override: 80,
  });
  skillRepo.upsertBinding({
    id: 'binding-room',
    skill_id: 'skill-planner',
    scope: 'room',
    scope_id: 'room-1',
    enabled: true,
    priority_override: 70,
  });

  const resolved = skillRepo.resolveEffectiveBindings({
    projectId: 'project-1',
    roomId: 'room-1',
  });

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.binding.id, 'binding-room');
  assert.equal(resolved[0]?.skill.id, 'skill-planner');
  assert.equal(resolved[0]?.effectivePriority, 70);
  assert.equal(resolved[0]?.scopeSpecificity, 3);
  assert.equal(skillRepo.listBindings({ scope: 'system', scope_id: 'default' })[0]?.scope_id, 'default');
});

test('skillRepo lets narrow disabled bindings suppress wider enabled bindings', () => {
  resetSkills();

  skillRepo.createSkill({
    id: 'skill-memory',
    name: 'memory-skill',
    description: null,
    source_type: 'manual',
    source_uri: null,
    install_path: '/managed/memory',
    manifest_path: null,
    runtime_scopes: ['memory'],
    trigger_mode: 'always_for_scope',
    trigger_keywords: [],
    enabled: true,
    priority: 100,
    checksum: null,
  });

  skillRepo.upsertBinding({
    id: 'binding-system-memory',
    skill_id: 'skill-memory',
    scope: 'system',
    scope_id: 'default',
    enabled: true,
    priority_override: null,
  });
  skillRepo.upsertBinding({
    id: 'binding-room-memory',
    skill_id: 'skill-memory',
    scope: 'room',
    scope_id: 'room-2',
    enabled: false,
    priority_override: null,
  });

  const resolved = skillRepo.resolveEffectiveBindings({
    roomId: 'room-2',
  });

  assert.equal(resolved.length, 0);
  assert.equal(skillRepo.deleteBinding('binding-room-memory'), true);
  assert.equal(skillRepo.resolveEffectiveBindings({ roomId: 'room-2' }).length, 1);
});
