import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexExecInvocation } from './codex.js';

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
      args: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-'],
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
      args: ['exec', '--json', '--sandbox', 'read-only', '-'],
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
      args: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'abc123', '-'],
      stdin: '- 复现群聊错误',
    },
  );
});
