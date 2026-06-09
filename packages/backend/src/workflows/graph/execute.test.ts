import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { RespondAsAgentInput } from '../../dispatcher.js';
import type { RoomAgent, WsServerEvent } from '../../types.js';

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

test('execute node starts independent ready implementation children in parallel', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-parallel-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Parallel', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Parallel Room' });
  const backend = createAcpExecutor(room.id, 'parallel-backend', ['packages/backend']);
  const frontend = createAcpExecutor(room.id, 'parallel-frontend', ['packages/frontend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parallel parent task',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Backend child',
    description: 'Implement backend change.',
    assigned_agent_id: backend.id,
    created_from: 'workflow_assignment',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Frontend child',
    description: 'Implement frontend change.',
    assigned_agent_id: frontend.id,
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
  const started: string[] = [];
  const release: Record<string, () => void> = {};
  const tools = createGraphTools({
    runAcpAgent: async (input) => {
      started.push(input.agent.id);
      await new Promise<void>((resolve) => {
        release[input.agent.id] = resolve;
      });
      return createCompletedGraphAgentRun(room.id, input, 'parallel implementation done');
    },
  });
  const nodes = createGraphNodes(tools);

  const running = nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Run independent children in parallel',
      assumptions: [],
      tasks: [
        {
          title: backendChild.title,
          description: backendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend implementation reaches review'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
        {
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend implementation reaches review'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Run independent children in parallel',
      tasks: [
        {
          id: 'task-1-backend-child',
          title: backendChild.title,
          description: backendChild.description ?? '',
          role: 'executor',
          agent_id: backend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
        {
          id: 'task-2-frontend-child',
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          role: 'executor',
          agent_id: frontend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'dispatch',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [backendChild.id, frontendChild.id],
    childTaskPlanIndexes: {
      [backendChild.id]: 0,
      [frontendChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  await waitForExecuteTest(() => started.includes(backend.id) && started.includes(frontend.id));
  assert.deepEqual([...started].sort(), [backend.id, frontend.id].sort());
  release[backend.id]?.();
  release[frontend.id]?.();
  const nextState = await running;

  assert.equal(taskRepo.get(backendChild.id)?.status, 'review');
  assert.equal(taskRepo.get(frontendChild.id)?.status, 'review');
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['completed', 'completed']);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 2);
});

test('execute node settles parallel batch when one agent throws and another completes', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-parallel-throw-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Parallel Throw', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Parallel Throw Room' });
  const backend = createAcpExecutor(room.id, 'parallel-throw-backend', ['packages/backend']);
  const frontend = createAcpExecutor(room.id, 'parallel-throw-frontend', ['packages/frontend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parallel throw parent task',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Throwing backend child',
    description: 'Backend agent crashes.',
    assigned_agent_id: backend.id,
    created_from: 'workflow_assignment',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Completing frontend child',
    description: 'Frontend agent completes.',
    assigned_agent_id: frontend.id,
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
  const started: string[] = [];
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async (input) => {
      started.push(input.agent.id);
      if (input.agent.id === backend.id) {
        throw new Error('backend agent crashed');
      }
      return createCompletedGraphAgentRun(room.id, input, 'frontend implementation done');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Settle parallel children despite thrown agent error',
      assumptions: [],
      tasks: [
        {
          title: backendChild.title,
          description: backendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend failure is captured'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
        {
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend implementation reaches review'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Settle parallel children despite thrown agent error',
      tasks: [
        {
          id: 'task-1-throwing-backend-child',
          title: backendChild.title,
          description: backendChild.description ?? '',
          role: 'executor',
          agent_id: backend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
        {
          id: 'task-2-completing-frontend-child',
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          role: 'executor',
          agent_id: frontend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'dispatch',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [backendChild.id, frontendChild.id],
    childTaskPlanIndexes: {
      [backendChild.id]: 0,
      [frontendChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });
  const steps = workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute');
  const backendStep = steps.find((step) => step.task_id === backendChild.id);
  const frontendStep = steps.find((step) => step.task_id === frontendChild.id);

  assert.deepEqual([...started].sort(), [backend.id, frontend.id].sort());
  assert.equal(nextState.status, 'blocked');
  assert.equal(workflowRepo.getRun(run.id)?.status, 'blocked');
  assert.equal(taskRepo.get(backendChild.id)?.status, 'failed');
  assert.equal(taskRepo.get(frontendChild.id)?.status, 'review');
  assert.equal(backendStep?.status, 'failed');
  assert.match(backendStep?.error ?? '', /backend agent crashed/);
  assert.equal(frontendStep?.status, 'completed');
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['failed', 'completed']);
  assert.equal(nextState.workflowPlan?.tasks[1]?.progress, 100);
});

test('execute node does not parallelize implementation children with conflicting write scopes', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-conflict-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Conflict', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Conflict Room' });
  const firstExecutor = createAcpExecutor(room.id, 'conflict-backend-a', ['packages/backend']);
  const secondExecutor = createAcpExecutor(room.id, 'conflict-backend-b', ['packages/backend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Conflicting parent task',
  });
  const firstChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'First backend child',
    description: 'Modify backend route.',
    assigned_agent_id: firstExecutor.id,
    created_from: 'workflow_assignment',
  });
  const secondChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Second backend child',
    description: 'Modify same backend route.',
    assigned_agent_id: secondExecutor.id,
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
  const started: string[] = [];
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async (input) => {
      started.push(input.agent.id);
      return createCompletedGraphAgentRun(room.id, input, 'single conflicting implementation done');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Do not run conflicting writes together',
      assumptions: [],
      tasks: [
        {
          title: firstChild.title,
          description: firstChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['First child reaches review'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
        {
          title: secondChild.title,
          description: secondChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Second child waits'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Do not run conflicting writes together',
      tasks: [
        {
          id: 'task-1-first-backend-child',
          title: firstChild.title,
          description: firstChild.description ?? '',
          role: 'executor',
          agent_id: firstExecutor.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
        {
          id: 'task-2-second-backend-child',
          title: secondChild.title,
          description: secondChild.description ?? '',
          role: 'executor',
          agent_id: secondExecutor.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'dispatch',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [firstChild.id, secondChild.id],
    childTaskPlanIndexes: {
      [firstChild.id]: 0,
      [secondChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.deepEqual(started, [firstExecutor.id]);
  assert.equal(taskRepo.get(firstChild.id)?.status, 'review');
  assert.equal(taskRepo.get(secondChild.id)?.status, 'todo');
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['completed', 'pending']);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 1);
});

test('execute node does not parallelize high-risk root config writes with other ready children', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-high-risk-root-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute High Risk Root', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute High Risk Root Room' });
  const configExecutor = createAcpExecutor(room.id, 'high-risk-config', ['.']);
  const frontend = createAcpExecutor(room.id, 'high-risk-frontend', ['packages/frontend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'High-risk root config parent task',
  });
  const configChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Root workspace config child',
    description: 'Modify root workspace config.',
    assigned_agent_id: configExecutor.id,
    created_from: 'workflow_assignment',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Frontend page child',
    description: 'Modify frontend page.',
    assigned_agent_id: frontend.id,
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
  const started: string[] = [];
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async (input) => {
      started.push(input.agent.id);
      return createCompletedGraphAgentRun(room.id, input, 'high-risk implementation done');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Do not parallelize high-risk root config writes',
      assumptions: [],
      tasks: [
        {
          title: configChild.title,
          description: configChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Root config reaches review'],
          scopeRead: ['turbo.json'],
          scopeWrite: ['turbo.json'],
          dependsOn: [],
        },
        {
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend waits'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Do not parallelize high-risk root config writes',
      tasks: [
        {
          id: 'task-1-root-package-config-child',
          title: configChild.title,
          description: configChild.description ?? '',
          role: 'executor',
          agent_id: configExecutor.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
        {
          id: 'task-2-frontend-page-child',
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          role: 'executor',
          agent_id: frontend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'dispatch',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [configChild.id, frontendChild.id],
    childTaskPlanIndexes: {
      [configChild.id]: 0,
      [frontendChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.deepEqual(started, [configExecutor.id]);
  assert.equal(taskRepo.get(configChild.id)?.status, 'review');
  assert.equal(taskRepo.get(frontendChild.id)?.status, 'todo');
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['completed', 'pending']);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 1);
});

test('execute node blocks parallel batch without partial steps when a child has no executor', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-parallel-missing-executor-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Missing Parallel Executor', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Missing Parallel Executor Room' });
  const backend = createAcpExecutor(room.id, 'missing-backend', ['packages/backend']);
  const legacyExecutor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: `missing-legacy-${Date.now()}`,
    agent_name: 'Missing Legacy Executor',
  });
  const legacyWithRole = roomAgentRepo.setWorkflowRole(legacyExecutor.id, 'executor') ?? legacyExecutor;
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parallel missing executor parent task',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Backend ready child without partial run',
    description: 'Would run if all batch executors were valid.',
    assigned_agent_id: backend.id,
    created_from: 'workflow_assignment',
  });
  const legacyChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Legacy child without ACP',
    description: 'Cannot run because assigned executor has no ACP runtime.',
    assigned_agent_id: legacyWithRole.id,
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
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async () => {
      calls += 1;
      throw new Error('runAcpAgent should not be called when a parallel batch executor is missing');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Block before partially preparing a parallel batch',
      assumptions: [],
      tasks: [
        {
          title: backendChild.title,
          description: backendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend child is not partially started'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
        {
          title: legacyChild.title,
          description: legacyChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Batch blocks because executor is unavailable'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Block before partially preparing a parallel batch',
      tasks: [
        {
          id: 'task-1-backend-ready-child-without-partial-run',
          title: backendChild.title,
          description: backendChild.description ?? '',
          role: 'executor',
          agent_id: backend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
        {
          id: 'task-2-legacy-child-without-acp',
          title: legacyChild.title,
          description: legacyChild.description ?? '',
          role: 'executor',
          agent_id: legacyWithRole.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'dispatch',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [backendChild.id, legacyChild.id],
    childTaskPlanIndexes: {
      [backendChild.id]: 0,
      [legacyChild.id]: 1,
    },
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
  assert.equal(taskRepo.get(backendChild.id)?.status, 'todo');
  assert.equal(taskRepo.get(legacyChild.id)?.status, 'todo');
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['pending', 'blocked']);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 0);
});

test('execute node starts ready sibling while another implementation child run is active', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-active-sibling-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Active Sibling', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Active Sibling Room' });
  const backend = createAcpExecutor(room.id, 'active-sibling-backend', ['packages/backend']);
  const frontend = createAcpExecutor(room.id, 'active-sibling-frontend', ['packages/frontend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Active sibling parent task',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Backend active child',
    description: 'Already running.',
    assigned_agent_id: backend.id,
    created_from: 'workflow_assignment',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Frontend ready child',
    description: 'Can start while backend is running.',
    assigned_agent_id: frontend.id,
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
    task_id: backendChild.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: backend.id,
    assigned_room_agent_id: backend.id,
    scope_read: ['packages/backend/src/routes.ts'],
    scope_write: ['packages/backend/src/routes.ts'],
    prompt: 'active backend prompt',
    sort_order: 1,
  });
  agentRunRepo.create({
    room_id: room.id,
    room_agent_id: backend.id,
    agent_id: backend.agent_id,
    backend: backend.acp_backend ?? 'codex',
    task_id: backendChild.id,
    workflow_run_id: run.id,
    workflow_step_id: activeStep.id,
    workflow_stage: 'implementation',
    prompt: 'active backend prompt',
  });

  const started: string[] = [];
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async (input) => {
      started.push(input.agent.id);
      return createCompletedGraphAgentRun(room.id, input, 'ready sibling implementation done');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Start ready sibling despite active implementation run',
      assumptions: [],
      tasks: [
        {
          title: backendChild.title,
          description: backendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend keeps running'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
        {
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend reaches review'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Start ready sibling despite active implementation run',
      tasks: [
        {
          id: 'task-1-backend-active-child',
          title: backendChild.title,
          description: backendChild.description ?? '',
          role: 'executor',
          agent_id: backend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'running',
          progress: 35,
          result_refs: [],
        },
        {
          id: 'task-2-frontend-ready-child',
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          role: 'executor',
          agent_id: frontend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'execute',
    currentStepId: activeStep.id,
    activeAgentRunId: null,
    childTaskIds: [backendChild.id, frontendChild.id],
    childTaskPlanIndexes: {
      [backendChild.id]: 0,
      [frontendChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.deepEqual(started, [frontend.id]);
  assert.equal(taskRepo.get(frontendChild.id)?.status, 'review');
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['running', 'completed']);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 2);
});

test('execute node does not start a ready sibling assigned to an agent with an active implementation run', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-busy-agent-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Busy Agent', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Busy Agent Room' });
  const executor = createAcpExecutor(room.id, 'busy-agent-executor', ['packages/backend', 'packages/frontend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Busy agent parent task',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Backend active same agent child',
    description: 'Already running on the shared executor.',
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Frontend ready same agent child',
    description: 'Must wait because the shared executor is busy.',
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
  const activeStep = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: backendChild.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: executor.id,
    assigned_room_agent_id: executor.id,
    scope_read: ['packages/backend/src/routes.ts'],
    scope_write: ['packages/backend/src/routes.ts'],
    prompt: 'active backend prompt',
    sort_order: 1,
  });
  const activeRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: executor.id,
    agent_id: executor.agent_id,
    backend: executor.acp_backend ?? 'codex',
    task_id: backendChild.id,
    workflow_run_id: run.id,
    workflow_step_id: activeStep.id,
    workflow_stage: 'implementation',
    prompt: 'active backend prompt',
  });

  let calls = 0;
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async () => {
      calls += 1;
      throw new Error('runAcpAgent should not be called for a busy single-instance agent');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Do not start a second child on a busy agent',
      assumptions: [],
      tasks: [
        {
          title: backendChild.title,
          description: backendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend keeps running'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
        {
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend waits for the busy executor'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Do not start a second child on a busy agent',
      tasks: [
        {
          id: 'task-1-backend-active-same-agent-child',
          title: backendChild.title,
          description: backendChild.description ?? '',
          role: 'executor',
          agent_id: executor.id,
          mode: 'parallel',
          depends_on: [],
          status: 'running',
          progress: 35,
          result_refs: [],
        },
        {
          id: 'task-2-frontend-ready-same-agent-child',
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          role: 'executor',
          agent_id: executor.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'execute',
    currentStepId: activeStep.id,
    activeAgentRunId: null,
    childTaskIds: [backendChild.id, frontendChild.id],
    childTaskPlanIndexes: {
      [backendChild.id]: 0,
      [frontendChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.equal(calls, 0);
  assert.equal(taskRepo.get(frontendChild.id)?.status, 'todo');
  assert.equal(nextState.activeAgentRunId, activeRun.id);
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['running', 'pending']);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 1);
});

test('execute node does not start an explicit serial child while another implementation child is active', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-serial-active-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Serial Active', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Serial Active Room' });
  const backend = createAcpExecutor(room.id, 'serial-active-backend', ['packages/backend']);
  const frontend = createAcpExecutor(room.id, 'serial-active-frontend', ['packages/frontend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Serial active parent task',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Backend active parallel child',
    description: 'Already running.',
    assigned_agent_id: backend.id,
    created_from: 'workflow_assignment',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Frontend explicit serial child',
    description: 'Must wait because mode is serial.',
    assigned_agent_id: frontend.id,
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
    task_id: backendChild.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: backend.id,
    assigned_room_agent_id: backend.id,
    scope_read: ['packages/backend/src/routes.ts'],
    scope_write: ['packages/backend/src/routes.ts'],
    prompt: 'active backend prompt',
    sort_order: 1,
  });
  const activeRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: backend.id,
    agent_id: backend.agent_id,
    backend: backend.acp_backend ?? 'codex',
    task_id: backendChild.id,
    workflow_run_id: run.id,
    workflow_step_id: activeStep.id,
    workflow_stage: 'implementation',
    prompt: 'active backend prompt',
  });

  let calls = 0;
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async () => {
      calls += 1;
      throw new Error('runAcpAgent should not be called for a serial child while another implementation child is active');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Do not overlap explicit serial tasks with active implementation runs',
      assumptions: [],
      tasks: [
        {
          title: backendChild.title,
          description: backendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend keeps running'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
        {
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend waits for active implementation run'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Do not overlap explicit serial tasks with active implementation runs',
      tasks: [
        {
          id: 'task-1-backend-active-parallel-child',
          title: backendChild.title,
          description: backendChild.description ?? '',
          role: 'executor',
          agent_id: backend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'running',
          progress: 35,
          result_refs: [],
        },
        {
          id: 'task-2-frontend-explicit-serial-child',
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          role: 'executor',
          agent_id: frontend.id,
          mode: 'serial',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'execute',
    currentStepId: activeStep.id,
    activeAgentRunId: null,
    childTaskIds: [backendChild.id, frontendChild.id],
    childTaskPlanIndexes: {
      [backendChild.id]: 0,
      [frontendChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.equal(calls, 0);
  assert.equal(taskRepo.get(frontendChild.id)?.status, 'todo');
  assert.equal(nextState.activeAgentRunId, activeRun.id);
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['running', 'pending']);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 1);
});

test('execute node waits for workflowPlan dependencies before parallel implementation', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-depends-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Depends', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Depends Room' });
  const backend = createAcpExecutor(room.id, 'depends-backend', ['packages/backend']);
  const frontend = createAcpExecutor(room.id, 'depends-frontend', ['packages/frontend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Dependent parent task',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Backend dependency child',
    description: 'Implement dependency first.',
    assigned_agent_id: backend.id,
    created_from: 'workflow_assignment',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Frontend dependent child',
    description: 'Wait for backend dependency.',
    assigned_agent_id: frontend.id,
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
  const started: string[] = [];
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async (input) => {
      started.push(input.agent.id);
      return createCompletedGraphAgentRun(room.id, input, 'dependency implementation done');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Respect workflow plan dependencies',
      assumptions: [],
      tasks: [
        {
          title: backendChild.title,
          description: backendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend reaches review'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
        {
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend waits for dependency'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: ['Backend dependency child'],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Respect workflow plan dependencies',
      tasks: [
        {
          id: 'task-1-backend-dependency-child',
          title: backendChild.title,
          description: backendChild.description ?? '',
          role: 'executor',
          agent_id: backend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
        {
          id: 'task-2-frontend-dependent-child',
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          role: 'executor',
          agent_id: frontend.id,
          mode: 'parallel',
          depends_on: ['task-1-backend-dependency-child'],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'dispatch',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [backendChild.id, frontendChild.id],
    childTaskPlanIndexes: {
      [backendChild.id]: 0,
      [frontendChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.deepEqual(started, [backend.id]);
  assert.equal(taskRepo.get(backendChild.id)?.status, 'review');
  assert.equal(taskRepo.get(frontendChild.id)?.status, 'todo');
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['completed', 'pending']);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 1);
});

test('execute node skips a dependency-blocked child and starts the next ready child', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-ready-sibling-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Ready Sibling', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Ready Sibling Room' });
  const backend = createAcpExecutor(room.id, 'ready-backend', ['packages/backend']);
  const frontend = createAcpExecutor(room.id, 'ready-frontend', ['packages/frontend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Ready sibling parent task',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Frontend blocked child',
    description: 'Waits for backend.',
    assigned_agent_id: frontend.id,
    created_from: 'workflow_assignment',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Backend ready child',
    description: 'Can run first.',
    assigned_agent_id: backend.id,
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
  const started: string[] = [];
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async (input) => {
      started.push(input.agent.id);
      return createCompletedGraphAgentRun(room.id, input, 'ready sibling implementation done');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Run ready sibling before dependency-blocked child',
      assumptions: [],
      tasks: [
        {
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend waits'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: ['Backend ready child'],
        },
        {
          title: backendChild.title,
          description: backendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend reaches review'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Run ready sibling before dependency-blocked child',
      tasks: [
        {
          id: 'task-1-frontend-blocked-child',
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          role: 'executor',
          agent_id: frontend.id,
          mode: 'parallel',
          depends_on: ['task-2-backend-ready-child'],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
        {
          id: 'task-2-backend-ready-child',
          title: backendChild.title,
          description: backendChild.description ?? '',
          role: 'executor',
          agent_id: backend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'dispatch',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [frontendChild.id, backendChild.id],
    childTaskPlanIndexes: {
      [frontendChild.id]: 0,
      [backendChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.deepEqual(started, [backend.id]);
  assert.equal(taskRepo.get(frontendChild.id)?.status, 'todo');
  assert.equal(taskRepo.get(backendChild.id)?.status, 'review');
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['pending', 'completed']);
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

function createAcpExecutor(roomId: string, agentId: string, writableDirs: string[]): RoomAgent {
  const agent = roomAgentRepo.add({
    room_id: roomId,
    agent_id: `${agentId}-${Date.now()}-${Math.random()}`,
    agent_name: agentId,
  });
  const withRole = roomAgentRepo.setWorkflowRole(agent.id, 'executor') ?? agent;
  const withAcp = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
  }) ?? withRole;
  return roomAgentRepo.setCapabilitiesAndRuntime(withAcp.id, {
    capabilities: withAcp.capabilities,
    default_runtime: withAcp.default_runtime,
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: writableDirs },
  }) ?? withAcp;
}

function createCompletedGraphAgentRun(roomId: string, input: RespondAsAgentInput, output: string) {
  const run = agentRunRepo.create({
    room_id: roomId,
    room_agent_id: input.agent.id,
    agent_id: input.agent.agent_id,
    backend: input.agent.acp_backend ?? 'codex',
    task_id: input.taskId ?? null,
    workflow_run_id: input.workflowRunId ?? null,
    workflow_step_id: input.workflowStepId ?? null,
    workflow_stage: input.workflowStage ?? null,
    prompt: input.prompt,
  });
  const completedRun = agentRunRepo.updateStatus(run.id, 'completed', { stdout: output }) ?? run;
  const message = messageRepo.create({
    room_id: roomId,
    sender_type: 'agent',
    sender_id: input.agent.agent_id,
    sender_name: input.agent.agent_name,
    content: output,
    message_type: 'agent_stream',
  });
  return {
    run: completedRun,
    message,
    status: 'completed' as const,
  };
}

async function waitForExecuteTest(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
