import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-messages-')), 'test.db');

const { db } = await import('../db.js');
const { messageRepo } = await import('./messages.js');
const { projectRepo } = await import('./projects.js');
const { roomRepo } = await import('./rooms.js');

test('messageRepo returns compact trace events for historical oversized metadata', () => {
  const project = projectRepo.create({
    name: `messages-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-messages-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'agent-1',
    sender_name: 'Agent',
    content: '完成',
    message_type: 'agent_stream',
  });
  const largeOutput = 'y'.repeat(40_000);
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({
    trace: {
      events: [
        {
          id: 'run-1:1',
          message_id: message.id,
          run_id: 'run-1',
          agent_id: 'agent-1',
          seq: 1,
          type: 'tool_result',
          status: 'completed',
          title: '工具结果 rg search',
          payload: {
            id: 'tool-1',
            name: 'rg search',
            output: {
              command: ['/bin/zsh', '-lc', 'rg -n "settings" packages'],
              output: largeOutput,
            },
          },
          raw: {
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'tool_call_update',
                rawOutput: largeOutput,
              },
            },
          },
          created_at: 123,
        },
      ],
    },
  }), message.id);

  const [listed] = messageRepo.listByRoom(room.id);
  assert.ok(listed);
  assert.ok((listed.metadata ?? '').length < 20_000);

  const metadata = JSON.parse(listed.metadata ?? '{}') as {
    trace?: {
      events?: Array<{
        payload: Record<string, unknown>;
        raw?: Record<string, unknown>;
      }>;
    };
  };
  const event = metadata.trace?.events?.[0];
  assert.ok(event);
  assert.equal(event.raw, undefined);
  assert.equal(event.payload.truncated, true);
  assert.equal(typeof event.payload.original_bytes, 'number');
  assert.match(JSON.stringify(event.payload), /rg -n/);
});

test('messageRepo listForClient keeps timeline-visible trace events as lightweight summaries', () => {
  const project = projectRepo.create({
    name: `messages-client-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-messages-client-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'agent-1',
    sender_name: 'Agent',
    content: '完成',
    message_type: 'agent_stream',
  });
  const events = [
    {
      id: 'run-1:thinking',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'agent-1',
      seq: 1,
      type: 'thinking',
      status: 'delta',
      title: '思考过程',
      payload: { text: 'hidden thinking'.repeat(100) },
      created_at: 1000,
    },
    ...Array.from({ length: 120 }, (_, index) => ({
      id: `run-1:${index + 2}`,
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'agent-1',
      seq: index + 2,
      type: 'tool_result',
      status: 'completed',
      title: `工具结果 ${index + 1}`,
      payload: { text: `event-${index + 1}`, output: 'large output'.repeat(100), path: `file-${index + 1}.ts` },
      raw: { type: 'tool_result', body: 'raw output'.repeat(100) },
      created_at: 1001 + index,
    })),
    {
      id: 'run-1:raw',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'agent-1',
      seq: 122,
      type: 'raw',
      status: 'completed',
      title: '原始事件 usage_update',
      payload: { raw_type: 'usage_update', body: 'debug'.repeat(100) },
      raw: { type: 'usage_update' },
      created_at: 1122,
    },
  ];
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({
    trace: { events },
  }), message.id);

  const [internal] = messageRepo.listByRoom(room.id);
  const internalMetadata = JSON.parse(internal?.metadata ?? '{}') as {
    trace?: { events?: unknown[] };
  };
  assert.equal(internalMetadata.trace?.events?.length, 122);

  const [listed] = messageRepo.listForClientByRoom(room.id);
  assert.ok(listed);
  const metadata = JSON.parse(listed.metadata ?? '{}') as {
    trace?: {
      events?: Array<{ seq: number; type: string; payload: Record<string, unknown>; raw?: Record<string, unknown> }>;
      events_total?: number;
      events_omitted?: number;
    };
  };
  assert.equal(metadata.trace?.events?.length, 120);
  assert.equal(metadata.trace?.events?.[0]?.seq, 2);
  assert.equal(metadata.trace?.events?.[119]?.seq, 121);
  assert.equal(metadata.trace?.events?.some((event) => event.type === 'thinking'), false);
  assert.equal(metadata.trace?.events?.some((event) => event.type === 'raw'), false);
  assert.equal(metadata.trace?.events?.[0]?.payload.detail_omitted, true);
  assert.equal(metadata.trace?.events?.[0]?.payload.detail_event_id, 'run-1:2');
  assert.equal(metadata.trace?.events?.[0]?.payload.path, 'file-1.ts');
  assert.equal(metadata.trace?.events?.[0]?.payload.text, undefined);
  assert.equal(metadata.trace?.events?.[0]?.payload.output, undefined);
  assert.equal(metadata.trace?.events?.[0]?.raw, undefined);
  assert.equal(metadata.trace?.events_total, undefined);
  assert.equal(metadata.trace?.events_omitted, undefined);
});

