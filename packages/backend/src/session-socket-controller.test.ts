import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import type { WebSocket } from 'ws';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-session-socket-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');
const { handleSessionSocketEvent } = await import('./session-socket-controller.js');

afterEach(() => setSessionRuntimeAdapterForTest(undefined));

function createSocket() {
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as WebSocket;
  return { socket, sent };
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(assertion(), true);
}

test('websocket message send starts planner run and sends no HTTP response object', async () => {
  const project = projectRepo.create({
    name: 'socket message project',
    path: mkdtempSync(join(tmpdir(), 'socket-message-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Socket Message',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const seenPrompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt, onSession }) => {
      seenPrompts.push(prompt);
      onSession?.('socket-acp');
      return { exitCode: 0, sessionId: 'socket-acp', stderr: '' };
    },
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.message.send',
    sessionId: session.id,
    content: '继续实现',
    agentId: 'planner',
  });

  await waitFor(() => sessionRunRepo.listBySession(session.id).length === 1);
  const run = sessionRunRepo.listBySession(session.id)[0]!;
  assert.equal(run.agent_id, 'planner');
  assert.match(seenPrompts[0] ?? '', /继续实现/);
  assert.equal(sent.some((payload) => JSON.parse(payload).type === 'session_error'), false);
});

test('websocket workspace request returns a session workspace snapshot event', () => {
  const project = projectRepo.create({
    name: 'socket snapshot project',
    path: mkdtempSync(join(tmpdir(), 'socket-snapshot-project-')),
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.workspace.request',
    projectId: project.id,
  });

  const event = JSON.parse(sent[0]!);
  assert.equal(event.type, 'session_workspace:snapshot');
  assert.equal(event.payload.project.id, project.id);
  assert.equal(event.payload.activeSession.session.project_id, project.id);
});

test('websocket pause marks the active run as paused instead of cancelled', () => {
  const project = projectRepo.create({
    name: 'socket pause project',
    path: mkdtempSync(join(tmpdir(), 'socket-pause-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Socket Pause',
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
  });
  const { socket } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'agent.run.pause',
    sessionId: session.id,
    agentId: 'planner',
    runId: run.id,
  });

  assert.equal(sessionRunRepo.get(run.id)?.status, 'paused');
});
