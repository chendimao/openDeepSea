import test from 'node:test';
import assert from 'node:assert/strict';
import { isProtocolEvent, normalizeProtocolEvent } from './protocol-events.js';

const baseArgs = {
  messageId: 'msg-1',
  runId: 'run-1',
  agentId: 'agent-1',
  seq: 1,
  provider: 'codex',
} as const;

test('normalizeProtocolEvent maps session thinking update to thinking delta', () => {
  const raw = {
    type: 'session/update',
    kind: 'thinking',
    delta: '先检查文件',
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    raw,
  });

  assert.equal(event.type, 'thinking');
  assert.equal(event.status, 'delta');
  assert.equal(event.payload.text, '先检查文件');
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps ACP JSON-RPC agent message chunks to assistant_message', () => {
  const raw = {
    method: 'session/update',
    params: {
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '已完成修改',
        },
      },
    },
  };

  assert.equal(isProtocolEvent(raw), true);

  const event = normalizeProtocolEvent({
    ...baseArgs,
    raw,
  });

  assert.equal(event.type, 'assistant_message');
  assert.equal(event.status, 'delta');
  assert.equal(event.payload.text, '已完成修改');
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps ACP JSON-RPC thought chunks to thinking', () => {
  const raw = {
    method: 'session/update',
    params: {
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: '先阅读相关文件',
        },
      },
    },
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    raw,
  });

  assert.equal(event.type, 'thinking');
  assert.equal(event.status, 'delta');
  assert.equal(event.payload.text, '先阅读相关文件');
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps tool_call_started to started tool_call', () => {
  const raw = {
    type: 'tool_call_started',
    name: 'Read',
    input: { path: 'src/app.ts' },
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 2,
    raw,
  });

  assert.equal(event.type, 'tool_call');
  assert.equal(event.status, 'started');
  assert.equal(event.payload.name, 'Read');
  assert.deepEqual(event.payload.input, { path: 'src/app.ts' });
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps ACP tool_call with rawInput and locations', () => {
  const raw = {
    method: 'session/update',
    params: {
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read src/app.ts',
        kind: 'read',
        rawInput: { path: 'src/app.ts' },
        locations: [{ path: 'src/app.ts' }],
        status: 'in_progress',
      },
    },
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 3,
    raw,
  });

  assert.equal(event.type, 'tool_call');
  assert.equal(event.status, 'started');
  assert.equal(event.payload.id, 'tool-1');
  assert.equal(event.payload.title, 'Read src/app.ts');
  assert.equal(event.payload.kind, 'read');
  assert.deepEqual(event.payload.input, { path: 'src/app.ts' });
  assert.deepEqual(event.payload.locations, [{ path: 'src/app.ts' }]);
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps ACP in-progress tool_call_update as tool_call', () => {
  const raw = {
    method: 'session/update',
    params: {
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Read src/app.ts',
        status: 'in_progress',
      },
    },
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 4,
    raw,
  });

  assert.equal(event.type, 'tool_call');
  assert.equal(event.status, 'started');
  assert.equal(event.payload.id, 'tool-1');
  assert.equal(event.payload.title, 'Read src/app.ts');
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps ACP completed tool_call_update as tool_result', () => {
  const raw = {
    method: 'session/update',
    params: {
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Read src/app.ts',
        status: 'completed',
        rawOutput: { ok: true },
      },
    },
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 5,
    raw,
  });

  assert.equal(event.type, 'tool_result');
  assert.equal(event.status, 'completed');
  assert.equal(event.payload.id, 'tool-1');
  assert.equal(event.payload.title, 'Read src/app.ts');
  assert.deepEqual(event.payload.output, { ok: true });
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent truncates oversized tool output and drops oversized raw event', () => {
  const largeOutput = 'x'.repeat(40_000);
  const raw = {
    method: 'session/update',
    params: {
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'rg search',
        status: 'completed',
        rawOutput: {
          command: ['/bin/zsh', '-lc', 'rg -n "settings" packages'],
          output: largeOutput,
        },
      },
    },
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 5,
    raw,
  });

  assert.equal(event.type, 'tool_result');
  assert.equal(event.raw, undefined);
  assert.equal(event.payload.truncated, true);
  assert.equal(typeof event.payload.original_bytes, 'number');
  assert.ok(Number(event.payload.original_bytes) > 40_000);
  assert.match(JSON.stringify(event.payload), /rg -n/);
  assert.ok(JSON.stringify(event.payload).length < 20_000);
});

