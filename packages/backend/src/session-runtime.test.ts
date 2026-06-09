import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-runtime-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { sessionRepo, sessionRunRepo, sessionAgentEventRepo } = await import('./repos/sessions.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
const { sessionTokenUsageRepo } = await import('./repos/session-token-usage.js');
const {
  retrySessionAgentRun,
  runSessionAgent,
  setSessionRuntimeAdapterForTest,
  setSessionRuntimeGenerateImageToolDepsForTest,
} = await import('./session-runtime.js');
const { wsHub } = await import('./ws-hub.js');
const { imageGenerationJobRepo } = await import('./image-generation/jobs.js');
const { imageProviderProfileRepo } = await import('./image-generation/provider-profiles.js');
const { createImageGenerationService } = await import('./image-generation/service.js');

afterEach(() => {
  setSessionRuntimeAdapterForTest(undefined);
  setSessionRuntimeGenerateImageToolDepsForTest(undefined);
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

test('retrySessionAgentRun asks the provider to continue a failed partial answer', async () => {
  const project = projectRepo.create({
    name: 'runtime continuation retry project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-continuation-retry-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Continuation Retry',
    mode: 'ask',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onSession, onChunk }) => {
      onSession?.('acp-continuation-retry');
      onChunk({
        stream: 'stdout',
        channel: 'answer',
        text: '已确认第二个选择：轻量版只做本地 git 状态。\n',
      });
      onChunk({
        stream: 'stdout',
        channel: 'event',
        text: '',
        rawType: 'tool_call_update',
        rawEvent: {
          method: 'session/update',
          params: {
            sessionId: 'acp-continuation-retry',
            update: {
              sessionUpdate: 'tool_call_update',
              rawOutput: {
                exit_code: 1,
                status: 'failed',
                formatted_output: 'Error: listen EPERM: operation not permitted 127.0.0.1:55063',
              },
            },
          },
        },
      });
      return { exitCode: 1, sessionId: 'acp-continuation-retry', stderr: '' };
    },
  });

  const failed = await runSessionAgent({ sessionId: session.id, prompt: 'a', provider: 'codex' });
  assert.equal(failed.status, 'failed');

  let capturedPrompt = '';
  let capturedSessionId: string | null | undefined;
  const retryInvoked = new Promise<void>((resolve) => {
    setSessionRuntimeAdapterForTest({
      backend: 'codex',
      listSessions: async () => [],
      invoke: async ({ prompt, sessionId }) => {
        capturedPrompt = prompt;
        capturedSessionId = sessionId;
        resolve();
        return { exitCode: 0, sessionId: sessionId ?? 'acp-continuation-retry', stderr: '' };
      },
    });
  });

  retrySessionAgentRun(failed.id);
  await retryInvoked;

  assert.equal(capturedSessionId, 'acp-continuation-retry');
  assert.notEqual(capturedPrompt, 'a');
  assert.match(capturedPrompt, /从中断点继续/u);
  assert.match(capturedPrompt, /已确认第二个选择/u);
  assert.match(capturedPrompt, /listen EPERM/u);
  assert.match(capturedPrompt, /不要重新回答原始用户请求/u);
});

test('runSessionAgent passes knowledge usage env overrides to session adapter', async () => {
  const project = projectRepo.create({
    name: 'runtime knowledge env project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-knowledge-env-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Knowledge Env',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  let capturedEnvOverrides: Record<string, string> | undefined;

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ envOverrides }) => {
      capturedEnvOverrides = envOverrides;
      return { exitCode: 0, sessionId: 'knowledge-env-acp', stderr: '' };
    },
  });

  const run = await runSessionAgent({
    sessionId: session.id,
    agentId: 'planner',
    prompt: '查询知识库',
    provider: 'codex',
  });

  assert.equal(capturedEnvOverrides?.OPENDEEPSEA_SESSION_RUN_ID, run.id);
  assert.equal(capturedEnvOverrides?.OPENDEEPSEA_SESSION_ID, session.id);
  assert.equal(capturedEnvOverrides?.OPENDEEPSEA_PROJECT_ID, project.id);
  assert.equal(capturedEnvOverrides?.OPENDEEPSEA_AGENT_ID, 'planner');
  assert.equal(capturedEnvOverrides?.OPENDEEPSEA_KNOWLEDGE_REF_TYPE, 'session_run');
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

test('runSessionAgent promotes failed ACP tool output into run error', async () => {
  const project = projectRepo.create({
    name: 'runtime tool failure project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-tool-failure-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Tool Failure',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk }) => {
      onChunk({ stream: 'stdout', channel: 'answer', text: '准备启动可视化辅助。' });
      onChunk({
        stream: 'stdout',
        channel: 'event',
        text: '',
        rawType: 'tool_call_update',
        rawEvent: {
          method: 'session/update',
          params: {
            sessionId: 'acp-tool-failure',
            update: {
              sessionUpdate: 'tool_call_update',
              content: [{
                type: 'content',
                content: {
                  type: 'text',
                  text: [
                    '```sh',
                    'Error: listen EPERM: operation not permitted 127.0.0.1:55063',
                    '    at Server.setupListenHandle [as _listen2] (node:net:1918:21)',
                    '```',
                  ].join('\n'),
                },
              }],
              rawOutput: {
                exit_code: 1,
                stderr: '',
              },
            },
          },
        },
      });
      return { exitCode: 1, sessionId: 'acp-tool-failure', stderr: '' };
    },
  });

  const run = await runSessionAgent({ sessionId: session.id, prompt: '继续', provider: 'codex' });
  const stored = sessionRunRepo.get(run.id)!;
  const blocker = sessionEvidenceRepo.listBySession(session.id).find((event) => event.event_type === 'blocker');

  assert.equal(stored.status, 'failed');
  assert.match(stored.error ?? '', /listen EPERM/);
  assert.match(stored.stderr, /listen EPERM/);
  assert.match(blocker?.summary ?? '', /listen EPERM/);
});

