import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-skills-routes-db-')), 'test.db');
process.env.OPENDEEPSEA_SKILLS_DIR = mkdtempSync(join(tmpdir(), 'opendeepsea-skills-managed-'));
process.env.OPENDEEPSEA_LOCAL_TOKEN = 'skills-routes-local-token';

const LOCAL_TOKEN = process.env.OPENDEEPSEA_LOCAL_TOKEN;

const { router } = await import('../routes.js');
const { skillRepo } = await import('./repo.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

const originalFetch = globalThis.fetch;

async function request(path: string, init: RequestInit = {}, options: { localToken?: boolean } = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (options.localToken !== false) {
      headers.set('X-OpenDeepSea-Local-Token', LOCAL_TOKEN);
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

function mockSkillsShFetch(handler: (url: URL) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.origin === 'https://skills.sh') {
      return handler(url);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
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

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('skills routes require local access token', async () => {
  const res = await request('/api/skills', {}, { localToken: false });

  assert.equal(res.status, 403);
});

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
    source_uri: string | null;
    install_path_set: boolean;
    runtime_scopes: string[];
  };
  assert.equal(imported.name, 'route-skill');
  assert.equal(imported.install_path, undefined);
  assert.equal(imported.source_uri, sourceDir);
  assert.equal(imported.install_path_set, true);
  assert.deepEqual(imported.runtime_scopes, ['planner']);

  const listRes = await request('/api/skills');
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as Array<{ id: string; name: string; install_path?: string; source_uri: string | null }>;
  assert.equal(listed.some((skill) => skill.id === imported.id), true);
  assert.equal(listed.find((skill) => skill.id === imported.id)?.install_path, undefined);
  assert.equal(listed.find((skill) => skill.id === imported.id)?.source_uri, sourceDir);

  const detailRes = await request(`/api/skills/${imported.id}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as { id: string; install_path?: string; source_uri: string | null; install_path_set: boolean };
  assert.equal(detail.id, imported.id);
  assert.equal(detail.install_path, undefined);
  assert.equal(detail.source_uri, sourceDir);
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

test('skills routes reject duplicate skill names', async () => {
  const firstDir = await createLocalSkill('duplicate-skill', 'First instructions.');
  const secondDir = await createLocalSkill('duplicate-skill', 'Second instructions.');

  const firstRes = await request('/api/skills/import/local', {
    method: 'POST',
    body: JSON.stringify({ path: firstDir }),
  });
  assert.equal(firstRes.status, 201);

  const secondRes = await request('/api/skills/import/local', {
    method: 'POST',
    body: JSON.stringify({ path: secondDir }),
  });

  assert.equal(secondRes.status, 409);
  const body = await secondRes.json() as { error: string };
  assert.match(body.error, /same name/i);
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

test('skills routes search the public skills.sh marketplace', async () => {
  const requestedUrls: string[] = [];
  mockSkillsShFetch(async (url) => {
    requestedUrls.push(url.toString());
    return jsonResponse({
      skills: [
        {
          id: 'acme/skills/route-marketplace',
          skillId: 'route-marketplace',
          name: 'route-marketplace',
          source: 'acme/skills',
          description: 'Marketplace route skill.',
          installs: '42',
          version: '1.0.0',
          revision: 'rev-market',
        },
      ],
    });
  });

  const res = await request('/api/skills/marketplace?q=route');

  assert.equal(res.status, 200);
  assert.equal(new URL(requestedUrls[0]!).origin, 'https://skills.sh');
  assert.equal(new URL(requestedUrls[0]!).pathname, '/api/search');
  assert.equal(new URL(requestedUrls[0]!).searchParams.get('q'), 'route');
  const body = await res.json() as Array<{
    id: string;
    name: string;
    skillId: string | null;
    source: string | null;
    installLabel: string;
    description: string | null;
    installs: number | null;
    version: string | null;
    revision: string | null;
  }>;
  assert.deepEqual(body, [
    {
      id: 'acme/skills/route-marketplace',
      name: 'route-marketplace',
      skillId: 'route-marketplace',
      source: 'acme/skills',
      installLabel: 'acme/skills/route-marketplace',
      description: 'Marketplace route skill.',
      installs: 42,
      version: '1.0.0',
      revision: 'rev-market',
    },
  ]);
});

test('skills routes import skills.sh packages, expose executable metadata, check updates, and patch update modes', async () => {
  const requestedUrls: string[] = [];
  mockSkillsShFetch(async (url) => {
    requestedUrls.push(url.toString());
    if (url.pathname === '/api/download/acme/skills/route-package') {
      return jsonResponse({
        id: 'acme/skills/route-package',
        skillId: 'route-package',
        source: 'acme/skills',
        version: '1.0.0',
        revision: 'rev-1',
        files: [
          {
            path: 'SKILL.md',
            content: [
              '---',
              'name: route-package-skill',
              'description: Installed through the route.',
              'runtime_scopes: [workflow]',
              'trigger_mode: manual',
              'priority: 60',
              '---',
              '',
              'Run route package.',
            ].join('\n'),
          },
          {
            path: 'skill.json',
            content: JSON.stringify({
              name: 'route-package-skill',
              description: 'Executable route package.',
              version: '1.0.0',
              revision: 'rev-1',
              runtime: 'shell',
              entrypoint: 'scripts/run.sh',
              permissions: {
                filesystem: 'project',
                network: false,
                commands: ['bash'],
              },
            }),
          },
          {
            path: 'scripts/run.sh',
            content: 'echo route-package\n',
          },
        ],
      });
    }
    if (url.pathname === '/api/download/acme/skills/route-package-updated') {
      return jsonResponse({
        id: 'acme/skills/route-package-updated',
        skillId: 'route-package-updated',
        source: 'acme/skills',
        version: '1.1.0',
        revision: 'rev-2',
        files: {
          'SKILL.md': '# Route Package Updated\n',
        },
      });
    }
    throw new Error(`unexpected skills.sh request: ${url.pathname}`);
  });

  const importRes = await request('/api/skills/import/skills-sh', {
    method: 'POST',
    body: JSON.stringify({ installLabel: 'acme/skills/route-package' }),
  });
  assert.equal(importRes.status, 201);
  const imported = await importRes.json() as {
    id: string;
    source_uri: string | null;
    package_version: string | null;
    package_revision: string | null;
    runtime_type: string | null;
    entrypoint: string | null;
    permissions: { filesystem: string; network: boolean; commands: string[] } | null;
    install_source_label: string | null;
    update_check_mode: string;
    update_apply_mode: string;
    last_update_checked_at: number | null;
    available_version: string | null;
    available_revision: string | null;
  };
  assert.equal(imported.source_uri, 'skills.sh/acme/skills/route-package');
  assert.equal(imported.package_version, '1.0.0');
  assert.equal(imported.package_revision, 'rev-1');
  assert.equal(imported.runtime_type, 'shell');
  assert.equal(imported.entrypoint, 'scripts/run.sh');
  assert.deepEqual(imported.permissions, { filesystem: 'project', network: false, commands: ['bash'] });
  assert.equal(imported.install_source_label, 'acme/skills/route-package');
  assert.equal(imported.update_check_mode, 'startup');
  assert.equal(imported.update_apply_mode, 'prompt');
  assert.equal(imported.last_update_checked_at, null);
  assert.equal(imported.available_version, null);
  assert.equal(imported.available_revision, null);

  const patchRes = await request(`/api/skills/${imported.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      update_check_mode: 'manual',
      update_apply_mode: 'download',
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as { update_check_mode: string; update_apply_mode: string };
  assert.equal(patched.update_check_mode, 'manual');
  assert.equal(patched.update_apply_mode, 'download');

  skillRepo.updateSkill(imported.id, {
    install_source_label: 'acme/skills/route-package-updated',
    source_uri: 'skills.sh/acme/skills/route-package-updated',
  });
  const updateRes = await request(`/api/skills/${imported.id}/updates`);
  assert.equal(updateRes.status, 200);
  const update = await updateRes.json() as {
    skillId: string;
    hasUpdate: boolean;
    currentVersion: string | null;
    currentRevision: string | null;
    availableVersion: string | null;
    availableRevision: string | null;
    checkedAt: number;
  };
  assert.equal(update.skillId, imported.id);
  assert.equal(update.hasUpdate, true);
  assert.equal(update.currentVersion, '1.0.0');
  assert.equal(update.currentRevision, 'rev-1');
  assert.equal(update.availableVersion, '1.1.0');
  assert.equal(update.availableRevision, 'rev-2');
  assert.equal(typeof update.checkedAt, 'number');

  const detailRes = await request(`/api/skills/${imported.id}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as typeof imported;
  assert.equal(detail.source_uri, 'skills.sh/acme/skills/route-package-updated');
  assert.equal(detail.available_version, '1.1.0');
  assert.equal(detail.available_revision, 'rev-2');
  assert.equal(typeof detail.last_update_checked_at, 'number');

  const listRes = await request('/api/skills');
  assert.equal(listRes.status, 200);
  const list = await listRes.json() as Array<typeof imported>;
  const listed = list.find((skill) => skill.id === imported.id);
  assert.ok(listed);
  assert.equal(listed.source_uri, 'skills.sh/acme/skills/route-package-updated');
  assert.equal(listed.package_version, '1.0.0');
  assert.equal(listed.package_revision, 'rev-1');
  assert.equal(listed.runtime_type, 'shell');
  assert.equal(listed.entrypoint, 'scripts/run.sh');
  assert.deepEqual(listed.permissions, { filesystem: 'project', network: false, commands: ['bash'] });
  assert.equal(listed.install_source_label, 'acme/skills/route-package-updated');
  assert.equal(listed.update_check_mode, 'manual');
  assert.equal(listed.update_apply_mode, 'download');
  assert.equal(listed.available_version, '1.1.0');
  assert.equal(listed.available_revision, 'rev-2');

  assert.equal(requestedUrls.some((url) => new URL(url).origin !== 'https://skills.sh'), false);
});

test('skills routes reject update checks for non-skills.sh skills', async () => {
  const sourceDir = await createLocalSkill('route-local-no-update');
  const importRes = await request('/api/skills/import/local', {
    method: 'POST',
    body: JSON.stringify({ path: sourceDir }),
  });
  assert.equal(importRes.status, 201);
  const imported = await importRes.json() as { id: string };

  const updateRes = await request(`/api/skills/${imported.id}/updates`);

  assert.equal(updateRes.status, 400);
  const body = await updateRes.json() as { error: string };
  assert.match(body.error, /only skills\.sh skills/i);
});

test('skills routes execute skills and list run history', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'opendeepsea-skill-route-project-'));
  const project = (await import('../repos/projects.js')).projectRepo.create({ name: 'Skill Route Project', path: projectDir });
  const installPath = mkdtempSync(join(process.env.OPENDEEPSEA_SKILLS_DIR!, 'route-exec-skill-'));
  await mkdir(join(installPath, 'scripts'), { recursive: true });
  await writeFile(join(installPath, 'SKILL.md'), '# Route Exec Skill\n');
  await writeFile(join(installPath, 'scripts', 'run.sh'), 'cat > route-skill-input.json\necho route-ok\n');
  const skill = skillRepo.createSkill({
    id: 'skill-route-exec',
    name: 'route-exec-skill',
    source_type: 'skills_sh',
    source_uri: 'skills.sh/acme/route-exec',
    install_path: installPath,
    manifest_path: 'SKILL.md',
    runtime_scopes: ['workflow'],
    trigger_mode: 'manual',
    runtime_type: 'shell',
    entrypoint: 'scripts/run.sh',
    permissions: { filesystem: 'project', network: false, commands: ['bash', 'cat'] },
  });

  const noToken = await request(`/api/skills/${skill.id}/run`, {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, input: { route: true } }),
  }, { localToken: false });
  assert.equal(noToken.status, 403);

  const runRes = await request(`/api/skills/${skill.id}/run`, {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, invokedBy: 'workflow', input: { route: true } }),
  });
  assert.equal(runRes.status, 200);
  const run = await runRes.json() as { id: string; status: string; stdout: string; exit_code: number; project_id: string };
  assert.equal(run.status, 'completed');
  assert.equal(run.exit_code, 0);
  assert.equal(run.project_id, project.id);
  assert.match(run.stdout, /route-ok/);

  const runsRes = await request(`/api/skills/runs?skillId=${skill.id}`);
  assert.equal(runsRes.status, 200);
  const runs = await runsRes.json() as Array<{ id: string; skill_id: string }>;
  assert.equal(runs.some((item) => item.id === run.id && item.skill_id === skill.id), true);
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
