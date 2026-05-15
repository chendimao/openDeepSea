import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeCodeArgs } from './claudecode.js';

test('buildClaudeCodeArgs maps bypass to bypassPermissions', () => {
  assert.deepEqual(
    buildClaudeCodeArgs({
      sessionId: null,
      prompt: 'hello',
      permissionMode: 'bypass',
      writableDirs: ['/tmp/ignored'],
    }),
    ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', 'hello'],
  );
});

test('buildClaudeCodeArgs maps workspace-write to acceptEdits with add-dir', () => {
  assert.deepEqual(
    buildClaudeCodeArgs({
      sessionId: 'session-1',
      prompt: 'continue',
      permissionMode: 'workspace-write',
      writableDirs: ['/tmp/a', ' /tmp/b ', '/tmp/a'],
    }),
    [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--add-dir',
      '/tmp/a',
      '--add-dir',
      '/tmp/b',
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
      permissionMode: 'read-only',
      writableDirs: [],
    }),
    ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', 'inspect'],
  );
});
