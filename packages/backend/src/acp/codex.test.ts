import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexExecInvocation, codexAdapter } from './codex.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const tsxLoaderPath = join(currentDir, '../../../../node_modules/tsx/dist/loader.mjs');
const fakeCliPath = join(currentDir, 'fake-cli-runner.ts');

function createFakeCliBin(commandName: string): string {
  const binDir = mkdtempSync(join(tmpdir(), `openclaw-${commandName}-bin-`));
  const commandPath = join(binDir, commandName);
  writeFileSync(
    commandPath,
    `#!/bin/sh\nexec "${process.execPath}" --import "${tsxLoaderPath}" "${fakeCliPath}" "$@"\n`,
    'utf-8',
  );
  chmodSync(commandPath, 0o755);
  return binDir;
}

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

test('buildCodexExecInvocation injects managed model and reasoning overrides', () => {
  assert.deepEqual(
    buildCodexExecInvocation({
      sessionId: null,
      prompt: 'hello',
      imagePaths: [],
      permissionMode: 'bypass',
      writableDirs: [],
      providerRuntimeConfig: {
        provider: 'codex',
        source: 'managed_profile',
        profile_id: 'profile-codex',
        model: 'gpt-5.5',
        base_url: 'https://codex.example/v1',
        api_key: 'sk-codex1234',
        api_key_env_var: 'OPENAI_API_KEY',
        reasoning_effort: 'xhigh',
        run_overrides_enabled: true,
      },
    }),
    {
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--model',
        'gpt-5.5',
        '-c',
        'model_reasoning_effort=xhigh',
        '--dangerously-bypass-approvals-and-sandbox',
        '-',
      ],
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

test('codexAdapter falls back to CLI resume when ACP cannot resume saved session id', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  const previousPath = process.env.PATH;
  const previousCapture = process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
  const captureFile = join(mkdtempSync(join(tmpdir(), 'openclaw-codex-cli-')), 'capture.jsonl');
  const binDir = createFakeCliBin('codex');
  process.env.OPENCLAW_ACP_MODE = 'auto';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = captureFile;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: 'saved-codex-session',
      prompt: 'continue',
      onChunk: (chunk) => chunks.push(chunk),
      envOverrides: {
        NODE_OPTIONS: `--import ${tsxLoaderPath}`,
      },
    });

    const capture = JSON.parse(readFileSync(captureFile, 'utf-8').trim()) as { argv: string[]; stdin: string };
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'fake-cli-session');
    assert.equal(chunks.some((chunk) => chunk.rawType === 'protocol_fallback'), true);
    assert.deepEqual(capture.argv.slice(-3), ['resume', 'saved-codex-session', '-']);
    assert.equal(capture.stdin, 'continue');
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_CODEX_COMMAND;
    else process.env.OPENCLAW_ACP_CODEX_COMMAND = previousCommand;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
    else process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = previousCapture;
  }
});

test('codexAdapter falls back to CLI resume when ACP resumeSession fails before prompt', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  const previousPath = process.env.PATH;
  const previousCapture = process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
  const captureFile = join(mkdtempSync(join(tmpdir(), 'openclaw-codex-cli-resume-fail-')), 'capture.jsonl');
  const binDir = createFakeCliBin('codex');
  process.env.OPENCLAW_ACP_MODE = 'auto';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = captureFile;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: 'saved-codex-session',
      prompt: 'continue',
      onChunk: (chunk) => chunks.push(chunk),
      envOverrides: {
        NODE_OPTIONS: `--import ${tsxLoaderPath}`,
        OPENCLAW_FAKE_ACP_CAN_RESUME: '1',
        OPENCLAW_FAKE_ACP_FAIL_RESUME: '1',
      },
    });

    const capture = JSON.parse(readFileSync(captureFile, 'utf-8').trim()) as { argv: string[]; stdin: string };
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'fake-cli-session');
    assert.equal(chunks.some((chunk) => chunk.rawType === 'protocol_fallback'), true);
    assert.deepEqual(capture.argv.slice(-3), ['resume', 'saved-codex-session', '-']);
    assert.equal(capture.stdin, 'continue');
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_CODEX_COMMAND;
    else process.env.OPENCLAW_ACP_CODEX_COMMAND = previousCommand;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
    else process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = previousCapture;
  }
});

