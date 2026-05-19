import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-skills-installer-db-')), 'test.db');
process.env.OPENDEEPSEA_SKILLS_DIR = mkdtempSync(join(tmpdir(), 'opendeepsea-skills-installer-managed-'));

const { db } = await import('../db.js');
const {
  checkSkillsShUpdate,
  importLocalSkill,
  installSkillsShSkill,
} = await import('./installer.js');
const { createSkillsShPackage, normalizeSkillsShManifest } = await import('./installer-runner.js');
const { skillRepo } = await import('./repo.js');
const { SkillsShClient } = await import('./skills-sh-client.js');

function resetSkills(): void {
  db.prepare('DELETE FROM skill_bindings').run();
  db.prepare('DELETE FROM skills').run();
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

test('installSkillsShSkill installs a public executable package and records source metadata', async () => {
  resetSkills();
  const client = new SkillsShClient({
    fetch: async () => jsonResponse({
      id: 'acme/skills/executable',
      skillId: 'executable',
      source: 'acme/skills',
      version: '1.2.3',
      revision: 'rev-abc',
      files: [
        {
          path: 'SKILL.md',
          content: [
            '---',
            'name: executable-skill',
            'description: Runs a checked script.',
            'runtime_scopes:',
            '  - workflow',
            'trigger_mode: manual',
            'priority: 70',
            '---',
            '',
            'Run the checked script.',
          ].join('\n'),
        },
        {
          path: 'skill.json',
          content: JSON.stringify({
            name: 'executable-skill',
            version: '1.2.3',
            revision: 'rev-abc',
            runtime: 'node',
            entrypoint: 'scripts/main.js',
            permissions: {
              filesystem: 'project',
              network: true,
              commands: ['node'],
            },
          }),
        },
        {
          path: 'scripts/main.js',
          content: 'console.log("installed");\n',
        },
      ],
    }),
  });

  const skill = await installSkillsShSkill('acme/skills/executable', { client });

  assert.equal(skill.name, 'executable-skill');
  assert.equal(skill.source_type, 'skills_sh');
  assert.equal(skill.source_uri, 'skills.sh/acme/skills/executable');
  assert.equal(skill.package_version, '1.2.3');
  assert.equal(skill.package_revision, 'rev-abc');
  assert.equal(skill.runtime_type, 'node');
  assert.equal(skill.entrypoint, 'scripts/main.js');
  assert.deepEqual(skill.permissions, {
    filesystem: 'project',
    network: true,
    commands: ['node'],
  });
  assert.equal(skill.install_source_label, 'acme/skills/executable');
  assert.equal(skill.update_check_mode, 'startup');
  assert.equal(skill.update_apply_mode, 'prompt');
  assert.match(skill.checksum ?? '', /^[a-f0-9]{64}$/);
  assert.equal(skill.manifest_path, 'SKILL.md');
  assert.equal(existsSync(join(skill.install_path, 'SKILL.md')), true);
  assert.equal(existsSync(join(skill.install_path, 'skill.json')), true);
  assert.equal(readFileSync(join(skill.install_path, 'scripts/main.js'), 'utf-8'), 'console.log("installed");\n');
});

test('installSkillsShSkill installs prompt-only public packages with executable fields empty', async () => {
  resetSkills();
  const client = new SkillsShClient({
    fetch: async () => jsonResponse({
      id: 'acme/skills/prompt-only',
      skillId: 'prompt-only',
      source: 'acme/skills',
      version: '0.1.0',
      revision: 'rev-prompt',
      files: {
        'SKILL.md': [
          '---',
          'name: prompt-only-skill',
          'description: Prompt only.',
          'runtime_scopes: [planner]',
          '---',
          '',
          'Use this prompt-only skill.',
        ].join('\n'),
      },
    }),
  });

  const skill = await installSkillsShSkill('acme/skills/prompt-only', { client });

  assert.equal(skill.source_type, 'skills_sh');
  assert.equal(skill.package_version, '0.1.0');
  assert.equal(skill.package_revision, 'rev-prompt');
  assert.equal(skill.runtime_type, null);
  assert.equal(skill.entrypoint, null);
  assert.equal(skill.permissions, null);
});

test('installSkillsShSkill rejects unsafe remote package paths before writing outside managed dir', async () => {
  resetSkills();
  const outside = join(process.env.OPENDEEPSEA_SKILLS_DIR!, '..', 'escaped.txt');
  const client = new SkillsShClient({
    fetch: async () => jsonResponse({
      id: 'acme/skills/unsafe',
      skillId: 'unsafe',
      source: 'acme/skills',
      files: [
        { path: 'SKILL.md', content: '# Unsafe Skill\n' },
        { path: '../escaped.txt', content: 'escaped' },
      ],
    }),
  });

  await assert.rejects(
    () => installSkillsShSkill('acme/skills/unsafe', { client }),
    /unsafe package path/i,
  );
  assert.equal(existsSync(outside), false);
});

test('checkSkillsShUpdate records whether the remote package has a newer version or revision', async () => {
  resetSkills();
  const localDir = mkdtempSync(join(tmpdir(), 'opendeepsea-local-update-skill-'));
  await writeFile(join(localDir, 'SKILL.md'), [
    '---',
    'name: update-check-skill',
    'runtime_scopes: [planner]',
    '---',
    '',
    'Check updates.',
  ].join('\n'));
  const skill = await importLocalSkill(localDir);
  const skillsShSkill = skillRepo.updateSkill(skill.id, {
    source_type: 'skills_sh',
    source_uri: 'skills.sh/acme/skills/update-check',
    install_source_label: 'acme/skills/update-check',
    package_version: '1.0.0',
    package_revision: 'rev-old',
  });
  assert.ok(skillsShSkill);

  const client = new SkillsShClient({
    fetch: async () => jsonResponse({
      id: 'acme/skills/update-check',
      skillId: 'update-check',
      source: 'acme/skills',
      version: '1.1.0',
      revision: 'rev-new',
      files: {
        'SKILL.md': '# Update Check Skill\n',
      },
    }),
  });

  const result = await checkSkillsShUpdate(skillsShSkill, { client });
  const updated = skillRepo.getSkill(skillsShSkill.id);

  assert.equal(result.hasUpdate, true);
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.currentRevision, 'rev-old');
  assert.equal(result.availableVersion, '1.1.0');
  assert.equal(result.availableRevision, 'rev-new');
  assert.equal(updated?.available_version, '1.1.0');
  assert.equal(updated?.available_revision, 'rev-new');
  assert.equal(typeof updated?.last_update_checked_at, 'number');
});

test('checkSkillsShUpdate ignores non-skills.sh skills', async () => {
  resetSkills();
  const localDir = mkdtempSync(join(tmpdir(), 'opendeepsea-local-no-update-skill-'));
  await writeFile(join(localDir, 'SKILL.md'), [
    '---',
    'name: local-no-update-skill',
    'runtime_scopes: [planner]',
    '---',
    '',
    'Local only.',
  ].join('\n'));
  const skill = await importLocalSkill(localDir);

  await assert.rejects(
    () => checkSkillsShUpdate(skill),
    /only skills\.sh skills/i,
  );
});

test('createSkillsShPackage rejects private registry metadata and unsafe manifest entrypoints', () => {
  assert.throws(
    () => createSkillsShPackage({
      id: 'private-skill',
      source: 'https://registry.example.test/private',
      skillId: 'private-skill',
      files: {
        'SKILL.md': '# Private Skill\n',
      },
    }),
    /private registries are not supported/i,
  );

  assert.throws(
    () => normalizeSkillsShManifest({
      runtime: 'shell',
      entrypoint: '../run.sh',
      permissions: {
        filesystem: 'project',
        network: false,
        commands: ['bash'],
      },
    }),
    /entrypoint must be a safe relative path/i,
  );
});
