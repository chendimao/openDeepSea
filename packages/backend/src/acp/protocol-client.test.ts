import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeProtocolSession } from './protocol-client.js';
import { normalizeProtocolEvent } from './protocol-events.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const tsxLoaderPath = join(currentDir, '../../../../node_modules/tsx/dist/loader.mjs');

test('invokeProtocolSession streams ACP session updates as raw protocol events and answer text', async () => {
  const chunks: Array<{
    channel?: string;
    text: string;
    rawType?: string;
    rawEvent?: Record<string, unknown>;
  }> = [];
  const sessions: string[] = [];

  const result = await invokeProtocolSession({
    backend: 'codex',
    server: {
      backend: 'codex',
      mode: 'protocol',
      command: process.execPath,
      args: ['--import', tsxLoaderPath, join(currentDir, 'fake-acp-server.ts')],
      transport: 'stdio',
      enabled: true,
    },
    projectPath: process.cwd(),
    sessionId: null,
    prompt: 'hello',
    onChunk: (chunk) => chunks.push(chunk),
    onSession: (sessionId) => sessions.push(sessionId),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, 'fake-session-1');
  assert.deepEqual(sessions, ['fake-session-1']);
  assert.equal(chunks.filter((chunk) => chunk.channel === 'answer').map((chunk) => chunk.text).join(''), 'fake answer');

  const eventChunks = chunks.filter((chunk) => chunk.channel === 'event' && chunk.rawEvent);
  assert.deepEqual(eventChunks.map((chunk) => chunk.rawType), [
    'agent_thought_chunk',
    'plan',
    'tool_call',
    'tool_call_update',
    'agent_message_chunk',
  ]);

  const timelineEvents = eventChunks.map((chunk, index) => normalizeProtocolEvent({
    messageId: 'msg-1',
    runId: 'run-1',
    agentId: 'agent-1',
    seq: index + 1,
    provider: 'codex',
    raw: chunk.rawEvent!,
  }));

  assert.deepEqual(timelineEvents.map((event) => event.type), [
    'thinking',
    'plan_update',
    'tool_call',
    'tool_result',
    'assistant_message',
  ]);
});

test('invokeProtocolSession returns spawn error when ACP server command is missing', async () => {
  const result = await invokeProtocolSession({
    backend: 'codex',
    server: {
      backend: 'codex',
      mode: 'protocol',
      command: '/definitely/not/found/openclaw-acp-server',
      args: [],
      transport: 'stdio',
      enabled: true,
    },
    projectPath: process.cwd(),
    sessionId: null,
    prompt: 'hello',
    onChunk: () => undefined,
  });

  assert.equal(result.exitCode, -1);
  assert.equal(result.fallbackSafe, true);
  assert.match(result.stderr, /spawn|ENOENT|not\/found/);
});

test('invokeProtocolSession rejects ACP file reads that traverse outside allowed roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-acp-'));
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  await writeFile(join(root, 'outside.txt'), 'secret', 'utf-8');
  const previousReadPath = process.env.OPENCLAW_FAKE_ACP_READ_PATH;
  process.env.OPENCLAW_FAKE_ACP_READ_PATH = join(projectPath, '..', 'outside.txt');

  try {
    const result = await invokeProtocolSession({
      backend: 'codex',
      server: {
        backend: 'codex',
        mode: 'protocol',
        command: process.execPath,
        args: ['--import', tsxLoaderPath, join(currentDir, 'fake-acp-server.ts')],
        transport: 'stdio',
        enabled: true,
        env: {
          OPENCLAW_FAKE_ACP_READ_PATH: process.env.OPENCLAW_FAKE_ACP_READ_PATH,
        },
      },
      projectPath,
      sessionId: null,
      prompt: 'hello',
      onChunk: () => undefined,
    });

    assert.equal(result.exitCode, -1);
    assert.equal(result.fallbackSafe, false);
    assert.match(result.stderr, /outside allowed roots/);
  } finally {
    if (previousReadPath === undefined) delete process.env.OPENCLAW_FAKE_ACP_READ_PATH;
    else process.env.OPENCLAW_FAKE_ACP_READ_PATH = previousReadPath;
  }
});