test('normalizeProtocolEvent maps ACP diff tool_call_update content to file_diff', () => {
  const raw = {
    method: 'session/update',
    params: {
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Edit src/app.ts',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: 'src/app.ts',
            oldText: 'old\nline',
            newText: 'new\nline\nextra',
          },
        ],
      },
    },
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 6,
    raw,
  });

  assert.equal(event.type, 'file_diff');
  assert.equal(event.status, 'completed');
  assert.equal(event.payload.path, 'src/app.ts');
  assert.equal(event.payload.additions, 3);
  assert.equal(event.payload.deletions, 2);
  assert.equal(event.payload.tool_call_id, 'tool-1');
  assert.match(String(event.payload.patch), /--- a\/src\/app\.ts/);
  assert.match(String(event.payload.patch), /\+extra/);
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent prefers ACP tool title over kind for display name', () => {
  const raw = {
    method: 'session/update',
    params: {
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read src/app.ts',
        kind: 'read',
        status: 'in_progress',
      },
    },
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 7,
    raw,
  });

  assert.equal(event.payload.name, 'Read src/app.ts');
  assert.equal(event.title, '调用工具 Read src/app.ts');
});

test('normalizeProtocolEvent maps stdout command output delta to command_output', () => {
  const raw = {
    type: 'command_output_delta',
    command: 'npm test',
    stream: 'stdout',
    delta: 'ok\n',
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 3,
    raw,
  });

  assert.equal(event.type, 'command_output');
  assert.equal(event.status, 'delta');
  assert.equal(event.payload.command, 'npm test');
  assert.equal(event.payload.stdout, 'ok\n');
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps ACP plan sessionUpdate to plan_update', () => {
  const raw = {
    method: 'session/update',
    params: {
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: '实现协议客户端', priority: 'high', status: 'in_progress' },
          { content: '运行测试', priority: 'medium', status: 'pending' },
        ],
      },
    },
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 7,
    raw,
  });

  assert.equal(event.type, 'plan_update');
  assert.equal(event.status, 'completed');
  assert.deepEqual(event.payload.entries, [
    { content: '实现协议客户端', priority: 'high', status: 'in_progress' },
    { content: '运行测试', priority: 'medium', status: 'pending' },
  ]);
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps file diff patch and counts additions and deletions', () => {
  const raw = {
    type: 'file_diff',
    path: 'src/app.ts',
    patch: [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,3 @@',
      '-old',
      '+new',
      '+extra',
      ' context',
    ].join('\n'),
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 4,
    raw,
  });

  assert.equal(event.type, 'file_diff');
  assert.equal(event.status, 'completed');
  assert.equal(event.payload.path, 'src/app.ts');
  assert.equal(event.payload.additions, 2);
  assert.equal(event.payload.deletions, 1);
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent downgrades unknown provider events to raw and preserves raw', () => {
  const raw = {
    type: 'provider.custom',
    value: 1,
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 5,
    raw,
  });

  assert.equal(event.type, 'raw');
  assert.equal(event.status, 'completed');
  assert.equal(event.payload.raw_type, 'provider.custom');
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps plan_update events to plan_update entries', () => {
  const raw = {
    type: 'plan_update',
    entries: [
      { title: '新增 mapper', status: 'in_progress' },
      { title: '运行测试', status: 'pending' },
    ],
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 6,
    raw,
  });

  assert.equal(event.type, 'plan_update');
  assert.equal(event.status, 'completed');
  assert.deepEqual(event.payload.entries, [
    { title: '新增 mapper', status: 'in_progress' },
    { title: '运行测试', status: 'pending' },
  ]);
  assert.deepEqual(event.raw, raw);
});

test('normalizeProtocolEvent maps next_steps events to plan_update entries', () => {
  const raw = {
    type: 'next_steps',
    next_steps: ['补充验证', '整理结果'],
  };

  const event = normalizeProtocolEvent({
    ...baseArgs,
    seq: 7,
    raw,
  });

  assert.equal(event.type, 'plan_update');
  assert.equal(event.status, 'completed');
  assert.deepEqual(event.payload.entries, ['补充验证', '整理结果']);
  assert.deepEqual(event.raw, raw);
});
