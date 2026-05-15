import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCodeArgs } from './opencode.js';

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
