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
const { db, now } = await import('../db.js');

function createMemoryFixture(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `openclaw-room-memory-${name}-`));
  const project = projectRepo.create({ name, path: dir });
  const room = roomRepo.create({ project_id: project.id, name: `${name} Room` });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: `${name}-agent`, agent_name: `${name} Agent` });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: `${name} task` });

  return { project, room, agent, task };
}

let directSqlMemoryCounter = 0;

function insertMemoryDirect(input: {
  project_id: string;
  room_id?: string | null;
  room_agent_id?: string | null;
  task_id?: string | null;
  scope: 'project' | 'room' | 'agent' | 'task';
}) {
  const ts = now();
  directSqlMemoryCounter += 1;
  const id = `direct-sql-memory-${directSqlMemoryCounter}`;
  db.prepare(
    `INSERT INTO memory_entries (
      id, project_id, room_id, room_agent_id, task_id, scope, memory_type, title,
      content, source_type, source_id, pinned, created_at, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, 'fact', 'Direct SQL memory', 'Inserted outside the repository.', 'manual', NULL, 0, ?, ?)`,
  ).run(
    id,
    input.project_id,
    input.room_id ?? null,
    input.room_agent_id ?? null,
    input.task_id ?? null,
    input.scope,
    ts,
    ts,
  );
  return id;
}

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

test('memoryRepo lists, gets, updates, and deletes memories', () => {
  const { project, room, agent, task } = createMemoryFixture('CRUD Memory');
  const other = createMemoryFixture('Other CRUD Memory');

  const projectMemory = memoryRepo.create({
    project_id: project.id,
    scope: 'project',
    memory_type: 'decision',
    title: 'Project CRUD memory',
    content: 'Project scoped CRUD memory.',
  });
  const roomMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    scope: 'room',
    memory_type: 'fact',
    title: 'Room CRUD memory',
    content: 'Room scoped CRUD memory.',
  });
  const agentMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    room_agent_id: agent.id,
    scope: 'agent',
    memory_type: 'preference',
    title: 'Agent CRUD memory',
    content: 'Agent scoped CRUD memory.',
  });
  const taskMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    task_id: task.id,
    scope: 'task',
    memory_type: 'task_summary',
    title: 'Task CRUD memory',
    content: 'Task scoped CRUD memory.',
  });
  memoryRepo.create({
    project_id: other.project.id,
    room_id: other.room.id,
    scope: 'room',
    memory_type: 'fact',
    title: 'Other project CRUD memory',
    content: 'This should not appear in this project list.',
  });

  const listed = memoryRepo.list({
    projectId: project.id,
    roomId: room.id,
    roomAgentId: agent.id,
    taskId: task.id,
  });
  assert.deepEqual(
    listed.map((entry) => entry.id).sort(),
    [projectMemory.id, roomMemory.id, agentMemory.id, taskMemory.id].sort(),
  );

  const fetched = memoryRepo.get(roomMemory.id);
  assert.equal(fetched?.title, 'Room CRUD memory');

  const updated = memoryRepo.update(roomMemory.id, {
    memory_type: 'lesson',
    title: 'Updated room CRUD memory',
    content: 'Updated room scoped CRUD memory.',
    pinned: true,
  });
  assert.equal(updated?.memory_type, 'lesson');
  assert.equal(updated?.title, 'Updated room CRUD memory');
  assert.equal(updated?.content, 'Updated room scoped CRUD memory.');
  assert.equal(updated?.pinned, 1);

  assert.equal(memoryRepo.delete(roomMemory.id), true);
  assert.equal(memoryRepo.get(roomMemory.id), undefined);
  assert.equal(memoryRepo.delete(roomMemory.id), false);
});

test('memoryRepo searches project memories with room source labels and filters', () => {
  const { project, room } = createMemoryFixture('Search Memory');
  const otherRoom = roomRepo.create({ project_id: project.id, name: 'Search Other Room' });
  const otherProject = createMemoryFixture('Search Other Project');

  const projectMemory = memoryRepo.create({
    project_id: project.id,
    scope: 'project',
    memory_type: 'decision',
    title: 'SQLite search strategy',
    content: 'Use LIKE for the first cross-room memory search implementation.',
    pinned: true,
  });
  const roomMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    scope: 'room',
    memory_type: 'lesson',
    title: 'Room search lesson',
    content: 'Cross-room search results should include the source room name.',
  });
  const otherRoomMemory = memoryRepo.create({
    project_id: project.id,
    room_id: otherRoom.id,
    scope: 'room',
    memory_type: 'fact',
    title: 'Other room search fact',
    content: 'Filtering by room_id keeps this result separate.',
  });
  memoryRepo.create({
    project_id: otherProject.project.id,
    room_id: otherProject.room.id,
    scope: 'room',
    memory_type: 'fact',
    title: 'Foreign search fact',
    content: 'This belongs to a different project.',
  });

  const allResults = memoryRepo.search({ projectId: project.id, query: 'search' });
  assert.deepEqual(
    allResults.map((entry) => entry.id),
    [projectMemory.id, otherRoomMemory.id, roomMemory.id],
  );
  assert.equal(allResults.find((entry) => entry.id === roomMemory.id)?.room_name, room.name);
  assert.equal(allResults.find((entry) => entry.id === projectMemory.id)?.room_name, null);

  const projectOnly = memoryRepo.search({ projectId: project.id, scope: 'project' });
  assert.deepEqual(projectOnly.map((entry) => entry.id), [projectMemory.id]);

  const roomOnly = memoryRepo.search({ projectId: project.id, roomId: room.id });
  assert.deepEqual(roomOnly.map((entry) => entry.id), [roomMemory.id]);

  assert.throws(
    () => memoryRepo.search({ projectId: project.id, roomId: otherProject.room.id }),
    /room_id does not belong to project_id/,
  );
});

