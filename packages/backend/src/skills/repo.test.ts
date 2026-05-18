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
