import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-skills-routes-db-')), 'test.db');
process.env.OPENDEEPSEA_SKILLS_DIR = mkdtempSync(join(tmpdir(), 'opendeepsea-skills-managed-'));

const { router } = await import('../routes.js');
const { skillRepo } = await import('./repo.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function createLocalSkill(name: string, body = 'Follow the local instructions.'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `opendeepsea-local-skill-${name}-`));
  await writeFile(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    'description: Imported skill.',
    'runtime_scopes:',
    '  - planner',
    'trigger_keywords:',
    `  - ${name}`,
    'priority: 80',
    '---',
    '',
    body,
  ].join('\n'));
  return dir;
}

test('skills routes import, list, detail, patch, bind, preview, and delete local skills', async () => {
  const sourceDir = await createLocalSkill('route-skill');

  const importRes = await request('/api/skills/import/local', {
    method: 'POST',
    body: JSON.stringify({ path: sourceDir }),
  });
  assert.equal(importRes.status, 201);
  const imported = await importRes.json() as {
    id: string;
    name: string;
    install_path?: string;
    source_uri?: string;
    install_path_set: boolean;
    runtime_scopes: string[];
  };
  assert.equal(imported.name, 'route-skill');
  assert.equal(imported.install_path, undefined);
  assert.equal(imported.source_uri, undefined);
  assert.equal(imported.install_path_set, true);
  assert.deepEqual(imported.runtime_scopes, ['planner']);

  const listRes = await request('/api/skills');
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as Array<{ id: string; name: string; install_path?: string; source_uri?: string }>;
  assert.equal(listed.some((skill) => skill.id === imported.id), true);
  assert.equal(listed.find((skill) => skill.id === imported.id)?.install_path, undefined);
  assert.equal(listed.find((skill) => skill.id === imported.id)?.source_uri, undefined);

  const detailRes = await request(`/api/skills/${imported.id}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as { id: string; install_path?: string; source_uri?: string; install_path_set: boolean };
  assert.equal(detail.id, imported.id);
  assert.equal(detail.install_path, undefined);
  assert.equal(detail.source_uri, undefined);
  assert.equal(detail.install_path_set, true);

  const patchRes = await request(`/api/skills/${imported.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false, priority: 30 }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as { enabled: 0 | 1; priority: number };
  assert.equal(patched.enabled, 0);
  assert.equal(patched.priority, 30);

  const bindingRes = await request('/api/skills/bindings', {
    method: 'PUT',
    body: JSON.stringify({
      skill_id: imported.id,
      scope: 'system',
      scope_id: 'ignored',
      enabled: true,
      priority_override: 25,
    }),
  });
  assert.equal(bindingRes.status, 200);
  const binding = await bindingRes.json() as { id: string; scope_id: string; priority_override: number };
  assert.equal(binding.scope_id, 'default');
  assert.equal(binding.priority_override, 25);

  const bindingsListRes = await request('/api/skills/bindings?scope=system&scopeId=default');
  assert.equal(bindingsListRes.status, 200);
  const bindings = await bindingsListRes.json() as Array<{ id: string }>;
  assert.equal(bindings.some((item) => item.id === binding.id), true);

  await request(`/api/skills/${imported.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: true }),
  });
  const previewRes = await request('/api/skills/preview-selection', {
    method: 'POST',
    body: JSON.stringify({ runtimeScopes: ['planner'], message: 'route-skill please' }),
  });
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json() as {
    skills: Array<{ id: string; reasons: string[] }>;
    promptPreview: string;
  };
  assert.equal(preview.skills[0]?.id, imported.id);
  assert.match(preview.skills[0]?.reasons.join('\n') ?? '', /keyword match/);
  assert.match(preview.promptPreview, /OpenDeepSea active skills/);

  const deleteBindingRes = await request(`/api/skills/bindings/${binding.id}`, { method: 'DELETE' });
  assert.equal(deleteBindingRes.status, 204);

  const managedPath = skillRepo.getSkill(imported.id)?.install_path;
  assert.ok(managedPath);
  assert.equal(existsSync(managedPath), true);
  const deleteSkillRes = await request(`/api/skills/${imported.id}`, { method: 'DELETE' });
  assert.equal(deleteSkillRes.status, 204);
  assert.equal(existsSync(sourceDir), true);
  assert.equal(existsSync(managedPath), false);

  const missingDetailRes = await request(`/api/skills/${imported.id}`);
  assert.equal(missingDetailRes.status, 404);
});

test('skills routes reject missing manifests and unsafe local imports', async () => {
  const missingManifestDir = mkdtempSync(join(tmpdir(), 'opendeepsea-no-skill-md-'));
  const missingRes = await request('/api/skills/import/local', {
    method: 'POST',
    body: JSON.stringify({ path: missingManifestDir }),
  });
  assert.equal(missingRes.status, 400);

  const emptyPathRes = await request('/api/skills/import/local', {
    method: 'POST',
    body: JSON.stringify({ path: '   ' }),
  });
  assert.equal(emptyPathRes.status, 400);

  const missingPathRes = await request('/api/skills/import/local', {
    method: 'POST',
    body: JSON.stringify({ path: join(tmpdir(), 'does-not-exist-opendeepsea-skill') }),
  });
  assert.equal(missingPathRes.status, 400);

  const symlinkSource = await createLocalSkill('unsafe-symlink');
  const externalFile = join(tmpdir(), `opendeepsea-external-${Date.now()}.txt`);
  writeFileSync(externalFile, 'do not copy this');
  symlinkSync(externalFile, join(symlinkSource, 'external.txt'));

  const symlinkRes = await request('/api/skills/import/local', {
    method: 'POST',
    body: JSON.stringify({ path: symlinkSource }),
  });
  assert.equal(symlinkRes.status, 201);
  const imported = await symlinkRes.json() as { id: string };
  const installed = skillRepo.getSkill(imported.id);
  assert.ok(installed);
  assert.equal(existsSync(join(installed.install_path, 'external.txt')), false);
  assert.equal(readFileSync(externalFile, 'utf-8'), 'do not copy this');

  const nodeModulesSource = await createLocalSkill('skip-dirs');
  await mkdir(join(nodeModulesSource, 'node_modules'), { recursive: true });
  await mkdir(join(nodeModulesSource, '.git'), { recursive: true });
  await writeFile(join(nodeModulesSource, 'node_modules', 'package.js'), 'ignored');
  await writeFile(join(nodeModulesSource, '.git', 'config'), 'ignored');
  const skipRes = await request('/api/skills/import/local', {
    method: 'POST',
    body: JSON.stringify({ path: nodeModulesSource }),
  });
  assert.equal(skipRes.status, 201);
  const skipImported = await skipRes.json() as { id: string };
  const skipInstalled = skillRepo.getSkill(skipImported.id);
  assert.ok(skipInstalled);
  assert.equal(existsSync(join(skipInstalled.install_path, 'node_modules')), false);
  assert.equal(existsSync(join(skipInstalled.install_path, '.git')), false);

  await rm(externalFile, { force: true });
});

test('git skill import is explicitly deferred', async () => {
  const res = await request('/api/skills/import/git', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://example.invalid/skills.git' }),
  });

  assert.equal(res.status, 501);
  const body = await res.json() as { error: string };
  assert.match(body.error, /not implemented/i);
});