test('memoryRepo rejects cross-project room, agent, and task ownership', () => {
  const first = createMemoryFixture('Ownership Memory A');
  const second = createMemoryFixture('Ownership Memory B');

  assert.throws(
    () =>
      memoryRepo.create({
        project_id: first.project.id,
        room_id: second.room.id,
        scope: 'room',
        memory_type: 'fact',
        title: 'Invalid room',
        content: 'The room belongs to another project.',
      }),
    /room_id does not belong to project_id/,
  );

  assert.throws(
    () =>
      memoryRepo.create({
        project_id: first.project.id,
        room_id: first.room.id,
        room_agent_id: second.agent.id,
        scope: 'agent',
        memory_type: 'preference',
        title: 'Invalid agent',
        content: 'The agent belongs to another project.',
      }),
    /room_agent_id does not belong to project_id/,
  );

  assert.throws(
    () =>
      memoryRepo.create({
        project_id: first.project.id,
        room_id: first.room.id,
        task_id: second.task.id,
        scope: 'task',
        memory_type: 'task_summary',
        title: 'Invalid task',
        content: 'The task belongs to another project.',
      }),
    /task_id does not belong to project_id/,
  );

  assert.throws(
    () =>
      memoryRepo.upsertTaskSummary({
        project_id: first.project.id,
        room_id: first.room.id,
        task_id: second.task.id,
        title: 'Invalid summary',
        content: 'The task summary belongs to another project.',
        source_id: 'workflow-cross-project',
      }),
    /task_id does not belong to project_id/,
  );
});

test('memoryRepo rejects invalid scope foreign key combinations', () => {
  const first = createMemoryFixture('Scope Boundary Memory A');
  const secondRoom = roomRepo.create({ project_id: first.project.id, name: 'Scope Boundary Other Room' });
  const secondTask = taskRepo.create({
    project_id: first.project.id,
    room_id: secondRoom.id,
    title: 'Scope Boundary other task',
  });

  assert.throws(
    () =>
      memoryRepo.create({
        project_id: first.project.id,
        room_id: first.room.id,
        scope: 'project',
        memory_type: 'decision',
        title: 'Invalid project scope',
        content: 'Project scope must not carry room references.',
      }),
    /project scope cannot include room_id, room_agent_id, or task_id/,
  );

  assert.throws(
    () =>
      memoryRepo.create({
        project_id: first.project.id,
        room_id: first.room.id,
        task_id: first.task.id,
        scope: 'room',
        memory_type: 'fact',
        title: 'Invalid room scope',
        content: 'Room scope must not carry task references.',
      }),
    /room scope cannot include room_agent_id or task_id/,
  );

  assert.throws(
    () =>
      memoryRepo.create({
        project_id: first.project.id,
        room_id: secondRoom.id,
        room_agent_id: first.agent.id,
        scope: 'agent',
        memory_type: 'preference',
        title: 'Invalid agent room',
        content: 'Agent scope room must match the agent room.',
      }),
    /room_agent_id does not belong to room_id/,
  );

  assert.throws(
    () =>
      memoryRepo.create({
        project_id: first.project.id,
        room_id: first.room.id,
        task_id: secondTask.id,
        scope: 'task',
        memory_type: 'task_summary',
        title: 'Invalid task room',
        content: 'Task scope room must match the task room.',
      }),
    /task_id does not belong to room_id/,
  );
});

test('memoryRepo recalls valid agent and task scope memories for room context', () => {
  const { project, room, agent, task } = createMemoryFixture('Valid Scope Recall Memory');

  const agentMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    room_agent_id: agent.id,
    scope: 'agent',
    memory_type: 'preference',
    title: 'Valid agent memory',
    content: 'Agent scope includes its room and agent.',
  });
  const taskMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    task_id: task.id,
    scope: 'task',
    memory_type: 'task_summary',
    title: 'Valid task memory',
    content: 'Task scope includes its room and task.',
  });

  const entries = memoryRepo.listForRoomContext({
    projectId: project.id,
    roomId: room.id,
    roomAgentId: agent.id,
    taskId: task.id,
  });

  assert.deepEqual(
    entries.map((entry) => entry.id).sort(),
    [agentMemory.id, taskMemory.id].sort(),
  );
});

