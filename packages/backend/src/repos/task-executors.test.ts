import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-executors-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');
const { taskRepo } = await import('./tasks.js');
const { taskExecutorRepo } = await import('./task-executors.js');

test('taskExecutorRepo keeps ACP sessions isolated per task and agent', () => {
  const project = projectRepo.create({
    name: 'Task Executors',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-executors-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'codex', agent_name: 'Codex' });
  const firstTask = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'First task' });
  const secondTask = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Second task' });

  const first = taskExecutorRepo.ensure({
    task_id: firstTask.id,
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    acp_session_id: 'session-first',
  });
  const second = taskExecutorRepo.ensure({
    task_id: secondTask.id,
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    acp_session_id: 'session-second',
  });

  assert.notEqual(first.id, second.id);
  assert.equal(taskExecutorRepo.getByTaskAndAgent(firstTask.id, agent.id)?.acp_session_id, 'session-first');
  assert.equal(taskExecutorRepo.getByTaskAndAgent(secondTask.id, agent.id)?.acp_session_id, 'session-second');

  const updated = taskExecutorRepo.updateSession(first.id, 'session-first-next');
  assert.equal(updated?.status, 'idle');
  assert.equal(taskExecutorRepo.getByTaskAndAgent(firstTask.id, agent.id)?.acp_session_id, 'session-first-next');
  assert.equal(taskExecutorRepo.getByTaskAndAgent(secondTask.id, agent.id)?.acp_session_id, 'session-second');
});