test('runSessionAgent retries once when ACP tool output is the only failure reason', async () => {
  const project = projectRepo.create({
    name: 'runtime auto retry project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-auto-retry-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Auto Retry',
    provider: 'codex',
    workspace_path: project.path,
  });
  let attempts = 0;

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk }) => {
      attempts += 1;
      if (attempts === 1) {
        onChunk({
          stream: 'stdout',
          channel: 'event',
          text: '',
          rawType: 'tool_call_update',
          rawEvent: {
            method: 'session/update',
            params: {
              sessionId: 'acp-auto-retry',
              update: {
                sessionUpdate: 'tool_call_update',
                content: [{ content: { text: 'Error: listen EPERM: operation not permitted 127.0.0.1:55063' } }],
                rawOutput: { exit_code: 1 },
              },
            },
          },
        });
        return { exitCode: 1, sessionId: 'acp-auto-retry', stderr: '' };
      }
      onChunk({ stream: 'stdout', channel: 'answer', text: '重试后完成\n' });
      return { exitCode: 0, sessionId: 'acp-auto-retry', stderr: '' };
    },
  });

  const run = await runSessionAgent({ sessionId: session.id, prompt: '继续', provider: 'codex' });

  assert.equal(attempts, 2);
  assert.equal(run.status, 'completed');
  assert.match(sessionRunRepo.get(run.id)?.stdout ?? '', /重试后完成/);
  assert.ok(sessionEvidenceRepo.listBySession(session.id).some((event) => event.title === 'Session run auto retry'));
});