test('codexAdapter falls back to ACP new session when CLI resume fails', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  const previousPath = process.env.PATH;
  const previousCapture = process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
  const previousCliExit = process.env.OPENCLAW_FAKE_CLI_EXIT_CODE;
  const previousCliStderr = process.env.OPENCLAW_FAKE_CLI_STDERR;
  const previousEcho = process.env.OPENCLAW_FAKE_ACP_ECHO_PROMPT;
  const captureFile = join(mkdtempSync(join(tmpdir(), 'openclaw-codex-cli-fail-')), 'capture.jsonl');
  const binDir = createFakeCliBin('codex');
  process.env.OPENCLAW_ACP_MODE = 'auto';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = captureFile;
  process.env.OPENCLAW_FAKE_CLI_EXIT_CODE = '9';
  process.env.OPENCLAW_FAKE_CLI_STDERR = 'codex resume failed';
  process.env.OPENCLAW_FAKE_ACP_ECHO_PROMPT = '1';
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: 'saved-codex-session',
      prompt: 'continue',
      sessionHandoff: 'previous codex summary',
      onChunk: (chunk) => chunks.push(chunk),
      envOverrides: {
        NODE_OPTIONS: `--import ${tsxLoaderPath}`,
      },
    });

    const capture = JSON.parse(readFileSync(captureFile, 'utf-8').trim()) as { argv: string[]; stdin: string };
    const answer = chunks.filter((chunk) => chunk.channel === 'answer').map((chunk) => chunk.text).join('');
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'fake-session-1');
    assert.deepEqual(capture.argv.slice(-3), ['resume', 'saved-codex-session', '-']);
    assert.equal(chunks.some((chunk) => chunk.rawType === 'protocol.fake_resume_fallback'), true);
    assert.match(answer, /Previous ACP session could not be resumed/);
    assert.match(answer, /previous codex summary/);
    assert.match(answer, /当前请求：\s*continue/);
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_CODEX_COMMAND;
    else process.env.OPENCLAW_ACP_CODEX_COMMAND = previousCommand;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
    else process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = previousCapture;
    if (previousCliExit === undefined) delete process.env.OPENCLAW_FAKE_CLI_EXIT_CODE;
    else process.env.OPENCLAW_FAKE_CLI_EXIT_CODE = previousCliExit;
    if (previousCliStderr === undefined) delete process.env.OPENCLAW_FAKE_CLI_STDERR;
    else process.env.OPENCLAW_FAKE_CLI_STDERR = previousCliStderr;
    if (previousEcho === undefined) delete process.env.OPENCLAW_FAKE_ACP_ECHO_PROMPT;
    else process.env.OPENCLAW_FAKE_ACP_ECHO_PROMPT = previousEcho;
  }
});

test('codexAdapter does not fake resume after CLI resume streams output and then fails', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  const previousPath = process.env.PATH;
  const previousCapture = process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
  const previousCliExit = process.env.OPENCLAW_FAKE_CLI_EXIT_CODE;
  const previousCliStderr = process.env.OPENCLAW_FAKE_CLI_STDERR;
  const previousCliStdout = process.env.OPENCLAW_FAKE_CLI_STDOUT_BEFORE_EXIT;
  const captureFile = join(mkdtempSync(join(tmpdir(), 'openclaw-codex-cli-output-fail-')), 'capture.jsonl');
  const binDir = createFakeCliBin('codex');
  process.env.OPENCLAW_ACP_MODE = 'auto';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = captureFile;
  process.env.OPENCLAW_FAKE_CLI_EXIT_CODE = '9';
  process.env.OPENCLAW_FAKE_CLI_STDERR = 'codex resume failed after output';
  process.env.OPENCLAW_FAKE_CLI_STDOUT_BEFORE_EXIT = 'partial cli answer\n';
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: 'saved-codex-session',
      prompt: 'continue',
      sessionHandoff: 'previous codex summary',
      onChunk: (chunk) => chunks.push(chunk),
      envOverrides: {
        NODE_OPTIONS: `--import ${tsxLoaderPath}`,
      },
    });

    const answer = chunks.filter((chunk) => chunk.channel === 'answer').map((chunk) => chunk.text).join('');
    assert.equal(result.exitCode, 9);
    assert.equal(result.sessionId, null);
    assert.equal(chunks.some((chunk) => chunk.rawType === 'protocol.fake_resume_fallback'), false);
    assert.match(answer, /partial cli answer/);
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_CODEX_COMMAND;
    else process.env.OPENCLAW_ACP_CODEX_COMMAND = previousCommand;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
    else process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = previousCapture;
    if (previousCliExit === undefined) delete process.env.OPENCLAW_FAKE_CLI_EXIT_CODE;
    else process.env.OPENCLAW_FAKE_CLI_EXIT_CODE = previousCliExit;
    if (previousCliStderr === undefined) delete process.env.OPENCLAW_FAKE_CLI_STDERR;
    else process.env.OPENCLAW_FAKE_CLI_STDERR = previousCliStderr;
    if (previousCliStdout === undefined) delete process.env.OPENCLAW_FAKE_CLI_STDOUT_BEFORE_EXIT;
    else process.env.OPENCLAW_FAKE_CLI_STDOUT_BEFORE_EXIT = previousCliStdout;
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

test('codexAdapter preserves env overrides across ACP retries', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_CODEX_COMMAND;
  const previousFail = process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT;
  const previousRequireDisabled = process.env.OPENCLAW_FAKE_ACP_REQUIRE_SUPERPOWERS_DISABLED;
  const previousRetryDelays = process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS;
  const previousBootstrapDisabled = process.env.SUPERPOWERS_BOOTSTRAP_DISABLED;
  process.env.OPENCLAW_ACP_MODE = 'protocol';
  process.env.OPENCLAW_ACP_CODEX_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT = '1';
  process.env.OPENCLAW_FAKE_ACP_REQUIRE_SUPERPOWERS_DISABLED = '1';
  process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS = '0';
  delete process.env.SUPERPOWERS_BOOTSTRAP_DISABLED;
  let first = true;

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await codexAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: null,
      prompt: 'hello',
      envOverrides: {
        SUPERPOWERS_BOOTSTRAP_DISABLED: '1',
      },
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
    if (previousRequireDisabled === undefined) delete process.env.OPENCLAW_FAKE_ACP_REQUIRE_SUPERPOWERS_DISABLED;
    else process.env.OPENCLAW_FAKE_ACP_REQUIRE_SUPERPOWERS_DISABLED = previousRequireDisabled;
    if (previousRetryDelays === undefined) delete process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS;
    else process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS = previousRetryDelays;
    if (previousBootstrapDisabled === undefined) delete process.env.SUPERPOWERS_BOOTSTRAP_DISABLED;
    else process.env.SUPERPOWERS_BOOTSTRAP_DISABLED = previousBootstrapDisabled;
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
