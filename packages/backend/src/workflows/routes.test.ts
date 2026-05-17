import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-routes-')), 'test.db');
process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';

const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowContextRepo } = await import('../repos/workflow-context.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { setWorkflowConversationDeps } = await import('./conversation.js');
const { emptyAgentWorkflowState, serializeGraphState } = await import('./graph/state.js');
const { router } = await import('../routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

test.afterEach(() => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  setWorkflowConversationDeps({});
});

test('legacy workflow start route uses conversation short request path when graph is enabled', async () => {
  const { task } = createTask('Legacy Start Short Request');
  const enqueued: string[] = [];
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  const res = await request(`/api/tasks/${task.id}/workflows`, { method: 'POST' });

  assert.equal(res.status, 202);
  const workflow = await res.json() as { id: string; graph_version: string };
  assert.equal(workflow.graph_version, 'phase-b-v1');
  assert.equal(workflowRepo.listSteps(workflow.id).length, 0);
  assert.deepEqual(enqueued, [workflow.id]);
});

test('legacy workflow approval route uses conversation short request path when graph is enabled', async () => {
  const { project, room, task } = createTask('Legacy Approve Short Request');
  const state = emptyAgentWorkflowState({
    workflowRunId: 'pending',
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'awaiting_approval',
    current_stage: 'planning',
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState({
      ...state,
      workflowRunId: 'pending',
      currentNode: 'approval',
      status: 'awaiting_approval',
      approval: 'pending',
    }),
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...state,
    workflowRunId: run.id,
    currentNode: 'approval',
    status: 'awaiting_approval',
    approval: 'pending',
  }));
  const enqueued: string[] = [];
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  const res = await request(`/api/workflows/${run.id}/approve-plan`, { method: 'POST' });

  assert.equal(res.status, 202);
  const workflow = await res.json() as { id: string; status: string; approved_by: string };
  assert.equal(workflow.id, run.id);
  assert.equal(workflow.status, 'running');
  assert.equal(workflow.approved_by, 'user');
  assert.equal(workflowRepo.listSteps(run.id).length, 0);
  assert.deepEqual(enqueued, [run.id]);
});

test('workflow context route returns entries and aggregate stats', async () => {
  const { project, room, task } = createTask('Context Route');
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    graph_version: 'phase-b-v1',
  });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'completed',
    prompt: 'prompt',
    sort_order: 1,
  });
  const first = workflowContextRepo.create({
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    task_id: task.id,
    source_type: 'workflow_step',
    source_id: `${step.id}:summary`,
    entry_type: 'summary',
    title: '摘要',
    content: '完成了上下文路由。',
    token_estimate: 12,
  });
  const second = workflowContextRepo.create({
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    task_id: task.id,
    source_type: 'workflow_step',
    source_id: `${step.id}:handoff`,
    entry_type: 'handoff',
    title: '交接',
    content: '后续审查读取上下文条目。',
    token_estimate: 16,
  });

  const res = await request(`/api/workflows/${run.id}/context`);

  assert.equal(res.status, 200);
  const body = await res.json() as {
    entries: Array<{ id: string; title: string; summary_char_count: number }>;
    total_token_estimate: number;
    total_summary_chars: number;
  };
  assert.deepEqual(body.entries.map((entry) => entry.id), [first.id, second.id]);
  assert.equal(body.total_token_estimate, 28);
  assert.equal(body.total_summary_chars, first.summary_char_count + second.summary_char_count);
});

test('workflow context route returns 404 for missing workflow', async () => {
  const res = await request('/api/workflows/missing-workflow/context');

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
});

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

function createTask(name: string) {
  const projectPath = join(tmpdir(), `workflow-routes-${name.replace(/\W+/g, '-')}-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: `${name} Room` });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: name,
  });
  return { project, room, task };
}
