import assert from 'node:assert/strict';
import test from 'node:test';
import type { EffectiveSkillBinding, Skill } from './types.js';

const { selectSkills } = await import('./selector.js');

function fakeSkill(input: Partial<Skill> & Pick<Skill, 'id' | 'name'>): Skill {
  return {
    id: input.id,
    name: input.name,
    description: input.description ?? null,
    source_type: input.source_type ?? 'manual',
    source_uri: input.source_uri ?? null,
    install_path: input.install_path ?? `/managed/${input.id}`,
    manifest_path: input.manifest_path ?? 'SKILL.md',
    runtime_scopes: input.runtime_scopes ?? ['planner'],
    trigger_mode: input.trigger_mode ?? 'manual',
    trigger_keywords: input.trigger_keywords ?? [],
    enabled: input.enabled ?? 1,
    priority: input.priority ?? 100,
    checksum: input.checksum ?? null,
    package_version: input.package_version ?? null,
    package_revision: input.package_revision ?? null,
    runtime_type: input.runtime_type ?? null,
    entrypoint: input.entrypoint ?? null,
    permissions: input.permissions ?? null,
    install_source_label: input.install_source_label ?? null,
    update_check_mode: input.update_check_mode ?? 'startup',
    update_apply_mode: input.update_apply_mode ?? 'prompt',
    last_update_checked_at: input.last_update_checked_at ?? null,
    available_version: input.available_version ?? null,
    available_revision: input.available_revision ?? null,
    created_at: input.created_at ?? 1,
    updated_at: input.updated_at ?? 1,
  };
}

function effective(skill: Skill, overrides: Partial<EffectiveSkillBinding> = {}): EffectiveSkillBinding {
  return {
    skill,
    binding: {
      id: `binding-${skill.id}`,
      skill_id: skill.id,
      scope: 'system',
      scope_id: 'default',
      enabled: 1,
      priority_override: null,
      created_at: 1,
      updated_at: 1,
    },
    effectivePriority: skill.priority,
    scopeSpecificity: 1,
    ...overrides,
  };
}

test('selectSkills matches keyword and always_for_scope skills but not manual skills by default', async () => {
  const keyword = fakeSkill({
    id: 'skill-keyword',
    name: 'TDD',
    trigger_mode: 'keyword',
    trigger_keywords: ['TDD'],
    priority: 80,
  });
  const always = fakeSkill({
    id: 'skill-always',
    name: 'Always',
    trigger_mode: 'always_for_scope',
  });
  const manual = fakeSkill({
    id: 'skill-manual',
    name: 'Manual',
    trigger_mode: 'manual',
  });

  const selected = await selectSkills({
    runtimeScopes: ['planner'],
    message: 'Please use TDD for this plan.',
    bindings: [effective(keyword), effective(always), effective(manual)],
    loadInstructions: async (skill) => ({ instructions: `${skill.name} instructions`, truncated: false }),
  });

  assert.deepEqual(selected.map((item) => item.skill.id), ['skill-keyword', 'skill-always']);
  assert.deepEqual(selected[0]?.reasons, ['keyword match "TDD"']);
  assert.deepEqual(selected[1]?.reasons, ['always_for_scope planner']);
});

test('selectSkills allows manual skills when explicitly requested and filters runtime scopes', async () => {
  const manual = fakeSkill({
    id: 'skill-manual',
    name: 'Manual',
    runtime_scopes: ['review'],
    trigger_mode: 'manual',
  });

  const selected = await selectSkills({
    runtimeScopes: ['planner', 'review'],
    skillIds: ['skill-manual'],
    bindings: [effective(manual)],
    loadInstructions: async () => ({ instructions: 'manual instructions', truncated: false }),
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.skill.id, 'skill-manual');
  assert.deepEqual(selected[0]?.reasons, ['explicit skill request']);
});

test('selectSkills sorts by lower priority number, dedupes by name, and caps always_for_scope per scope', async () => {
  const lowerPriorityDuplicate = fakeSkill({
    id: 'skill-duplicate-low',
    name: 'Duplicate',
    trigger_mode: 'keyword',
    trigger_keywords: ['dup'],
    priority: 80,
  });
  const higherPriorityDuplicate = fakeSkill({
    id: 'skill-duplicate-high',
    name: 'Duplicate',
    trigger_mode: 'keyword',
    trigger_keywords: ['dup'],
    priority: 40,
  });
  const alwaysA = fakeSkill({
    id: 'skill-always-a',
    name: 'Always A',
    trigger_mode: 'always_for_scope',
    priority: 30,
  });
  const alwaysB = fakeSkill({
    id: 'skill-always-b',
    name: 'Always B',
    trigger_mode: 'always_for_scope',
    priority: 20,
  });

  const selected = await selectSkills({
    runtimeScopes: ['planner'],
    message: 'dup',
    bindings: [
      effective(lowerPriorityDuplicate),
      effective(higherPriorityDuplicate),
      effective(alwaysA),
      effective(alwaysB),
    ],
    loadInstructions: async (skill) => ({ instructions: skill.name, truncated: false }),
  });

  assert.deepEqual(selected.map((item) => item.skill.id), ['skill-always-b', 'skill-duplicate-high']);
});

test('selectSkills applies max skill and instruction character limits', async () => {
  const first = fakeSkill({ id: 'skill-first', name: 'First', trigger_mode: 'keyword', trigger_keywords: ['go'], priority: 10 });
  const second = fakeSkill({ id: 'skill-second', name: 'Second', trigger_mode: 'keyword', trigger_keywords: ['go'], priority: 20 });

  const selected = await selectSkills({
    runtimeScopes: ['planner'],
    message: 'go',
    maxSkills: 1,
    maxInstructionChars: 5,
    bindings: [effective(first), effective(second)],
    loadInstructions: async () => ({ instructions: '1234567890', truncated: false }),
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.skill.id, 'skill-first');
  assert.equal(selected[0]?.instructions, '12345');
  assert.equal(selected[0]?.truncated, true);
});