test('runSessionAgent keeps the retry-triggering ACP diagnostic when retry also fails silently', async () => {
  const project = projectRepo.create({
    name: 'runtime auto retry fallback project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-auto-retry-fallback-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Auto Retry Fallback',
    provider: 'codex',
    workspace_path: project.path,
  });
  let attempts = 0;

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk }) => {
      attempts += 1;
      if (attempts === 1) {
        onChunk({
          stream: 'stdout',
          channel: 'event',
          text: '',
          rawType: 'tool_call_update',
          rawEvent: {
            method: 'session/update',
            params: {
              sessionId: 'acp-auto-retry-fallback',
              update: {
                sessionUpdate: 'tool_call_update',
                content: [{ content: { text: 'Error: listen EPERM: operation not permitted 127.0.0.1:55063' } }],
                rawOutput: { exit_code: 1, stderr: '' },
              },
            },
          },
        });
        return { exitCode: 1, sessionId: 'acp-auto-retry-fallback', stderr: '' };
      }
      return { exitCode: 1, sessionId: 'acp-auto-retry-fallback', stderr: '' };
    },
  });

  const run = await runSessionAgent({ sessionId: session.id, prompt: '继续', provider: 'codex' });
  const stored = sessionRunRepo.get(run.id)!;

  assert.equal(attempts, 2);
  assert.equal(stored.status, 'failed');
  assert.match(stored.error ?? '', /listen EPERM/);
  assert.match(stored.stderr, /listen EPERM/);
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

test('runSessionAgent records token usage snapshots from ACP usage updates and broadcasts bottom status', async () => {
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as import('ws').WebSocket;
  const project = projectRepo.create({
    name: 'runtime token usage project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-token-usage-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Token Usage',
    mode: 'code',
    provider: 'codex',
    model: 'gpt-5.5',
    workspace_path: project.path,
  });
  wsHub.subscribeSession(session.id, socket);

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk, onSession }) => {
      onSession?.('acp-token-usage');
      onChunk({
        stream: 'stdout',
        channel: 'event',
        text: '',
        rawType: 'usage_update',
        rawEvent: {
          method: 'session/update',
          params: {
            sessionId: 'acp-token-usage',
            update: {
              sessionUpdate: 'usage_update',
              usage: {
                input_tokens: 200,
                output_tokens: 40,
                total_tokens: 240,
                input_tokens_details: { cached_tokens: 25 },
                output_tokens_details: { reasoning_tokens: 12 },
              },
            },
          },
        },
      });
      return { exitCode: 0, sessionId: 'acp-token-usage', stderr: '' };
    },
  });

  const run = await runSessionAgent({
    sessionId: session.id,
    agentId: 'planner',
    prompt: '继续',
    provider: 'codex',
    model: 'gpt-5.5',
  });

  const usageRows = sessionTokenUsageRepo.listBySession(session.id);
  assert.equal(usageRows.length, 1);
  assert.equal(usageRows[0]?.run_id, run.id);
  assert.equal(usageRows[0]?.agent_id, 'planner');
  assert.equal(usageRows[0]?.provider, 'codex');
  assert.equal(usageRows[0]?.model, 'gpt-5.5');
  assert.equal(usageRows[0]?.source, 'provider_context_usage');
  assert.equal(usageRows[0]?.input_tokens, 200);
  assert.equal(usageRows[0]?.output_tokens, 40);
  assert.equal(usageRows[0]?.total_tokens, 240);
  assert.equal(usageRows[0]?.cached_input_tokens, 25);
  assert.equal(usageRows[0]?.reasoning_tokens, 12);

  const events = sent.map((payload) =>
    JSON.parse(payload) as { type: string; bottomStatus?: { tokenUsage: { input: number; output: number; total: number } | null } }
  );
  const bottomStatus = events.find((event) => event.type === 'session_bottom_status:snapshot');
  assert.deepEqual(bottomStatus?.bottomStatus?.tokenUsage, {
    input: 200,
    output: 40,
    total: 240,
  });
  wsHub.removeSocket(socket);
});

