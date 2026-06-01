import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-filerefs-routes-')), 'test.db');

const express = (await import('express')).default;
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { router, setMessageRouteDeps } = await import('./routes.js');

setMessageRouteDeps({
  dispatchUserMessage: async () => undefined,
});

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

test('POST /rooms/:roomId/messages stores sanitized file_refs in metadata', async () => {
  const project = projectRepo.create({
    name: 'FileRefs Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-filerefs-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'hi', fileRefs: ['a.txt', '../escape.txt'] }),
  });

  assert.equal(res.status, 201);
  const message = await res.json() as { metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as { file_refs?: string[] };
  assert.deepEqual(metadata.file_refs, ['a.txt']);
});