test('messageRepo listForClient coalesces assistant deltas for the client transcript', () => {
  const project = projectRepo.create({
    name: `messages-client-assistant-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-messages-client-assistant-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: [
      '完整规划正文。',
      '',
      '```json',
      '{"planner_decision":{"awaiting_user_confirmation":true}}',
      '```',
    ].join('\n'),
    message_type: 'agent_stream',
  });
  const events = [
    {
      id: 'run-1:1',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'planner',
      seq: 1,
      type: 'assistant_message',
      status: 'delta',
      title: '助手回复',
      payload: { text: '开头正文。' },
      created_at: 1000,
    },
    {
      id: 'run-1:2',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'planner',
      seq: 2,
      type: 'tool_result',
      status: 'completed',
      title: '工具结果 Read',
      payload: { text: 'read RoomPage.tsx' },
      created_at: 1001,
    },
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `run-1:${index + 3}`,
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'planner',
      seq: index + 3,
      type: 'assistant_message',
      status: 'delta',
      title: '助手回复',
      payload: index === 50
        ? { text: '', content: { type: 'text', text: ' ' } }
        : { text: index === 99 ? 'awaiting_user_confirmation": true\n}\n```' : `token-${index}` },
      created_at: 1002 + index,
    })),
    {
      id: 'run-1:103',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'planner',
      seq: 103,
      type: 'tool_result',
      status: 'completed',
      title: '工具结果 Build',
      payload: { text: 'npm run build' },
      created_at: 1103,
    },
  ];
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({
    trace: { events },
  }), message.id);

  const [listed] = messageRepo.listForClientByRoom(room.id);
  assert.ok(listed);
  const metadata = JSON.parse(listed.metadata ?? '{}') as {
    trace?: {
      events?: Array<{ type: string; seq: number; payload: Record<string, unknown> }>;
      events_total?: number;
      events_omitted?: number;
    };
  };
  assert.deepEqual(metadata.trace?.events?.map((event) => event.type), [
    'assistant_message',
    'tool_result',
    'assistant_message',
    'tool_result',
  ]);
  assert.equal(metadata.trace?.events?.length, 4);
  assert.equal(metadata.trace?.events?.[0]?.seq, 1);
  assert.equal(metadata.trace?.events?.[0]?.payload.text, '开头正文。');
  assert.equal(metadata.trace?.events?.[1]?.seq, 2);
  assert.equal(metadata.trace?.events?.[1]?.payload.detail_omitted, true);
  assert.equal(metadata.trace?.events?.[2]?.seq, 3);
  assert.match(String(metadata.trace?.events?.[2]?.payload.text), /^token-0token-1/);
  assert.match(String(metadata.trace?.events?.[2]?.payload.text), /awaiting_user_confirmation": true\n}\n```$/);
  assert.equal(metadata.trace?.events?.[2]?.payload.content, undefined);
  assert.equal(metadata.trace?.events?.[3]?.payload.text, undefined);
  assert.equal(metadata.trace?.events?.[3]?.payload.detail_omitted, true);
  assert.equal(metadata.trace?.events_total, undefined);
  assert.equal(metadata.trace?.events_omitted, undefined);
});