test('runSessionAgent records standard ACP context usage updates in real time', async () => {
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as import('ws').WebSocket;
  const project = projectRepo.create({
    name: 'runtime standard ACP usage project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-standard-acp-usage-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Standard ACP Usage',
    mode: 'code',
    provider: 'codex',
    model: 'gpt-5.5',
    workspace_path: project.path,
  });
  wsHub.subscribeSession(session.id, socket);

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk, onSession }) => {
      onSession?.('acp-standard-token-usage');
      onChunk({
        stream: 'stdout',
        channel: 'event',
        text: '',
        rawType: 'usage_update',
        rawEvent: {
          method: 'session/update',
          params: {
            sessionId: 'acp-standard-token-usage',
            update: {
              sessionUpdate: 'usage_update',
              used: 53_000,
              size: 200_000,
              cost: {
                amount: 0.045,
                currency: 'USD',
              },
            },
          },
        },
      });
      return { exitCode: 0, sessionId: 'acp-standard-token-usage', stderr: '' };
    },
  });

  const run = await runSessionAgent({
    sessionId: session.id,
    agentId: 'planner',
    prompt: '继续',
    provider: 'codex',
    model: 'gpt-5.5',
  });

  const usageRows = sessionTokenUsageRepo.listBySession(session.id);
  assert.equal(usageRows.length, 1);
  assert.equal(usageRows[0]?.run_id, run.id);
  assert.equal(usageRows[0]?.source, 'provider_context_usage');
  assert.equal(usageRows[0]?.input_tokens, 53_000);
  assert.equal(usageRows[0]?.output_tokens, 0);
  assert.equal(usageRows[0]?.total_tokens, 53_000);
  assert.deepEqual(usageRows[0]?.raw_payload.usage, {
    sessionUpdate: 'usage_update',
    used: 53_000,
    size: 200_000,
    cost: {
      amount: 0.045,
      currency: 'USD',
    },
  });

  const events = sent.map((payload) =>
    JSON.parse(payload) as { type: string; bottomStatus?: { tokenUsage: { input: number; output: number; total: number } | null } }
  );
  const bottomStatus = events.find((event) => event.type === 'session_bottom_status:snapshot');
  assert.deepEqual(bottomStatus?.bottomStatus?.tokenUsage, {
    input: 53_000,
    output: 0,
    total: 53_000,
  });
  wsHub.removeSocket(socket);
});

test('runSessionAgent includes Anthropic cache token fields in input usage totals', async () => {
  const project = projectRepo.create({
    name: 'runtime anthropic token usage project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-anthropic-token-usage-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Anthropic Token Usage',
    mode: 'code',
    provider: 'claudecode',
    model: 'claude-sonnet-4-5',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'claudecode',
    listSessions: async () => [],
    invoke: async ({ onChunk, onSession }) => {
      onSession?.('acp-anthropic-token-usage');
      onChunk({
        stream: 'stdout',
        channel: 'event',
        text: '',
        rawType: 'message_delta',
        rawEvent: {
          message: {
            usage: {
              input_tokens: 80,
              cache_creation_input_tokens: 30,
              cache_read_input_tokens: 20,
              output_tokens: 25,
            },
          },
        },
      });
      return { exitCode: 0, sessionId: 'acp-anthropic-token-usage', stderr: '' };
    },
  });

  const run = await runSessionAgent({
    sessionId: session.id,
    agentId: 'reviewer',
    prompt: '继续',
    provider: 'claudecode',
    model: 'claude-sonnet-4-5',
  });

  const usageRows = sessionTokenUsageRepo.listBySession(session.id);

  assert.equal(usageRows.length, 1);
  assert.equal(usageRows[0]?.run_id, run.id);
  assert.equal(usageRows[0]?.input_tokens, 130);
  assert.equal(usageRows[0]?.output_tokens, 25);
  assert.equal(usageRows[0]?.total_tokens, 155);
  assert.equal(usageRows[0]?.cached_input_tokens, 50);
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

test('runSessionAgent omits project tools in read-only mode', async () => {
  const project = projectRepo.create({
    name: 'runtime read only tool project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-readonly-tool-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Readonly Tool',
    provider: 'codex',
    workspace_path: project.path,
  });
  let observedToolCount: number | null = null;

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async (args) => {
      observedToolCount = args.tools?.length ?? 0;
      return { exitCode: 0, sessionId: 'read-only-tool-acp', stderr: '' };
    },
  });

  const run = await runSessionAgent({ sessionId: session.id, prompt: '只读分析', provider: 'codex' });

  assert.equal(run.status, 'completed');
  assert.equal(observedToolCount, 0);
});

