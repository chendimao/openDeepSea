import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-run-links-')), 'test.db');

const { agentRunLinkRepo } = await import('./agent-run-links.js');
const { agentRunRepo } = await import('./agent-runs.js');
const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');
const { taskRepo } = await import('./tasks.js');

test('agentRunLinkRepo creates and lists child run links', () => {
  const { room, task, parent, child } = setupRunLinkFixture('agent-run-link-repo-create');
  const link = agentRunLinkRepo.create({
    room_id: room.id,
    task_id: task.id,
    parent_run_id: parent.id,
    child_run_id: child.id,
    relationship: 'subagent',
    role: 'implementer',
  });

  assert.equal(link.room_id, room.id);
  assert.equal(link.task_id, task.id);
  assert.equal(link.parent_run_id, parent.id);
  assert.equal(link.child_run_id, child.id);
  assert.equal(link.relationship, 'subagent');
  assert.equal(link.role, 'implementer');

  assert.deepEqual(agentRunLinkRepo.listByParentRun(parent.id).map((item) => item.id), [link.id]);
  assert.deepEqual(agentRunLinkRepo.listByTask(task.id).map((item) => item.id), [link.id]);
});

test('agentRunLinkRepo rejects links to missing child runs', () => {
  const { room, task, parent } = setupRunLinkFixture('agent-run-link-repo-missing-child');

  assert.throws(
    () => agentRunLinkRepo.create({
      room_id: room.id,
      task_id: task.id,
      parent_run_id: parent.id,
      child_run_id: 'missing-child-run',
      relationship: 'subagent',
      role: 'implementer',
    }),
    /child run not found/u,
  );
});

function setupRunLinkFixture(name: string) {
  const project = projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `${name}-`)),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Linked task' });
  const parentAgent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'frontend-executor',
    agent_name: 'Frontend Executor',
  });
  const childAgent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'reviewer',
    agent_name: 'Reviewer',
  });
  const parent = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: parentAgent.id,
    agent_id: parentAgent.agent_id,
    backend: 'codex',
    prompt: 'parent',
    task_id: task.id,
  });
  const child = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: childAgent.id,
    agent_id: childAgent.agent_id,
    backend: 'codex',
    prompt: 'child',
    task_id: task.id,
  });
  return { project, room, task, parent, child };
}
