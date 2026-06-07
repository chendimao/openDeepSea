import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const testHome = mkdtempSync(join(tmpdir(), 'opendeepsea-platform-skills-home-'));
process.env.HOME = testHome;
process.env.CODEX_HOME = join(testHome, '.custom-codex');

const {
  getPlatformDefinitions,
  getPlatformSkill,
  listPlatformSkillAggregates,
  listPlatformSkills,
  resolvePlatformRoot,
} = await import('./service.js');

test.after(async () => {
  await rm(testHome, { recursive: true, force: true });
});

test('resolvePlatformRoot returns default native skill roots', () => {
  assert.equal(resolvePlatformRoot('codex'), join(testHome, '.custom-codex', 'skills'));
  assert.equal(resolvePlatformRoot('claudecode'), join(testHome, '.claude', 'skills'));
  assert.equal(resolvePlatformRoot('opencode'), join(testHome, '.config', 'opencode', 'skills'));
});

test('getPlatformDefinitions exposes all supported platforms in stable order', () => {
  assert.deepEqual(
    getPlatformDefinitions().map((item) => item.provider),
    ['codex', 'claudecode', 'opencode'],
  );
});

test('listPlatformSkills scans native skill directories and reads metadata', async () => {
  const skillDir = await createPlatformSkill('codex', 'copy-skill', 'Copied skill.', {
    sourceLabel: 'external:copy-skill',
    version: '1.2.3',
  });
  await mkdir(join(skillDir, 'assets'));
  await writeFile(join(skillDir, 'assets', 'note.txt'), 'asset');

  const listed = await listPlatformSkills('codex');
  const skill = listed.find((item) => item.name === 'copy-skill');
  assert.ok(skill);
  assert.equal(skill.description, 'Copied skill.');
  assert.equal(skill.sourceLabel, 'external:copy-skill');
  assert.equal(skill.version, '1.2.3');
  assert.equal(skill.installMode, 'copy');
  assert.equal(skill.valid, true);
});

test('listPlatformSkills uses directory name as the stable API identifier', async () => {
  await createPlatformSkill('opencode', 'Fancy-Skill', 'Skill with a display name.', {
    manifestName: 'Fancy Skill',
  });

  const listed = await listPlatformSkills('opencode');
  const skill = listed.find((item) => item.name === 'Fancy-Skill');
  assert.ok(skill);
  assert.equal(skill.name, 'Fancy-Skill');
  assert.equal(skill.description, 'Skill with a display name.');
});

test('getPlatformSkill returns null for unsafe or missing entries', async () => {
  assert.equal(await getPlatformSkill('codex', '../outside'), null);
  assert.equal(await getPlatformSkill('codex', 'missing-skill'), null);
});

test('listPlatformSkills marks malformed and broken entries invalid', async () => {
  const badDir = join(testHome, '.config', 'opencode', 'skills', 'bad-skill');
  await mkdir(badDir, { recursive: true });
  writeFileSync(join(badDir, 'README.md'), 'missing manifest');

  const root = join(testHome, '.claude', 'skills');
  const source = await createSourceSkill('broken-linked', 'Broken linked skill.');
  const linkPath = join(root, 'broken-linked');
  await mkdir(root, { recursive: true });
  await symlink(source, linkPath, 'dir');
  await rm(source, { recursive: true, force: true });

  const bad = (await listPlatformSkills('opencode')).find((item) => item.name === 'bad-skill');
  assert.ok(bad);
  assert.equal(bad.valid, false);
  assert.match(bad.issues.join('\n'), /SKILL\.md is required/);

  const broken = (await listPlatformSkills('claudecode')).find((item) => item.name === 'broken-linked');
  assert.ok(broken);
  assert.equal(broken.installMode, 'symlink');
  assert.equal(broken.valid, false);
  assert.match(broken.issues.join('\n'), /SKILL\.md is required/);
});

test('listPlatformSkillAggregates merges skills across platforms with stable provider ordering', async () => {
  await createPlatformSkill('codex', 'matrix-shared', 'Codex matrix skill.');

  const claudeSource = await createSourceSkill('matrix-shared', 'Claude matrix skill.');
  const claudeRoot = join(testHome, '.claude', 'skills');
  await mkdir(claudeRoot, { recursive: true });
  await symlink(claudeSource, join(claudeRoot, 'matrix-shared'), 'dir');

  const invalidDir = join(testHome, '.config', 'opencode', 'skills', 'matrix-invalid');
  await mkdir(invalidDir, { recursive: true });
  writeFileSync(join(invalidDir, 'README.md'), 'missing manifest');

  const aggregates = await listPlatformSkillAggregates();
  const shared = aggregates.find((item) => item.name === 'matrix-shared');
  assert.ok(shared);
  assert.deepEqual(shared.providers, ['codex', 'claudecode']);
  assert.deepEqual(shared.missingProviders, ['opencode']);
  assert.equal(shared.installModes.codex, 'copy');
  assert.equal(shared.installModes.claudecode, 'symlink');
  assert.equal(shared.description, 'Codex matrix skill.');
  assert.equal(shared.valid, true);
  assert.equal(shared.lastModifiedAt !== null, true);

  const invalid = aggregates.find((item) => item.name === 'matrix-invalid');
  assert.ok(invalid);
  assert.deepEqual(invalid.providers, ['opencode']);
  assert.deepEqual(invalid.missingProviders, ['codex', 'claudecode']);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues[0]?.provider, 'opencode');
  assert.match(invalid.issues[0]?.message ?? '', /SKILL\.md is required/);

  const names = aggregates.map((item) => item.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

async function createPlatformSkill(
  provider: 'codex' | 'claudecode' | 'opencode',
  name: string,
  description: string,
  options: {
    manifestName?: string;
    sourceLabel?: string;
    version?: string;
  } = {},
): Promise<string> {
  const dir = join(resolveProviderRoot(provider), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), [
    '---',
    `name: ${options.manifestName ?? name}`,
    `description: ${description}`,
    `version: ${options.version ?? '1.0.0'}`,
    '---',
    '',
    `Use ${name}.`,
    '',
  ].join('\n'));
  if (options.sourceLabel) {
    await writeFile(
      join(dir, '.opendeepsea-platform-skill.json'),
      `${JSON.stringify({ sourceLabel: options.sourceLabel })}\n`,
    );
  }
  return dir;
}

async function createSourceSkill(name: string, description: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `opendeepsea-platform-source-${name}-`));
  await writeFile(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `Use ${name}.`,
    '',
  ].join('\n'));
  return dir;
}

function resolveProviderRoot(provider: 'codex' | 'claudecode' | 'opencode'): string {
  if (provider === 'codex') return join(process.env.CODEX_HOME!, 'skills');
  if (provider === 'claudecode') return join(testHome, '.claude', 'skills');
  return join(testHome, '.config', 'opencode', 'skills');
}
