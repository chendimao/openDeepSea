import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexExecArgs } from './codex.js';

test('buildCodexExecArgs defaults to bypassing approvals and sandbox', () => {
  assert.deepEqual(
    buildCodexExecArgs({
      sessionId: null,
      prompt: 'hello',
      permissionMode: 'bypass',
      writableDirs: ['/tmp/ignored'],
    }),
    ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', 'hello'],
  );
});

test('buildCodexExecArgs supports workspace-write with the current project directory', () => {
  assert.deepEqual(
    buildCodexExecArgs({
      sessionId: 'abc123',
      prompt: 'continue',
      permissionMode: 'workspace-write',
      writableDirs: ['/Users/chendimao/WWW/openclaw-room'],
    }),
    [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      '/Users/chendimao/WWW/openclaw-room',
      'resume',
      'abc123',
      'continue',
    ],
  );
});

test('buildCodexExecArgs supports read-only mode', () => {
  assert.deepEqual(
    buildCodexExecArgs({
      sessionId: null,
      prompt: 'inspect',
      permissionMode: 'read-only',
      writableDirs: ['/tmp/ignored'],
    }),
    ['exec', '--json', '--sandbox', 'read-only', 'inspect'],
  );
});
