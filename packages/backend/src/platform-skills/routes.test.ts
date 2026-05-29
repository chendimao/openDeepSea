import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readlinkSync } from 'node:fs';
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

test('platform skills routes search marketplace and install package to multiple platforms', async () => {
  let downloadCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.origin !== 'https://skills.sh') return originalFetch(input, init);
    if (url.pathname === '/api/search') {
      return jsonResponse({
        skills: [{
          id: 'acme/skills/platform-demo',
          name: 'platform-demo',
          description: 'Demo platform skill.',
          source: 'acme/skills',
          version: '1.0.0',
          install_label: 'acme/skills/platform-demo',
        }],
      });
    }
    if (url.pathname === '/api/download/acme/skills/platform-demo') {
      downloadCount += 1;
      const description = downloadCount >= 2
        ? 'Demo platform skill v2.'
        : 'Demo platform skill.';
      return jsonResponse({
        id: 'acme/skills/platform-demo',
        name: 'platform-demo',
        description,
        source: 'acme/skills',
        version: '1.0.0',
        files: [{
          path: 'SKILL.md',
          content: [
            '---',
            'name: platform-demo',
            `description: ${description}`,
            'version: 1.0.0',
            '---',
            '',
            'Follow demo instructions.',
          ].join('\n'),
        }],
      });
    }
    throw new Error(`unexpected skills.sh request ${url.pathname}`);
  }) as typeof fetch;

  const searchRes = await request('/api/platform-skills/marketplace?q=platform');
  assert.equal(searchRes.status, 200);
  const search = await searchRes.json() as Array<{ installLabel: string }>;
  assert.equal(search[0]?.installLabel, 'acme/skills/platform-demo');

  const installRes = await request('/api/platform-skills/install', {
    method: 'POST',
    body: JSON.stringify({
      installLabel: 'acme/skills/platform-demo',
      targets: ['codex', 'opencode'],
      installMode: 'copy',
    }),
  });
  assert.equal(installRes.status, 201);
  const installed = await installRes.json() as Array<{ provider: string; name: string; installMode: string }>;
  assert.deepEqual(installed.map((item) => item.provider), ['codex', 'opencode']);
  assert.equal(installed[0]?.name, 'platform-demo');
  assert.equal(installed[0]?.installMode, 'copy');
  assert.equal(existsSync(join(testHome, '.codex', 'skills', 'platform-demo', 'SKILL.md')), true);
  assert.equal(existsSync(join(testHome, '.config', 'opencode', 'skills', 'platform-demo', 'SKILL.md')), true);

  const deleteRes = await request('/api/platform-skills/codex/platform-demo', { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);
  assert.equal(existsSync(join(testHome, '.codex', 'skills', 'platform-demo')), false);

  downloadCount = 0;
  const symlinkInstallRes = await request('/api/platform-skills/install', {
    method: 'POST',
    body: JSON.stringify({
      installLabel: 'acme/skills/platform-demo',
      targets: ['claudecode'],
      installMode: 'symlink',
    }),
  });
  assert.equal(symlinkInstallRes.status, 201);
  const linkPath = join(testHome, '.claude', 'skills', 'platform-demo');
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(existsSync(join(linkPath, 'SKILL.md')), true);
  const firstLinkTarget = readlinkSync(linkPath);
  assert.equal(existsSync(join(testHome, 'sources')), true);

  const duplicateSymlinkRes = await request('/api/platform-skills/install', {
    method: 'POST',
    body: JSON.stringify({
      installLabel: 'acme/skills/platform-demo',
      targets: ['claudecode'],
      installMode: 'symlink',
    }),
  });
  assert.equal(duplicateSymlinkRes.status, 400);
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(existsSync(join(linkPath, 'SKILL.md')), true);

  const updatedSymlinkInstallRes = await request('/api/platform-skills/install', {
    method: 'POST',
    body: JSON.stringify({
      installLabel: 'acme/skills/platform-demo',
      targets: ['codex'],
      installMode: 'symlink',
    }),
  });
  assert.equal(updatedSymlinkInstallRes.status, 201);
  const updatedLinkPath = join(testHome, '.codex', 'skills', 'platform-demo');
  assert.equal(lstatSync(updatedLinkPath).isSymbolicLink(), true);
  assert.notEqual(readlinkSync(updatedLinkPath), firstLinkTarget);
});

test('platform skills routes list aggregated skills across providers', async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.origin !== 'https://skills.sh') return originalFetch(input, init);
    if (url.pathname === '/api/download/acme/skills/route-matrix') {
      return jsonResponse({
        id: 'acme/skills/route-matrix',
        name: 'route-matrix',
        source: 'acme/skills',
        version: '1.0.0',
        files: [{
          path: 'SKILL.md',
          content: [
            '---',
            'name: route-matrix',
            'description: Route matrix skill.',
            'version: 1.0.0',
            '---',
            '',
            'Follow route matrix instructions.',
          ].join('\n'),
        }],
      });
    }
    throw new Error(`unexpected skills.sh request ${url.pathname}`);
  }) as typeof fetch;

  const installCopyRes = await request('/api/platform-skills/install', {
    method: 'POST',
    body: JSON.stringify({
      installLabel: 'acme/skills/route-matrix',
      targets: ['codex', 'opencode'],
      installMode: 'copy',
    }),
  });
  assert.equal(installCopyRes.status, 201);

  const installSymlinkRes = await request('/api/platform-skills/install', {
    method: 'POST',
    body: JSON.stringify({
      installLabel: 'acme/skills/route-matrix',
      targets: ['claudecode'],
      installMode: 'symlink',
    }),
  });
  assert.equal(installSymlinkRes.status, 201);

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
  assert.equal(routeMatrix.installModes.claudecode, 'symlink');
  assert.equal(routeMatrix.installModes.opencode, 'copy');
  assert.equal(routeMatrix.valid, true);
});
