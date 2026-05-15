import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeCodeArgs, buildClaudeCodePrompt } from './claudecode.js';

test('buildClaudeCodeArgs maps bypass to bypassPermissions', () => {
  assert.deepEqual(
    buildClaudeCodeArgs({
      sessionId: null,
      prompt: 'hello',
      imagePaths: [],
      permissionMode: 'bypass',
      writableDirs: ['/tmp/ignored'],
    }),
    ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', 'hello'],
  );
});

test('buildClaudeCodeArgs maps workspace-write to acceptEdits with the current project directory', () => {
  assert.deepEqual(
    buildClaudeCodeArgs({
      sessionId: 'session-1',
      prompt: 'continue',
      imagePaths: [],
      permissionMode: 'workspace-write',
      writableDirs: ['/Users/chendimao/WWW/openclaw-room'],
    }),
    [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--add-dir',
      '/Users/chendimao/WWW/openclaw-room',
      '--resume',
      'session-1',
      'continue',
    ],
  );
});

test('buildClaudeCodeArgs maps read-only to plan mode', () => {
  assert.deepEqual(
    buildClaudeCodeArgs({
      sessionId: null,
      prompt: 'inspect',
      imagePaths: [],
      permissionMode: 'read-only',
      writableDirs: [],
    }),
    ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', 'inspect'],
  );
});

test('buildClaudeCodePrompt appends local image paths for Claude Code', () => {
  const prompt = buildClaudeCodePrompt('能识别图片吗', [
    '/tmp/screen.png',
    '/tmp/screen.png',
    ' ',
    '/tmp/diagram.webp',
  ]);

  assert.match(prompt, /能识别图片吗/);
  assert.match(prompt, /Claude Code 图片附件：/);
  assert.match(prompt, /1\. \/tmp\/screen\.png/);
  assert.match(prompt, /2\. \/tmp\/diagram\.webp/);
});
