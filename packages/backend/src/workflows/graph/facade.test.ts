import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun, Message, Task, WorkflowRun } from '../../types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-facade-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { memoryRepo } = await import('../../repos/memory.js');
const { runRegistry } = await import('../../run-registry.js');
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

  assert.equal(count, 3);
  assert.equal(workflowRepo.getStep(graphStep.id)?.status, 'interrupted');
  assert.equal(workflowRepo.getRun(graphRun.id)?.status, 'blocked');
  assert.equal(workflowRepo.getStep(graphLegacyShapedStep.id)?.status, 'interrupted');
  assert.equal(workflowRepo.getStep(legacyStep.id)?.status, 'interrupted');
  assert.equal(workflowRepo.getRun(legacyRun.id)?.status, 'blocked');
  assert.equal(workflowRepo.listRunningSteps().some((step) => step.workflow_run_id === graphRun.id), false);
});

test('workflowOrchestrator.approvePlan delegates graph approval to runtime continuation', async () => {
  const task = createTask('graph-facade-approve', 'Facade graph approval');
  const executor = addWorkflowAgent(task.room_id, 'executor');
  const run = createAwaitingGraphRun(task);
  const agentRuns: AgentRun[] = [];
  setWorkflowOrchestratorGraphDeps({
    runAcpAgent: async (input) => {
      const agentRun = agentRunRepo.create({
        room_id: input.roomId,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
        backend: 'codex',
        status: 'completed',
        task_id: input.taskId,
        workflow_run_id: input.workflowRunId,
        workflow_step_id: input.workflowStepId,
        workflow_stage: input.workflowStage,
        prompt: input.prompt,
      });
      agentRuns.push(agentRun);
      return {
        run: { ...agentRun, stdout: 'implementation completed' },
        message: fakeMessage(task.room_id, 'implementation completed'),
        status: 'completed',
      };
    },
  });

  const approved = await workflowOrchestrator.approvePlan(run.id, 'tester');

  assert.equal(approved.graph_version, 'phase-b-v1');
  assert.equal(approved.approved_by, 'tester');
  assert.equal(approved.current_stage, 'implementation');
  assert.ok(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'dispatch'));
  assert.ok(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'execute'));
  assert.equal(agentRuns[0]?.room_agent_id, executor.id);
  assert.ok(['running', 'blocked', 'failed', 'cancelled', 'completed'].includes(approved.status));
});

test('workflowOrchestrator.approvePlan resumes through acceptance and memory on successful path', async () => {
  const task = createTask('graph-facade-approve-memory', 'Facade graph approval memory path');
  addWorkflowAgent(task.room_id, 'executor');
  addWorkflowAgent(task.room_id, 'reviewer');
  addWorkflowAgent(task.room_id, 'acceptor');
  const run = createAwaitingGraphRun(task);
  const stageCalls: string[] = [];
  setWorkflowOrchestratorGraphDeps({
    runAcpAgent: async (input) => {
      const stage = input.workflowStage ?? 'unknown';
      stageCalls.push(stage);
      const agentRun = agentRunRepo.create({
        room_id: input.roomId,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
        backend: 'codex',
        status: 'completed',
        task_id: input.taskId,
        workflow_run_id: input.workflowRunId,
        workflow_step_id: input.workflowStepId,
        workflow_stage: input.workflowStage,
        prompt: input.prompt,
      });
      const output = stage === 'code_review'
        ? JSON.stringify({ verdict: 'pass', findings: [] })
        : stage === 'acceptance'
          ? JSON.stringify({
            verdict: 'pass',
            acceptedCriteria: ['Graph runtime completed all steps'],
            failedCriteria: [],
            notes: 'All checks passed',
          })
          : 'implementation completed';
      return {
        run: { ...agentRun, stdout: output },
        message: fakeMessage(task.room_id, output),
        status: 'completed',
      };
    },
  });

  const approved = await workflowOrchestrator.approvePlan(run.id, 'tester');
  const approvedState = parseGraphState(approved.graph_state);
  const taskMemories = memoryRepo.list({
    projectId: task.project_id,
    roomId: task.room_id,
    taskId: task.id,
  });
  const taskSummary = taskMemories.find((memory) => memory.memory_type === 'task_summary');

  assert.equal(approved.status, 'completed');
  assert.equal(approvedState?.status, 'completed');
  assert.equal(approvedState?.currentNode, 'memory');
  assert.deepEqual(stageCalls.slice(0, 3), ['implementation', 'code_review', 'acceptance']);
  assert.equal(stageCalls.includes('acceptance'), true);
  assert.equal(taskSummary?.memory_type, 'task_summary');
  assert.equal(taskSummary?.source_id, approved.id);
  assert.equal(taskSummary?.task_id, task.id);
  assert.match(taskSummary?.content ?? '', /Graph runtime completed all steps/);
  assert.equal(workflowRepo.listSteps(approved.id).some((step) => step.node_name === 'acceptance'), true);
  assert.equal(workflowRepo.listSteps(approved.id).some((step) => step.node_name === 'memory'), false);
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
  const controller = runRegistry.create(agentRun.id);

  const cancelled = await workflowOrchestrator.cancel(run.id);
  const cancelledState = parseGraphState(cancelled.graph_state);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelledState?.status, 'cancelled');
  assert.equal(workflowRepo.getStep(step.id)?.status, 'cancelled');
  assert.equal(agentRunRepo.get(agentRun.id)?.status, 'cancelled');
  assert.equal(controller.signal.aborted, true);
});

