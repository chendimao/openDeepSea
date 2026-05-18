import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-runtime-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { messageRepo } = await import('../../repos/messages.js');
const { settingsRepo } = await import('../../repos/settings.js');
const { workflowDefinitionRepo } = await import('../../repos/workflow-definitions.js');
const { createGraphNodes } = await import('./nodes.js');
const { parseGraphState } = await import('./state.js');
const { createGraphTools } = await import('./tools.js');
const { createGraphWorkflowRun, enqueueGraphWorkflow, startGraphWorkflow } = await import('./runtime.js');
import type { RespondAsAgentInput } from '../../dispatcher.js';
import type { RoomAgent, WorkflowStage } from '../../types.js';

test('enqueueGraphWorkflow defers graph node execution until after the current turn', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-enqueue-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Enqueue', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Enqueue Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Enqueue without synchronous steps',
  });
  const run = createGraphWorkflowRun(task.id);

  enqueueGraphWorkflow(run.id, {
    planner: async () => ({
      goal: task.title,
      summary: 'Deferred planning',
      assumptions: [],
      tasks: [],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: true,
    }),
  });

  assert.equal(workflowRepo.listSteps(run.id).length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'context'));
});

test('startGraphWorkflow runs context and planning nodes into awaiting approval', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Plan with graph',
    description: 'Use graph shell to produce a plan artifact.',
  });

  const run = await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: 'Plan with graph',
      summary: 'Graph shell planning',
      assumptions: [],
      tasks: [{
        title: 'Implement shell',
        description: 'Create context and planning nodes',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Plan is persisted'],
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

  const detail = workflowRepo.detail(run.id);
  assert.equal(detail?.run.status, 'awaiting_approval');
  assert.equal(detail?.run.graph_version, 'phase-b-v1');
  assert.ok(detail?.run.graph_state);
  assert.ok(detail?.artifacts.some((artifact) => artifact.artifact_type === 'plan'));
  assert.ok(detail?.steps.some((step) => step.node_name === 'context'));
  assert.ok(detail?.steps.some((step) => step.node_name === 'planning'));
});

