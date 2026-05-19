import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-skills-executor-db-')), 'test.db');
process.env.OPENDEEPSEA_SKILLS_DIR = mkdtempSync(join(tmpdir(), 'opendeepsea-skills-executor-managed-'));

const { db } = await import('../db.js');
const { projectRepo } = await import('../repos/projects.js');
const { skillRepo } = await import('./repo.js');
const { invokeSkill } = await import('./executor.js');

function reset(): void {
  db.prepare('DELETE FROM skill_runs').run();
  db.prepare('DELETE FROM skills').run();
  db.prepare('DELETE FROM projects').run();
}

test('invokeSkill runs an executable skill for a project', async () => {
  reset();
  const projectPath = mkdtempSync(join(tmpdir(), 'opendeepsea-invoke-project-'));
  const project = projectRepo.create({ name: 'Invoke Project', path: projectPath });
  const installPath = mkdtempSync(join(process.env.OPENDEEPSEA_SKILLS_DIR!, 'invoke-skill-'));
  await mkdir(join(installPath, 'scripts'), { recursive: true });
  await writeFile(join(installPath, 'SKILL.md'), '# Invoke Skill\n');
  await writeFile(join(installPath, 'scripts', 'run.sh'), 'cat > invoke-input.json\necho invoked\n');
  const skill = skillRepo.createSkill({
    id: 'skill-invoke-runtime',
    name: 'invoke-runtime-skill',
    source_type: 'skills_sh',
    source_uri: 'skills.sh/acme/invoke-runtime',
    install_path: installPath,
    manifest_path: 'SKILL.md',
    runtime_scopes: ['workflow'],
    trigger_mode: 'manual',
    runtime_type: 'shell',
    entrypoint: 'scripts/run.sh',
    permissions: { filesystem: 'project', network: true, commands: ['bash'] },
  });

  const run = await invokeSkill({
    skillId: skill.id,
    projectId: project.id,
    invokedBy: 'workflow',
    input: { value: 1 },
  });

  assert.equal(run.status, 'completed');
  assert.match(run.stdout ?? '', /invoked/);
});
