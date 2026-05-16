import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-execute-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { messageRepo } = await import('../../repos/messages.js');
const { createGraphNodes } = await import('./nodes.js');
const { createGraphTools } = await import('./tools.js');

test('execute node starts assigned ACP agent and records completed implementation step', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Room' });
  const executor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'executor',
    agent_name: 'Executor',
  });
  roomAgentRepo.setWorkflowRole(executor.id, 'executor');
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parent task',
    description: 'Parent workflow task',
  });
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Child task',
    description: 'Implementation child task',
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: parentTask.id,
    status: 'running',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
  });

  let fakeRunId: string | null = null;
  let fakeMessageId: string | null = null;

  const calls: Array<{
    roomAgentId: string;
    taskId: string | null | undefined;
    workflowRunId: string | null | undefined;
    workflowStepId: string | null | undefined;
    workflowStage: string | null | undefined;
    prompt: string;
  }> = [];
  const tools = createGraphTools({
    runAcpAgent: async (input) => {
      const runRow = agentRunRepo.create({
        room_id: room.id,
        room_agent_id: executor.id,
        agent_id: executor.agent_id,
        backend: 'codex',
        task_id: input.taskId ?? null,
        workflow_run_id: input.workflowRunId ?? null,
        workflow_step_id: input.workflowStepId ?? null,
        workflow_stage: input.workflowStage ?? null,
        prompt: input.prompt,
      });
      const completedRun = agentRunRepo.updateStatus(runRow.id, 'completed') ?? runRow;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: executor.agent_id,
        sender_name: executor.agent_name,
        content: 'implementation done',
        message_type: 'agent_stream',
      });
      fakeRunId = completedRun.id;
      fakeMessageId = message.id;
      calls.push({
        roomAgentId: input.agent.id,
        taskId: input.taskId,
        workflowRunId: input.workflowRunId,
        workflowStepId: input.workflowStepId,
        workflowStage: input.workflowStage ?? null,
        prompt: input.prompt,
      });
      return {
        run: completedRun,
        message,
        status: 'completed',
      };
    },
  });
  const nodes = createGraphNodes(tools);

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Execute one child task',
      assumptions: [],
      tasks: [{
        title: childTask.title,
        description: childTask.description ?? '',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Move child to review'],
        scopeRead: ['packages/backend/src/workflows/graph/nodes.ts'],
        scopeWrite: ['packages/backend/src/workflows/graph/nodes.ts'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    currentNode: 'dispatch',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [childTask.id],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.roomAgentId, executor.id);
  assert.equal(calls[0]?.taskId, childTask.id);
  assert.equal(calls[0]?.workflowRunId, run.id);
  assert.equal(calls[0]?.workflowStage, 'implementation');
  assert.match(calls[0]?.prompt ?? '', /你是开发闭环的执行智能体/);

  const steps = workflowRepo.listSteps(run.id);
  const step = steps.find((item) => item.node_name === 'execute');
  assert.ok(step);
  assert.equal(step?.stage, 'implementation');
  assert.equal(step?.status, 'completed');
  assert.equal(step?.room_agent_id, executor.id);
  assert.equal(step?.assigned_room_agent_id, executor.id);
  assert.deepEqual(step?.scope_read, ['packages/backend/src/workflows/graph/nodes.ts']);
  assert.deepEqual(step?.scope_write, ['packages/backend/src/workflows/graph/nodes.ts']);
  assert.equal(step?.agent_run_id, fakeRunId);
  assert.equal(step?.result_message_id, fakeMessageId);

  const updatedChild = taskRepo.get(childTask.id);
  assert.equal(updatedChild?.status, 'review');

  assert.equal(nextState.currentNode, 'execute');
  assert.equal(nextState.currentStepId, step?.id ?? null);
  assert.equal(nextState.activeAgentRunId, fakeRunId);
});

test('execute node fails workflow step and child task when ACP agent fails', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-fail-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Fail', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Fail Room' });
  const executor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'executor-fail',
    agent_name: 'Executor Fail',
  });
  roomAgentRepo.setWorkflowRole(executor.id, 'executor');
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parent fail task',
    description: 'Parent workflow task',
  });
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Child fail task',
    description: 'Implementation child task',
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: parentTask.id,
    status: 'running',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
  });
  const tools = createGraphTools({
    runAcpAgent: async (input) => {
      const runRow = agentRunRepo.create({
        room_id: room.id,
        room_agent_id: executor.id,
        agent_id: executor.agent_id,
        backend: 'codex',
        task_id: input.taskId ?? null,
        workflow_run_id: input.workflowRunId ?? null,
        workflow_step_id: input.workflowStepId ?? null,
        workflow_stage: input.workflowStage ?? null,
        prompt: input.prompt,
      });
      const failedRun = agentRunRepo.updateStatus(runRow.id, 'failed', {
        error: 'implementation failed',
        stdout: 'partial output',
      }) ?? runRow;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: executor.agent_id,
        sender_name: executor.agent_name,
        content: 'partial output',
        message_type: 'agent_stream',
      });
      return {
        run: failedRun,
        message,
        status: 'failed',
      };
    },
  });
  const nodes = createGraphNodes(tools);

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Execute one child task',
      assumptions: [],
      tasks: [{
        title: childTask.title,
        description: childTask.description ?? '',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Do not move child to review on failure'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    currentNode: 'dispatch',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [childTask.id],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  const step = workflowRepo.listSteps(run.id).find((item) => item.node_name === 'execute');
  assert.equal(step?.status, 'failed');
  assert.equal(taskRepo.get(childTask.id)?.status, 'failed');
  assert.equal(workflowRepo.getRun(run.id)?.status, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.match(nextState.error ?? '', /implementation failed/);
});
