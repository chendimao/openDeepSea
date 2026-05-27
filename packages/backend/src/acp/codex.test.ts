import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexExecInvocation, codexAdapter } from './codex.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const tsxLoaderPath = join(currentDir, '../../../../node_modules/tsx/dist/loader.mjs');

test('buildCodexExecArgs defaults to bypassing approvals and sandbox', () => {
  assert.deepEqual(
    buildCodexExecInvocation({
      sessionId: null,
      prompt: 'hello',
      imagePaths: [],
      permissionMode: 'bypass',
      writableDirs: ['/tmp/ignored'],
    }),
    {
      args: ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-'],
      stdin: 'hello',
    },
  );
});

test('buildCodexExecArgs supports workspace-write with the current project directory', () => {
  assert.deepEqual(
    buildCodexExecInvocation({
      sessionId: 'abc123',
      prompt: 'continue',
      imagePaths: [],
      permissionMode: 'workspace-write',
      writableDirs: ['/Users/chendimao/WWW/openclaw-room'],
    }),
    {
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--add-dir',
        '/Users/chendimao/WWW/openclaw-room',
        'resume',
        'abc123',
        '-',
      ],
      stdin: 'continue',
    },
  );
});

test('buildCodexExecArgs supports read-only mode', () => {
  assert.deepEqual(
    buildCodexExecInvocation({
      sessionId: null,
      prompt: 'inspect',
      imagePaths: [],
      permissionMode: 'read-only',
      writableDirs: ['/tmp/ignored'],
    }),
    {
      args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-'],
      stdin: 'inspect',
    },
  );
});

test('buildCodexExecArgs attaches image paths before the prompt', () => {
  assert.deepEqual(
    buildCodexExecInvocation({
      sessionId: null,
      prompt: 'look',
      imagePaths: ['/tmp/screen.png', '/tmp/screen.png', '  ', '/tmp/diagram.webp'],
      permissionMode: 'bypass',
      writableDirs: [],
    }),
    {
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--image',
        '/tmp/screen.png',
        '--image',
        '/tmp/diagram.webp',
        '-',
      ],
      stdin: 'look',
    },
  );
});

test('buildCodexExecArgs passes dash-prefixed chat messages through stdin', () => {
  assert.deepEqual(
    buildCodexExecInvocation({
      sessionId: 'abc123',
      prompt: '- 复现群聊错误',
      imagePaths: [],
      permissionMode: 'bypass',
      writableDirs: [],
    }),
    {
      args: ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'abc123', '-'],
      stdin: '- 复现群聊错误',
    },
  );
});

test('codexAdapter invokes configured ACP protocol server before legacy CLI', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  process.env.OPENCLAW_ACP_MODE = 'protocol';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: null,
      prompt: 'hello',
      onChunk: (chunk) => chunks.push(chunk),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'fake-session-1');
    assert.equal(chunks.filter((chunk) => chunk.channel === 'answer').map((chunk) => chunk.text).join(''), 'fake answer');
    assert.deepEqual(
      chunks.filter((chunk) => chunk.channel === 'event').map((chunk) => chunk.rawType),
      ['agent_thought_chunk', 'plan', 'tool_call', 'tool_call_update', 'agent_message_chunk'],
    );
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_CODEX_COMMAND;
    else process.env.OPENCLAW_ACP_CODEX_COMMAND = previousCommand;
  }
});

test('codexAdapter does not fallback after ACP protocol side effects', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  const previousFail = process.env.OPENCLAW_FAKE_ACP_FAIL_AFTER_EVENT;
  process.env.OPENCLAW_ACP_MODE = 'auto';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_ACP_FAIL_AFTER_EVENT = '1';

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: null,
      prompt: 'hello',
      onChunk: (chunk) => chunks.push(chunk),
    });

    assert.equal(result.exitCode, -1);
    assert.equal(result.fallbackSafe, false);
    assert.match(result.stderr, /Internal error/);
    assert.deepEqual(chunks.filter((chunk) => chunk.channel === 'event').map((chunk) => chunk.rawType), ['agent_thought_chunk']);
    assert.equal(chunks.some((chunk) => chunk.rawType === 'protocol_fallback'), false);
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_CODEX_COMMAND;
    else process.env.OPENCLAW_ACP_CODEX_COMMAND = previousCommand;
    if (previousFail === undefined) delete process.env.OPENCLAW_FAKE_ACP_FAIL_AFTER_EVENT;
    else process.env.OPENCLAW_FAKE_ACP_FAIL_AFTER_EVENT = previousFail;
  }
});

