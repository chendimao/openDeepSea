import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenCodeArgs, openCodeAdapter } from './opencode.js';

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

test('buildOpenCodeArgs maps bypass to dangerously skip permissions', () => {
  assert.deepEqual(
    buildOpenCodeArgs({
      sessionId: null,
      prompt: 'hello',
      filePaths: [],
      permissionMode: 'bypass',
      model: 'openai/gpt-5.1-codex',
    }),
    ['run', '--format', 'json', '--model', 'openai/gpt-5.1-codex', '--dangerously-skip-permissions', 'hello'],
  );
});

test('buildOpenCodeArgs leaves non-bypass modes to opencode defaults', () => {
  assert.deepEqual(
    buildOpenCodeArgs({
      sessionId: 'session-1',
      prompt: 'continue',
      filePaths: [],
      permissionMode: 'workspace-write',
      model: 'openai/gpt-5.1-codex',
    }),
    ['run', '--session', 'session-1', '--format', 'json', '--model', 'openai/gpt-5.1-codex', 'continue'],
  );
});

test('buildOpenCodeArgs attaches files before the prompt', () => {
  assert.deepEqual(
    buildOpenCodeArgs({
      sessionId: null,
      prompt: 'look',
      filePaths: ['/tmp/screen.png', '/tmp/screen.png', '', '/tmp/diagram.webp'],
      permissionMode: 'bypass',
      model: 'openai/gpt-5.1-codex',
    }),
    [
      'run',
      '--format',
      'json',
      '--model',
      'openai/gpt-5.1-codex',
      '--dangerously-skip-permissions',
      '--file',
      '/tmp/screen.png',
      '--file',
      '/tmp/diagram.webp',
      'look',
    ],
  );
});

test('openCodeAdapter falls back to CLI resume when ACP cannot resume saved session id', async () => {
  const previousMode = process.env.OPENCLAW_ACP_MODE;
  const previousCommand = process.env.OPENCLAW_ACP_OPENCODE_COMMAND;
  const previousPath = process.env.PATH;
  const previousCapture = process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
  const captureFile = join(mkdtempSync(join(tmpdir(), 'openclaw-opencode-cli-')), 'capture.jsonl');
  const binDir = createFakeCliBin('opencode');
  process.env.OPENCLAW_ACP_MODE = 'auto';
  process.env.OPENCLAW_ACP_OPENCODE_COMMAND = `${process.execPath} --import ${tsxLoaderPath} ${join(currentDir, 'fake-acp-server.ts')}`;
  process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = captureFile;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

  try {
    const chunks: Array<{ channel?: string; text: string; rawType?: string }> = [];
    const result = await openCodeAdapter.invoke({
      projectPath: process.cwd(),
      sessionId: 'saved-opencode-session',
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
    assert.equal(capture.argv.includes('--session'), true);
    assert.equal(capture.argv[capture.argv.indexOf('--session') + 1], 'saved-opencode-session');
    assert.equal(capture.argv.at(-1), 'continue');
    assert.equal(capture.stdin, '');
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_ACP_MODE;
    else process.env.OPENCLAW_ACP_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.OPENCLAW_ACP_OPENCODE_COMMAND;
    else process.env.OPENCLAW_ACP_OPENCODE_COMMAND = previousCommand;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE;
    else process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE = previousCapture;
  }
});