test('runSessionAgent exposes generate_image tool bound to session project scope', async () => {
  type RuntimeTool = {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    execute: (input: Record<string, unknown>) => Promise<unknown>;
  };

  const project = projectRepo.create({
    name: 'runtime image tool project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-image-tool-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Image Tool',
    provider: 'codex',
    workspace_path: project.path,
  });
  const profile = imageProviderProfileRepo.create(project.id, {
    name: 'Runtime Images',
    base_url: 'https://example.com/v1',
    api_key: 'runtime-tool-secret',
    model: 'gpt-image-2',
  });
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async (request) => {
      assert.equal(request.profileId, profile.id);
      return {
        images: [
          {
            data: Buffer.from(`png:${request.prompt}`),
            mimeType: 'image/png',
          },
        ],
      };
    },
  });
  let capturedToolResult: unknown;

  setSessionRuntimeGenerateImageToolDepsForTest({ service });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async (args) => {
      const tools = ((args as { tools?: RuntimeTool[] }).tools ?? []);
      const tool = tools.find((item) => item.name === 'generate_image');
      assert.ok(tool);
      const serializedSchema = JSON.stringify(tool.input_schema);
      assert.match(tool.description, /Generate text-to-image/);
      assert.equal(serializedSchema.includes('api_key'), false);
      assert.equal(serializedSchema.includes('base_url'), false);

      capturedToolResult = await tool.execute({
        project_id: 'malicious-project',
        session_id: 'malicious-session',
        prompt: 'bound apple',
        workflow: 'generate',
        provider_profile_id: null,
      });

      return { exitCode: 0, sessionId: 'image-tool-acp', stderr: '' };
    },
  });

  const run = await runSessionAgent({
    sessionId: session.id,
    prompt: '生成图片',
    provider: 'codex',
    permissionMode: 'workspace-write',
  });
  const toolResult = capturedToolResult as { job_id: string; status: string; outputs: unknown[] } | undefined;
  assert.ok(toolResult);
  assert.equal(run.status, 'completed');
  assert.equal(toolResult.status, 'completed');
  assert.equal(toolResult.outputs.length, 1);
  const job = imageGenerationJobRepo.get(toolResult.job_id);
  assert.equal(job?.project_id, project.id);
  assert.equal(job?.session_id, session.id);
  assert.equal(JSON.stringify(toolResult).includes('runtime-tool-secret'), false);
  const event = sessionEvidenceRepo.listBySession(session.id)
    .find((item) => item.title === '图片生成结果');
  assert.equal(event?.event_type, 'tool_result');
  assert.equal(event?.source_run_id, run.id);
  assert.deepEqual(event?.payload.outputs, toolResult.outputs);
});

