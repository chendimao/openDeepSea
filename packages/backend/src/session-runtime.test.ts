import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-runtime-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
const { runSessionAgent, setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');

afterEach(() => {
  setSessionRuntimeAdapterForTest(undefined);
});

test('runSessionAgent writes run, stream output and evidence', async () => {
  const project = projectRepo.create({
    name: 'runtime project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk, onSession }) => {
      onSession?.('acp-1');
      onChunk({ stream: 'stdout', channel: 'answer', text: '完成\n' });
      onChunk({ stream: 'stdout', channel: 'tool', text: 'read package.json\n', rawType: 'tool_call' });
      return { exitCode: 0, sessionId: 'acp-1', stderr: '' };
    },
  });

  const run = await runSessionAgent({ sessionId: session.id, prompt: '继续', provider: 'codex' });
  assert.equal(run.status, 'completed');
  assert.match(sessionRunRepo.get(run.id)!.stdout, /完成/);
  assert.equal(sessionRunRepo.get(run.id)!.acp_session_id, 'acp-1');
  assert.ok(sessionEvidenceRepo.listBySession(session.id).some((event) => event.event_type === 'tool_call'));
});

test('runSessionAgent records failed adapter as blocker evidence', async () => {
  const project = projectRepo.create({
    name: 'runtime failure project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-failure-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Failure',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => {
      throw new Error('adapter failed');
    },
  });

  const run = await runSessionAgent({ sessionId: session.id, prompt: '继续', provider: 'codex' });
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /adapter failed/);
  assert.ok(sessionEvidenceRepo.listBySession(session.id).some((event) => event.event_type === 'blocker'));
});
