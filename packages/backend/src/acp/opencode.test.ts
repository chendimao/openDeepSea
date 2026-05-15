import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCodeArgs } from './opencode.js';

test('buildOpenCodeArgs maps bypass to dangerously skip permissions', () => {
  assert.deepEqual(
    buildOpenCodeArgs({
      sessionId: null,
      prompt: 'hello',
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
      permissionMode: 'workspace-write',
      model: 'openai/gpt-5.1-codex',
    }),
    ['run', '--session', 'session-1', '--format', 'json', '--model', 'openai/gpt-5.1-codex', 'continue'],
  );
});
