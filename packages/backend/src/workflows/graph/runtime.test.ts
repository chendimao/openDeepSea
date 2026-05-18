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
import type { ParsedPlan } from '../plan-parser.js';
import type { RoomAgent, WorkflowDefinitionGraph, WorkflowStage } from '../../types.js';

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

test('planning node passes planner and workflow skill context to graph planner', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-planner-skills-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Planner Skills', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Planner Skills Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Plan with runtime skills',
  });
  let capturedSkillContext = '';
  const run = await startGraphWorkflow(task.id, {
    buildSkillContext: async (input) => {
      assert.deepEqual(input.runtimeScopes, ['planner', 'workflow']);
      assert.equal(input.projectId, project.id);
      assert.equal(input.roomId, room.id);
      assert.match(input.message ?? '', /Plan with runtime skills/);
      return 'OpenDeepSea active skills for this runtime:\nSkill: graph-planner-skill';
    },
    planner: async (_input, options) => {
      capturedSkillContext = options?.skillContext ?? '';
      return createApprovalPlan(task.title);
    },
  });

  assert.equal(workflowRepo.detail(run.id)?.run.status, 'awaiting_approval');
  assert.match(capturedSkillContext, /Skill: graph-planner-skill/);
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
    definition: createTestWorkflowDefinition(),
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

test('startGraphWorkflow passes workflow skill context to supervisor model', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-skills-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Skills', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Skills Room' });
  const workflow = createPublishedRoomWorkflow(room.id, 'Supervisor Skills Workflow');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Choose workflow with skills',
  });
  let capturedSkillContext = '';

  const run = await startGraphWorkflow(task.id, {
    buildSkillContext: async (input) => {
      if (input.runtimeScopes.length === 1 && input.runtimeScopes[0] === 'workflow') {
        assert.equal(input.projectId, project.id);
        assert.equal(input.roomId, room.id);
        assert.match(input.message ?? '', /Choose workflow with skills/);
        return 'OpenDeepSea active skills for this runtime:\nSkill: workflow-supervisor-skill';
      }
      return '';
    },
    supervisor: async (_input, options) => {
      capturedSkillContext = options?.skillContext ?? '';
      return {
        mode: 'select_existing_workflow',
        workflowDefinitionId: workflow.id,
        confidence: 0.91,
        reason: 'The workflow skill selected this workflow.',
        assignments: [],
        fallbackMode: 'default_workflow',
      };
    },
    planner: async () => createApprovalPlan(task.title),
  });

  assert.equal(run.workflow_definition_id, workflow.id);
  assert.match(capturedSkillContext, /Skill: workflow-supervisor-skill/);
});

test('startGraphWorkflow uses high-confidence supervisor workflow choice', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-choice-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Choice', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Choice Room' });
  const selected = createPublishedRoomWorkflow(room.id, 'Supervisor Selected Workflow');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Choose workflow dynamically',
  });

  const run = await startGraphWorkflow(task.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: selected.id,
      confidence: 0.91,
      reason: 'The selected workflow matches the task.',
      assignments: [],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => createApprovalPlan(task.title),
  });
  const snapshot = JSON.parse(run.workflow_definition_snapshot ?? '{}') as { supervisorDecision?: { reason?: string } };

  assert.equal(run.workflow_definition_id, selected.id);
  assert.match(run.workflow_definition_snapshot ?? '', /Supervisor Selected Workflow/);
  assert.equal(snapshot.supervisorDecision?.reason, 'The selected workflow matches the task.');
});

test('startGraphWorkflow falls back to default workflow on low confidence, invisible workflow, and supervisor failure', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-fallback-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Fallback', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Fallback Room' });
  const defaultDefinition = createPublishedRoomWorkflow(room.id, 'Room Default Workflow');
  const selected = createPublishedRoomWorkflow(room.id, 'Low Confidence Workflow');
  settingsRepo.updateRoom(room.id, { default_workflow_definition_id: defaultDefinition.id });

  const lowConfidenceTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Low confidence task',
  });
  const lowConfidenceRun = await startGraphWorkflow(lowConfidenceTask.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: selected.id,
      confidence: 0.5,
      reason: 'Not confident enough.',
      assignments: [],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => createApprovalPlan(lowConfidenceTask.title),
  });
  assert.equal(lowConfidenceRun.workflow_definition_id, defaultDefinition.id);

  const invisibleTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Invisible workflow task',
  });
  const invisibleRun = await startGraphWorkflow(invisibleTask.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: 'missing-workflow',
      confidence: 0.95,
      reason: 'Bad id.',
      assignments: [],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => createApprovalPlan(invisibleTask.title),
  });
  assert.equal(invisibleRun.workflow_definition_id, defaultDefinition.id);

  const failedTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Supervisor failure task',
  });
  const failedRun = await startGraphWorkflow(failedTask.id, {
    supervisor: async () => {
      throw new Error('supervisor unavailable');
    },
    planner: async () => createApprovalPlan(failedTask.title),
  });
  assert.equal(failedRun.workflow_definition_id, defaultDefinition.id);
});

