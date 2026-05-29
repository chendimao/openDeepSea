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

test('messageRepo listForClient keeps every timeline-visible trace event', () => {
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
  const events = Array.from({ length: 120 }, (_, index) => ({
    id: `run-1:${index + 1}`,
    message_id: message.id,
    run_id: 'run-1',
    agent_id: 'agent-1',
    seq: index + 1,
    type: 'tool_result',
    status: 'completed',
    title: `工具结果 ${index + 1}`,
    payload: { text: `event-${index + 1}` },
    created_at: 1000 + index,
  }));
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({
    trace: { events },
  }), message.id);

  const [internal] = messageRepo.listByRoom(room.id);
  const internalMetadata = JSON.parse(internal?.metadata ?? '{}') as {
    trace?: { events?: unknown[] };
  };
  assert.equal(internalMetadata.trace?.events?.length, 120);

  const [listed] = messageRepo.listForClientByRoom(room.id);
  assert.ok(listed);
  const metadata = JSON.parse(listed.metadata ?? '{}') as {
    trace?: {
      events?: Array<{ seq: number }>;
      events_total?: number;
      events_omitted?: number;
    };
  };
  assert.equal(metadata.trace?.events?.length, 120);
  assert.equal(metadata.trace?.events?.[0]?.seq, 1);
  assert.equal(metadata.trace?.events?.[119]?.seq, 120);
  assert.equal(metadata.trace?.events_total, undefined);
  assert.equal(metadata.trace?.events_omitted, undefined);
});

test('messageRepo listForClient keeps assistant deltas unchanged for the client', () => {
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
      events?: Array<{ type: string; seq: number; payload: { text?: string } }>;
      events_total?: number;
      events_omitted?: number;
    };
  };
  assert.deepEqual(metadata.trace?.events?.map((event) => event.type), events.map((event) => event.type));
  assert.equal(metadata.trace?.events?.length, 103);
  assert.equal(metadata.trace?.events?.[0]?.seq, 1);
  assert.equal(metadata.trace?.events?.[2]?.seq, 3);
  assert.equal(metadata.trace?.events?.[52]?.payload.text, '');
  assert.equal(metadata.trace?.events?.[52]?.seq, 53);
  assert.match(metadata.trace?.events?.[102]?.payload.text ?? '', /npm run build/);
  assert.equal(metadata.trace?.events_total, undefined);
  assert.equal(metadata.trace?.events_omitted, undefined);
});
