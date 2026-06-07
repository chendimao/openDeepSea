import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-runtime-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { sessionRepo, sessionRunRepo, sessionAgentEventRepo } = await import('./repos/sessions.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
const { runSessionAgent, setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');
const { wsHub } = await import('./ws-hub.js');

afterEach(() => {
  setSessionRuntimeAdapterForTest(undefined);
});

test('runSessionAgent writes run, stream output and evidence', async () => {
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as import('ws').WebSocket;
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
  wsHub.subscribeSession(session.id, socket);

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
  const streamEvents = sent.map((payload) => JSON.parse(payload) as { type: string; agentEvent?: { event_type: string } });
  assert.ok(streamEvents.some((event) => event.type === 'session_run:stream' && event.agentEvent?.event_type === 'tool_call'));
  wsHub.removeSocket(socket);
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

test('runSessionAgent records ordered agent stream events', async () => {
  const project = projectRepo.create({
    name: 'runtime event project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-events-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Events',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onSession, onChunk }) => {
      onSession?.('acp-events');
      onChunk({ stream: 'stdout', channel: 'thinking', text: '分析上下文\n' });
      onChunk({ stream: 'stdout', channel: 'tool', text: '读取文件\n', rawType: 'tool_call' });
      onChunk({ stream: 'stdout', channel: 'answer', text: '完成\n' });
      return { exitCode: 0, sessionId: 'acp-events', stderr: '' };
    },
  });

  const run = await runSessionAgent({ sessionId: session.id, agentId: 'planner', prompt: '继续', provider: 'codex' });
  const events = sessionAgentEventRepo.listByRun(run.id);

  assert.deepEqual(events.slice(0, 3).map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(events.slice(0, 3).map((event) => event.channel), ['thinking', 'tool', 'answer']);
  assert.equal(events[0]?.agent_id, 'planner');
});

test('runSessionAgent records activity chunks outside answer output', async () => {
  const project = projectRepo.create({
    name: 'runtime activity project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-activity-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Activity',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk }) => {
      onChunk({ stream: 'stderr', channel: 'activity', text: '[ACP fallback] using legacy CLI\n', rawType: 'protocol_fallback' });
      onChunk({ stream: 'stdout', channel: 'activity', text: '开始命令：rtk find skills\n' });
      onChunk({ stream: 'stdout', channel: 'answer', text: '✅ 结论：skills 已分析。\n' });
      return { exitCode: 0, sessionId: 'acp-activity', stderr: '' };
    },
  });

  const run = await runSessionAgent({ sessionId: session.id, agentId: 'planner', prompt: '分析 skills', provider: 'codex' });
  const storedRun = sessionRunRepo.get(run.id);
  const events = sessionAgentEventRepo.listByRun(run.id);

  assert.doesNotMatch(storedRun?.stderr ?? '', /ACP fallback/);
  assert.match(storedRun?.activity_log ?? '', /ACP fallback/);
  assert.match(storedRun?.activity_log ?? '', /开始命令/);
  assert.equal(storedRun?.stdout, '✅ 结论：skills 已分析。\n');
  assert.deepEqual(events.slice(0, 3).map((event) => event.channel), ['activity', 'activity', 'answer']);
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

test('runSessionAgent stores runtime profile snapshot on session run', async () => {
  const project = projectRepo.create({
    name: 'runtime profile snapshot project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-profile-snapshot-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Snapshot',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'snapshot-acp', stderr: '' }),
  });

  const snapshot = JSON.stringify({ backend_source: 'builtin', permission_mode: 'read-only' });
  const run = await runSessionAgent({
    sessionId: session.id,
    agentId: 'planner',
    prompt: '继续',
    provider: 'codex',
    runtimeProfileSnapshot: snapshot,
  });

  const stored = sessionRunRepo.get(run.id);
  assert.equal(stored?.runtime_profile_snapshot, snapshot);
});

test('runSessionAgent broadcasts inspector snapshot after ACP tool evidence', async () => {
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as import('ws').WebSocket;
  const project = projectRepo.create({
    name: 'runtime inspector project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-inspector-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Inspector',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  wsHub.subscribeSession(session.id, socket);

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk }) => {
      onChunk({
        stream: 'stdout',
        channel: 'tool',
        text: 'patch SessionShellView\n',
        rawType: 'tool_call',
        event: {
          id: 'tool-apply-patch',
          message_id: 'message-1',
          run_id: 'run-1',
          agent_id: 'planner',
          seq: 1,
          type: 'tool_call',
          status: 'started',
          title: '调用工具 apply_patch',
          payload: {
            name: 'apply_patch',
            input: '*** Update File: packages/frontend/src/session-ui/SessionShellView.tsx',
          },
          created_at: Date.now(),
        },
      });
      return { exitCode: 0, sessionId: 'acp-inspector', stderr: '' };
    },
  });

  await runSessionAgent({ sessionId: session.id, prompt: '继续', provider: 'codex' });

  const events = sent.map((payload) =>
    JSON.parse(payload) as { type: string; toolRows?: Array<{ label: string; target: string }> }
  );
  const inspector = events.find((event) => event.type === 'session_inspector:snapshot');
  assert.equal(inspector?.toolRows?.[0]?.label, 'apply_patch');
  assert.equal(inspector?.toolRows?.[0]?.target, 'packages/frontend/src/session-ui/SessionShellView.tsx');
  wsHub.removeSocket(socket);
});

