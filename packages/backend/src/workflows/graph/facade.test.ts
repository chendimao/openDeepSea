import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-facade-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { parseGraphState, serializeGraphState } = await import('./state.js');
const { setWorkflowOrchestratorGraphDeps, workflowOrchestrator } = await import('../orchestrator.js');

test.afterEach(() => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '';
  setWorkflowOrchestratorGraphDeps({});
});

test('workflowOrchestrator.start delegates to graph runtime when enabled', async () => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  setWorkflowOrchestratorGraphDeps({
    planner: async () => ({
      goal: 'Facade graph workflow',
      summary: 'Graph runtime handles orchestrator start.',
      assumptions: [],
      tasks: [{
        title: 'Implement graph facade',
        description: 'Delegate workflow start through the graph runtime',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Graph run is created'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: true,
    }),
  });
  const task = createTask('graph-facade-enabled', 'Facade graph workflow');

  const run = await workflowOrchestrator.start(task.id);

  assert.equal(run.graph_version, 'phase-b-v1');
  assert.equal(run.status, 'awaiting_approval');
  assert.ok(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'planning'));
});

test('workflowOrchestrator.start uses legacy runtime when graph disabled', async () => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '';
  const task = createTask('graph-facade-disabled', 'Facade legacy workflow');

  const run = await workflowOrchestrator.start(task.id);

  assert.equal(run.graph_version, null);
  assert.equal(run.current_stage, 'analysis');
  assert.equal(run.status, 'blocked');
  assert.equal(workflowRepo.listSteps(run.id).some((step) => step.node_name), false);
});

test('workflowOrchestrator.recoverOrphanedSteps recovers graph steps before legacy steps', () => {
  const task = createTask('graph-facade-recovery', 'Facade recovery workflow');
  const graphRun = workflowRepo.createRun({
    room_id: task.room_id,
    project_id: task.project_id,
    task_id: task.id,
    status: 'running',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
    graph_state: JSON.stringify({
      workflowRunId: 'pending',
      projectId: task.project_id,
      roomId: task.room_id,
      taskId: task.id,
      userGoal: task.title,
      projectPath: 'unused',
      plan: null,
      currentNode: 'execute',
      currentStepId: null,
      activeAgentRunId: null,
      childTaskIds: [],
      reviewFindings: [],
      reviewVerdict: null,
      verificationResults: [],
      repairAttempts: 0,
      approval: 'not_required',
      status: 'running',
      error: null,
    }),
  });
  const graphState = parseGraphState(graphRun.graph_state);
  if (!graphState) throw new Error('missing graph state');
  workflowRepo.updateGraphState(graphRun.id, JSON.stringify({ ...graphState, workflowRunId: graphRun.id }));
  const graphStep = workflowRepo.createStep({
    workflow_run_id: graphRun.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    prompt: 'graph running step',
    sort_order: 1,
  });
  const graphLegacyShapedStep = workflowRepo.createStep({
    workflow_run_id: graphRun.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: null,
    status: 'running',
    prompt: 'graph run step without node name',
    sort_order: 2,
  });
  const legacyRun = workflowRepo.createRun({
    room_id: task.room_id,
    project_id: task.project_id,
    task_id: task.id,
    status: 'running',
    current_stage: 'implementation',
  });
  const legacyStep = workflowRepo.createStep({
    workflow_run_id: legacyRun.id,
    task_id: task.id,
    stage: 'implementation',
    status: 'running',
    prompt: 'legacy running step',
    sort_order: 1,
  });

  const count = workflowOrchestrator.recoverOrphanedSteps('Backend restarted during facade recovery');

  assert.equal(count, 2);
  assert.equal(workflowRepo.getStep(graphStep.id)?.status, 'interrupted');
  assert.equal(workflowRepo.getRun(graphRun.id)?.status, 'blocked');
  assert.equal(workflowRepo.getStep(graphLegacyShapedStep.id)?.status, 'running');
  assert.equal(workflowRepo.getStep(legacyStep.id)?.status, 'interrupted');
  assert.equal(workflowRepo.getRun(legacyRun.id)?.status, 'blocked');
});

test('workflowOrchestrator.approvePlan delegates graph approval to runtime continuation', async () => {
  const task = createTask('graph-facade-approve', 'Facade graph approval');
  const run = createAwaitingGraphRun(task);

  const approved = await workflowOrchestrator.approvePlan(run.id, 'tester');

  assert.equal(approved.graph_version, 'phase-b-v1');
  assert.equal(approved.status, 'running');
  assert.equal(approved.approved_by, 'tester');
  assert.equal(approved.current_stage, 'implementation');
  assert.ok(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'dispatch'));
});

test('workflowOrchestrator.cancel delegates graph cancellation to runtime', async () => {
  const task = createTask('graph-facade-cancel', 'Facade graph cancellation');
  const run = createAwaitingGraphRun(task, { status: 'running', currentNode: 'execute' });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    prompt: 'running graph work',
    sort_order: 1,
  });
  const agent = roomAgentRepo.add({
    room_id: task.room_id,
    agent_id: 'cancel-agent',
    agent_name: 'Cancel Agent',
  });
  const agentRun = agentRunRepo.create({
    room_id: task.room_id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend: 'codex',
    task_id: task.id,
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    workflow_stage: 'implementation',
    prompt: 'running graph work',
  });

  const cancelled = await workflowOrchestrator.cancel(run.id);
  const cancelledState = parseGraphState(workflowRepo.getRun(run.id)?.graph_state ?? null);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(workflowRepo.getStep(step.id)?.status, 'cancelled');
  assert.equal(agentRunRepo.get(agentRun.id)?.status, 'cancelled');
  assert.equal(cancelledState?.status, 'cancelled');
});

function createTask(projectSuffix: string, title: string) {
  const projectPath = join(tmpdir(), `${projectSuffix}-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: title, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: `${title} Room` });
  return taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title,
    description: 'Task for workflow facade tests.',
  });
}

function createAwaitingGraphRun(
  task: ReturnType<typeof taskRepo.create>,
  overrides: { status?: 'running' | 'awaiting_approval'; currentNode?: 'approval' | 'execute' } = {},
) {
  const state = {
    workflowRunId: 'pending',
    projectId: task.project_id,
    roomId: task.room_id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: 'unused',
    plan: {
      goal: task.title,
      summary: 'Facade graph approval plan.',
      assumptions: [],
      tasks: [{
        title: 'Implement delegated graph workflow',
        description: 'Created by approval continuation',
        suggestedRole: 'executor' as const,
        priority: 'normal' as const,
        acceptance: ['Dispatch creates a child task'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: true,
    },
    currentNode: overrides.currentNode ?? 'approval' as const,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'pending' as const,
    status: overrides.status ?? 'awaiting_approval' as const,
    error: null,
  };
  const run = workflowRepo.createRun({
    room_id: task.room_id,
    project_id: task.project_id,
    task_id: task.id,
    status: overrides.status ?? 'awaiting_approval',
    current_stage: 'planning',
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState(state),
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState({ ...state, workflowRunId: run.id }));
  return workflowRepo.getRun(run.id)!;
}