test('supervisor assignment hint can assign implementation child task to executable agent', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-assignment-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Assignment', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Assignment Room' });
  const defaultExecutor = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(defaultExecutor.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
  });
  const hintedExecutor = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(hintedExecutor.id, {
    capabilities: ['frontend'],
    default_runtime: 'acp',
  });
  const workflow = createPublishedRoomWorkflow(room.id, 'Supervisor Assignment Workflow');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Use supervisor assignment hint',
  });

  await startGraphWorkflow(task.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: workflow.id,
      confidence: 0.92,
      reason: 'Workflow and executor are suitable.',
      assignments: [{
        stage: 'implementation',
        role: 'executor',
        agentId: hintedExecutor.id,
        reason: 'Prefer frontend executor.',
      }],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => ({
      ...createApprovalPlan(task.title),
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  const child = taskRepo.listChildren(task.id)[0];
  assert.equal(child?.assigned_agent_id, hintedExecutor.id);
});

test('supervisor assignment hint ignores non-executable agent and falls back to resolver', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-assignment-fallback-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Assignment Fallback', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Assignment Fallback Room' });
  const fallbackExecutor = addAcpWorkflowAgent(room.id, 'executor');
  const nonExecutable = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'non-executable-hint',
    agent_name: 'Non Executable Hint',
  });
  roomAgentRepo.setWorkflowRole(nonExecutable.id, 'executor');
  const workflow = createPublishedRoomWorkflow(room.id, 'Supervisor Assignment Fallback Workflow');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Ignore invalid supervisor assignment hint',
  });

  await startGraphWorkflow(task.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: workflow.id,
      confidence: 0.92,
      reason: 'Workflow is suitable but assignment is invalid.',
      assignments: [{
        stage: 'implementation',
        role: 'executor',
        agentId: nonExecutable.id,
        reason: 'This agent is not ACP executable.',
      }],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => ({
      ...createApprovalPlan(task.title),
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  const child = taskRepo.listChildren(task.id)[0];
  assert.equal(child?.assigned_agent_id, fallbackExecutor.id);
});

test('graph workflow invites required built-in agents when the room only has planner', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-auto-invite-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Auto Invite', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Auto Invite Room' });
  roomAgentRepo.ensureDefaultPlanner(room.id);
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Auto invite workflow agents',
  });
  const calls: Array<{ agentId: string; stage: WorkflowStage | null | undefined }> = [];

  await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: 'Auto invite workflow agents',
      summary: 'Create frontend and backend work items',
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
    runAcpAgent: async (input) => {
      calls.push({ agentId: input.agent.agent_id, stage: input.workflowStage });
      return createCompletedAgentRun(room.id, input);
    },
  });

  const agents = roomAgentRepo.listByRoom(room.id);
  assert.deepEqual(
    agents.map((agent) => agent.agent_id),
    ['planner', 'frontend-executor', 'backend-executor', 'reviewer', 'acceptor'],
  );
  const children = taskRepo.listChildren(task.id);
  assert.equal(
    children.find((child) => child.title === 'Update React page')?.assigned_agent_id,
    agents.find((agent) => agent.agent_id === 'frontend-executor')?.id,
  );
  assert.equal(
    children.find((child) => child.title === 'Update API route')?.assigned_agent_id,
    agents.find((agent) => agent.agent_id === 'backend-executor')?.id,
  );
  assert.deepEqual(
    calls.map((call) => `${call.stage}:${call.agentId}`),
    [
      'implementation:frontend-executor',
      'implementation:backend-executor',
      'code_review:reviewer',
      'acceptance:acceptor',
    ],
  );
});

