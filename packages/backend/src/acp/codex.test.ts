import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexExecArgs } from './codex.js';

test('buildCodexExecArgs defaults to bypassing approvals and sandbox', () => {
  assert.deepEqual(
    buildCodexExecArgs({
      sessionId: null,
      prompt: 'hello',
      imagePaths: [],
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
      imagePaths: [],
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
      imagePaths: [],
      permissionMode: 'read-only',
      writableDirs: ['/tmp/ignored'],
    }),
    ['exec', '--json', '--sandbox', 'read-only', 'inspect'],
  );
});

test('buildCodexExecArgs attaches image paths before the prompt', () => {
  assert.deepEqual(
    buildCodexExecArgs({
      sessionId: null,
      prompt: 'look',
      imagePaths: ['/tmp/screen.png', '/tmp/screen.png', '  ', '/tmp/diagram.webp'],
      permissionMode: 'bypass',
      writableDirs: [],
    }),
    [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--image',
      '/tmp/screen.png',
      '--image',
      '/tmp/diagram.webp',
      'look',
    ],
  );
});
