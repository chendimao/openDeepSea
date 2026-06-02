import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-brainstorming-routes-')), 'test.db');

const express = (await import('express')).default;
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { messageRepo } = await import('./repos/messages.js');
const { taskRepo } = await import('./repos/tasks.js');
const { workflowRepo } = await import('./repos/workflows.js');
const { router, setMessageRouteDeps } = await import('./routes.js');

let dispatchCount = 0;
setMessageRouteDeps({
  dispatchUserMessage: async () => {
    dispatchCount += 1;
  },
});

const app = express();
app.use(express.json());
app.use('/api', router);

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('POST /rooms/:roomId/messages stores generic option selection as normal chat metadata', async () => {
  const project = projectRepo.create({
    name: 'Brainstorming Selection Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-brainstorming-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: '推荐方案：统一资源和工作区入口',
    message_type: 'agent_stream',
    metadata: {
      brainstorming_options: [
        {
          id: 'unified-workspace-reference',
          title: '推荐方案',
          summary: '统一资源和工作区入口',
          benefits: [],
          risks: [],
          maturity: 'boundary_needed',
          recommended: true,
        },
      ],
    },
  });

  dispatchCount = 0;
  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: '我选择：推荐方案「统一资源和工作区入口」',
      choice_option_selection: {
        selected_option_id: 'unified-workspace-reference',
        selected_option_title: '推荐方案',
        selected_option_maturity: 'boundary_needed',
        source_message_id: sourceMessage.id,
        source_type: 'message_option',
      },
    }),
  });

  assert.equal(res.status, 201);
  const message = await res.json() as { metadata: string | null; message_type: string; sender_type: string };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    choice_option_selection?: {
      selected_option_id: string;
      source_message_id: string;
      source_type: string;
    };
  };
  assert.equal(message.sender_type, 'user');
  assert.equal(message.message_type, 'text');
  assert.equal(metadata.choice_option_selection?.selected_option_id, 'unified-workspace-reference');
  assert.equal(metadata.choice_option_selection?.source_message_id, sourceMessage.id);
  assert.equal(metadata.choice_option_selection?.source_type, 'message_option');
  assert.equal(taskRepo.listByRoom(room.id).length, 0);
  assert.equal(workflowRepo.listByRoom(room.id).length, 0);
  assert.equal(dispatchCount, 1);
});

test('POST /rooms/:roomId/messages rejects generic selection source from another room', async () => {
  const project = projectRepo.create({
    name: 'Brainstorming Selection Cross Room',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-brainstorming-cross-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const otherRoom = roomRepo.create({ project_id: project.id, name: 'Other Room' });
  const sourceMessage = messageRepo.create({
    room_id: otherRoom.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: '推荐方案：跨房间',
    message_type: 'agent_stream',
  });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: '我选择：推荐方案「跨房间」',
      choice_option_selection: {
        selected_option_id: 'cross-room',
        selected_option_title: '推荐方案',
        selected_option_maturity: 'boundary_needed',
        source_message_id: sourceMessage.id,
        source_type: 'message_option',
      },
    }),
  });

  assert.equal(res.status, 400);
});
