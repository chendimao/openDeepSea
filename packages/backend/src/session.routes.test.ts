import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { fileRepo } = await import('./repos/files.js');
const { sessionRepo, sessionMessageRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { historyRecordRepo } = await import('./repos/history-records.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');
const { router } = await import('./routes.js');
const { buildWorkspacePayload } = await import('./session.routes.js');
const express = (await import('express')).default;

const capturedPrompts: string[] = [];
const app = express();
app.use(express.json());
app.use('/api', router);

setSessionRuntimeAdapterForTest({
  backend: 'codex',
  listSessions: async () => [],
  invoke: async ({ prompt, onChunk, onSession }) => {
    capturedPrompts.push(prompt);
    onSession?.('route-test-acp-session');
    onChunk({ stream: 'stdout', channel: 'answer', text: 'ok' });
    return { exitCode: 0, sessionId: 'route-test-acp-session', stderr: '' };
  },
});

test('legacy HTTP session workspace route is removed', async () => {
  const project = projectRepo.create({
    name: 'removed workspace route project',
    path: mkdtempSync(join(tmpdir(), 'removed-session-workspace-route-')),
  });

  const res = await request(`/api/projects/${project.id}/session-workspace`);

  assert.equal(res.status, 404);
});

test('legacy HTTP session message route is removed', async () => {
  const project = projectRepo.create({
    name: 'removed message route project',
    path: mkdtempSync(join(tmpdir(), 'removed-session-message-route-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Removed Message Route',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  const res = await request(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'should not work over http' }),
  });

  assert.equal(res.status, 404);
});

test('legacy HTTP session run control routes are removed', async () => {
  const project = projectRepo.create({
    name: 'removed run route project',
    path: mkdtempSync(join(tmpdir(), 'removed-session-run-route-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Removed Run Route',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const run = sessionRunRepo.create({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
    mode: 'code',
    status: 'running',
    prompt: 'long task',
    acp_session_id: 'removed-acp',
  });

  for (const suffix of ['cancel', 'retry', 'pause', 'resume']) {
    const res = await request(`/api/session-runs/${run.id}/${suffix}`, { method: 'POST' });
    assert.equal(res.status, 404);
  }
});

test('legacy HTTP session command routes are removed', async () => {
  const project = projectRepo.create({
    name: 'removed command route project',
    path: mkdtempSync(join(tmpdir(), 'removed-command-route-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Removed Commands',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  for (const path of [
    `/api/projects/${project.id}/session-workspace`,
    `/api/sessions/${session.id}/new`,
    `/api/sessions/${session.id}/compact/preview`,
    `/api/sessions/${session.id}/compact/apply`,
    `/api/sessions/${session.id}/compact/discard`,
    `/api/sessions/${session.id}/contract`,
    `/api/sessions/${session.id}/status`,
    `/api/sessions/${session.id}/context`,
    `/api/sessions/${session.id}/evidence`,
    `/api/sessions/${session.id}/checkpoints`,
    `/api/sessions/${session.id}/fork`,
    `/api/projects/${project.id}/history-records`,
  ]) {
    const method = path.includes('/session-workspace') ||
      path.endsWith('/status') ||
      path.endsWith('/context') ||
      path.endsWith('/evidence') ||
      path.endsWith('/history-records')
      ? 'GET'
      : path.endsWith('/contract')
        ? 'PATCH'
        : 'POST';
    const res = await request(path, { method });
    assert.equal(res.status, 404);
  }
});

test('session PATCH updates pinned_at for active session ordering', async () => {
  const project = projectRepo.create({
    name: 'session pin patch project',
    path: mkdtempSync(join(tmpdir(), 'session-pin-patch-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Pin Me',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  const pinnedAt = Date.now();
  const pinRes = await request(`/api/sessions/${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned_at: pinnedAt }),
  });

  assert.equal(pinRes.status, 200);
  const pinned = await pinRes.json() as { pinned_at: number | null };
  assert.equal(pinned.pinned_at, pinnedAt);
  assert.equal(sessionRepo.get(session.id)?.pinned_at, pinnedAt);

  const unpinRes = await request(`/api/sessions/${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned_at: null }),
  });

  assert.equal(unpinRes.status, 200);
  const unpinned = await unpinRes.json() as { pinned_at: number | null };
  assert.equal(unpinned.pinned_at, null);
  assert.equal(sessionRepo.get(session.id)?.pinned_at, null);
});

test('session workspace payload backfills attachments from legacy library file refs', () => {
  const project = projectRepo.create({
    name: 'legacy attachment refs project',
    path: mkdtempSync(join(tmpdir(), 'legacy-session-attachment-refs-')),
  });
  const uploadedFile = fileRepo.create({
    project_id: project.id,
    original_name: 'screen.png',
    stored_name: 'stored-screen.png',
    mime_type: 'image/png',
    size: 2048,
    url: `/uploads/files/${project.id}/stored-screen.png`,
    storage_path: join(project.path, 'stored-screen.png'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Legacy Attachment Refs',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    sender_name: null,
    content: '分析内容',
    metadata: {
      target_agent_id: 'planner',
      library_file_refs: [uploadedFile.id],
    },
  });

  const payload = buildWorkspacePayload(project, session);
  const [message] = payload.activeSession.messages;
  assert.ok(message?.metadata);
  const metadata = JSON.parse(message.metadata) as {
    attachments?: Array<{ fileId: string; name: string; url: string; isImage: boolean }>;
  };
  assert.deepEqual(metadata.attachments, [{
    id: uploadedFile.id,
    fileId: uploadedFile.id,
    name: 'screen.png',
    mimeType: 'image/png',
    size: 2048,
    url: `/uploads/files/${project.id}/stored-screen.png`,
    isImage: true,
    deleted: false,
  }]);
  const storedMessage = sessionMessageRepo.get(message.id);
  assert.ok(storedMessage?.metadata);
  assert.deepEqual(JSON.parse(storedMessage.metadata).attachments, metadata.attachments);
});

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