test('supervisor assignment hint is ignored when multiple executor tasks would make it ambiguous', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-assignment-ambiguous-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Assignment Ambiguous', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Assignment Ambiguous Room' });
  const backend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(backend.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const frontend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(frontend.id, {
    capabilities: ['frontend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/frontend'] },
  });
  const workflow = createPublishedRoomWorkflow(room.id, 'Supervisor Assignment Ambiguous Workflow');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Ignore ambiguous supervisor assignment hint',
  });

  await startGraphWorkflow(task.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: workflow.id,
      confidence: 0.92,
      reason: 'Workflow is suitable but assignment is ambiguous.',
      assignments: [{
        stage: 'implementation',
        role: 'executor',
        agentId: frontend.id,
        reason: 'This hint is not task-specific.',
      }],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => ({
      goal: task.title,
      summary: 'Create frontend and backend child tasks',
      assumptions: [],
      tasks: [
        {
          title: 'Update React page',
          description: 'Modify packages/frontend.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend updated'],
          scopeRead: ['packages/frontend/src/pages/RoomPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/RoomPage.tsx'],
          dependsOn: [],
        },
        {
          title: 'Update API route',
          description: 'Modify packages/backend.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend updated'],
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

test('supervisor assignment hint ignores scope mismatch and falls back to resolver', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-assignment-scope-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Assignment Scope', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Assignment Scope Room' });
  const backend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(backend.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const frontend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(frontend.id, {
    capabilities: ['frontend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/frontend'] },
  });
  const workflow = createPublishedRoomWorkflow(room.id, 'Supervisor Assignment Scope Workflow');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Ignore mismatched supervisor assignment hint',
  });

  await startGraphWorkflow(task.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: workflow.id,
      confidence: 0.92,
      reason: 'Workflow is suitable but assignment scope is wrong.',
      assignments: [{
        stage: 'implementation',
        role: 'executor',
        agentId: frontend.id,
        reason: 'Incorrectly suggested frontend for backend route.',
      }],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => ({
      ...createApprovalPlan(task.title),
      tasks: [{
        title: 'Update API route',
        description: 'Modify the backend route.',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Backend route is updated'],
        scopeRead: ['packages/backend/src/routes.ts'],
        scopeWrite: ['packages/backend/src/routes.ts'],
        dependsOn: [],
      }],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  const child = taskRepo.listChildren(task.id)[0];
  assert.equal(child?.assigned_agent_id, backend.id);
});

test('supervisor assignment hint ignores executor without matching runtime write boundary', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-runtime-boundary-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Runtime Boundary', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Runtime Boundary Room' });
  const writableBackend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(writableBackend.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const readOnlyBackend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(readOnlyBackend.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const workflow = createPublishedRoomWorkflow(room.id, 'Supervisor Runtime Boundary Workflow');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Ignore runtime-ineligible supervisor assignment hint',
  });

  await startGraphWorkflow(task.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: workflow.id,
      confidence: 0.92,
      reason: 'Workflow is suitable but assignment runtime boundary is wrong.',
      assignments: [{
        stage: 'implementation',
        role: 'executor',
        agentId: readOnlyBackend.id,
        reason: 'Incorrectly suggested executor without write tool.',
      }],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => ({
      ...createApprovalPlan(task.title),
      tasks: [{
        title: 'Update API route',
        description: 'Modify the backend route.',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Backend route is updated'],
        scopeRead: ['packages/backend/src/routes.ts'],
        scopeWrite: ['packages/backend/src/routes.ts'],
        dependsOn: [],
      }],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  const child = taskRepo.listChildren(task.id)[0];
  assert.equal(child?.assigned_agent_id, writableBackend.id);
});

test('startGraphWorkflow does not call supervisor when task already has active workflow', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-active-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Active Guard', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Active Guard Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Already active workflow',
  });
  createGraphWorkflowRun(task.id);

  let calls = 0;
  await assert.rejects(
    () => startGraphWorkflow(task.id, {
      supervisor: async () => {
        calls += 1;
        throw new Error('supervisor should not be called');
      },
      planner: async () => createApprovalPlan(task.title),
    }),
    /task already has an active workflow/,
  );
  assert.equal(calls, 0);
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
  roomAgentRepo.setCapabilitiesAndRuntime(executor.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
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
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const frontend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(frontend.id, {
    capabilities: ['frontend', 'testing'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/frontend'] },
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

test('no-approval graph invites built-in executor instead of selecting non-ACP executor', async () => {
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

  let implementationAgentId: string | null = null;
  const run = await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: 'Dispatch without ACP executor',
      summary: 'Create one child task',
      assumptions: [],
      tasks: [{
        title: 'Implement without legacy executor',
        description: 'This should invite a built-in executor before agent execution',
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
    runAcpAgent: async (input) => {
      if (input.workflowStage === 'implementation') implementationAgentId = input.agent.agent_id;
      return createCompletedAgentRun(room.id, input);
    },
  });

  const detail = workflowRepo.detail(run.id);
  const childTasks = taskRepo.listChildren(task.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);

  assert.ok(['backend-executor', 'frontend-executor'].includes(implementationAgentId ?? ''));
  assert.equal(detail?.run.status, 'completed');
  assert.equal(childTasks.length, 1);
  assert.equal(
    childTasks[0]?.assigned_agent_id,
    roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === implementationAgentId)?.id,
  );
  assert.equal(graphState?.status, 'completed');
});

test('graph execute invites matching executor instead of falling back outside runtime boundary', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-unassigned-write-boundary-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Unassigned Write Boundary', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Unassigned Write Boundary Room' });
  const backend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(backend.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Do not fallback outside write boundary',
  });

  let implementationAgentId: string | null = null;
  const run = await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: 'Do not fallback outside write boundary',
      summary: 'Create one frontend child task without eligible existing executor',
      assumptions: [],
      tasks: [{
        title: 'Update React page',
        description: 'Modify frontend page.',
        suggestedRole: 'executor' as const,
        priority: 'normal' as const,
        acceptance: ['Frontend page is updated'],
        scopeRead: ['packages/frontend/src/pages/RoomPage.tsx'],
        scopeWrite: ['packages/frontend/src/pages/RoomPage.tsx'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => {
      if (input.workflowStage === 'implementation') implementationAgentId = input.agent.agent_id;
      return createCompletedAgentRun(room.id, input);
    },
  });

  const detail = workflowRepo.detail(run.id);
  const childTasks = taskRepo.listChildren(task.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);

  assert.equal(implementationAgentId, 'frontend-executor');
  assert.equal(detail?.run.status, 'completed');
  assert.equal(childTasks.length, 1);
  assert.equal(
    childTasks[0]?.assigned_agent_id,
    roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'frontend-executor')?.id,
  );
  assert.equal(graphState?.status, 'completed');
});