test('createGraphWorkflowRun records selected room workflow definition snapshot', () => {
  const projectPath = join(tmpdir(), `graph-runtime-definition-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Definition', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Definition Room' });
  const definition = workflowDefinitionRepo.publish(workflowDefinitionRepo.createDraft({
    name: 'Room Defined Workflow',
    description: null,
    scope: 'room',
    scope_id: room.id,
    definition: {
      nodes: [
        { id: 'planning', type: 'planning', label: 'Planning' },
        { id: 'approval', type: 'approval_gate', label: 'Approval' },
        { id: 'dispatch', type: 'dispatch', label: 'Dispatch' },
        { id: 'execute', type: 'execute', label: 'Execute' },
        { id: 'review', type: 'review', label: 'Review' },
        { id: 'repair', type: 'repair_decision', label: 'Repair' },
        { id: 'verify', type: 'verify', label: 'Verify' },
        { id: 'acceptance', type: 'acceptance', label: 'Acceptance' },
        { id: 'memory', type: 'memory', label: 'Memory' },
      ],
      edges: [
        { from: 'planning', to: 'approval' },
        { from: 'approval', to: 'dispatch', condition: 'approved' },
        { from: 'dispatch', to: 'execute' },
        { from: 'execute', to: 'execute', condition: 'has_runnable_child' },
        { from: 'execute', to: 'review', condition: 'review' },
        { from: 'review', to: 'repair', condition: 'changes_requested' },
        { from: 'review', to: 'verify', condition: 'pass' },
        { from: 'repair', to: 'execute', condition: 'execute' },
        { from: 'verify', to: 'acceptance', condition: 'acceptance' },
        { from: 'acceptance', to: 'memory', condition: 'completed' },
      ],
    },
  }).id);
  assert.ok(definition);
  settingsRepo.updateRoom(room.id, { default_workflow_definition_id: definition.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Record definition snapshot',
  });

  const run = createGraphWorkflowRun(task.id);

  assert.equal(run.workflow_definition_id, definition.id);
  assert.equal(run.workflow_definition_version, definition.version);
  assert.match(run.workflow_definition_snapshot ?? '', /Room Defined Workflow/);
});

test('startGraphWorkflow blocks workflow and fails running graph step when planner fails', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-failure-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Failure', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Failure Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Planner fails',
    description: 'Planner failure should not leave a running graph step.',
  });

  await assert.rejects(
    () => startGraphWorkflow(task.id, {
      planner: async () => {
        throw new Error('planner unavailable');
      },
    }),
    /planner unavailable/,
  );

  const run = workflowRepo.listByTask(task.id)[0];
  assert.equal(run?.status, 'blocked');
  assert.match(run?.error ?? '', /planner unavailable/);

  const detail = run ? workflowRepo.detail(run.id) : undefined;
  assert.ok(detail?.run.graph_state?.includes('"status":"blocked"'));
  assert.ok(detail?.run.graph_state?.includes('planner unavailable'));
  assert.equal(detail?.steps.some((step) => step.status === 'running'), false);
  assert.ok(detail?.steps.some((step) => step.node_name === 'planning' && step.status === 'failed'));
});

test('graph dispatch creates child tasks and assignment artifact after no-approval plan', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-dispatch-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Dispatch', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Dispatch Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Dispatch with graph',
    description: 'Create child tasks from no-approval plan.',
  });

  const run = await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: 'Dispatch with graph',
      summary: 'Create one child task',
      assumptions: [],
      tasks: [{
        title: 'Implement dispatch',
        description: 'Create child task and assignment artifact',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Child task is assigned'],
        scopeRead: ['packages/backend/src/workflows/graph/runtime.ts'],
        scopeWrite: ['packages/backend/src/workflows/graph/nodes.ts'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  const detail = workflowRepo.detail(run.id);
  const childTasks = taskRepo.listChildren(task.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);

  assert.ok(['implementation', 'review', 'verification', 'acceptance'].includes(detail?.run.current_stage ?? ''));
  assert.ok(detail?.artifacts.some((artifact) => artifact.artifact_type === 'assignment'));
  assert.equal(childTasks.length, 1);
  assert.equal(childTasks[0]?.assigned_agent_id, executor.id);
  assert.equal(graphState?.childTaskIds.length, 1);
});

test('graph dispatch assigns child tasks by frontend and backend scope hints', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-scope-dispatch-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Scope Dispatch', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Scope Dispatch Room' });
  const backend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(backend.id, {
    capabilities: ['backend', 'testing'],
    default_runtime: 'acp',
  });
  const frontend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(frontend.id, {
    capabilities: ['frontend', 'testing'],
    default_runtime: 'acp',
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Dispatch scoped tasks',
  });

  await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: 'Dispatch scoped tasks',
      summary: 'Create frontend and backend child tasks',
      assumptions: [],
      tasks: [
        {
          title: 'Update React page',
          description: 'Modify the room page component.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend page is updated'],
          scopeRead: ['packages/frontend/src/pages/RoomPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/RoomPage.tsx'],
          dependsOn: [],
        },
        {
          title: 'Update API route',
          description: 'Modify the backend route.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend route is updated'],
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
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  const children = taskRepo.listChildren(task.id);
  assert.equal(children.find((child) => child.title === 'Update React page')?.assigned_agent_id, frontend.id);
  assert.equal(children.find((child) => child.title === 'Update API route')?.assigned_agent_id, backend.id);
});

test('no-approval graph blocks instead of selecting non-ACP executor', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-non-acp-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Non ACP', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Non ACP Room' });
  const executor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'legacy-executor',
    agent_name: 'Legacy Executor',
  });
  roomAgentRepo.setWorkflowRole(executor.id, 'executor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Dispatch without ACP executor',
    description: 'Do not select legacy executors for ACP-only graph workflows.',
  });

  let calls = 0;
  const run = await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: 'Dispatch without ACP executor',
      summary: 'Create one child task',
      assumptions: [],
      tasks: [{
        title: 'Implement without legacy executor',
        description: 'This should block before agent execution',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['No non-ACP agent is invoked'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async () => {
      calls += 1;
      throw new Error('non-ACP executor should not run');
    },
  });

  const detail = workflowRepo.detail(run.id);
  const childTasks = taskRepo.listChildren(task.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);

  assert.equal(calls, 0);
  assert.equal(detail?.run.status, 'blocked');
  assert.match(detail?.run.error ?? '', /No executor available/);
  assert.equal(childTasks.length, 1);
  assert.equal(childTasks[0]?.assigned_agent_id, null);
  assert.equal(graphState?.status, 'blocked');
  assert.match(graphState?.error ?? '', /No executor available/);
});

test('dispatch node is idempotent when replayed with existing child task ids', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-dispatch-idempotent-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Dispatch Idempotent', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Dispatch Idempotent Room' });
  const executor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'executor-idempotent',
    agent_name: 'Executor Idempotent',
  });
  roomAgentRepo.setWorkflowRole(executor.id, 'executor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Dispatch idempotently',
    description: 'Replay dispatch without duplicate child tasks.',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    graph_version: 'phase-b-v1',
  });
  const state = {
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
    plan: {
      goal: 'Dispatch idempotently',
      summary: 'Create one child task once',
      assumptions: [],
      tasks: [{
        title: 'Implement once',
        description: 'Create exactly one child task',
        suggestedRole: 'executor' as const,
        priority: 'normal' as const,
        acceptance: ['Only one child task exists'],
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
    currentNode: 'approval' as const,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required' as const,
    status: 'running' as const,
    error: null,
  };
  const nodes = createGraphNodes(createGraphTools());

  const first = await nodes.dispatchNode(state);
  const second = await nodes.dispatchNode(first);

  assert.equal(taskRepo.listChildren(task.id).length, 1);
  assert.deepEqual(second.childTaskIds, first.childTaskIds);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'dispatch').length, 1);
  assert.equal(workflowRepo.listArtifacts(run.id).filter((artifact) => artifact.artifact_type === 'assignment').length, 1);
});

function addAcpWorkflowAgent(roomId: string, role: 'executor' | 'reviewer' | 'acceptor'): RoomAgent {
  const agent = roomAgentRepo.add({
    room_id: roomId,
    agent_id: `acp-${role}-${Date.now()}-${Math.random()}`,
    agent_name: `ACP ${role}`,
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

function createCompletedAgentRun(roomId: string, input: RespondAsAgentInput) {
  const content = outputForStage(input.workflowStage);
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
  const completedRun = agentRunRepo.updateStatus(run.id, 'completed', { stdout: content }) ?? run;
  const message = messageRepo.create({
    room_id: roomId,
    sender_type: 'agent',
    sender_id: input.agent.agent_id,
    sender_name: input.agent.agent_name,
    content,
    message_type: 'agent_stream',
  });
  return Promise.resolve({ run: completedRun, message, status: 'completed' as const });
}

function outputForStage(stage: WorkflowStage | null | undefined): string {
  if (stage === 'code_review') {
    return JSON.stringify({
      verdict: 'pass',
      findings: [],
      requiredFixes: [],
      riskLevel: 'low',
    });
  }
  if (stage === 'acceptance') {
    return JSON.stringify({
      verdict: 'pass',
      acceptedCriteria: ['Workflow completed'],
      failedCriteria: [],
      notes: 'Accepted.',
    });
  }
  return 'implementation output from ACP-only executor';
}