test('workflowOrchestrator.cancel cancels graph workflow with invalid graph_state', async () => {
  const task = createTask('graph-facade-cancel-invalid-state', 'Facade invalid graph state cancellation');
  const run = createAwaitingGraphRun(task, { status: 'running', currentNode: 'execute' });
  workflowRepo.updateGraphState(run.id, '{"invalid": ');
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    prompt: 'running graph work with invalid state',
    sort_order: 1,
  });
  const agent = roomAgentRepo.add({
    room_id: task.room_id,
    agent_id: 'cancel-invalid-state-agent',
    agent_name: 'Cancel Invalid State Agent',
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
    prompt: 'running graph work with invalid state',
  });
  const controller = runRegistry.create(agentRun.id);

  const cancelled = await workflowOrchestrator.cancel(run.id);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.graph_state, '{"invalid": ');
  assert.equal(workflowRepo.getStep(step.id)?.status, 'cancelled');
  assert.equal(agentRunRepo.get(agentRun.id)?.status, 'cancelled');
  assert.equal(controller.signal.aborted, true);
});

test('workflowOrchestrator.approvePlan rejects invalid graph_state before mutating run state', async () => {
  const task = createTask('graph-facade-approve-invalid-state', 'Facade invalid graph state approval');
  const run = createAwaitingGraphRun(task);
  workflowRepo.updateGraphState(run.id, '{"invalid": ');

  await assert.rejects(
    () => workflowOrchestrator.approvePlan(run.id, 'tester'),
    /graph state is invalid/,
  );

  const latest = workflowRepo.getRun(run.id);
  assert.equal(latest?.status, 'blocked');
  assert.equal(latest?.approved_by, null);
  assert.match(latest?.error ?? '', /graph state is invalid/);
  assert.equal(latest?.graph_state, '{"invalid": ');
  assert.equal(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'dispatch'), false);
});

test('workflowOrchestrator.retryStep restores failed graph child task and resumes execute', async () => {
  const task = createTask('graph-facade-retry', 'Facade graph retry');
  const executor = addWorkflowAgent(task.room_id, 'executor');
  const child = taskRepo.create({
    room_id: task.room_id,
    project_id: task.project_id,
    parent_task_id: task.id,
    title: 'Failed child task',
    description: 'Retry should restore this task.',
    assigned_agent_id: executor.id,
  });
  taskRepo.updateStatus(child.id, 'failed');
  const run = createAwaitingGraphRun(task, {
    status: 'blocked',
    currentNode: 'execute',
    childTaskIds: [child.id],
    error: 'Agent run failed',
  });
  const failedStep = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: child.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'failed',
    assigned_room_agent_id: executor.id,
    room_agent_id: executor.id,
    prompt: 'failed graph work',
    sort_order: 1,
  });
  let executed = false;
  setWorkflowOrchestratorGraphDeps({
    runAcpAgent: async (input) => {
      executed = true;
      const agentRun = agentRunRepo.create({
        room_id: input.roomId,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
        backend: 'codex',
        status: 'completed',
        task_id: input.taskId,
        workflow_run_id: input.workflowRunId,
        workflow_step_id: input.workflowStepId,
        workflow_stage: input.workflowStage,
        prompt: input.prompt,
      });
      return {
        run: { ...agentRun, stdout: 'retry implementation completed' },
        message: fakeMessage(task.room_id, 'retry implementation completed'),
        status: 'completed',
      };
    },
  });

  await workflowOrchestrator.retryStep(run.id);

  assert.equal(workflowRepo.getStep(failedStep.id)?.status, 'skipped');
  assert.equal(taskRepo.get(child.id)?.status, 'review');
  assert.equal(executed, true);
  assert.ok(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length >= 2);
});

