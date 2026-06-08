import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sourceUrl = new URL('./SkillsPage.tsx', import.meta.url);

test('SkillsPage opens the restricted skills install terminal only', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /<TerminalPanel/);
  assert.match(source, /profile="skills_install"/);
  assert.doesNotMatch(source, /profile="project_shell"/);
});

test('SkillsPage refreshes platform skill queries from terminal refresh events', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /platform-skills', 'platforms'/);
  assert.match(source, /platform-skills', 'aggregate'/);
  assert.match(source, /onRefreshRequested=\{refreshPlatformSkills\}/);
});
