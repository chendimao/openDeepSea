import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { WsServerEvent } from '../../types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-execute-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { messageRepo } = await import('../../repos/messages.js');
const { wsHub } = await import('../../ws-hub.js');
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
  const withRole = roomAgentRepo.setWorkflowRole(executor.id, 'executor') ?? executor;
  const acpExecutor = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
  }) ?? withRole;
  const boundedExecutor = roomAgentRepo.setCapabilitiesAndRuntime(acpExecutor.id, {
    capabilities: acpExecutor.capabilities,
    default_runtime: acpExecutor.default_runtime,
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  }) ?? acpExecutor;
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
    assigned_agent_id: boundedExecutor.id,
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
    buildSkillContext: async () => 'OpenDeepSea active skills for this runtime:\nSkill: should-not-reach-execute-acp',
    runAcpAgent: async (input) => {
      const runRow = agentRunRepo.create({
        room_id: room.id,
        room_agent_id: boundedExecutor.id,
        agent_id: boundedExecutor.agent_id,
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
        sender_id: boundedExecutor.agent_id,
        sender_name: boundedExecutor.agent_name,
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
  assert.equal(calls[0]?.roomAgentId, boundedExecutor.id);
  assert.equal(calls[0]?.taskId, childTask.id);
  assert.equal(calls[0]?.workflowRunId, run.id);
  assert.equal(calls[0]?.workflowStage, 'implementation');
  assert.match(calls[0]?.prompt ?? '', /你是开发闭环的执行智能体/);
  assert.doesNotMatch(calls[0]?.prompt ?? '', /OpenDeepSea active skills for this runtime/);
  assert.doesNotMatch(calls[0]?.prompt ?? '', /should-not-reach-execute-acp/);

  const steps = workflowRepo.listSteps(run.id);
  const step = steps.find((item) => item.node_name === 'execute');
  assert.ok(step);
  assert.equal(step?.stage, 'implementation');
  assert.equal(step?.status, 'completed');
  assert.equal(step?.room_agent_id, boundedExecutor.id);
  assert.equal(step?.assigned_room_agent_id, boundedExecutor.id);
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

test('execute node reuses active workflow run instead of starting duplicate ACP execution', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-active-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Active', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Active Room' });
  const executor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'executor-active',
    agent_name: 'Executor Active',
  });
  const withRole = roomAgentRepo.setWorkflowRole(executor.id, 'executor') ?? executor;
  const acpExecutor = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
  }) ?? withRole;
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parent active task',
    description: 'Parent workflow task',
  });
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Child active task',
    description: 'Implementation child task',
    assigned_agent_id: acpExecutor.id,
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
  const activeStep = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: childTask.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: acpExecutor.id,
    sort_order: 1,
  });
  const activeRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: acpExecutor.id,
    agent_id: acpExecutor.agent_id,
    backend: 'codex',
    task_id: childTask.id,
    workflow_run_id: run.id,
    workflow_step_id: activeStep.id,
    workflow_stage: 'implementation',
    prompt: 'already running',
  });
  let calls = 0;
  const tools = createGraphTools({
    runAcpAgent: async () => {
      calls += 1;
      throw new Error('runAcpAgent should not be called while workflow has an active run');
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
      summary: 'Do not duplicate active execution',
      assumptions: [],
      tasks: [{
        title: childTask.title,
        description: childTask.description ?? '',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Active run is reused'],
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
    currentNode: 'execute',
    currentStepId: activeStep.id,
    activeAgentRunId: activeRun.id,
    childTaskIds: [childTask.id],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.equal(calls, 0);
  assert.equal(nextState.currentStepId, activeStep.id);
  assert.equal(nextState.activeAgentRunId, activeRun.id);
  assert.equal(agentRunRepo.listActiveByWorkflow(run.id).length, 1);
});

test('execute node ignores active run from a different workflow stage', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-active-stage-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Active Stage', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Active Stage Room' });
  const executor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'executor-active-stage',
    agent_name: 'Executor Active Stage',
  });
  const withRole = roomAgentRepo.setWorkflowRole(executor.id, 'executor') ?? executor;
  const acpExecutor = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
  }) ?? withRole;
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parent stage task',
    description: 'Parent workflow task',
  });
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Child stage task',
    description: 'Implementation child task',
    assigned_agent_id: acpExecutor.id,
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
  const reviewStep = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: parentTask.id,
    stage: 'code_review',
    node_name: 'review',
    status: 'running',
    room_agent_id: acpExecutor.id,
    sort_order: 1,
  });
  agentRunRepo.create({
    room_id: room.id,
    room_agent_id: acpExecutor.id,
    agent_id: acpExecutor.agent_id,
    backend: 'codex',
    task_id: parentTask.id,
    workflow_run_id: run.id,
    workflow_step_id: reviewStep.id,
    workflow_stage: 'code_review',
    prompt: 'review still running',
  });
  let calls = 0;
  const tools = createGraphTools({
    runAcpAgent: async (input) => {
      calls += 1;
      const runRow = agentRunRepo.create({
        room_id: room.id,
        room_agent_id: acpExecutor.id,
        agent_id: acpExecutor.agent_id,
        backend: 'codex',
        task_id: input.taskId ?? null,
        workflow_run_id: input.workflowRunId ?? null,
        workflow_step_id: input.workflowStepId ?? null,
        workflow_stage: input.workflowStage ?? null,
        prompt: input.prompt,
      });
      const completedRun = agentRunRepo.updateStatus(runRow.id, 'completed', { stdout: 'implementation done' }) ?? runRow;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: acpExecutor.agent_id,
        sender_name: acpExecutor.agent_name,
        content: 'implementation done',
        message_type: 'agent_stream',
      });
      return {
        run: completedRun,
        message,
        status: 'completed' as const,
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
      summary: 'Ignore active review run',
      assumptions: [],
      tasks: [{
        title: childTask.title,
        description: childTask.description ?? '',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Implementation still runs'],
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

  assert.equal(calls, 1);
  assert.equal(taskRepo.get(childTask.id)?.status, 'review');
  assert.equal(nextState.currentStepId !== reviewStep.id, true);
  assert.equal(workflowRepo.listSteps(run.id).filter((item) => item.node_name === 'execute').length, 1);
});

test('execute node blocks assigned non-ACP agent without starting ACP run', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-non-acp-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Non ACP', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Non ACP Room' });
  const executor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'legacy-executor',
    agent_name: 'Legacy Executor',
  });
  roomAgentRepo.setWorkflowRole(executor.id, 'executor');
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parent non ACP task',
    description: 'Parent workflow task',
  });
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Child non ACP task',
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

  let calls = 0;
  const tools = createGraphTools({
    runAcpAgent: async () => {
      calls += 1;
      throw new Error('runAcpAgent should not be called for assigned non-ACP agent');
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
        acceptance: ['Block because assigned executor is not ACP configured'],
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

  assert.equal(calls, 0);
  assert.equal(nextState.status, 'blocked');
  assert.match(nextState.error ?? '', /No executor available/);
  assert.equal(workflowRepo.getRun(run.id)?.status, 'blocked');
  assert.match(workflowRepo.getRun(run.id)?.error ?? '', /No executor available/);
  assert.equal(taskRepo.get(childTask.id)?.status, 'todo');
  assert.equal(workflowRepo.listSteps(run.id).some((item) => item.node_name === 'execute'), false);
});

test('execute node broadcasts agent join when it provisions a workflow executor', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-provision-broadcast-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Provision Broadcast', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Provision Broadcast Room' });
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parent provision broadcast task',
    description: 'Parent workflow task',
  });
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Child backend task',
    description: 'Implementation child task',
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
  const capture = captureRoomEvents(room.id);
  const calls: string[] = [];
  const tools = createGraphTools({
    runAcpAgent: async (input) => {
      calls.push(input.agent.agent_id);
      const runRow = agentRunRepo.create({
        room_id: room.id,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
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
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: 'implementation done',
        message_type: 'agent_stream',
      });
      return {
        run: completedRun,
        message,
        status: 'completed' as const,
      };
    },
  });
  const nodes = createGraphNodes(tools);

  try {
    await nodes.executeNode({
      workflowRunId: run.id,
      projectId: project.id,
      roomId: room.id,
      taskId: parentTask.id,
      userGoal: parentTask.title,
      projectPath: project.path,
      plan: {
        goal: parentTask.title,
        summary: 'Provision one backend executor',
        assumptions: [],
        tasks: [{
          title: childTask.title,
          description: childTask.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend implementation completes'],
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
  } finally {
    capture.cleanup();
  }

  const joinedAgents = capture.events.filter((event) => event.type === 'room:agent_joined');
  assert.deepEqual(calls, ['backend-executor']);
  assert.equal(joinedAgents.length, 1);
  assert.equal(joinedAgents[0]?.agent.agent_id, 'backend-executor');
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
  const withRole = roomAgentRepo.setWorkflowRole(executor.id, 'executor') ?? executor;
  const acpExecutor = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
  }) ?? withRole;
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
    assigned_agent_id: acpExecutor.id,
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
        room_agent_id: acpExecutor.id,
        agent_id: acpExecutor.agent_id,
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
        sender_id: acpExecutor.agent_id,
        sender_name: acpExecutor.agent_name,
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

function captureRoomEvents(roomId: string): { events: WsServerEvent[]; cleanup: () => void } {
  const events: WsServerEvent[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send(payload: string) {
      events.push(JSON.parse(payload) as WsServerEvent);
    },
  } as unknown as WebSocket;
  wsHub.subscribe(roomId, socket);
  return {
    events,
    cleanup: () => wsHub.removeSocket(socket),
  };
}
