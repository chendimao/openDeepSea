import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const testHome = mkdtempSync(join(tmpdir(), 'opendeepsea-platform-routes-home-'));
process.env.HOME = testHome;
process.env.CODEX_HOME = join(testHome, '.codex');
process.env.OPENDEEPSEA_PLATFORM_SKILL_SOURCES_DIR = join(testHome, 'sources');
process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-platform-routes-db-')), 'test.db');
process.env.OPENDEEPSEA_LOCAL_TOKEN = 'platform-routes-token';

const LOCAL_TOKEN = process.env.OPENDEEPSEA_LOCAL_TOKEN;

const { router } = await import('../routes.js');
const { projectRepo } = await import('../repos/projects.js');
const { settingsRepo } = await import('../repos/settings.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

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

test('platform skills routes require local access token', async () => {
  const res = await request('/api/platform-skills/platforms', {}, { localToken: false });
  assert.equal(res.status, 403);
});

test('platform skills routes list platforms and scan empty roots', async () => {
  const platformsRes = await request('/api/platform-skills/platforms');
  assert.equal(platformsRes.status, 200);
  const platforms = await platformsRes.json() as Array<{
    provider: string;
    root: string;
    installedCount: number;
  }>;
  assert.deepEqual(platforms.map((item) => item.provider), ['codex', 'claudecode', 'opencode']);
  assert.equal(platforms[0]?.installedCount, 0);

  const listRes = await request('/api/platform-skills/codex');
  assert.equal(listRes.status, 200);
  assert.deepEqual(await listRes.json(), []);
});

test('platform skills routes list only current session planner backend skills for a project', async () => {
  const project = projectRepo.create({
    name: 'Planner Platform Skill Route',
    path: mkdtempSync(join(tmpdir(), 'opendeepsea-platform-planner-route-project-')),
  });
  settingsRepo.updateProject(project.id, { session_planner_acp_backend: 'opencode' });
  createPlatformSkill('codex', 'planner-route-codex-only', 'Codex-only skill.');
  createPlatformSkill('opencode', 'planner-route-opencode', 'OpenCode planner skill.');

  const res = await request(`/api/platform-skills/session-planner/${project.id}`);
  assert.equal(res.status, 200);
  const body = await res.json() as {
    provider: string;
    skills: Array<{ provider: string; name: string; description: string | null; valid: boolean }>;
  };
  assert.equal(body.provider, 'opencode');
  assert.equal(body.skills.every((skill) => skill.provider === 'opencode'), true);
  assert.equal(body.skills.some((skill) => skill.name === 'planner-route-codex-only'), false);
  const plannerSkill = body.skills.find((skill) => skill.name === 'planner-route-opencode');
  assert.ok(plannerSkill);
  assert.equal(plannerSkill.description, 'OpenCode planner skill.');
  assert.equal(plannerSkill.valid, true);
});

function createPlatformSkill(provider: 'codex' | 'claudecode' | 'opencode', name: string, description: string): void {
  const root = provider === 'codex'
    ? join(process.env.CODEX_HOME!, 'skills')
    : provider === 'claudecode'
      ? join(testHome, '.claude', 'skills')
      : join(testHome, '.config', 'opencode', 'skills');
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `Use ${name}.`,
    '',
  ].join('\n'));
}

test('platform skills routes list aggregated skills across providers', async () => {
  createPlatformSkill('codex', 'route-matrix', 'Route matrix skill.');
  createPlatformSkill('claudecode', 'route-matrix', 'Route matrix skill.');
  createPlatformSkill('opencode', 'route-matrix', 'Route matrix skill.');

  const aggregateRes = await request('/api/platform-skills');
  assert.equal(aggregateRes.status, 200);
  const aggregates = await aggregateRes.json() as Array<{
    name: string;
    providers: string[];
    missingProviders: string[];
    installModes: Partial<Record<string, string>>;
    valid: boolean;
  }>;
  const routeMatrix = aggregates.find((item) => item.name === 'route-matrix');
  assert.ok(routeMatrix);
  assert.deepEqual(routeMatrix.providers, ['codex', 'claudecode', 'opencode']);
  assert.deepEqual(routeMatrix.missingProviders, []);
  assert.equal(routeMatrix.installModes.codex, 'copy');
  assert.equal(routeMatrix.installModes.claudecode, 'copy');
  assert.equal(routeMatrix.installModes.opencode, 'copy');
  assert.equal(routeMatrix.valid, true);
});
