import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sourceUrl = new URL('./SkillsPage.tsx', import.meta.url);

test('SkillsPage opens the restricted skills install terminal only', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /<TerminalPanel/);
  assert.match(source, /profile="skills_install"/);
  assert.match(source, /initialInput=\{initialInstallCommand\}/);
  assert.doesNotMatch(source, /profile="project_shell"/);
});

test('SkillsPage defaults to online skills APIs and refreshes local status after terminal events', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /api\.listOnlineSkills/);
  assert.match(source, /api\.searchOnlineSkills/);
  assert.match(source, /\['online-skills'/);
  assert.match(source, /useState\(false\)/);
  assert.match(source, /platform-skills', 'platforms'/);
  assert.match(source, /platform-skills', 'aggregate'/);
  assert.match(source, /queryKey: \['online-skills'\]/);
  assert.match(source, /onRefreshRequested=\{refreshPlatformSkills\}/);
});