test('memory_entries triggers reject direct SQL ownership mismatches', () => {
  const first = createMemoryFixture('Direct SQL Boundary A');
  const second = createMemoryFixture('Direct SQL Boundary B');
  const otherRoom = roomRepo.create({ project_id: first.project.id, name: 'Direct SQL Other Room' });
  const otherTask = taskRepo.create({
    project_id: first.project.id,
    room_id: otherRoom.id,
    title: 'Direct SQL other task',
  });

  assert.throws(
    () =>
      insertMemoryDirect({
        project_id: first.project.id,
        room_id: second.room.id,
        scope: 'room',
      }),
    /memory room_id does not belong to project_id/,
  );

  assert.throws(
    () =>
      insertMemoryDirect({
        project_id: first.project.id,
        room_id: first.room.id,
        room_agent_id: second.agent.id,
        scope: 'agent',
      }),
    /memory room_agent_id does not belong to project_id/,
  );

  assert.throws(
    () =>
      insertMemoryDirect({
        project_id: first.project.id,
        room_id: otherRoom.id,
        room_agent_id: first.agent.id,
        scope: 'agent',
      }),
    /memory room_agent_id does not belong to room_id/,
  );

  assert.throws(
    () =>
      insertMemoryDirect({
        project_id: first.project.id,
        room_id: first.room.id,
        task_id: second.task.id,
        scope: 'task',
      }),
    /memory task_id does not belong to project_id/,
  );

  assert.throws(
    () =>
      insertMemoryDirect({
        project_id: first.project.id,
        room_id: first.room.id,
        task_id: otherTask.id,
        scope: 'task',
      }),
    /memory task_id does not belong to room_id/,
  );

  const directRoomMemoryId = insertMemoryDirect({
    project_id: first.project.id,
    room_id: first.room.id,
    scope: 'room',
  });

  assert.throws(
    () =>
      db
        .prepare('UPDATE memory_entries SET project_id = ?, updated_at = ? WHERE id = ?')
        .run(second.project.id, now(), directRoomMemoryId),
    /memory room_id does not belong to project_id/,
  );
});

test('memoryRepo list requires project ownership for room, agent, and task filters', () => {
  const first = createMemoryFixture('List Boundary Memory A');
  const second = createMemoryFixture('List Boundary Memory B');

  const firstProjectMemory = memoryRepo.create({
    project_id: first.project.id,
    scope: 'project',
    memory_type: 'decision',
    title: 'First project memory',
    content: 'This must stay inside the first project.',
  });
  memoryRepo.create({
    project_id: second.project.id,
    scope: 'project',
    memory_type: 'decision',
    title: 'Second project memory',
    content: 'This must stay inside the second project.',
  });

  assert.deepEqual(memoryRepo.list({ projectId: first.project.id }).map((entry) => entry.id), [firstProjectMemory.id]);
  assert.throws(
    () => memoryRepo.list({ projectId: first.project.id, roomId: second.room.id }),
    /room_id does not belong to project_id/,
  );
  assert.throws(
    () => memoryRepo.list({ projectId: first.project.id, roomAgentId: second.agent.id }),
    /room_agent_id does not belong to project_id/,
  );
  assert.throws(
    () => memoryRepo.list({ projectId: first.project.id, taskId: second.task.id }),
    /task_id does not belong to project_id/,
  );
});

test('memoryRepo does not widen agent or task memories after owner deletion', () => {
  const { project, room, agent, task } = createMemoryFixture('Cascade Boundary Memory');
  const roomMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    scope: 'room',
    memory_type: 'fact',
    title: 'Room memory remains',
    content: 'Room scoped memory should remain visible.',
  });
  const agentMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    room_agent_id: agent.id,
    scope: 'agent',
    memory_type: 'preference',
    title: 'Agent memory cascades',
    content: 'Agent scoped memory should be deleted with the agent.',
  });
  const taskMemory = memoryRepo.create({
    project_id: project.id,
    room_id: room.id,
    task_id: task.id,
    scope: 'task',
    memory_type: 'task_summary',
    title: 'Task memory cascades',
    content: 'Task scoped memory should be deleted with the task.',
  });

  assert.equal(roomAgentRepo.remove(agent.id), true);
  assert.equal(taskRepo.delete(task.id), true);

  assert.equal(memoryRepo.get(agentMemory.id), undefined);
  assert.equal(memoryRepo.get(taskMemory.id), undefined);
  assert.deepEqual(memoryRepo.list({ projectId: project.id, roomId: room.id }).map((entry) => entry.id), [
    roomMemory.id,
  ]);
});

test('memoryRepo upserts one automatic task summary per task and source', () => {
  const { project, room, task } = createMemoryFixture('Auto Summary Memory');

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