test('codexAdapter retries retry-safe ACP network disconnect before output', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  const previousFail = process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT;
  const previousRetryDelays = process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS;
  process.env.OPENCLAW_ACP_MODE = 'protocol';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT = '1';
  process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS = '0';
  let first = true;

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: null,
      prompt: 'hello',
      onChunk: (chunk) => chunks.push(chunk),
      onSession: () => {
        if (first) {
          first = false;
          delete process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT;
        }
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(chunks.filter((chunk) => chunk.channel === 'answer').map((chunk) => chunk.text).join(''), 'fake answer');
    assert.equal(chunks.some((chunk) => chunk.rawType === 'protocol.retry'), true);
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_CODEX_COMMAND;
    else process.env.OPENCLAW_ACP_CODEX_COMMAND = previousCommand;
    if (previousFail === undefined) delete process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT;
    else process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT = previousFail;
    if (previousRetryDelays === undefined) delete process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS;
    else process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS = previousRetryDelays;
  }
});

test('codexAdapter retries promptly when ACP reports stream disconnect on stderr', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  const previousDisconnect = process.env.OPENCLAW_FAKE_ACP_STDERR_DISCONNECT;
  const previousRetryDelays = process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS;
  process.env.OPENCLAW_ACP_MODE = 'protocol';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_ACP_STDERR_DISCONNECT = '1';
  process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS = '0';
  let first = true;

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: null,
      prompt: 'hello',
      onChunk: (chunk) => chunks.push(chunk),
      onSession: () => {
        if (first) {
          first = false;
          delete process.env.OPENCLAW_FAKE_ACP_STDERR_DISCONNECT;
        }
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(chunks.filter((chunk) => chunk.channel === 'answer').map((chunk) => chunk.text).join(''), 'fake answer');
    assert.equal(chunks.some((chunk) => chunk.rawType === 'protocol.retry'), true);
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_CODEX_COMMAND;
    else process.env.OPENCLAW_ACP_CODEX_COMMAND = previousCommand;
    if (previousDisconnect === undefined) delete process.env.OPENCLAW_FAKE_ACP_STDERR_DISCONNECT;
    else process.env.OPENCLAW_FAKE_ACP_STDERR_DISCONNECT = previousDisconnect;
    if (previousRetryDelays === undefined) delete process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS;
    else process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS = previousRetryDelays;
  }
});

test('codexAdapter exhausts five ACP network retries with configured backoff delays', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  const previousFail = process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT;
  const previousRetryDelays = process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS;
  process.env.OPENCLAW_ACP_MODE = 'protocol';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT = '1';
  process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS = '0,0,0,0,0';

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: null,
      prompt: 'hello',
      onChunk: (chunk) => chunks.push(chunk),
    });

    const retryChunks = chunks.filter((chunk) => chunk.rawType === 'protocol.retry');
    assert.equal(result.exitCode, -1);
    assert.equal(retryChunks.length, 5);
    assert.match(retryChunks[0]?.text ?? '', /retrying 1\/5 after 0ms/);
    assert.match(retryChunks[4]?.text ?? '', /retrying 5\/5 after 0ms/);
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_CODEX_COMMAND;
    else process.env.OPENCLAW_ACP_CODEX_COMMAND = previousCommand;
    if (previousFail === undefined) delete process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT;
    else process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT = previousFail;
    if (previousRetryDelays === undefined) delete process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS;
    else process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS = previousRetryDelays;
  }
});
