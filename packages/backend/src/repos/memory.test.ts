import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-memory-')), 'test.db');

const projectDir = join(tmpdir(), `openclaw-room-memory-project-${Date.now()}`);
mkdirSync(projectDir, { recursive: true });

const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');
const { taskRepo } = await import('./tasks.js');
const { memoryRepo } = await import('./memory.js');

test('memoryRepo stores and filters project, room, agent, and task memories for prompt context', () => {
  const project = projectRepo.create({ name: 'Memory Test', path: projectDir });
  const room = roomRepo.create({ project_id: project.id, name: 'Feature Room' });
  const otherRoom = roomRepo.create({ project_id: project.id, name: 'Other Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'architect', agent_name: 'Architect' });
  const otherAgent = roomAgentRepo.add({ room_id: room.id, agent_id: 'builder', agent_name: 'Builder' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Memory task' });
  const otherTask = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Other memory task' });

  const projectMemory = memoryRepo.create({
    project_id: project.id,
    scope: 'project',
    memory_type: 'decision',
    title: 'Use explicit memory',
    content: 'Project memories must be injected before agent prompts.',
    pinned: true,
  });
  const roomMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    scope: 'room',
    memory_type: 'fact',
    title: 'Room purpose',
    content: 'This room coordinates memory feature work.',
  });
  const agentMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    room_agent_id: agent.id,
    scope: 'agent',
    memory_type: 'preference',
    title: 'Architect preference',
    content: 'Architect prefers short implementation plans.',
  });
  const taskMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    task_id: task.id,
    scope: 'task',
    memory_type: 'task_summary',
    title: 'Task summary',
    content: 'The task created the memory repository.',
  });
  memoryRepo.create({
    project_id: project.id,
    room_id: otherRoom.id,
    scope: 'room',
    memory_type: 'fact',
    title: 'Other room',
    content: 'This should not be injected into the feature room.',
  });
  memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    room_agent_id: otherAgent.id,
    scope: 'agent',
    memory_type: 'preference',
    title: 'Builder preference',
    content: 'This should not be injected into the architect context.',
  });
  memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    task_id: otherTask.id,
    scope: 'task',
    memory_type: 'task_summary',
    title: 'Other task summary',
    content: 'This should not be injected into the current task context.',
  });

  const entries = memoryRepo.listForRoomContext({
    projectId: project.id,
    roomId: room.id,
    roomAgentId: agent.id,
    taskId: task.id,
  });

  assert.deepEqual(entries.map((entry) => entry.id), [
    projectMemory.id,
    taskMemory.id,
    agentMemory.id,
    roomMemory.id,
  ]);
});

test('memoryRepo upserts one automatic task summary per task and source', () => {
  const project = projectRepo.list()[0];
  const room = roomRepo.listByProject(project.id)[0];
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Auto summary task' });

  const first = memoryRepo.upsertTaskSummary({
    project_id: project.id,
    room_id: room.id,
    task_id: task.id,
    title: 'Auto summary task',
    content: 'First accepted summary.',
    source_id: 'workflow-1',
  });
  const second = memoryRepo.upsertTaskSummary({
    project_id: project.id,
    room_id: room.id,
    task_id: task.id,
    title: 'Auto summary task',
    content: 'Updated accepted summary.',
    source_id: 'workflow-1',
  });

  assert.equal(first.id, second.id);
  assert.equal(second.content, 'Updated accepted summary.');
  assert.equal(second.source_type, 'workflow');
  assert.equal(second.memory_type, 'task_summary');
});
