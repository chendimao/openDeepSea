import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-skills-runtime-db-')), 'test.db');
process.env.OPENDEEPSEA_SKILLS_DIR = mkdtempSync(join(tmpdir(), 'opendeepsea-skills-runtime-managed-'));

const { db } = await import('../db.js');
const { projectRepo } = await import('../repos/projects.js');
const { skillRepo } = await import('./repo.js');
const { skillRunRepo } = await import('./run-repo.js');
const { runSkillInProjectSandbox, validateProjectSandboxPath } = await import('./runtime.js');

function reset(): void {
  db.prepare('DELETE FROM skill_runs').run();
  db.prepare('DELETE FROM skills').run();
  db.prepare('DELETE FROM projects').run();
}

async function createProject(): Promise<{ id: string; path: string }> {
  const path = mkdtempSync(join(tmpdir(), 'opendeepsea-skill-project-'));
  const project = projectRepo.create({ name: 'Skill Project', path });
  return { id: project.id, path };
}

async function createShellSkill(): Promise<string> {
  const installPath = mkdtempSync(join(process.env.OPENDEEPSEA_SKILLS_DIR!, 'shell-skill-'));
  await mkdir(join(installPath, 'scripts'), { recursive: true });
  await writeFile(join(installPath, 'SKILL.md'), '# Shell Skill\n');
  await writeFile(join(installPath, 'scripts', 'run.sh'), [
    'set -eu',
    'input=$(cat)',
    'printf "%s" "$input" > skill-output.json',
    'echo "wrote-output"',
  ].join('\n'));
  const skill = skillRepo.createSkill({
    id: 'skill-shell-runtime',
    name: 'shell-runtime-skill',
    source_type: 'skills_sh',
    source_uri: 'skills.sh/acme/shell-runtime',
    install_path: installPath,
    manifest_path: 'SKILL.md',
    runtime_scopes: ['workflow'],
    trigger_mode: 'manual',
    runtime_type: 'shell',
    entrypoint: 'scripts/run.sh',
    permissions: { filesystem: 'project', network: true, commands: ['bash'] },
  });
  return skill.id;
}

test('validateProjectSandboxPath rejects paths outside the project directory', async () => {
  reset();
  const project = await createProject();

  assert.equal(validateProjectSandboxPath(project.path, project.path), project.path);
  assert.throws(
    () => validateProjectSandboxPath(project.path, join(project.path, '..', 'outside')),
    /outside the project sandbox/i,
  );
});

test('runSkillInProjectSandbox executes shell skills inside the project and records output', async () => {
  reset();
  const project = await createProject();
  const skillId = await createShellSkill();

  const run = await runSkillInProjectSandbox({
    skillId,
    projectId: project.id,
    invokedBy: 'workflow',
    input: { ok: true },
  });

  assert.equal(run.status, 'completed');
  assert.equal(run.exit_code, 0);
  assert.match(run.stdout ?? '', /wrote-output/);
  assert.equal(readFileSync(join(project.path, 'skill-output.json'), 'utf-8'), JSON.stringify({ ok: true }));

  const stored = skillRunRepo.getRun(run.id);
  assert.equal(stored?.skill_id, skillId);
  assert.equal(stored?.project_id, project.id);
  assert.equal(stored?.network_enabled, 1);
  assert.deepEqual(stored?.allowed_paths, [realpathSync(project.path)]);
});