test('runSessionAgent records raw ACP event tool calls as tool evidence', async () => {
  const project = projectRepo.create({
    name: 'runtime raw tool project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-raw-tool-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Raw Tool',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk, onSession }) => {
      onSession?.('acp-raw-tool');
      onChunk({
        stream: 'stdout',
        channel: 'event',
        text: '',
        rawType: 'tool_call',
        rawEvent: {
          method: 'session/update',
          params: {
            sessionId: 'acp-raw-tool',
            update: {
              sessionUpdate: 'tool_call',
              kind: 'execute',
              rawInput: {
                command: ['/bin/zsh', '-lc', 'echo hi'],
                cwd: '/workspace',
              },
              status: 'in_progress',
              title: 'echo hi',
            },
          },
        },
      });
      return { exitCode: 0, sessionId: 'acp-raw-tool', stderr: '' };
    },
  });

  await runSessionAgent({ sessionId: session.id, prompt: '继续', provider: 'codex' });

  const rawToolEvidence = sessionEvidenceRepo.listBySession(session.id)
    .find((event) => event.payload.rawType === 'tool_call');
  assert.equal(rawToolEvidence?.event_type, 'tool_call');
});

test('runSessionAgent prefers normalized tool event when raw type is generic', async () => {
  const project = projectRepo.create({
    name: 'runtime normalized tool project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-normalized-tool-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Normalized Tool',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk, onSession }) => {
      onSession?.('acp-normalized-tool');
      onChunk({
        stream: 'stdout',
        channel: 'event',
        text: '',
        rawType: 'session_update',
        event: {
          id: 'tool-read',
          message_id: 'message-1',
          run_id: 'run-1',
          agent_id: 'planner',
          seq: 1,
          type: 'tool_call',
          status: 'started',
          title: '调用工具 read',
          payload: {
            name: 'read',
            path: 'packages/backend/src/session-runtime.ts',
          },
          created_at: Date.now(),
        },
      });
      return { exitCode: 0, sessionId: 'acp-normalized-tool', stderr: '' };
    },
  });

  await runSessionAgent({ sessionId: session.id, prompt: '继续', provider: 'codex' });

  const genericRawEvidence = sessionEvidenceRepo.listBySession(session.id)
    .find((event) => event.payload.rawType === 'session_update');
  assert.equal(genericRawEvidence?.event_type, 'tool_call');
});

test('runSessionAgent forwards imagePaths to session adapter', async () => {
  const project = projectRepo.create({
    name: 'runtime image project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-image-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Image',
    provider: 'codex',
    workspace_path: project.path,
  });
  const seen: string[][] = [];

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ imagePaths }) => {
      seen.push(imagePaths ?? []);
      return { exitCode: 0, sessionId: 'image-acp', stderr: '' };
    },
  });

  await runSessionAgent({
    sessionId: session.id,
    prompt: '看图',
    provider: 'codex',
    imagePaths: ['/tmp/screen.png'],
  });

  assert.deepEqual(seen, [['/tmp/screen.png']]);
});