test('workflowOrchestrator.retryStep rejects invalid graph_state before resetting child or step state', async () => {
  const task = createTask('graph-facade-retry-invalid-state', 'Facade invalid graph state retry');
  const executor = addWorkflowAgent(task.room_id, 'executor');
  const child = taskRepo.create({
    room_id: task.room_id,
    project_id: task.project_id,
    parent_task_id: task.id,
    title: 'Invalid state retry child task',
    description: 'Retry should not mutate this task before graph state parses.',
    assigned_agent_id: executor.id,
  });
  taskRepo.updateStatus(child.id, 'failed');
  const run = createAwaitingGraphRun(task, {
    status: 'blocked',
    currentNode: 'execute',
    childTaskIds: [child.id],
    error: 'Agent run failed',
  });
  const failedStep = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: child.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'failed',
    assigned_room_agent_id: executor.id,
    room_agent_id: executor.id,
    prompt: 'failed graph work with invalid state',
    sort_order: 1,
  });
  workflowRepo.updateGraphState(run.id, '{"invalid": ');

  await assert.rejects(
    () => workflowOrchestrator.retryStep(run.id),
    /graph state is invalid/,
  );

  const latest = workflowRepo.getRun(run.id);
  assert.equal(latest?.status, 'blocked');
  assert.match(latest?.error ?? '', /graph state is invalid/);
  assert.equal(latest?.graph_state, '{"invalid": ');
  assert.equal(taskRepo.get(child.id)?.status, 'failed');
  assert.equal(workflowRepo.getStep(failedStep.id)?.status, 'failed');
  assert.equal(agentRunRepo.listActiveByWorkflow(run.id).length, 0);
});

test('workflowOrchestrator.retryStep resumes repair decision through execute before review', async () => {
  const task = createTask('graph-facade-repair-resume', 'Facade graph repair resume');
  const executor = addWorkflowAgent(task.room_id, 'executor');
  addWorkflowAgent(task.room_id, 'reviewer');
  const child = taskRepo.create({
    room_id: task.room_id,
    project_id: task.project_id,
    parent_task_id: task.id,
    title: 'Repair child task',
    description: 'Repair retry should execute this child again.',
    assigned_agent_id: executor.id,
  });
  taskRepo.updateStatus(child.id, 'review');
  const run = createAwaitingGraphRun(task, {
    status: 'blocked',
    currentNode: 'repair_decision',
    childTaskIds: [child.id],
    reviewVerdict: 'changes_requested',
    error: 'Code review requested changes',
  });
  const executionOrder: string[] = [];
  setWorkflowOrchestratorGraphDeps({
    runAcpAgent: async (input) => {
      executionOrder.push(input.workflowStage ?? 'unknown');
      const agentRun = agentRunRepo.create({
        room_id: input.roomId,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
        backend: 'codex',
        status: 'completed',
        task_id: input.taskId,
        workflow_run_id: input.workflowRunId,
        workflow_step_id: input.workflowStepId,
        workflow_stage: input.workflowStage,
        prompt: input.prompt,
      });
      const content = input.workflowStage === 'code_review'
        ? JSON.stringify({ verdict: 'pass', findings: [] })
        : 'repair implementation completed';
      return {
        run: { ...agentRun, stdout: content },
        message: fakeMessage(task.room_id, content),
        status: 'completed',
      };
    },
  });

  await workflowOrchestrator.retryStep(run.id);
  const steps = workflowRepo.listSteps(run.id);

  assert.equal(taskRepo.get(child.id)?.status, 'review');
  assert.equal(steps.some((step) => step.node_name === 'execute'), true);
  assert.equal(steps.some((step) => step.node_name === 'review'), true);
  assert.deepEqual(executionOrder.slice(0, 2), ['implementation', 'code_review']);
});

