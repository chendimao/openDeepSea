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

test('runSessionAgent reuses provider session for same business session agent and provider', async () => {
  const project = projectRepo.create({
    name: 'runtime reuse project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-reuse-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Reuse',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const observedSessionIds: Array<string | null> = [];

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ sessionId, onSession, onChunk }) => {
      observedSessionIds.push(sessionId);
      const providerSessionId = sessionId ?? 'acp-provider-1';
      onSession?.(providerSessionId);
      onChunk({ stream: 'stdout', channel: 'answer', text: `reply:${providerSessionId}\n` });
      return { exitCode: 0, sessionId: providerSessionId, stderr: '' };
    },
  });

  await runSessionAgent({ sessionId: session.id, agentId: 'planner', prompt: '第一轮', provider: 'codex' });
  await runSessionAgent({ sessionId: session.id, agentId: 'planner', prompt: '第二轮', provider: 'codex' });

  assert.deepEqual(observedSessionIds, [null, 'acp-provider-1']);
});

test('runSessionAgent isolates provider sessions by agent id', async () => {
  const project = projectRepo.create({
    name: 'runtime multi agent project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-multi-agent-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Multi Agent',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const observed: Array<{ prompt: string; sessionId: string | null }> = [];

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt, sessionId, onSession }) => {
      observed.push({ prompt, sessionId });
      const providerSessionId = sessionId ?? `provider-${prompt}`;
      onSession?.(providerSessionId);
      return { exitCode: 0, sessionId: providerSessionId, stderr: '' };
    },
  });

  await runSessionAgent({ sessionId: session.id, agentId: 'planner', prompt: 'planner', provider: 'codex' });
  await runSessionAgent({ sessionId: session.id, agentId: 'reviewer', prompt: 'reviewer', provider: 'codex' });
  await runSessionAgent({ sessionId: session.id, agentId: 'planner', prompt: 'planner-again', provider: 'codex' });

  assert.deepEqual(observed, [
    { prompt: 'planner', sessionId: null },
    { prompt: 'reviewer', sessionId: null },
    { prompt: 'planner-again', sessionId: 'provider-planner' },
  ]);
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