test('runSkillInProjectSandbox blocks filesystem access outside the project directory', async () => {
  reset();
  const project = await createProject();
  const outsideDir = mkdtempSync(join(tmpdir(), 'opendeepsea-skill-outside-'));
  const outsideSecret = join(outsideDir, 'secret.txt');
  const outsideWrite = join(outsideDir, 'write.txt');
  writeFileSync(outsideSecret, 'secret');

  const installPath = mkdtempSync(join(process.env.OPENDEEPSEA_SKILLS_DIR!, 'sandbox-boundary-skill-'));
  await mkdir(join(installPath, 'scripts'), { recursive: true });
  await writeFile(join(installPath, 'SKILL.md'), '# Sandbox Boundary Skill\n');
  await writeFile(join(installPath, 'scripts', 'run.sh'), [
    'set +e',
    `cat ${JSON.stringify(outsideSecret)} > outside-read.txt 2> outside-read.err`,
    'read_status=$?',
    `(echo denied > ${JSON.stringify(outsideWrite)}) 2> outside-write.err`,
    'write_status=$?',
    'echo allowed > project-write.txt',
    'printf \'{"readStatus":%s,"writeStatus":%s}\\n\' "$read_status" "$write_status"',
  ].join('\n'));
  const skill = skillRepo.createSkill({
    id: 'skill-sandbox-boundary',
    name: 'sandbox-boundary-skill',
    source_type: 'skills_sh',
    source_uri: 'skills.sh/acme/sandbox-boundary',
    install_path: installPath,
    manifest_path: 'SKILL.md',
    runtime_scopes: ['workflow'],
    trigger_mode: 'manual',
    runtime_type: 'shell',
    entrypoint: 'scripts/run.sh',
    permissions: { filesystem: 'project', network: false, commands: ['bash'] },
  });

  const run = await runSkillInProjectSandbox({
    skillId: skill.id,
    projectId: project.id,
    invokedBy: 'workflow',
    input: null,
  });

  assert.equal(run.status, 'completed');
  assert.deepEqual(run.result, { readStatus: 1, writeStatus: 1 });
  assert.equal(readFileSync(join(project.path, 'project-write.txt'), 'utf-8').trim(), 'allowed');
  assert.equal(existsSync(outsideWrite), false);
  assert.match(readFileSync(join(project.path, 'outside-read.err'), 'utf-8'), /Operation not permitted/i);
  assert.match(readFileSync(join(project.path, 'outside-write.err'), 'utf-8'), /Operation not permitted/i);
});

test('runSkillInProjectSandbox records failed executions', async () => {
  reset();
  const project = await createProject();
  const installPath = mkdtempSync(join(process.env.OPENDEEPSEA_SKILLS_DIR!, 'failing-skill-'));
  await mkdir(join(installPath, 'scripts'), { recursive: true });
  await writeFile(join(installPath, 'SKILL.md'), '# Failing Skill\n');
  await writeFile(join(installPath, 'scripts', 'run.sh'), 'echo fail >&2\nexit 3\n');
  const skill = skillRepo.createSkill({
    id: 'skill-failing-runtime',
    name: 'failing-runtime-skill',
    source_type: 'skills_sh',
    source_uri: 'skills.sh/acme/failing-runtime',
    install_path: installPath,
    manifest_path: 'SKILL.md',
    runtime_scopes: ['workflow'],
    trigger_mode: 'manual',
    runtime_type: 'shell',
    entrypoint: 'scripts/run.sh',
    permissions: { filesystem: 'project', network: false, commands: ['bash'] },
  });

  const run = await runSkillInProjectSandbox({
    skillId: skill.id,
    projectId: project.id,
    invokedBy: 'agent',
    input: null,
  });

  assert.equal(run.status, 'failed');
  assert.equal(run.exit_code, 3);
  assert.match(run.stderr ?? '', /fail/);
  assert.match(run.error ?? '', /exit code 3/i);
});

test('runSkillInProjectSandbox rejects skills without executable metadata', async () => {
  reset();
  const project = await createProject();
  skillRepo.createSkill({
    id: 'skill-prompt-only-runtime',
    name: 'prompt-only-runtime-skill',
    source_type: 'manual',
    source_uri: null,
    install_path: mkdtempSync(join(process.env.OPENDEEPSEA_SKILLS_DIR!, 'prompt-only-runtime-')),
    manifest_path: 'SKILL.md',
    runtime_scopes: ['planner'],
    trigger_mode: 'manual',
  });

  await assert.rejects(
    () => runSkillInProjectSandbox({
      skillId: 'skill-prompt-only-runtime',
      projectId: project.id,
      invokedBy: 'manual',
      input: null,
    }),
    /does not declare an executable runtime/i,
  );
});
