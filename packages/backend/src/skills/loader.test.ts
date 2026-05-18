import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { loadSkillFromDirectory } = await import('./loader.js');

function createSkillDir(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), `opendeepsea-skill-${name}-`));
  writeFileSync(join(dir, 'SKILL.md'), content);
  return dir;
}

test('loadSkillFromDirectory parses yaml-like frontmatter from SKILL.md', async () => {
  const dir = createSkillDir('frontmatter', [
    '---',
    'name: test-driven-development',
    'description: Use when implementing behavior changes.',
    'runtime_scopes:',
    '  - planner',
    '  - workflow',
    'trigger_keywords:',
    '  - TDD',
    '  - test-driven',
    'priority: 80',
    '---',
    '',
    '# Instructions',
    '',
    'Write the failing test first.',
  ].join('\n'));

  const loaded = await loadSkillFromDirectory(dir);

  assert.equal(loaded.name, 'test-driven-development');
  assert.equal(loaded.description, 'Use when implementing behavior changes.');
  assert.deepEqual(loaded.runtimeScopes, ['planner', 'workflow']);
  assert.deepEqual(loaded.triggerKeywords, ['TDD', 'test-driven']);
  assert.equal(loaded.triggerMode, 'keyword');
  assert.equal(loaded.priority, 80);
  assert.equal(loaded.manifestPath, 'SKILL.md');
  assert.match(loaded.instructions, /Write the failing test first/);
});

test('loadSkillFromDirectory falls back when frontmatter is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendeepsea-skill-no-frontmatter-'));
  const nested = join(dir, 'plain-skill');
  mkdirSync(nested);
  writeFileSync(join(nested, 'SKILL.md'), [
    '# Plain Skill',
    '',
    'Use this skill when no metadata exists.',
    '',
    'Detailed instruction.',
  ].join('\n'));

  const loaded = await loadSkillFromDirectory(nested);

  assert.equal(loaded.name, 'plain-skill');
  assert.equal(loaded.description, 'Plain Skill');
  assert.deepEqual(loaded.runtimeScopes, []);
  assert.equal(loaded.triggerMode, 'manual');
  assert.deepEqual(loaded.triggerKeywords, []);
  assert.match(loaded.instructions, /Use this skill when no metadata exists/);
});

test('loadSkillFromDirectory ignores invalid metadata values and truncates instructions', async () => {
  const dir = createSkillDir('invalid', [
    '---',
    'name: noisy-skill',
    'runtime_scopes:',
    '  - planner',
    '  - invalid-scope',
    'priority: not-a-number',
    '---',
    '',
    'a'.repeat(32),
  ].join('\n'));

  const loaded = await loadSkillFromDirectory(dir, { maxInstructionChars: 10 });

  assert.equal(loaded.name, 'noisy-skill');
  assert.deepEqual(loaded.runtimeScopes, ['planner']);
  assert.equal(loaded.priority, 100);
  assert.equal(loaded.instructions, 'aaaaaaaaaa');
  assert.equal(loaded.truncated, true);
});
