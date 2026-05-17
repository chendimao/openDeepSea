import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workspace-routes-')), 'test.db');
process.env.OPENDEEPSEA_LOCAL_TOKEN = 'workspace-test-token';

const { projectRepo } = await import('./repos/projects.js');
const { router } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

const TRUSTED_ORIGIN = 'http://localhost:5173';
const WRONG_ORIGIN = 'https://evil.example';
const LOCAL_TOKEN = process.env.OPENDEEPSEA_LOCAL_TOKEN as string;

type HeaderMap = Record<string, string>;

async function request(path: string, init: RequestInit = {}, headers: HeaderMap = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers ?? {}),
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function createWorkspaceProject(name: string): { id: string; path: string } {
  const projectPath = mkdtempSync(join(tmpdir(), `openclaw-room-workspace-${name}-`));
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  writeFileSync(join(projectPath, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(join(projectPath, 'binary.bin'), Buffer.from([0, 255, 1, 2, 3]));
  writeFileSync(join(projectPath, '.env'), 'SECRET=1\n');
  writeFileSync(join(projectPath, 'too-large.txt'), 'a'.repeat(2 * 1024 * 1024 + 1));
  mkdirSync(join(projectPath, 'search'), { recursive: true });
  for (let index = 0; index < 60; index += 1) {
    writeFileSync(join(projectPath, 'search', `needle-${String(index).padStart(2, '0')}.ts`), 'export {};\n');
  }
  const project = projectRepo.create({ name, path: projectPath });
  return { id: project.id, path: project.path };
}

function localHeaders(token = LOCAL_TOKEN, origin = TRUSTED_ORIGIN): HeaderMap {
  return {
    origin,
    'x-opendeepsea-local-token': token,
  };
}

test('workspace tree rejects missing token', async () => {
  const project = createWorkspaceProject('tree-missing-token');
  const res = await request(`/api/projects/${project.id}/workspace/tree`, {}, {
    origin: TRUSTED_ORIGIN,
  });
  assert.equal(res.status, 403);
});

test('workspace tree rejects wrong token', async () => {
  const project = createWorkspaceProject('tree-wrong-token');
  const res = await request(`/api/projects/${project.id}/workspace/tree`, {}, localHeaders('wrong-token'));
  assert.equal(res.status, 403);
});

test('workspace tree rejects untrusted origin', async () => {
  const project = createWorkspaceProject('tree-wrong-origin');
  const res = await request(`/api/projects/${project.id}/workspace/tree`, {}, localHeaders(LOCAL_TOKEN, WRONG_ORIGIN));
  assert.equal(res.status, 403);
});

test('workspace tree returns entries with trusted origin and token', async () => {
  const project = createWorkspaceProject('tree-success');
  const res = await request(`/api/projects/${project.id}/workspace/tree?path=src`, {}, localHeaders());
  assert.equal(res.status, 200);
  const payload = await res.json() as { path: string; entries: Array<{ name: string; type: string; path: string }> };
  assert.equal(payload.path, 'src');
  assert.equal(payload.entries.some((entry) => entry.name === 'main.ts' && entry.type === 'file' && entry.path === 'src/main.ts'), true);
});

test('workspace file rejects binary, too-large and ignored paths', async () => {
  const project = createWorkspaceProject('file-errors');
  const headers = localHeaders();

  const binaryRes = await request(
    `/api/projects/${project.id}/workspace/file?path=binary.bin`,
    {},
    headers,
  );
  assert.equal(binaryRes.status, 400);

  const tooLargeRes = await request(
    `/api/projects/${project.id}/workspace/file?path=too-large.txt`,
    {},
    headers,
  );
  assert.equal(tooLargeRes.status, 400);

  const ignoredRes = await request(
    `/api/projects/${project.id}/workspace/file?path=.env`,
    {},
    headers,
  );
  assert.equal(ignoredRes.status, 400);
});

test('workspace search returns matching files and truncation metadata', async () => {
  const project = createWorkspaceProject('search-success');
  const res = await request(
    `/api/projects/${project.id}/workspace/search?q=needle`,
    {},
    localHeaders(),
  );
  assert.equal(res.status, 200);
  const payload = await res.json() as {
    entries: Array<{ path: string; name: string; type: string }>;
    truncated: boolean;
  };
  assert.equal(payload.entries.length, 50);
  assert.equal(payload.entries.every((entry) => entry.name.includes('needle-')), true);
  assert.equal(payload.truncated, true);
});