test('messageRepo listForClient omits heavy tool and command output details', () => {
  const project = projectRepo.create({
    name: `messages-client-detail-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-messages-client-detail-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: '完成',
    message_type: 'agent_stream',
  });
  const events = [
    {
      id: 'run-1:tool-call',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'planner',
      seq: 1,
      type: 'tool_call',
      status: 'started',
      title: '调用工具 Read',
      payload: {
        id: 'call-1',
        name: 'Read',
        title: 'Read',
        kind: 'tool',
        input: { path: 'packages/frontend/src/pages/RoomPage.tsx' },
        content: 'large call content',
      },
      raw: { rawCall: true },
      created_at: 1000,
    },
    {
      id: 'run-1:tool-result',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'planner',
      seq: 2,
      type: 'tool_result',
      status: 'completed',
      title: '工具结果 Read',
      payload: {
        id: 'call-1',
        name: 'Read',
        tool_call_id: 'call-1',
        output: 'file body'.repeat(100),
        text: 'file text'.repeat(100),
        stdout: 'stdout'.repeat(100),
        stderr: 'stderr'.repeat(100),
        path: 'packages/frontend/src/pages/RoomPage.tsx',
      },
      raw: { rawResult: true },
      created_at: 1001,
    },
    {
      id: 'run-1:command-output',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'planner',
      seq: 3,
      type: 'command_output',
      status: 'completed',
      title: '命令输出 npm test',
      payload: {
        command: 'npm test',
        output: 'test output'.repeat(100),
        stdout: 'stdout'.repeat(100),
        stderr: 'stderr'.repeat(100),
      },
      raw: { rawCommand: true },
      created_at: 1002,
    },
    {
      id: 'run-1:file-diff',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'planner',
      seq: 4,
      type: 'file_diff',
      status: 'completed',
      title: '修改文件 RoomPage.tsx',
      payload: {
        path: 'packages/frontend/src/pages/RoomPage.tsx',
        additions: 12,
        deletions: 3,
        patch: 'diff --git'.repeat(100),
        oldText: 'old'.repeat(100),
        newText: 'new'.repeat(100),
      },
      raw: { rawDiff: true },
      created_at: 1003,
    },
    {
      id: 'run-1:assistant',
      message_id: message.id,
      run_id: 'run-1',
      agent_id: 'planner',
      seq: 5,
      type: 'assistant_message',
      status: 'delta',
      title: '助手回复',
      payload: { text: '正文必须保留', content: { type: 'text', text: '重复正文' } },
      raw: { rawAssistant: true },
      created_at: 1004,
    },
  ];
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({
    trace: { events },
  }), message.id);

  const [listed] = messageRepo.listForClientByRoom(room.id);
  assert.ok(listed);
  const metadata = JSON.parse(listed.metadata ?? '{}') as {
    trace?: {
      events?: Array<{
        id: string;
        type: string;
        payload: Record<string, unknown>;
        raw?: Record<string, unknown>;
      }>;
    };
  };
  const listedEvents = metadata.trace?.events ?? [];
  assert.equal(listedEvents.length, 5);

  const lightweightToolCall = listedEvents[0];
  assert.equal(lightweightToolCall?.payload.detail_omitted, true);
  assert.equal(lightweightToolCall?.payload.detail_event_id, 'run-1:tool-call');
  assert.equal(lightweightToolCall?.payload.name, 'Read');
  assert.equal(lightweightToolCall?.payload.input, undefined);
  assert.equal(lightweightToolCall?.payload.content, undefined);
  assert.equal(lightweightToolCall?.raw, undefined);

  const lightweightToolResult = listedEvents[1];
  assert.equal(lightweightToolResult?.payload.detail_omitted, true);
  assert.equal(lightweightToolResult?.payload.detail_event_id, 'run-1:tool-result');
  assert.equal(lightweightToolResult?.payload.tool_call_id, 'call-1');
  assert.equal(lightweightToolResult?.payload.path, 'packages/frontend/src/pages/RoomPage.tsx');
  assert.equal(lightweightToolResult?.payload.output, undefined);
  assert.equal(lightweightToolResult?.payload.text, undefined);
  assert.equal(lightweightToolResult?.payload.stdout, undefined);
  assert.equal(lightweightToolResult?.payload.stderr, undefined);
  assert.equal(lightweightToolResult?.raw, undefined);

  const lightweightCommandOutput = listedEvents[2];
  assert.equal(lightweightCommandOutput?.payload.detail_omitted, true);
  assert.equal(lightweightCommandOutput?.payload.detail_event_id, 'run-1:command-output');
  assert.equal(lightweightCommandOutput?.payload.command, 'npm test');
  assert.equal(lightweightCommandOutput?.payload.output, undefined);
  assert.equal(lightweightCommandOutput?.payload.stdout, undefined);
  assert.equal(lightweightCommandOutput?.payload.stderr, undefined);
  assert.equal(lightweightCommandOutput?.raw, undefined);

  const lightweightFileDiff = listedEvents[3];
  assert.equal(lightweightFileDiff?.payload.detail_omitted, true);
  assert.equal(lightweightFileDiff?.payload.detail_event_id, 'run-1:file-diff');
  assert.equal(lightweightFileDiff?.payload.path, 'packages/frontend/src/pages/RoomPage.tsx');
  assert.equal(lightweightFileDiff?.payload.additions, 12);
  assert.equal(lightweightFileDiff?.payload.deletions, 3);
  assert.equal(lightweightFileDiff?.payload.patch, undefined);
  assert.equal(lightweightFileDiff?.payload.diff, undefined);
  assert.equal(lightweightFileDiff?.payload.oldText, undefined);
  assert.equal(lightweightFileDiff?.payload.newText, undefined);
  assert.equal(lightweightFileDiff?.raw, undefined);

  const assistant = listedEvents[4];
  assert.equal(assistant?.payload.text, '正文必须保留');
  assert.equal(assistant?.payload.content, undefined);
  assert.equal(assistant?.raw, undefined);

  const fullEvent = messageRepo.getTraceEventForClient(room.id, message.id, 'run-1:tool-result');
  assert.ok(fullEvent);
  assert.equal(fullEvent.payload.output, 'file body'.repeat(100));
  assert.equal(fullEvent.raw, undefined);
  assert.equal(messageRepo.getTraceEventForClient('wrong-room', message.id, 'run-1:tool-result'), undefined);
  assert.equal(messageRepo.getTraceEventForClient(room.id, message.id, 'missing'), undefined);
});