test('invokeProtocolSession rejects ACP writes through symlinks outside allowed roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-acp-'));
  const projectPath = join(root, 'project');
  const outsidePath = join(root, 'outside.txt');
  const linkPath = join(projectPath, 'link.txt');
  await mkdir(projectPath);
  await writeFile(outsidePath, 'secret', 'utf-8');
  await symlink(outsidePath, linkPath);

  const result = await invokeProtocolSession({
    backend: 'codex',
    server: {
      backend: 'codex',
      mode: 'protocol',
      command: process.execPath,
      args: ['--import', tsxLoaderPath, join(currentDir, 'fake-acp-server.ts')],
      transport: 'stdio',
      enabled: true,
      env: {
        OPENCLAW_FAKE_ACP_WRITE_PATH: linkPath,
        OPENCLAW_FAKE_ACP_WRITE_CONTENT: 'overwritten',
      },
    },
    projectPath,
    sessionId: null,
    prompt: 'hello',
    onChunk: () => undefined,
  });

  assert.equal(result.exitCode, -1);
  assert.equal(result.fallbackSafe, false);
  assert.match(result.stderr, /Internal error/);
  assert.equal(await readFile(outsidePath, 'utf-8'), 'secret');
});

test('invokeProtocolSession allows file permissions in workspace-write mode', async () => {
  const chunks: Array<{ channel?: string; rawType?: string; rawEvent?: Record<string, unknown> }> = [];
  const result = await invokeProtocolSession({
    backend: 'codex',
    server: {
      backend: 'codex',
      mode: 'protocol',
      command: process.execPath,
      args: ['--import', tsxLoaderPath, join(currentDir, 'fake-acp-server.ts')],
      transport: 'stdio',
      enabled: true,
      env: {
        OPENCLAW_FAKE_ACP_PERMISSION: '1',
        OPENCLAW_FAKE_ACP_PERMISSION_KIND: 'edit',
        OPENCLAW_FAKE_ACP_PERMISSION_TITLE: 'Edit package.json',
      },
    },
    projectPath: process.cwd(),
    sessionId: null,
    prompt: 'hello',
    acpPermissionMode: 'workspace-write',
    onChunk: (chunk) => chunks.push(chunk),
  });

  assert.equal(result.exitCode, 0);
  const permissionEvent = chunks.find((chunk) => chunk.rawType === 'permission_request');
  assert.equal(permissionEvent?.rawEvent?.outcome, 'selected');
});

test('invokeProtocolSession cancels non-file permissions in workspace-write mode', async () => {
  const chunks: Array<{ channel?: string; rawType?: string; rawEvent?: Record<string, unknown> }> = [];
  const result = await invokeProtocolSession({
    backend: 'codex',
    server: {
      backend: 'codex',
      mode: 'protocol',
      command: process.execPath,
      args: ['--import', tsxLoaderPath, join(currentDir, 'fake-acp-server.ts')],
      transport: 'stdio',
      enabled: true,
      env: {
        OPENCLAW_FAKE_ACP_PERMISSION: '1',
        OPENCLAW_FAKE_ACP_PERMISSION_KIND: 'execute',
        OPENCLAW_FAKE_ACP_PERMISSION_TITLE: 'Run npm test',
      },
    },
    projectPath: process.cwd(),
    sessionId: null,
    prompt: 'hello',
    acpPermissionMode: 'workspace-write',
    onChunk: (chunk) => chunks.push(chunk),
  });

  assert.equal(result.exitCode, 0);
  const permissionEvent = chunks.find((chunk) => chunk.rawType === 'permission_request');
  assert.equal(permissionEvent?.rawEvent?.outcome, 'cancelled');
});

test('invokeProtocolSession times out unresponsive initialization safely', async () => {
  const result = await invokeProtocolSession({
    backend: 'codex',
    server: {
      backend: 'codex',
      mode: 'protocol',
      command: process.execPath,
      args: ['--import', tsxLoaderPath, join(currentDir, 'fake-acp-server.ts')],
      transport: 'stdio',
      enabled: true,
      env: {
        OPENCLAW_FAKE_ACP_HANG_INITIALIZE: '1',
      },
    },
    projectPath: process.cwd(),
    sessionId: null,
    prompt: 'hello',
    stageTimeoutMs: 25,
    onChunk: () => undefined,
  });

  assert.equal(result.exitCode, -1);
  assert.equal(result.fallbackSafe, true);
  assert.match(result.stderr, /ACP initialize timed out/);
});
