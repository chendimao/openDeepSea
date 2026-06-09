import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sourceUrl = new URL('./SkillsPage.tsx', import.meta.url);
const cssUrl = new URL('./SkillsPage.css', import.meta.url);

test('SkillsPage opens the restricted skills install terminal only', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /<TerminalPanel/);
  assert.match(source, /profile="skills_install"/);
  assert.match(source, /initialInput=\{initialInstallCommand\}/);
  assert.doesNotMatch(source, /profile="project_shell"/);
});

test('SkillsPage defaults to online skills APIs and refreshes local status after terminal events', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /useInfiniteQuery/);
  assert.match(source, /api\.listOnlineSkills/);
  assert.match(source, /api\.searchOnlineSkills/);
  assert.match(source, /useDebouncedValue\(trimmedSearchQuery, 350\)/);
  assert.match(source, /fetchNextPage/);
  assert.match(source, /onScroll=\{handleListScroll\}/);
  assert.match(source, /getNextPageParam/);
  assert.match(source, /api\.getOnlineSkillsTokenConfig/);
  assert.match(source, /api\.updateOnlineSkillsTokenConfig/);
  assert.match(source, /\['online-skills'/);
  assert.match(source, /useState\(false\)/);
  assert.match(source, /platform-skills', 'platforms'/);
  assert.match(source, /platform-skills', 'aggregate'/);
  assert.match(source, /queryKey: \['online-skills'\]/);
  assert.match(source, /queryKey: \['online-skills', 'token-config'\]/);
  assert.match(source, /onRefreshRequested=\{refreshPlatformSkills\}/);
});

test('SkillsPage removes pagination and shows per-platform install status in the list', () => {
  const source = readFileSync(sourceUrl, 'utf8');
  const css = readFileSync(cssUrl, 'utf8');

  assert.match(source, /PlatformInstallStrip/);
  assert.match(source, /isSkillInstalledForProvider/);
  assert.match(source, /providerLabel\(provider\)/);
  assert.match(source, /SkillsListLoadState/);
  assert.doesNotMatch(source, /function SkillsPagination/);
  assert.doesNotMatch(source, /上一页/);
  assert.doesNotMatch(source, /下一页/);
  assert.doesNotMatch(css, /skills-pagination/);
  assert.match(css, /skills-platform-strip/);
  assert.match(css, /skills-platform-chip/);
  assert.match(css, /skills-list-load-state/);
});

test('SkillsPage supports SkillsMP API Key configuration and keeps terminal below the app header', () => {
  const source = readFileSync(sourceUrl, 'utf8');
  const css = readFileSync(cssUrl, 'utf8');

  assert.match(source, /SkillsMP API Key/);
  assert.match(source, /skillsmp\.com/);
  assert.match(source, /匿名 REST/);
  assert.match(source, /SkillsMpTokenSettingsPanel/);
  assert.match(source, /SKILLSMP_API_TOKEN/);
  assert.match(source, /完整 API Key 只提交给本地后端保存/);
  assert.doesNotMatch(source, /skills\.sh API Token/);
  assert.doesNotMatch(source, /Vercel OIDC/);
  assert.match(css, /--skills-shell-top-offset: 48px/);
  assert.match(css, /skills-token-panel/);
  assert.match(css, /inset: var\(--skills-shell-top-offset\) 0 0/);
  assert.match(css, /height: calc\(100dvh - var\(--skills-shell-top-offset\)\)/);
});

test('TerminalPanel supports prefilled command input without auto-executing it', () => {
  const terminalSource = readFileSync(new URL('../components/TerminalPanel.tsx', import.meta.url), 'utf8');

  assert.match(terminalSource, /initialInput\?: string/);
  assert.match(terminalSource, /roomSocket\.sendTerminalInput\(nextSessionId, command\)/);
  assert.doesNotMatch(terminalSource, /command\s*\+\s*['"]\\n['"]/);
  assert.doesNotMatch(terminalSource, /command\s*\+\s*['"]\\r['"]/);
});