test('graph execute blocks assigned write task when assigned executor is outside runtime boundary', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-assigned-write-boundary-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Assigned Write Boundary', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Assigned Write Boundary Room' });
  const backend = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(backend.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Assigned executor must respect write boundary',
  });
  const child = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: 'Update React page',
    description: 'Modify frontend page.',
    priority: 'normal',
    assigned_agent_id: backend.id,
    created_from: 'workflow_assignment',
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
      goal: 'Assigned executor must respect write boundary',
      summary: 'Create one frontend child task with invalid assigned executor',
      assumptions: [],
      tasks: [{
        title: 'Update React page',
        description: 'Modify frontend page.',
        suggestedRole: 'executor' as const,
        priority: 'normal' as const,
        acceptance: ['Frontend page is updated'],
        scopeRead: ['packages/frontend/src/pages/RoomPage.tsx'],
        scopeWrite: ['packages/frontend/src/pages/RoomPage.tsx'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    currentNode: 'dispatch' as const,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [child.id],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required' as const,
    status: 'running' as const,
    error: null,
  };

  let calls = 0;
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async () => {
      calls += 1;
      throw new Error('assigned backend executor should not run frontend write task');
    },
  }));
  const nextState = await nodes.executeNode(state);

  const detail = workflowRepo.detail(run.id);
  const childTasks = taskRepo.listChildren(task.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);

  assert.equal(calls, 0);
  assert.equal(detail?.run.status, 'blocked');
  assert.match(detail?.run.error ?? '', /No executor available/);
  assert.equal(childTasks.length, 1);
  assert.equal(childTasks[0]?.assigned_agent_id, backend.id);
  assert.equal(nextState.status, 'blocked');
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

function createPublishedRoomWorkflow(roomId: string, name: string) {
  const draft = workflowDefinitionRepo.createDraft({
    name,
    description: null,
    scope: 'room',
    scope_id: roomId,
    definition: createTestWorkflowDefinition(),
  });
  const published = workflowDefinitionRepo.publish(draft.id);
  if (!published) throw new Error(`failed to publish workflow ${name}`);
  return published;
}

function createApprovalPlan(title: string): ParsedPlan {
  return {
    goal: title,
    summary: `Plan for ${title}`,
    assumptions: [],
    tasks: [{
      title: 'Implement selected workflow task',
      description: 'Use the selected workflow definition.',
      suggestedRole: 'executor',
      priority: 'normal',
      acceptance: ['Workflow definition is selected'],
      scopeRead: [],
      scopeWrite: [],
      dependsOn: [],
    }],
    reviewFocus: [],
    verification: [],
    verificationCommands: [],
    risks: [],
    needsApproval: true,
  };
}

function createTestWorkflowDefinition(): WorkflowDefinitionGraph {
  return {
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
  };
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