test('workflowOrchestrator.retryStep from review re-runs execute before review', async () => {
  const task = createTask('graph-facade-review-retry', 'Facade graph review retry');
  const executor = addWorkflowAgent(task.room_id, 'executor');
  addWorkflowAgent(task.room_id, 'reviewer');
  const child = taskRepo.create({
    room_id: task.room_id,
    project_id: task.project_id,
    parent_task_id: task.id,
    title: 'Review retry child task',
    description: 'Retry from review should execute first.',
    assigned_agent_id: executor.id,
  });
  taskRepo.updateStatus(child.id, 'failed');
  const run = createAwaitingGraphRun(task, {
    status: 'blocked',
    currentNode: 'review',
    childTaskIds: [child.id],
    reviewVerdict: 'failed',
    error: 'Code review failed',
  });
  const executionOrder: string[] = [];
  setWorkflowOrchestratorGraphDeps({
    runAcpAgent: async (input) => {
      executionOrder.push(input.workflowStage ?? 'unknown');
      const agentRun = agentRunRepo.create({
        room_id: input.roomId,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
        backend: 'codex',
        status: 'completed',
        task_id: input.taskId,
        workflow_run_id: input.workflowRunId,
        workflow_step_id: input.workflowStepId,
        workflow_stage: input.workflowStage,
        prompt: input.prompt,
      });
      const content = input.workflowStage === 'code_review'
        ? JSON.stringify({ verdict: 'pass', findings: [] })
        : 'review retry implementation completed';
      return {
        run: { ...agentRun, stdout: content },
        message: fakeMessage(task.room_id, content),
        status: 'completed',
      };
    },
  });

  await workflowOrchestrator.retryStep(run.id);

  assert.equal(taskRepo.get(child.id)?.status, 'review');
  assert.deepEqual(executionOrder.slice(0, 2), ['implementation', 'code_review']);
});

test('workflowOrchestrator.retryStep rejects graph retry while an agent run is active', async () => {
  const task = createTask('graph-facade-active-retry', 'Facade graph active retry');
  const executor = addWorkflowAgent(task.room_id, 'executor');
  const child = taskRepo.create({
    room_id: task.room_id,
    project_id: task.project_id,
    parent_task_id: task.id,
    title: 'Active child task',
    description: 'Retry should reject active work.',
    assigned_agent_id: executor.id,
  });
  const run = createAwaitingGraphRun(task, {
    status: 'blocked',
    currentNode: 'execute',
    childTaskIds: [child.id],
    error: 'Agent still active',
  });
  workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: child.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    assigned_room_agent_id: executor.id,
    room_agent_id: executor.id,
    prompt: 'active graph work',
    sort_order: 1,
  });
  agentRunRepo.create({
    room_id: task.room_id,
    room_agent_id: executor.id,
    agent_id: executor.agent_id,
    backend: 'codex',
    task_id: child.id,
    workflow_run_id: run.id,
    workflow_stage: 'implementation',
    prompt: 'active graph work',
  });
  const before = agentRunRepo.listActiveByWorkflow(run.id).length;

  await assert.rejects(
    () => workflowOrchestrator.retryStep(run.id),
    /workflow already has an active agent run/,
  );

  assert.equal(agentRunRepo.listActiveByWorkflow(run.id).length, before);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 1);
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
  task: Task,
  overrides: {
    status?: WorkflowRun['status'];
    currentNode?: 'approval' | 'execute' | 'review' | 'repair_decision' | 'acceptance';
    childTaskIds?: string[];
    error?: string | null;
    reviewVerdict?: 'pass' | 'changes_requested' | 'failed' | null;
  } = {},
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
    childTaskIds: overrides.childTaskIds ?? [],
    reviewFindings: [],
    reviewVerdict: overrides.reviewVerdict ?? null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'pending' as const,
    status: overrides.status ?? 'awaiting_approval' as const,
    error: overrides.error ?? null,
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

function addWorkflowAgent(roomId: string, role: 'executor' | 'reviewer' | 'acceptor') {
  const agent = roomAgentRepo.add({
    room_id: roomId,
    agent_id: `${role}-${Date.now()}-${Math.random()}`,
    agent_name: `${role} Agent`,
  });
  const withRole = roomAgentRepo.setWorkflowRole(agent.id, role);
  if (!withRole) throw new Error(`failed to assign ${role} role`);
  const withAcp = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: [],
  });
  if (!withAcp) throw new Error(`failed to enable ACP for ${role}`);
  return withAcp;
}

function fakeMessage(roomId: string, content: string): Message {
  return {
    id: `message-${Date.now()}-${Math.random()}`,
    room_id: roomId,
    sender_type: 'agent',
    sender_id: 'agent',
    sender_name: 'Agent',
    content,
    message_type: 'text',
    metadata: null,
    created_at: Date.now(),
  };
}
