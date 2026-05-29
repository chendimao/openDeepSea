import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

const testHome = mkdtempSync(join(tmpdir(), 'opendeepsea-platform-skills-home-'));
process.env.HOME = testHome;
process.env.CODEX_HOME = join(testHome, '.custom-codex');

const {
  getPlatformDefinitions,
  installDirectoryToPlatforms,
  listPlatformSkillAggregates,
  listPlatformSkills,
  removePlatformSkill,
  resolvePlatformRoot,
} = await import('./service.js');

const tempSources: string[] = [];

test.after(async () => {
  await Promise.all(tempSources.map((dir) => rm(dir, { recursive: true, force: true })));
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

test('installDirectoryToPlatforms copies a local skill and listPlatformSkills reads metadata', async () => {
  const source = await createSourceSkill('copy-skill', 'Copied skill.');

  const installed = await installDirectoryToPlatforms({
    sourceDir: source,
    targets: ['codex'],
    installMode: 'copy',
    sourceLabel: `local:${basename(source)}`,
  });

  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.provider, 'codex');
  assert.equal(installed[0]?.name, 'copy-skill');
  assert.equal(installed[0]?.installMode, 'copy');
  assert.equal(existsSync(join(process.env.CODEX_HOME!, 'skills', 'copy-skill', 'assets', 'note.txt')), true);

  const listed = await listPlatformSkills('codex');
  const skill = listed.find((item) => item.name === 'copy-skill');
  assert.ok(skill);
  assert.equal(skill.description, 'Copied skill.');
  assert.equal(skill.sourceLabel, `local:${basename(source)}`);
  assert.equal(skill.version, '1.2.3');
  assert.equal(skill.valid, true);
});

test('installDirectoryToPlatforms rejects concurrent copy install to the same target', async () => {
  const source = await createSourceSkill('race-skill', 'Concurrent install.');
  const results = await Promise.allSettled([
    installDirectoryToPlatforms({
      sourceDir: source,
      targets: ['codex'],
      installMode: 'copy',
      sourceLabel: `local:${basename(source)}-a`,
    }),
    installDirectoryToPlatforms({
      sourceDir: source,
      targets: ['codex'],
      installMode: 'copy',
      sourceLabel: `local:${basename(source)}-b`,
    }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const listed = await listPlatformSkills('codex');
  assert.equal(listed.filter((item) => item.name === 'race-skill').length, 1);
});

test('listPlatformSkills uses directory name as the stable API identifier', async () => {
  const source = await createSourceSkill('Fancy Skill', 'Skill with a display name.');

  const installed = await installDirectoryToPlatforms({
    sourceDir: source,
    targets: ['opencode'],
    installMode: 'copy',
    sourceLabel: `local:${basename(source)}`,
  });

  assert.equal(installed[0]?.name, 'Fancy-Skill');
  assert.equal(existsSync(join(testHome, '.config', 'opencode', 'skills', 'Fancy-Skill')), true);

  const removed = await removePlatformSkill('opencode', installed[0]!.name);
  assert.equal(removed, true);
  assert.equal(existsSync(join(testHome, '.config', 'opencode', 'skills', 'Fancy-Skill')), false);
});

test('installDirectoryToPlatforms rejects unsafe skill names without touching platform root', async () => {
  const source = await createSourceSkill('.', 'Unsafe skill name.');
  const keepDir = join(process.env.CODEX_HOME!, 'skills', 'keep-skill');
  await mkdir(keepDir, { recursive: true });
  await writeFile(join(keepDir, 'SKILL.md'), '---\nname: keep-skill\n---\n');

  await assert.rejects(
    () => installDirectoryToPlatforms({
      sourceDir: source,
      targets: ['codex'],
      installMode: 'copy',
      sourceLabel: `local:${basename(source)}`,
    }),
    /safe directory name/,
  );
  assert.equal(existsSync(keepDir), true);

  await assert.rejects(
    () => removePlatformSkill('codex', '.'),
    /safe directory name/,
  );
  assert.equal(existsSync(keepDir), true);
});

test('installDirectoryToPlatforms preflights all targets before writing any platform', async () => {
  const source = await createSourceSkill('partial-skill', 'Partial install should not happen.');
  const conflictDir = join(testHome, '.config', 'opencode', 'skills', 'partial-skill');
  await mkdir(conflictDir, { recursive: true });
  await writeFile(join(conflictDir, 'SKILL.md'), '---\nname: partial-skill\n---\n');

  await assert.rejects(
    () => installDirectoryToPlatforms({
      sourceDir: source,
      targets: ['claudecode', 'opencode'],
      installMode: 'copy',
      sourceLabel: `local:${basename(source)}`,
    }),
    /already exists/,
  );

  assert.equal(existsSync(join(testHome, '.claude', 'skills', 'partial-skill')), false);
  assert.equal(existsSync(conflictDir), true);
});

test('installDirectoryToPlatforms symlinks the whole skill directory for advanced mode', async () => {
  const source = await createSourceSkill('linked-skill', 'Linked skill.');
  const installed = await installDirectoryToPlatforms({
    sourceDir: source,
    targets: ['claudecode'],
    installMode: 'symlink',
    sourceLabel: `local:${basename(source)}`,
  });

  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.provider, 'claudecode');
  assert.equal(installed[0]?.installMode, 'symlink');
  const target = join(testHome, '.claude', 'skills', 'linked-skill');
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.equal(existsSync(join(target, 'SKILL.md')), true);
});

test('installDirectoryToPlatforms rejects duplicate skill directories', async () => {
  const source = await createSourceSkill('copy-skill', 'Duplicate skill.');

  await assert.rejects(
    () => installDirectoryToPlatforms({
      sourceDir: source,
      targets: ['codex'],
      installMode: 'copy',
      sourceLabel: `local:${basename(source)}`,
    }),
    /already exists/i,
  );
});

test('removePlatformSkill deletes copies and only unlinks symlinks', async () => {
  const removedCopy = await removePlatformSkill('codex', 'copy-skill');
  assert.equal(removedCopy, true);
  assert.equal(existsSync(join(process.env.CODEX_HOME!, 'skills', 'copy-skill')), false);

  const sourceLinked = await createSourceSkill('source-linked', 'Source linked skill.');
  const linkPath = join(testHome, '.claude', 'skills', 'source-linked');
  await installDirectoryToPlatforms({
    sourceDir: sourceLinked,
    targets: ['claudecode'],
    installMode: 'symlink',
    sourceLabel: `local:${basename(sourceLinked)}`,
  });
  assert.equal(existsSync(join(sourceLinked, 'SKILL.md')), true);
  assert.equal(existsSync(join(linkPath, 'SKILL.md')), true);

  const removedLink = await removePlatformSkill('claudecode', 'source-linked');
  assert.equal(removedLink, true);
  assert.equal(existsSync(linkPath), false);
  assert.equal(existsSync(join(sourceLinked, 'SKILL.md')), true);
});

test('removePlatformSkill can delete a broken symlink entry', async () => {
  const root = join(testHome, '.claude', 'skills');
  const source = await createSourceSkill('broken-linked', 'Broken linked skill.');
  const linkPath = join(root, 'broken-linked');
  await mkdir(root, { recursive: true });
  await symlink(source, linkPath, 'dir');
  await rm(source, { recursive: true, force: true });

  const listed = await listPlatformSkills('claudecode');
  const broken = listed.find((item) => item.name === 'broken-linked');
  assert.ok(broken);
  assert.equal(broken.installMode, 'symlink');
  assert.equal(broken.valid, false);

  const removed = await removePlatformSkill('claudecode', 'broken-linked');
  assert.equal(removed, true);
  assert.equal(existsSync(linkPath), false);
});

test('listPlatformSkills marks malformed entries invalid', async () => {
  const badDir = join(testHome, '.config', 'opencode', 'skills', 'bad-skill');
  await mkdir(badDir, { recursive: true });
  writeFileSync(join(badDir, 'README.md'), 'missing manifest');

  const listed = await listPlatformSkills('opencode');
  const bad = listed.find((item) => item.name === 'bad-skill');
  assert.ok(bad);
  assert.equal(bad.valid, false);
  assert.match(bad.issues.join('\n'), /SKILL\.md is required/);
});

test('listPlatformSkillAggregates merges skills across platforms with stable provider ordering', async () => {
  const codexSource = await createSourceSkill('matrix-shared', 'Codex matrix skill.');
  const claudeSource = await createSourceSkill('matrix-shared', 'Claude matrix skill.');
  const invalidDir = join(testHome, '.config', 'opencode', 'skills', 'matrix-invalid');
  await mkdir(invalidDir, { recursive: true });
  writeFileSync(join(invalidDir, 'README.md'), 'missing manifest');

  await installDirectoryToPlatforms({
    sourceDir: codexSource,
    targets: ['codex'],
    installMode: 'copy',
    sourceLabel: `local:${basename(codexSource)}`,
  });
  await installDirectoryToPlatforms({
    sourceDir: claudeSource,
    targets: ['claudecode'],
    installMode: 'symlink',
    sourceLabel: `local:${basename(claudeSource)}`,
  });

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

test('removePlatformSkill rejects path traversal outside platform root', async () => {
  await assert.rejects(
    () => removePlatformSkill('codex', '../outside'),
    /safe directory name/,
  );
});

async function createSourceSkill(name: string, description: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `opendeepsea-platform-source-${name}-`));
  tempSources.push(dir);

  await writeFile(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'version: 1.2.3',
    '---',
    '',
    'Follow platform instructions.',
  ].join('\n'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'assets', 'note.txt'), 'asset');
  return dir;
}
