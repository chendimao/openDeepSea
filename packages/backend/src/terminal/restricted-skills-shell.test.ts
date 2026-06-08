import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRestrictedSkillsCommand } from './restricted-skills-shell.js';

test('restricted skills shell accepts npx skills commands', () => {
  assert.deepEqual(parseRestrictedSkillsCommand('npx --yes skills find browser'), {
    kind: 'spawn',
    file: 'npx',
    args: ['--yes', 'skills', 'find', 'browser'],
  });
  assert.deepEqual(parseRestrictedSkillsCommand('npx skills add "agent browser"'), {
    kind: 'spawn',
    file: 'npx',
    args: ['skills', 'add', 'agent browser'],
  });
  assert.deepEqual(parseRestrictedSkillsCommand('npx skills add https://github.com/vercel-labs/skills --skill find-skills'), {
    kind: 'spawn',
    file: 'npx',
    args: ['skills', 'add', 'https://github.com/vercel-labs/skills', '--skill', 'find-skills'],
  });
});

test('restricted skills shell accepts direct skills commands and local commands', () => {
  assert.deepEqual(parseRestrictedSkillsCommand('skills check'), {
    kind: 'spawn',
    file: 'skills',
    args: ['check'],
  });
  assert.deepEqual(parseRestrictedSkillsCommand('pwd'), { kind: 'local', name: 'pwd' });
  assert.deepEqual(parseRestrictedSkillsCommand('clear'), { kind: 'local', name: 'clear' });
  assert.deepEqual(parseRestrictedSkillsCommand('exit'), { kind: 'local', name: 'exit' });
});

test('restricted skills shell rejects shell syntax and unsupported commands', () => {
  for (const command of [
    'TOKEN=abc npx skills add demo',
    'npx skills add demo && rm -rf /',
    'npx skills add demo | cat',
    'npx skills add demo > out',
    'npx skills add $(pwd)',
    'curl https://example.com/install.sh',
    'npx cowsay hi',
    'skills remove demo',
  ]) {
    assert.throws(() => parseRestrictedSkillsCommand(command));
  }
});

test('restricted skills shell rejects malformed quotes', () => {
  assert.throws(() => parseRestrictedSkillsCommand('npx skills add "unfinished'));
});
