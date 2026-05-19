import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-state-'));
process.env.OPENCLAW_ROOM_DB = join(tempDir, 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { emptyAgentWorkflowState, parseGraphState, serializeGraphState } = await import('./state.js');

test('workflowRepo persists graph version and graph state', () => {
  const projectPath = join(tempDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Graph task' });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    current_stage: 'planning',
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState(
      emptyAgentWorkflowState({
        workflowRunId: 'pending',
        projectId: project.id,
        roomId: room.id,
        taskId: task.id,
        userGoal: task.title,
        projectPath: project.path,
      }),
    ),
  });

  assert.equal(run.graph_version, 'phase-b-v1');
  assert.match(run.graph_state ?? '', /"userGoal":"Graph task"/);
});

test('workflowRepo persists workflow step node and scope metadata', () => {
  const projectPath = join(tempDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph 2', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Room 2' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Graph step task' });
  const run = workflowRepo.createRun({ room_id: room.id, project_id: project.id, task_id: task.id });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: 'execute',
    scope_read: ['packages/backend/src/workflows/graph/runtime.ts'],
    scope_write: ['packages/backend/src/workflows/graph/runtime.ts'],
    sort_order: 1,
  });

  assert.equal(step.node_name, 'execute');
  assert.deepEqual(step.scope_read, ['packages/backend/src/workflows/graph/runtime.ts']);
  assert.deepEqual(step.scope_write, ['packages/backend/src/workflows/graph/runtime.ts']);
});

test('parseGraphState defaults missing workflowPlan to null for existing runs', () => {
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-legacy',
    projectId: 'project-legacy',
    roomId: 'room-legacy',
    taskId: 'task-legacy',
    userGoal: 'Legacy state',
    projectPath: tempDir,
  });
  const legacyJson = JSON.stringify(Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== 'workflowPlan'),
  ));

  const parsed = parseGraphState(legacyJson);

  assert.equal(parsed?.workflowPlan, null);
});