test('runSessionAgent executes generate_image bridge markers from adapters that do not call tools', async () => {
  const project = projectRepo.create({
    name: 'runtime image bridge project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-image-bridge-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Image Bridge',
    provider: 'codex',
    workspace_path: project.path,
  });
  const profile = imageProviderProfileRepo.create(project.id, {
    name: 'Runtime Bridge Images',
    base_url: 'https://example.com/v1',
    api_key: 'runtime-bridge-secret',
    model: 'gpt-image-2',
  });
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async (request) => {
      assert.equal(request.profileId, profile.id);
      assert.equal(request.prompt, 'bridge pear');
      return {
        images: [
          {
            data: Buffer.from(`png:${request.prompt}`),
            mimeType: 'image/png',
          },
        ],
      };
    },
  });

  setSessionRuntimeGenerateImageToolDepsForTest({ service });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt, tools, onChunk }) => {
      assert.equal(tools?.some((tool) => tool.name === 'generate_image'), true);
      assert.match(prompt, /opendeepsea-tool-call/);
      assert.doesNotMatch(prompt, /runtime-bridge-secret/);
      onChunk({
        stream: 'stdout',
        channel: 'answer',
        text: [
          '准备生成图片。',
          '<opendeepsea-tool-call name="generate_image">',
          '{"prompt":"bridge pear","workflow":"generate","count":1,"provider_profile_id":null}',
          '</opendeepsea-tool-call>',
        ].join('\n'),
      });
      return { exitCode: 0, sessionId: 'image-bridge-acp', stderr: '' };
    },
  });

  const run = await runSessionAgent({
    sessionId: session.id,
    prompt: '生成一张梨子的图片',
    provider: 'codex',
    permissionMode: 'workspace-write',
  });
  const event = sessionEvidenceRepo.listBySession(session.id)
    .find((item) => item.title === '图片生成结果');
  const payload = event?.payload as { job_id?: string; outputs?: unknown[] } | undefined;
  assert.equal(run.status, 'completed');
  assert.doesNotMatch(sessionRunRepo.get(run.id)?.stdout ?? '', /opendeepsea-tool-call/);
  assert.equal(event?.event_type, 'tool_result');
  assert.equal(event?.source_run_id, run.id);
  assert.ok(payload?.job_id);
  assert.equal(payload.outputs?.length, 1);
  const job = imageGenerationJobRepo.get(payload.job_id);
  assert.equal(job?.project_id, project.id);
  assert.equal(job?.session_id, session.id);
  assert.equal(JSON.stringify(event).includes('runtime-bridge-secret'), false);
});

test('runSessionAgent hides and executes split generate_image bridge markers', async () => {
  const project = projectRepo.create({
    name: 'runtime split image bridge project',
    path: mkdtempSync(join(tmpdir(), 'session-runtime-image-bridge-split-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Runtime Split Image Bridge',
    provider: 'codex',
    workspace_path: project.path,
  });
  const profile = imageProviderProfileRepo.create(project.id, {
    name: 'Runtime Split Bridge Images',
    base_url: 'https://example.com/v1',
    api_key: 'runtime-split-bridge-secret',
    model: 'gpt-image-2',
  });
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async (request) => {
      assert.equal(request.profileId, profile.id);
      assert.equal(request.prompt, 'split peach');
      return {
        images: [
          {
            data: Buffer.from(`png:${request.prompt}`),
            mimeType: 'image/png',
          },
        ],
      };
    },
  });

  setSessionRuntimeGenerateImageToolDepsForTest({ service });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk }) => {
      onChunk({ stream: 'stdout', channel: 'answer', text: '准备生成图片。\n<opend' });
      onChunk({
        stream: 'stdout',
        channel: 'answer',
        text: [
          'eepsea-tool-call name="generate_image">',
          '{"prompt":"split peach","workflow":"generate","count":1,"provider_profile_id":null}',
        ].join('\n'),
      });
      onChunk({ stream: 'stdout', channel: 'answer', text: '\n</opendeepsea-tool-call>\n图片生成请求已提交。' });
      return { exitCode: 0, sessionId: 'image-split-bridge-acp', stderr: '' };
    },
  });

  const run = await runSessionAgent({
    sessionId: session.id,
    prompt: '生成一张桃子的图片',
    provider: 'codex',
    permissionMode: 'workspace-write',
  });
  const event = sessionEvidenceRepo.listBySession(session.id)
    .find((item) => item.title === '图片生成结果');
  const runRecord = sessionRunRepo.get(run.id);

  assert.equal(run.status, 'completed');
  assert.ok(event);
  assert.equal(event.source_run_id, run.id);
  assert.doesNotMatch(runRecord?.stdout ?? '', /opend|opendeepsea-tool-call|generate_image/);
  assert.match(runRecord?.stdout ?? '', /准备生成图片/);
  assert.match(runRecord?.stdout ?? '', /图片生成请求已提交/);
});
