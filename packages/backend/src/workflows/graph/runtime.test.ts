import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-runtime-')), 'test.db');

const { db } = await import('../../db.js');
const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { workflowArtifactVersionRepo } = await import('../../repos/workflows.js');
const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { messageRepo } = await import('../../repos/messages.js');
const { settingsRepo } = await import('../../repos/settings.js');
const { taskEventRepo } = await import('../../repos/task-events.js');
const { workflowDefinitionRepo } = await import('../../repos/workflow-definitions.js');
const { createGraphNodes } = await import('./nodes.js');
const { emptyAgentWorkflowState, parseGraphState, serializeGraphState } = await import('./state.js');
const { createGraphTools } = await import('./tools.js');
const { approveGraphWorkflow, continueGraphWorkflow, createGraphWorkflowRun, enqueueGraphWorkflow, retryGraphWorkflow, startGraphWorkflow } = await import('./runtime.js');
const { SUPERPOWERS_GRAPH_VERSION } = await import('./superpowers-runtime.js');
const { setVerificationCommandRunnerForTests } = await import('./verification.js');
const { parsePlanArtifact } = await import('../plan-parser.js');
import type { RespondAsAgentInput } from '../../dispatcher.js';
import type { ParsedPlan } from '../plan-parser.js';
import type { RoomAgent, WorkflowDefinitionGraph, WorkflowRun, WorkflowStage } from '../../types.js';

setVerificationCommandRunnerForTests(async (command) => ({
  command,
  status: 'passed',
  exitCode: 0,
  stdout: 'stubbed verification passed',
  stderr: '',
}));
test.after(() => setVerificationCommandRunnerForTests(null));

const lowConfidenceSupervisor = async () => ({
  mode: 'use_default_workflow' as const,
  workflowDefinitionId: null,
  confidence: 0.1,
  reason: 'Use default Superpowers workflow in tests.',
  assignments: [],
  fallbackMode: 'default_workflow' as const,
});

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
  const run = createLegacyGraphWorkflowRun({
    projectId: project.id,
    projectPath: project.path,
    roomId: room.id,
    taskId: task.id,
    taskTitle: task.title,
  });

  enqueueGraphWorkflow(run.id, {
    planner: async () => ({
      goal: task.title,
      summary: 'Deferred planning',
      assumptions: [],
      tasks: [],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
      risks: [],
      needsApproval: true,
    }),
  });

  assert.equal(workflowRepo.listSteps(run.id).length, 0);
  await waitForGraphRuntime(() => workflowRepo.listSteps(run.id).length > 0);
  assert.ok(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'planning'));
});

test('enqueueGraphWorkflow retries background errors with configured backoff delays', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-enqueue-retry-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Enqueue Retry', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Enqueue Retry Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Retry transient planner error',
  });
  const run = createLegacyGraphWorkflowRun({
    projectId: project.id,
    projectPath: project.path,
    roomId: room.id,
    taskId: task.id,
    taskTitle: task.title,
  });
  const scheduled: Array<{ delayMs: number; retry: () => void }> = [];
  let plannerCalls = 0;

  enqueueGraphWorkflow(run.id, {
    planner: async () => {
      plannerCalls += 1;
      if (plannerCalls < 3) throw new Error(`planner transient ${plannerCalls}`);
      return createApprovalPlan(task.title);
    },
    scheduleRetry: (input, retry) => {
      scheduled.push({ delayMs: input.delayMs, retry });
    },
  });

  await waitForGraphRuntime(() => plannerCalls === 1 && scheduled.length === 1);
  assert.equal(plannerCalls, 1);
  assert.equal(workflowRepo.getRun(run.id)?.status, 'running');
  assert.deepEqual(scheduled.map((item) => item.delayMs), [10_000]);

  scheduled[0]!.retry();
  await waitForGraphRuntime(() => plannerCalls === 2 && scheduled.length === 2);
  assert.equal(plannerCalls, 2);
  assert.equal(workflowRepo.getRun(run.id)?.status, 'running');
  assert.deepEqual(scheduled.map((item) => item.delayMs), [10_000, 20_000]);

  scheduled[1]!.retry();
  await waitForGraphRuntime(() => plannerCalls === 3);

  const latest = workflowRepo.getRun(run.id);
  const state = parseGraphState(latest?.graph_state ?? null);
  assert.equal(plannerCalls, 3);
  assert.equal(latest?.status, 'awaiting_approval');
  assert.equal(state?.status, 'awaiting_approval');
  assert.equal(state?.plan?.summary, `Plan for ${task.title}`);
  assert.equal(workflowRepo.listSteps(run.id).some((step) => step.status === 'running'), false);
  assert.deepEqual(scheduled.map((item) => item.delayMs), [10_000, 20_000]);
});

test('enqueueGraphWorkflow blocks background errors after retry backoff is exhausted', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-enqueue-retry-exhausted-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Enqueue Retry Exhausted', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Enqueue Retry Exhausted Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Retry exhausted planner error',
  });
  const run = createLegacyGraphWorkflowRun({
    projectId: project.id,
    projectPath: project.path,
    roomId: room.id,
    taskId: task.id,
    taskTitle: task.title,
  });
  const scheduled: Array<{ delayMs: number; retry: () => void }> = [];
  let plannerCalls = 0;

  enqueueGraphWorkflow(run.id, {
    planner: async () => {
      plannerCalls += 1;
      throw new Error(`planner unavailable ${plannerCalls}`);
    },
    scheduleRetry: (input, retry) => {
      scheduled.push({ delayMs: input.delayMs, retry });
    },
  });

  await waitForGraphRuntime(() => plannerCalls === 1 && scheduled.length === 1);
  for (let index = 0; index < 4; index += 1) {
    scheduled[index]!.retry();
    await waitForGraphRuntime(() =>
      plannerCalls === index + 2 &&
      (index < 3 ? scheduled.length === index + 2 : workflowRepo.getRun(run.id)?.status === 'blocked'),
    );
  }

  const latest = workflowRepo.getRun(run.id);
  const state = parseGraphState(latest?.graph_state ?? null);

  assert.equal(plannerCalls, 5);
  assert.deepEqual(scheduled.map((item) => item.delayMs), [10_000, 20_000, 40_000, 120_000]);
  assert.equal(latest?.status, 'blocked');
  assert.match(latest?.error ?? '', /planner unavailable 5/);
  assert.equal(state?.status, 'blocked');
  assert.equal(workflowRepo.listSteps(run.id).some((step) => step.status === 'running'), false);
});

test('startGraphWorkflow runs context and planning nodes into spec artifact approval gate', async () => {
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
    supervisor: lowConfidenceSupervisor,
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
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
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
      risks: [],
      needsApproval: true,
    }),
  });

  const detail = workflowRepo.detail(run.id);
  assert.equal(detail?.run.status, 'awaiting_approval');
  assert.equal(detail?.run.error, null);
  assert.equal(detail?.run.graph_version, SUPERPOWERS_GRAPH_VERSION);
  assert.ok(detail?.run.graph_state);
  assert.ok(workflowArtifactVersionRepo.listByRun(run.id).some((artifact) => artifact.artifact_type === 'spec'));
  assert.ok(detail?.steps.some((step) => step.node_name === 'context'));
  assert.ok(listRawStepNodeNames(run.id).includes('brainstorming'));
  assert.equal(listRawStepNodeNames(run.id).includes('writing_plans'), false);
});

test('planning node omits legacy skill context for graph planner', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-planner-skills-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Planner Skills', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Planner Skills Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Plan with runtime skills',
  });
  const run = createLegacyGraphWorkflowRun({
    projectId: project.id,
    projectPath: project.path,
    roomId: room.id,
    taskId: task.id,
    taskTitle: task.title,
  });
  const state = parseGraphState(run.graph_state);
  assert.ok(state);
  let plannerCalled = false;

  const nodes = createGraphNodes(createGraphTools({
    planner: async (_input, options) => {
      plannerCalled = true;
      assert.equal(Object.hasOwn(options ?? {}, 'skillContext'), false);
      return createApprovalPlan(task.title);
    },
  }));
  const nextState = await nodes.planningNode(state);

  assert.ok(nextState.plan);
  assert.equal(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'planning'), true);
  assert.equal(plannerCalled, true);
});

test('low-risk README docs plan passes approval gate without awaiting approval', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-low-risk-docs-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Low Risk Docs', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Low Risk Docs Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Update README docs',
    description: 'Clarify setup notes in README only.',
  });
  const run = createLegacyGraphWorkflowRun({
    projectId: project.id,
    projectPath: project.path,
    roomId: room.id,
    taskId: task.id,
    taskTitle: task.title,
  });
  const state = parseGraphState(run.graph_state);
  assert.ok(state);

  const nodes = createGraphNodes(createGraphTools({
    planner: async () => ({
      goal: task.title,
      summary: 'Update README setup documentation.',
      assumptions: ['Docs-only update.'],
      tasks: [{
        title: 'Document setup command',
        description: 'Edit README setup instructions.',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['README includes the setup command'],
        scopeRead: ['README.md'],
        scopeWrite: ['README.md'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'minimum docs validation', required: true },
      ],
      risks: [],
      needsApproval: false,
    }),
  }));

  const plannedState = await nodes.planningNode(state);
  const approvedState = await nodes.approvalNode(plannedState);
  const latestRun = workflowRepo.getRun(run.id);
  const persistedState = parseGraphState(latestRun?.graph_state ?? null);
  const planArtifact = workflowRepo.listArtifacts(run.id).find((artifact) => artifact.artifact_type === 'plan');
  const planMetadata = parseArtifactMetadata(planArtifact);

  assert.equal(approvedState.riskAssessment?.riskLevel, 'low');
  assert.equal(approvedState.plan?.riskLevel, 'low');
  assert.equal(approvedState.plan?.taskKind, 'docs_only');
  assert.equal(approvedState.plan?.needsApproval, false);
  assert.equal(approvedState.approvalCard, null);
  assert.equal(approvedState.approval, 'not_required');
  assert.equal(latestRun?.status, 'running');
  assert.notEqual(latestRun?.status, 'awaiting_approval');
  assert.equal(persistedState?.riskAssessment?.riskLevel, 'low');
  assert.equal(planMetadata.risk_assessment?.riskLevel, 'low');
  assert.equal(planMetadata.approval_card, null);
});

test('approved plan artifact lets medium-risk Superpowers workflow continue past approval gate', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-medium-risk-workflow-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Medium Risk Workflow', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Medium Risk Workflow Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Connect frontend workflow approval panel to backend events',
    description: 'Update workflow UI and backend graph handling together.',
  });
  const agentRunStages: Array<WorkflowStage | null | undefined> = [];

  const run = await startGraphWorkflowAfterArtifactApprovals(task.id, {
    supervisor: lowConfidenceSupervisor,
    planner: async () => ({
      goal: task.title,
      summary: 'Wire frontend approval panel to backend workflow events.',
      assumptions: ['Existing API shape remains compatible.'],
      tasks: [
        {
          title: 'Update workflow approval UI',
          description: 'Render approval state from workflow events.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend shows approval card metadata'],
          scopeRead: ['packages/frontend/src/pages/WorkflowPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/WorkflowPage.tsx'],
          dependsOn: [],
        },
        {
          title: 'Update backend workflow event metadata',
          description: 'Persist approval card metadata on workflow events.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend stores workflow approval metadata'],
          scopeRead: ['packages/backend/src/workflows/graph/nodes.ts'],
          scopeWrite: ['packages/backend/src/workflows/graph/nodes.ts'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'fullstack validation', required: true },
      ],
      risks: ['Frontend/backend workflow metadata must stay aligned.'],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => {
      agentRunStages.push(input.workflowStage);
      return createCompletedAgentRun(room.id, input);
    },
  });

  const latestRun = workflowRepo.getRun(run.id);
  const state = parseGraphState(latestRun?.graph_state ?? null);
  const planArtifact = workflowRepo.listArtifacts(run.id).find((artifact) => artifact.artifact_type === 'plan');
  const planMetadata = parseArtifactMetadata(planArtifact);

  assert.notEqual(latestRun?.status, 'awaiting_approval');
  assert.equal(state?.approval, 'approved');
  assert.equal(state?.riskAssessment?.riskLevel, 'medium');
  assert.equal(state?.approvalCard?.riskLevel, 'medium');
  assert.equal(state?.plan?.needsApproval, true);
  assert.equal(planMetadata.approval_card?.riskLevel, 'medium');
  assert.ok(agentRunStages.some((stage) => stage === 'implementation'));
  assert.equal(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'dispatch'), true);
});

test('planner risk metadata is preserved while missing fields are filled by risk assessment', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-explicit-risk-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Explicit Risk', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Explicit Risk Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Review backend workflow schema',
    description: 'Adjust backend workflow schema handling.',
  });
  const run = createLegacyGraphWorkflowRun({
    projectId: project.id,
    projectPath: project.path,
    roomId: room.id,
    taskId: task.id,
    taskTitle: task.title,
  });
  const state = parseGraphState(run.graph_state);
  assert.ok(state);

  const nodes = createGraphNodes(createGraphTools({
    planner: async () => ({
      goal: task.title,
      summary: 'Review and adjust backend workflow schema handling.',
      taskKind: 'code_review',
      riskLevel: 'high',
      assumptions: [],
      tasks: [{
        title: 'Inspect workflow schema',
        description: 'Read backend workflow schema and propose updates.',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Workflow schema behavior is validated'],
        scopeRead: ['packages/backend/src/workflows/graph/state.ts'],
        scopeWrite: ['packages/backend/src/workflows/graph/nodes.ts'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'backend validation', required: true },
      ],
      risks: [],
      needsApproval: false,
    }),
  }));

  const plannedState = await nodes.planningNode(state);
  const planArtifact = workflowRepo.listArtifacts(run.id).find((artifact) => artifact.artifact_type === 'plan');
  const planMetadata = parseArtifactMetadata(planArtifact);

  assert.equal(plannedState.riskAssessment?.riskLevel, 'medium');
  assert.equal(plannedState.plan?.taskKind, 'code_review');
  assert.equal(plannedState.plan?.riskLevel, 'high');
  assert.equal(plannedState.plan?.approvalReason, 'workflow/shared contract schema or types changes require approval');
  assert.equal(plannedState.plan?.needsApproval, true);
  assert.equal(planMetadata.risk_assessment?.riskLevel, 'medium');
  assert.equal(planMetadata.taskKind, 'code_review');
  assert.equal(planMetadata.riskLevel, 'high');
  assert.equal(planMetadata.approvalReason, 'workflow/shared contract schema or types changes require approval');
});

test('Superpowers run records planning gate steps before dispatch', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-gates-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Gates', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Gates Room' });
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
    title: 'Run Superpowers gates before dispatch',
  });

  const run = await startGraphWorkflowAfterApproval(task.id, {
    supervisor: lowConfidenceSupervisor,
    planner: async () => ({
      ...createApprovalPlan(task.title),
      tasks: [{
        title: 'Implement gated dispatch',
        description: 'Dispatch only after Superpowers planning gates.',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Dispatch runs after plan review'],
        scopeRead: ['packages/backend/src/workflows/graph/runtime.ts'],
        scopeWrite: ['packages/backend/src/workflows/graph/runtime.ts'],
        dependsOn: [],
      }],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  const nodeNames = listRawStepNodeNames(run.id);
  assertOrderedSubsequence(nodeNames, [
    'context',
    'brainstorming',
    'worktree',
    'writing_plans',
    'dispatch',
    'tdd_execute',
  ]);
  assert.equal(nodeNames.includes('execute'), false);
});

test('Superpowers planning route requires approved spec and invokes planner phases once', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-single-planner-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Single Planner', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Single Planner Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Run Superpowers planner phases once',
  });
  const run = createGraphWorkflowRun(task.id);
  const planningCalls: string[] = [];

  const latest = await continueGraphWorkflow(run.id, {
    planner: async () => createApprovalPlan(task.title),
    runAcpAgent: async (input) => {
      if (input.workflowStage === 'planning') {
        planningCalls.push(input.prompt);
      }
      return createCompletedAgentRun(room.id, input);
    },
  });

  assert.equal(latest.status, 'awaiting_approval');
  assert.equal(latest.error, null);
  assert.equal(planningCalls.length, 1);
  assert.match(planningCalls[0] ?? '', /当前 Superpowers 阶段：brainstorming/);
  const state = parseGraphState(latest.graph_state);
  assert.ok(state?.draftSpecArtifactVersionId);
  assert.equal(state?.draftPlanArtifactVersionId, null);

  const approvedSpec = workflowArtifactVersionRepo.approve(state.draftSpecArtifactVersionId, { approved_by: 'test' });
  assert.ok(approvedSpec);
  workflowRepo.updateRun(run.id, { status: 'running', error: null });
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...state,
    approvedSpecArtifactVersionId: approvedSpec.id,
    draftSpecArtifactVersionId: null,
    status: 'running',
    error: null,
  }));

  const resumed = await continueGraphWorkflow(run.id, {
    planner: async () => createApprovalPlan(task.title),
    runAcpAgent: async (input) => {
      if (input.workflowStage === 'planning') {
        planningCalls.push(input.prompt);
      }
      return createCompletedAgentRun(room.id, input);
    },
  });

  assert.equal(resumed.status, 'awaiting_approval');
  assert.equal(resumed.error, null);
  assert.equal(planningCalls.length, 2);
  assert.match(planningCalls[1] ?? '', /当前 Superpowers 阶段：writing_plans/);
  assert.ok(parseGraphState(resumed.graph_state)?.draftPlanArtifactVersionId);
});

test('Superpowers writing plans canonicalizes fallback planner output back into the draft artifact', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-canonical-plan-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Canonical Plan', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Canonical Plan Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Canonicalize fallback plan artifact',
  });
  const run = createGraphWorkflowRun(task.id);

  const specBlockedRun = await continueGraphWorkflow(run.id, {
    planner: async () => createApprovalPlan(task.title),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const specBlockedState = parseGraphState(specBlockedRun.graph_state);
  assert.ok(specBlockedState?.draftSpecArtifactVersionId);
  const approvedSpec = workflowArtifactVersionRepo.approve(specBlockedState.draftSpecArtifactVersionId, {
    approved_by: 'test',
  });
  assert.ok(approvedSpec);
  workflowRepo.updateRun(run.id, { status: 'running', error: null });
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...specBlockedState,
    approvedSpecArtifactVersionId: approvedSpec.id,
    draftSpecArtifactVersionId: null,
    status: 'running',
    error: null,
  }));

  const planBlockedRun = await continueGraphWorkflow(run.id, {
    planner: async () => createApprovalPlan(task.title),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const planBlockedState = parseGraphState(planBlockedRun.graph_state);
  assert.ok(planBlockedState?.plan);
  assert.ok(planBlockedState.draftPlanArtifactVersionId);
  const draftPlan = workflowArtifactVersionRepo.get(planBlockedState.draftPlanArtifactVersionId);
  assert.equal(draftPlan?.status, 'draft');
  const parsedArtifactPlan = parsePlanArtifact(draftPlan?.content ?? '');
  assert.equal(parsedArtifactPlan.summary, planBlockedState.plan.summary);
  assert.deepEqual(
    parsedArtifactPlan.tasks.map((item) => item.title),
    planBlockedState.plan.tasks.map((item) => item.title),
  );
  const structuredData = JSON.parse(draftPlan?.structured_data ?? '{}') as {
    canonicalized?: boolean;
    canonicalized_from?: string;
    plan?: { summary?: string };
  };
  assert.equal(structuredData.canonicalized, true);
  assert.equal(structuredData.canonicalized_from, 'planner');
  assert.equal(structuredData.plan?.summary, planBlockedState.plan.summary);
});

test('Superpowers dispatch blocks when implementation plan is missing or unapproved', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-dispatch-gate-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Dispatch Gate', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Dispatch Gate Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Block dispatch without approved plan review',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
    plan: createApprovalPlan(task.title),
    workflowPlan: null,
    currentNode: 'approval',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    childTaskPlanIndexes: {},
    supervisorAssignments: [],
    runtimeProfile: 'superpowers',
    superpowersPhase: 'plan_review',
    designDocPath: 'docs/superpowers/specs/superpowers-design.md',
    designReviewVerdict: 'approved',
    implementationPlanPath: null,
    planReviewVerdict: 'approved',
    worktree: null,
    tddEvidence: [],
    tddExemption: null,
    specComplianceReview: null,
    codeQualityReview: null,
    verificationEvidence: [],
    finishBranchDecision: null,
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  }));

  const missingPlanRun = await continueGraphWorkflow(run.id);
  const missingPlanState = parseGraphState(missingPlanRun.graph_state);
  assert.equal(missingPlanRun.status, 'blocked');
  assert.match(missingPlanRun.error ?? '', /implementationPlanPath/);
  assert.equal(missingPlanState?.superpowersPhase, 'plan_review');
  assert.equal(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'dispatch'), false);

  const unapprovedTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Block dispatch with unapproved plan review',
  });
  const unapprovedRun = createGraphWorkflowRun(unapprovedTask.id);
  workflowRepo.updateGraphState(unapprovedRun.id, JSON.stringify({
    workflowRunId: unapprovedRun.id,
    projectId: project.id,
    roomId: room.id,
    taskId: unapprovedTask.id,
    userGoal: unapprovedTask.title,
    projectPath: project.path,
    plan: createApprovalPlan(unapprovedTask.title),
    workflowPlan: null,
    currentNode: 'approval',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    childTaskPlanIndexes: {},
    supervisorAssignments: [],
    runtimeProfile: 'superpowers',
    superpowersPhase: 'plan_review',
    designDocPath: 'docs/superpowers/specs/superpowers-design.md',
    designReviewVerdict: 'approved',
    implementationPlanPath: 'docs/superpowers/plans/test-plan.md',
    planReviewVerdict: 'changes_requested',
    worktree: null,
    tddEvidence: [],
    tddExemption: null,
    specComplianceReview: null,
    codeQualityReview: null,
    verificationEvidence: [],
    finishBranchDecision: null,
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  }));

  const unapprovedLatest = await continueGraphWorkflow(unapprovedRun.id);
  const unapprovedState = parseGraphState(unapprovedLatest.graph_state);
  assert.equal(unapprovedLatest.status, 'blocked');
  assert.match(unapprovedLatest.error ?? '', /plan review/i);
  assert.equal(unapprovedState?.superpowersPhase, 'plan_review');
  assert.equal(workflowRepo.listSteps(unapprovedRun.id).some((step) => step.node_name === 'dispatch'), false);
});

test('Superpowers actual runtime executes TDD, two-stage reviews, verify, and waits at finish branch decision', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-actual-route-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Actual Route', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Actual Route Room' });
  const acceptor = addAcpWorkflowAgent(room.id, 'acceptor');
  roomAgentRepo.setCapabilitiesAndRuntime(acceptor.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Run actual Superpowers TDD review route',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    plan: {
      ...createRunnableSuperpowersPlan(task.title),
      verification: ['node --version'],
      verificationCommands: [
        { command: 'node --version', reason: 'verify review evidence flow', required: true },
      ],
    },
    tddEvidence: [
      { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
    ],
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const state = parseGraphState(latest.graph_state);
  const nodeNames = listRawStepNodeNames(run.id);

  assert.deepEqual(nodeNames.slice(0, 6), [
    'dispatch',
    'tdd_execute',
    'spec_compliance_review',
    'code_quality_review',
    'verify',
    'finish_branch',
  ]);
  assert.equal(latest.status, 'awaiting_decision');
  assert.equal(state?.superpowersPhase, 'finish_branch');
  assert.equal(state?.specComplianceReview?.verdict, 'approved');
  assert.equal(state?.codeQualityReview?.verdict, 'approved');
  assert.equal(state?.finishBranchDecision?.decision, null);
  assert.equal(nodeNames.includes('review'), false);
});

test('Superpowers review stages run current room reviewer agents instead of auto-approving', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-agent-review-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Agent Review', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Agent Review Room' });
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  const acceptor = addAcpWorkflowAgent(room.id, 'acceptor');
  roomAgentRepo.setCapabilitiesAndRuntime(reviewer.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  roomAgentRepo.setCapabilitiesAndRuntime(acceptor.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Run Superpowers reviewer agents',
  });
  const run = createGraphWorkflowRun(task.id);
  const reviewCalls: Array<{
    stage: WorkflowStage | null | undefined;
    nodeName: string | null | undefined;
    prompt: string;
    runId: string;
  }> = [];
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    plan: createRunnableSuperpowersPlan(task.title),
    tddEvidence: [
      { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
    ],
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => {
      const result = await createCompletedAgentRun(room.id, input);
      reviewCalls.push({
        stage: input.workflowStage,
        nodeName: input.workflowStepId ? workflowRepo.getStep(input.workflowStepId)?.node_name : null,
        prompt: input.prompt,
        runId: result.run.id,
      });
      return result;
    },
  });
  const state = parseGraphState(latest.graph_state);

  assert.equal(latest.status, 'awaiting_decision');
  assert.deepEqual(
    reviewCalls.map((call) => `${call.stage}:${call.nodeName}`),
    [
      'code_review:spec_compliance_review',
      'code_review:code_quality_review',
    ],
  );
  assert.match(reviewCalls[0]!.prompt, /spec_compliance_review/);
  assert.match(reviewCalls[1]!.prompt, /code_quality_review/);
  assert.equal(state?.specComplianceReview?.verdict, 'approved');
  assert.equal(state?.codeQualityReview?.verdict, 'approved');
  assert.equal(
    state?.specComplianceReview?.reviewedAt,
    new Date(agentRunRepo.get(reviewCalls[0]!.runId)?.completed_at ?? 0).toISOString(),
  );
});

test('Superpowers review stages accept project-owned Superpowers evidence JSON', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-evidence-review-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Evidence Review', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Evidence Review Room' });
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  const acceptor = addAcpWorkflowAgent(room.id, 'acceptor');
  roomAgentRepo.setCapabilitiesAndRuntime(reviewer.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  roomAgentRepo.setCapabilitiesAndRuntime(acceptor.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Accept Superpowers review evidence',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    plan: {
      ...createRunnableSuperpowersPlan(task.title),
      verification: ['node --version'],
      verificationCommands: [
        { command: 'node --version', reason: 'verify review evidence flow', required: true },
      ],
    },
    tddEvidence: [
      { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
    ],
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input, {
      codeReviewOutput: workflowRepo.getStep(input.workflowStepId ?? '')?.node_name === 'spec_compliance_review'
        ? JSON.stringify({
          superpowers: {
            specComplianceReview: {
              verdict: 'approved',
              findings: [],
              reviewedAt: '2026-06-13T00:00:00.000Z',
            },
          },
        })
        : JSON.stringify({
          superpowers: {
            codeQualityReview: {
              verdict: 'approved',
              findings: [],
              reviewedAt: '2026-06-13T00:01:00.000Z',
            },
          },
        }),
    }),
  });
  const state = parseGraphState(latest.graph_state);

  assert.equal(latest.status, 'awaiting_decision');
  assert.equal(state?.specComplianceReview?.verdict, 'approved');
  assert.equal(state?.codeQualityReview?.verdict, 'approved');
  assert.equal(state?.reviewVerdict, 'pass');
});

test('Superpowers lightweight README task verifies with git status instead of build', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-lightweight-readme-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'README.md'), '# Smoke\n');
  execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: projectPath });
  execFileSync('git', ['config', 'user.name', 'Smoke Test'], { cwd: projectPath });
  execFileSync('git', ['add', 'README.md'], { cwd: projectPath });
  execFileSync('git', ['commit', '-m', 'docs: initial'], { cwd: projectPath, stdio: 'ignore' });

  const project = projectRepo.create({ name: 'Graph Runtime Lightweight README', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Lightweight README Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  const acceptor = addAcpWorkflowAgent(room.id, 'acceptor');
  for (const agent of [executor, reviewer, acceptor]) {
    roomAgentRepo.setCapabilitiesAndRuntime(agent.id, {
      capabilities: ['documentation'],
      default_runtime: 'acp',
      tool_policy: { allowed: ['read_files', 'write_files'] },
      workspace_policy: { read: ['.'], write: ['.'] },
    });
  }
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '轻量修改 README 文档，追加一行说明',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path, {
      approvedPlanArtifactVersionId: null,
    }),
    currentNode: 'intake',
    selectedIntent: 'lightweight_task',
    selectedPath: ['intake', 'route_skills', 'lightweight_plan'],
    plan: null,
    approval: 'not_required',
    approvedPlanArtifactVersionId: null,
    lightweightPlanArtifactVersionId: null,
    implementationPlanPath: null,
    planReviewVerdict: null,
  }));

  let awaiting = await continueGraphWorkflow(run.id);
  let state = parseGraphState(awaiting.graph_state);
  assert.equal(awaiting.status, 'awaiting_approval');
  assert.equal(state?.plan?.verificationCommands[0]?.command, 'git status --short');
  const approvedLightweightPlan = workflowArtifactVersionRepo.approve(state?.lightweightPlanArtifactVersionId ?? '', {
    approved_by: 'test',
    approval_message_id: null,
  });
  assert.ok(approvedLightweightPlan);
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...state!,
    lightweightPlanArtifactVersionId: approvedLightweightPlan.id,
    status: 'running',
    error: null,
  }));
  workflowRepo.updateRun(run.id, { status: 'running', error: null });

  const latest = await continueGraphWorkflow(awaiting.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input, {
      implementationOutput: JSON.stringify({
        superpowers: {
          tddExemption: {
            reason: 'README-only 文档轻量任务，不涉及可执行代码行为。',
            approvedBy: 'test',
            createdAt: Date.now(),
          },
        },
      }),
      codeReviewOutput: workflowRepo.getStep(input.workflowStepId ?? '')?.node_name === 'spec_compliance_review'
        ? JSON.stringify({
          superpowers: {
            specComplianceReview: {
              verdict: 'approved',
              findings: [],
              reviewedAt: '2026-06-13T00:00:00.000Z',
            },
          },
        })
        : JSON.stringify({
          superpowers: {
            codeQualityReview: {
              verdict: 'approved',
              findings: [],
              reviewedAt: '2026-06-13T00:01:00.000Z',
            },
          },
        }),
    }),
  });
  state = parseGraphState(latest.graph_state);
  const verifyStep = workflowRepo.listSteps(run.id).find((step) => step.node_name === 'verify');

  assert.equal(latest.status, 'awaiting_decision');
  assert.equal(state?.superpowersPhase, 'finish_branch');
  assert.equal(state?.verificationEvidence?.[0]?.command, 'git status --short');
  assert.equal(state?.verificationEvidence?.[0]?.status, 'passed');
  assert.match(verifyStep?.result ?? '', /git status --short: passed/);
});

test('Superpowers debug route dispatches and runs systematic debugging worker before verification', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-debug-route-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'package.json'), JSON.stringify({
    scripts: {
      build: 'node -e "process.exit(0)"',
    },
  }));
  execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'debug@example.com'], { cwd: projectPath });
  execFileSync('git', ['config', 'user.name', 'Debug Test'], { cwd: projectPath });
  execFileSync('git', ['add', 'package.json'], { cwd: projectPath });
  execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: projectPath, stdio: 'ignore' });

  const project = projectRepo.create({ name: 'Graph Runtime Debug Route', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Debug Route Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(executor.id, {
    capabilities: ['debugging'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['.'] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '修复 npm run build 失败',
  });
  const run = createGraphWorkflowRun(task.id);
  const plan = createRunnableSuperpowersPlan(task.title);
  plan.tasks = [{
    title: '执行系统化调试',
    description: task.title,
    suggestedRole: 'executor',
    priority: 'normal',
    acceptance: ['完成用户请求并保持现有行为不回退。'],
    scopeRead: [],
    scopeWrite: [],
    dependsOn: [],
  }];
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    currentNode: 'agent_assignment',
    selectedIntent: 'debug',
    selectedPath: ['intake', 'route_skills', 'debug_plan'],
    activeSuperpowersStage: 'agent_assignment',
    plan,
    agentAssignments: [{
      taskId: 'task-1',
      assignedAgentId: executor.id,
      fallbackAgentIds: [],
      fallbackReason: null,
      executionMode: 'parallel',
      scopeRead: [],
      scopeWrite: [],
    }],
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input, {
      implementationOutput: [
        'rootCause: package build script is available after debugging.',
        'verificationResult: npm run build can be checked by workflow verification.',
      ].join('\n'),
    }),
  });
  const state = parseGraphState(latest.graph_state);
  const steps = workflowRepo.listSteps(run.id);

  assert.equal(latest.status, 'awaiting_decision');
  assert.ok(
    steps.some((step) => step.node_name === 'dispatch'),
    `steps: ${steps.map((step) => `${step.node_name}:${step.status}`).join(', ')}`,
  );
  assert.ok(
    steps.some((step) => step.node_name === 'systematic_debugging'),
    `steps: ${steps.map((step) => `${step.node_name}:${step.status}`).join(', ')}`,
  );
  const agentRunCount = db.prepare('SELECT COUNT(*) AS count FROM agent_runs WHERE workflow_run_id = ?').get(run.id) as
    | { count: number }
    | undefined;
  assert.equal(agentRunCount?.count, 1);
  assert.equal(state?.verificationEvidence?.[0]?.command, 'npm run build');
  assert.equal(state?.verificationEvidence?.[0]?.status, 'passed');
});

test('Superpowers debug retry resumes systematic debugging before verification when child is runnable', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-debug-retry-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'package.json'), JSON.stringify({
    scripts: { build: 'node -e "process.exit(0)"' },
  }));
  const project = projectRepo.create({ name: 'Graph Runtime Debug Retry', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Debug Retry Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(executor.id, {
    capabilities: ['debugging'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['.'] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '修复 npm run build 失败',
  });
  const child = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: '执行系统化调试',
    description: task.title,
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  const run = createGraphWorkflowRun(task.id);
  const plan = createRunnableSuperpowersPlan(task.title);
  plan.tasks = [{
    title: child.title,
    description: child.description ?? child.title,
    suggestedRole: 'executor',
    priority: 'normal',
    acceptance: ['完成用户请求并保持现有行为不回退。'],
    scopeRead: [],
    scopeWrite: [],
    dependsOn: [],
  }];
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    currentNode: 'execute',
    currentStepId: 'previous-systematic-debugging-step',
    selectedIntent: 'debug',
    selectedPath: ['intake', 'route_skills', 'debug_plan'],
    activeSuperpowersStage: 'agent_assignment',
    superpowersPhase: 'systematic_debugging',
    plan,
    childTaskIds: [child.id],
    childTaskPlanIndexes: { [child.id]: 0 },
    agentAssignments: [{
      taskId: 'task-1',
      assignedAgentId: executor.id,
      fallbackAgentIds: [],
      fallbackReason: null,
      executionMode: 'parallel',
      scopeRead: [],
      scopeWrite: [],
    }],
  }));

  let calls = 0;
  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => {
      calls += 1;
      return createCompletedAgentRun(room.id, input, {
        implementationOutput: 'rootCause: retry resumed systematic debugging.',
      });
    },
  });
  const steps = workflowRepo.listSteps(run.id);

  assert.equal(latest.status, 'awaiting_decision');
  assert.equal(calls, 1);
  assert.ok(steps.some((step) => step.node_name === 'systematic_debugging'));
  assert.ok(steps.findIndex((step) => step.node_name === 'systematic_debugging') < steps.findIndex((step) => step.node_name === 'verify'));
});

test('Superpowers review-only path skips TDD execution and proceeds to finish branch decision', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-review-only-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Review Only', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Review Only Room' });
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  roomAgentRepo.setCapabilitiesAndRuntime(reviewer.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '只做代码审查，不要修改文件',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    currentNode: 'review_plan',
    selectedIntent: 'review_only',
    selectedPath: ['intake', 'route_skills', 'review_plan'],
    superpowersPhase: null,
    activeSuperpowersStage: 'review_plan',
    plan: {
      goal: task.title,
      summary: '只读审查路径',
      assumptions: [],
      tasks: [],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: null,
    childTaskIds: [],
    childTaskPlanIndexes: {},
    tddEvidence: [],
    tddExemption: null,
    approvedPlanArtifactVersionId: null,
    draftPlanArtifactVersionId: createApprovedPlanArtifactVersion(run.id, task.title).id,
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input, {
      codeReviewOutput: JSON.stringify({
        verdict: 'pass',
        findings: ['review-only path reviewed'],
        requiredFixes: [],
        riskLevel: 'low',
      }),
    }),
  });
  const state = parseGraphState(latest.graph_state);
  const steps = workflowRepo.listSteps(run.id);
  const stepNames = steps.map((step) => step.node_name);

  assert.equal(latest.status, 'awaiting_decision');
  assert.equal(state?.selectedIntent, 'review_only');
  assert.equal(state?.currentNode, 'acceptance');
  assert.equal(state?.verificationEvidence?.length, 0);
  assert.equal(stepNames.includes('spec_compliance_review'), true);
  assert.equal(stepNames.includes('code_quality_review'), false);
  assert.equal(stepNames.includes('tdd_execute'), false);
  assert.equal(stepNames.includes('verify'), true);
  assert.equal(stepNames.includes('finish_branch'), true);
});

test('Superpowers review-only findings do not reroute into TDD repair', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-review-only-findings-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Review Only Findings', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Review Only Findings Room' });
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  roomAgentRepo.setCapabilitiesAndRuntime(reviewer.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '只做代码审查，不要修改文件，指出问题',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    currentNode: 'review_plan',
    selectedIntent: 'review_only',
    selectedPath: ['intake', 'route_skills', 'review_plan'],
    superpowersPhase: null,
    activeSuperpowersStage: 'review_plan',
    plan: {
      goal: task.title,
      summary: '只读审查路径',
      assumptions: [],
      tasks: [],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: null,
    childTaskIds: [],
    childTaskPlanIndexes: {},
    approvedPlanArtifactVersionId: null,
    draftPlanArtifactVersionId: createApprovedPlanArtifactVersion(run.id, task.title).id,
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input, {
      codeReviewOutput: JSON.stringify({
        verdict: 'changes_requested',
        findings: ['review-only finding should be reported, not repaired'],
        requiredFixes: ['Add missing tests later if user asks for implementation'],
        riskLevel: 'medium',
      }),
    }),
  });
  const state = parseGraphState(latest.graph_state);
  const stepNames = workflowRepo.listSteps(run.id).map((step) => step.node_name);

  assert.equal(latest.status, 'awaiting_decision');
  assert.equal(state?.selectedIntent, 'review_only');
  assert.equal(state?.reviewVerdict, 'changes_requested');
  assert.equal(state?.currentNode, 'acceptance');
  assert.equal(stepNames.includes('spec_compliance_review'), true);
  assert.equal(stepNames.includes('code_quality_review'), false);
  assert.equal(stepNames.includes('tdd_execute'), false);
  assert.equal(stepNames.includes('verify'), true);
  assert.equal(stepNames.includes('finish_branch'), true);
});

test('Superpowers review failure synchronizes workflow run as blocked', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-review-block-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Review Block', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Review Block Room' });
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  roomAgentRepo.setCapabilitiesAndRuntime(reviewer.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Block workflow run when Superpowers review fails',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    plan: createRunnableSuperpowersPlan(task.title),
    tddEvidence: [
      { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
    ],
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input, {
      codeReviewOutput: JSON.stringify({
        verdict: 'failed',
        findings: ['Implementation cannot be reviewed safely.'],
        requiredFixes: ['Align implementation with plan.'],
        riskLevel: 'high',
      }),
    }),
  });
  const state = parseGraphState(latest.graph_state);
  const steps = listRawSteps(run.id);

  assert.equal(latest.status, 'blocked');
  assert.equal(latest.current_stage, 'code_review');
  assert.match(latest.error ?? '', /spec compliance review failed/i);
  assert.equal(state?.status, 'blocked');
  assert.equal(state?.superpowersPhase, 'spec_compliance_review');
  assert.equal(steps.find((step) => step.node_name === 'spec_compliance_review')?.status, 'failed');
  assert.equal(steps.filter((step) => step.node_name === 'tdd_execute').length, 1);
});

test('Superpowers actual runtime records fresh verification evidence and waits for finish branch decision after verify succeeds', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-verify-evidence-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Verify Evidence', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Verify Evidence Room' });
  const acceptor = addAcpWorkflowAgent(room.id, 'acceptor');
  roomAgentRepo.setCapabilitiesAndRuntime(acceptor.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['.'], write: [] },
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Record verification evidence',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    plan: {
      ...createRunnableSuperpowersPlan(task.title),
      tasks: [],
      needsApproval: false,
    },
    tddEvidence: [
      { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
    ],
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const state = parseGraphState(latest.graph_state);
  const nodeNames = listRawStepNodeNames(run.id);

  assert.ok(nodeNames.includes('finish_branch'));
  assert.equal(nodeNames.includes('acceptance'), false);
  assert.equal(latest.status, 'awaiting_decision');
  assert.equal(state?.verificationEvidence?.length, 1);
  assert.equal(state?.verificationEvidence?.[0]?.command, 'npm run build');
  assert.equal(state?.verificationEvidence?.[0]?.required, true);
  assert.equal(state?.verificationEvidence?.[0]?.fresh, true);
  assert.equal(state?.verificationEvidence?.[0]?.status, 'passed');
  assert.match(state?.verificationEvidence?.[0]?.recordedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state?.finishBranchDecision?.decision, null);
});

test('Superpowers actual runtime blocks before finish branch when required verification evidence is missing, failing, or stale', async () => {
  const baseProjectPath = join(tmpdir(), `graph-runtime-superpowers-verify-block-${Date.now()}`);
  mkdirSync(baseProjectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Verify Block', path: baseProjectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Verify Block Room' });
  const cases = [
    {
      title: 'missing required evidence',
      verificationCommands: [{ command: 'npm run build', reason: 'required verification', required: true }],
      verificationEvidence: [],
      expectedError: /verification evidence/i,
    },
    {
      title: 'failing required evidence',
      verificationCommands: [{ command: 'npm run build', reason: 'required verification', required: true }],
      verificationEvidence: [
        {
          command: 'npm run build',
          status: 'failed' as const,
          required: true,
          fresh: true,
          recordedAt: '2026-05-20T00:00:00.000Z',
        },
      ],
      expectedError: /Verification failed|verification evidence/i,
    },
    {
      title: 'stale required evidence',
      verificationCommands: [{ command: 'npm run build', reason: 'required verification', required: true }],
      verificationEvidence: [
        {
          command: 'npm run build',
          status: 'passed' as const,
          required: true,
          fresh: false,
          recordedAt: '2026-05-20T00:00:00.000Z',
        },
      ],
      expectedError: /verification evidence/i,
    },
  ];

  for (const item of cases) {
    const task = taskRepo.create({
      room_id: room.id,
      project_id: project.id,
      title: `Block ${item.title}`,
    });
    const run = createGraphWorkflowRun(task.id);
    workflowRepo.updateGraphState(run.id, JSON.stringify({
      ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
      plan: {
        ...createApprovalPlan(task.title),
        tasks: [],
        verification: [],
        verificationCommands: item.verificationCommands,
        needsApproval: false,
      },
      tddEvidence: [
        { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
        { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
      ],
      currentNode: 'verify',
      superpowersPhase: null,
      specComplianceReview: {
        verdict: 'approved',
        findings: [],
        reviewedAt: '2026-05-20T00:00:00.000Z',
      },
      codeQualityReview: {
        verdict: 'approved',
        findings: [],
        reviewedAt: '2026-05-20T00:00:00.000Z',
      },
      verificationEvidence: item.verificationEvidence,
    }));

    const latest = await continueGraphWorkflow(run.id);
    const state = parseGraphState(latest.graph_state);
    const nodeNames = listRawStepNodeNames(run.id);

    assert.equal(latest.status, 'blocked', item.title);
    assert.match(latest.error ?? '', item.expectedError);
    assert.equal(nodeNames.includes('acceptance'), false);
    assert.equal(nodeNames.includes('finish_branch'), true);
    assert.equal(state?.superpowersPhase, 'finish_branch');
    assert.equal(state?.finishBranchDecision, null);
  }
});

test('Superpowers actual runtime keeps TDD gate before spec review when runnable child tasks exist', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-tdd-child-gate-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers TDD Child Gate', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers TDD Child Gate Room' });
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
    title: 'Keep TDD gate with runnable child tasks',
  });
  const run = createGraphWorkflowRun(task.id);
  const child = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: 'Runnable implementation child',
    assigned_agent_id: executor.id,
  });
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    childTaskIds: [child.id],
    tddEvidence: [],
    tddExemption: null,
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input, { includeTddEvidence: false }),
  });
  const state = parseGraphState(latest.graph_state);
  const nodeNames = listRawStepNodeNames(run.id);

  assert.equal(latest.status, 'blocked');
  assert.match(latest.error ?? '', /TDD evidence/i);
  assert.deepEqual(nodeNames.slice(0, 1), ['tdd_execute']);
  assert.equal(nodeNames.includes('spec_compliance_review'), false);
  assert.equal(taskRepo.get(child.id)?.status, 'review');
  assert.equal(state?.superpowersPhase, 'tdd_execute');
  assert.equal(state?.status, 'blocked');
});

test('Superpowers actual runtime proceeds from child-task TDD execute to spec review with RED and GREEN evidence', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-tdd-child-pass-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers TDD Child Pass', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers TDD Child Pass Room' });
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
    title: 'Proceed with child-task TDD evidence',
  });
  const run = createGraphWorkflowRun(task.id);
  const child = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: 'Runnable implementation child with evidence',
    assigned_agent_id: executor.id,
  });
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    childTaskIds: [child.id],
    tddEvidence: [
      { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
    ],
    specComplianceReview: {
      verdict: 'pending',
      findings: ['Stop after proving route enters spec compliance review.'],
      reviewedAt: null,
    },
  }));

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const state = parseGraphState(latest.graph_state);
  const nodeNames = listRawStepNodeNames(run.id);

  assert.equal(latest.status, 'blocked');
  assert.deepEqual(nodeNames.slice(0, 2), ['tdd_execute', 'spec_compliance_review']);
  assert.equal(taskRepo.get(child.id)?.status, 'review');
  assert.equal(state?.superpowersPhase, 'spec_compliance_review');
  assert.match(state?.error ?? '', /spec compliance review is pending/i);
});

test('Superpowers actual runtime blocks before spec review without TDD evidence or exemption', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-tdd-block-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers TDD Block', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers TDD Block Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Block before spec review without TDD evidence',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify(
    createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
  ));

  const latest = await continueGraphWorkflow(run.id);
  const state = parseGraphState(latest.graph_state);
  const nodeNames = listRawStepNodeNames(run.id);

  assert.equal(latest.status, 'blocked');
  assert.match(latest.error ?? '', /TDD evidence/i);
  assert.deepEqual(nodeNames.slice(0, 2), ['dispatch', 'tdd_execute']);
  assert.equal(nodeNames.includes('spec_compliance_review'), false);
  assert.equal(state?.superpowersPhase, 'tdd_execute');
});

test('Superpowers v2 dispatch blocks without approved plan artifact version', async () => {
  const { run, room } = createSuperpowersV2TestRunWithoutApprovedPlan();

  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const state = parseGraphState(latest.graph_state);

  assert.equal(latest.status, 'blocked');
  assert.match(latest.error ?? '', /approved plan artifact/i);
  assert.equal(state?.currentNode, 'dispatch');
  assert.match(state?.error ?? '', /approved plan artifact/i);
});

test('Superpowers actual runtime proceeds from TDD execute to spec compliance review with RED and GREEN evidence', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-tdd-pass-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers TDD Pass', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers TDD Pass Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Proceed to spec review with TDD evidence',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    tddEvidence: [
      { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
    ],
    specComplianceReview: {
      verdict: 'pending',
      findings: ['Stop after proving route enters spec compliance review.'],
      reviewedAt: null,
    },
  }));

  const latest = await continueGraphWorkflow(run.id);
  const state = parseGraphState(latest.graph_state);
  const nodeNames = listRawStepNodeNames(run.id);

  assert.equal(latest.status, 'blocked');
  assert.deepEqual(nodeNames.slice(0, 3), ['dispatch', 'tdd_execute', 'spec_compliance_review']);
  assert.equal(nodeNames.includes('code_quality_review'), false);
  assert.equal(state?.superpowersPhase, 'spec_compliance_review');
  assert.match(state?.error ?? '', /spec compliance review is pending/i);
});

test('Superpowers implementation scope change request blocks for planner revision', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-scope-change-request-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Scope Change Request', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Scope Change Request Room' });
  roomAgentRepo.ensureDefaultPlanner(room.id);
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Handle implementation scope change request',
  });
  const implementationOutput = JSON.stringify({
    workflowRunId: 'runtime-will-normalize',
    stepId: 'step-will-normalize',
    agentRunId: 'agent-run-will-normalize',
    type: 'scope_change_request',
    summary: '需要修改 shared type',
    detail: '新增字段会影响前后端契约',
    requestedScopeWrite: ['packages/backend/src/types.ts'],
    createdAt: 1,
  });

  const run = await startGraphWorkflowAfterApproval(task.id, {
    planner: async () => ({
      goal: task.title,
      summary: 'Create one implementation task that discovers a scope change.',
      assumptions: [],
      tasks: [{
        title: '实现后端状态字段',
        description: '实现后端 workflow 状态字段。',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['发现需要修改 shared type 时阻塞'],
        scopeRead: ['packages/backend/src/workflows/graph/nodes.ts'],
        scopeWrite: ['packages/backend/src/workflows/graph/nodes.ts'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input, { implementationOutput }),
  });

  const detail = workflowRepo.detail(run.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);
  const implementationStep = detail?.steps.find((step) => step.stage === 'implementation');

  assert.equal(detail?.run.status, 'blocked');
  assert.equal(detail?.run.error, 'scope_change_request');
  assert.equal(graphState?.currentNode, 'route_skills');
  assert.equal(graphState?.activeSuperpowersStage, 'writing_plans');
  assert.equal(graphState?.activeChangeRequestId, `${implementationStep?.id}:1`);
  assert.equal(graphState?.approvedPlanArtifactVersionId, null);
  assert.equal(graphState?.agentAssignmentArtifactVersionId, null);
  assert.equal(implementationStep?.status, 'interrupted');
  assert.equal(graphState?.agentEvents?.at(-1)?.type, 'scope_change_request');
});

test('Superpowers review changes request clears TDD evidence and blocks instead of looping', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-review-changes-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Review Changes', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Review Changes Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Handle changes requested without looping',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path),
    tddEvidence: [
      { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
    ],
    specComplianceReview: {
      verdict: 'changes_requested',
      findings: ['Update implementation to match the plan.'],
      reviewedAt: null,
    },
  }));

  const latest = await continueGraphWorkflow(run.id);
  const state = parseGraphState(latest.graph_state);
  const nodeNames = listRawStepNodeNames(run.id);

  assert.equal(latest.status, 'blocked');
  assert.deepEqual(nodeNames.slice(0, 4), ['dispatch', 'tdd_execute', 'spec_compliance_review', 'tdd_execute']);
  assert.equal(nodeNames.filter((nodeName) => nodeName === 'spec_compliance_review').length, 1);
  assert.equal(state?.superpowersPhase, 'tdd_execute');
  assert.deepEqual(state?.tddEvidence, []);
  assert.equal(state?.specComplianceReview, null);
  assert.match(state?.error ?? '', /TDD evidence/i);
});

test('startGraphWorkflow always records Superpowers definition and runtime profile for new runs', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-entry-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Entry', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Entry Room' });
  const legacyDefinition = createPublishedRoomWorkflow(room.id, 'Legacy Room Default Workflow');
  settingsRepo.updateRoom(room.id, { default_workflow_definition_id: legacyDefinition.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Route new run through Superpowers',
  });
  const superpowersDefinition = workflowDefinitionRepo.getBuiltInByKey('superpowers-development');
  assert.ok(superpowersDefinition);

  let supervisorCalls = 0;
  let supervisorWorkflowDefinitionIds: string[] = [];
  const run = await startGraphWorkflow(task.id, {
    supervisor: async (input) => {
      supervisorCalls += 1;
      supervisorWorkflowDefinitionIds = input.workflowDefinitions.map((definition) => definition.id);
      return {
        mode: 'select_existing_workflow',
        workflowDefinitionId: legacyDefinition.id,
        confidence: 0.99,
        reason: 'Legacy selection should be ignored for new workflow runs.',
        assignments: [],
        fallbackMode: 'default_workflow',
      };
    },
    planner: async () => createApprovalPlan(task.title),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const snapshot = JSON.parse(run.workflow_definition_snapshot ?? '{}') as {
    builtinKey?: string | null;
    definition?: WorkflowDefinitionGraph;
    supervisorDecision?: unknown;
  };
  const state = parseGraphState(run.graph_state);

  assert.equal(supervisorCalls, 1);
  assert.deepEqual(supervisorWorkflowDefinitionIds, [superpowersDefinition.id]);
  assert.equal(run.workflow_definition_id, superpowersDefinition.id);
  assert.equal(run.workflow_definition_version, superpowersDefinition.version);
  assert.equal(run.graph_version, SUPERPOWERS_GRAPH_VERSION);
  assert.equal(snapshot.builtinKey, 'superpowers-development');
  assert.equal(snapshot.definition?.metadata?.runtime_profile, 'superpowers');
  assert.equal(snapshot.supervisorDecision, undefined);
  assert.equal(state?.runtimeProfile, 'superpowers');
});

test('createGraphWorkflowRun ignores room default workflow and records Superpowers snapshot', () => {
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

  assert.notEqual(run.workflow_definition_id, definition.id);
  assertSuperpowersWorkflowRun(run);
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
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  assert.notEqual(run.workflow_definition_id, workflow.id);
  assertSuperpowersWorkflowRun(run);
  assert.match(capturedSkillContext, /Skill: workflow-supervisor-skill/);
});

test('startGraphWorkflow keeps high-confidence assignments from default supervisor when deps.supervisor is omitted', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-supervisor-default-assignment-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Supervisor Default Assignment', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Supervisor Default Assignment Room' });
  const fallbackExecutor = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(fallbackExecutor.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
  });
  const hintedExecutor = addAcpWorkflowAgent(room.id, 'executor');
  roomAgentRepo.setCapabilitiesAndRuntime(hintedExecutor.id, {
    capabilities: ['frontend'],
    default_runtime: 'acp',
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Use default supervisor assignment hint',
  });

  const run = await startGraphWorkflowAfterApproval(task.id, {
    planner: async () => ({
      ...createApprovalPlan(task.title),
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
    defaultSupervisor: async () => ({
      mode: 'use_default_workflow',
      workflowDefinitionId: null,
      confidence: 0.92,
      reason: 'Use hinted executor from default supervisor.',
      assignments: [{
        stage: 'implementation',
        role: 'executor',
        agentId: hintedExecutor.id,
        reason: 'Prefer frontend executor.',
      }],
      fallbackMode: 'default_workflow',
    }),
  } as Parameters<typeof startGraphWorkflow>[1] & {
    defaultSupervisor: (
      input: Parameters<(typeof import('../supervisor.js'))['generateWorkflowSupervisorDecision']>[0],
      options?: Parameters<(typeof import('../supervisor.js'))['generateWorkflowSupervisorDecision']>[2],
    ) => ReturnType<(typeof import('../supervisor.js'))['generateWorkflowSupervisorDecision']>;
  });

  const child = taskRepo.listChildren(task.id)[0];
  assert.equal(child?.assigned_agent_id, hintedExecutor.id);
});

test('startGraphWorkflow ignores high-confidence supervisor workflow choice for new runs', async () => {
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
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const snapshot = JSON.parse(run.workflow_definition_snapshot ?? '{}') as { supervisorDecision?: unknown };

  assert.notEqual(run.workflow_definition_id, selected.id);
  assertSuperpowersWorkflowRun(run);
  assert.doesNotMatch(run.workflow_definition_snapshot ?? '', /Supervisor Selected Workflow/);
  assert.equal(snapshot.supervisorDecision, undefined);
});

test('startGraphWorkflow keeps Superpowers workflow on low confidence, invisible workflow, and supervisor failure', async () => {
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
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  assert.notEqual(lowConfidenceRun.workflow_definition_id, defaultDefinition.id);
  assertSuperpowersWorkflowRun(lowConfidenceRun);

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
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  assert.notEqual(invisibleRun.workflow_definition_id, defaultDefinition.id);
  assertSuperpowersWorkflowRun(invisibleRun);

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
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  assert.notEqual(failedRun.workflow_definition_id, defaultDefinition.id);
  assertSuperpowersWorkflowRun(failedRun);
});

test('startGraphWorkflow keeps Superpowers workflow for analysis-only tasks', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-analysis-intent-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Analysis Intent Fallback', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Analysis Intent Room' });
  const defaultDefinition = createPublishedRoomWorkflow(room.id, 'Room Default Workflow');
  settingsRepo.updateRoom(room.id, { default_workflow_definition_id: defaultDefinition.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '只读排查方案',
    description: '只做方案设计，不进入实现。\n\n任务意图：analysis_only',
  });

  const run = await startGraphWorkflow(task.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: defaultDefinition.id,
      confidence: 0.4,
      reason: 'Not confident enough.',
      assignments: [],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => createApprovalPlan(task.title),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const snapshot = JSON.parse(run.workflow_definition_snapshot ?? '{}') as { supervisorDecision?: unknown };

  assert.notEqual(run.workflow_definition_id, defaultDefinition.id);
  assertSuperpowersWorkflowRun(run);
  assert.doesNotMatch(run.workflow_definition_snapshot ?? '', /方案文档闭环/);
  assert.equal(snapshot.supervisorDecision, undefined);
});

test('startGraphWorkflow keeps Superpowers workflow even for analysis-only tasks', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-analysis-override-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Analysis Intent Override', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Analysis Intent Override Room' });
  const defaultDefinition = workflowDefinitionRepo.ensureBuiltInDefinitions();
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '只读排查方案',
    description: '只做方案设计，不进入实现。\n\n任务意图：analysis_only',
  });

  const run = await startGraphWorkflow(task.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: defaultDefinition.id,
      confidence: 0.97,
      reason: 'Incorrectly selected development workflow.',
      assignments: [],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => createApprovalPlan(task.title),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });
  const snapshot = JSON.parse(run.workflow_definition_snapshot ?? '{}') as { supervisorDecision?: unknown };

  assert.equal(run.workflow_definition_id, defaultDefinition.id);
  assertSuperpowersWorkflowRun(run);
  assert.doesNotMatch(run.workflow_definition_snapshot ?? '', /方案文档闭环/);
  assert.equal(snapshot.supervisorDecision, undefined);
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

  const run = await startGraphWorkflowAfterApproval(task.id, {
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

  const run = await startGraphWorkflowAfterApproval(task.id, {
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

  const run = await startGraphWorkflowAfterApproval(task.id, {
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
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
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
    ['planner', 'frontend-executor', 'backend-executor', 'reviewer'],
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
    calls
      .filter((call) => call.stage !== 'planning')
      .map((call) => `${call.stage}:${call.agentId}`),
    [
      'implementation:frontend-executor',
      'implementation:backend-executor',
      'code_review:reviewer',
      'code_review:reviewer',
    ],
  );
  assert.deepEqual(
    listRawStepNodeNames(run.id).filter((nodeName) =>
      nodeName === 'spec_compliance_review' || nodeName === 'code_quality_review',
    ),
    ['spec_compliance_review', 'code_quality_review'],
  );
});

test('graph workflow pre-invites domain executors when planner gives broad project scopes', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-broad-scope-invite-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Broad Scope Invite', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Broad Scope Invite Room' });
  roomAgentRepo.ensureDefaultPlanner(room.id);
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '细化文件管理功能',
  });
  const calls: Array<{ agentId: string; stage: WorkflowStage | null | undefined }> = [];
  const broadProjectScope = join(currentProjectRoot(), '.');

  await startGraphWorkflowAfterApproval(task.id, {
    planner: async () => ({
      goal: '细化文件管理功能',
      summary: 'Create backend and frontend work items with broad scopes.',
      assumptions: [],
      tasks: [
        {
          title: '实现后端资源查询与类型筛选能力',
          description: '扩展资源库后端接口，支持统一返回上传文件与智能体 Markdown 文档。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['后端资源列表支持类型筛选'],
          scopeRead: [broadProjectScope],
          scopeWrite: [broadProjectScope],
          dependsOn: [],
        },
        {
          title: '实现资源库列表 UI 的类型区分、筛选和搜索',
          description: '在前端资源库中清晰展示不同资源类型和来源，并提供筛选入口。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['前端资源库展示类型与来源'],
          scopeRead: [broadProjectScope],
          scopeWrite: [broadProjectScope],
          dependsOn: ['实现后端资源查询与类型筛选能力'],
        },
      ],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => {
      calls.push({ agentId: input.agent.agent_id, stage: input.workflowStage });
      return createCompletedAgentRun(room.id, input);
    },
  });

  const agents = roomAgentRepo.listByRoom(room.id);
  const children = taskRepo.listChildren(task.id);
  const backend = agents.find((agent) => agent.agent_id === 'backend-executor');
  const frontend = agents.find((agent) => agent.agent_id === 'frontend-executor');

  assert.ok(backend);
  assert.ok(frontend);
  assert.equal(
    children.find((child) => child.title === '实现后端资源查询与类型筛选能力')?.assigned_agent_id,
    backend.id,
  );
  assert.equal(
    children.find((child) => child.title === '实现资源库列表 UI 的类型区分、筛选和搜索')?.assigned_agent_id,
    frontend.id,
  );
  assert.deepEqual(
    calls.filter((call) => call.stage === 'implementation').map((call) => call.agentId),
    ['backend-executor', 'frontend-executor'],
  );
});

test('graph dispatch keeps planner steps as workflow context instead of implementation children', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-skip-planner-child-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Skip Planner Child', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Skip Planner Child Room' });
  const planner = roomAgentRepo.ensureDefaultPlanner(room.id);
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Skip planner implementation child',
  });
  const calls: Array<{ agentId: string; taskId: string | null | undefined; stage: WorkflowStage | null | undefined }> = [];

  const run = await startGraphWorkflowAfterApproval(task.id, {
    planner: async () => ({
      goal: task.title,
      summary: 'Plan contains one coordination item and one executable item.',
      assumptions: [],
      tasks: [
        {
          title: '梳理现状并冻结实现方案',
          description: '消费产品经理方案背景，不再重复分析。',
          suggestedRole: 'planner',
          priority: 'normal',
          acceptance: ['方案背景已作为执行上下文'],
          scopeRead: [],
          scopeWrite: [],
          dependsOn: [],
        },
        {
          title: '补充后端资源元数据与查询能力',
          description: '修改后端文件元数据查询。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['后端查询返回来源类型'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: ['梳理现状并冻结实现方案'],
        },
      ],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => {
      calls.push({ agentId: input.agent.agent_id, taskId: input.taskId, stage: input.workflowStage });
      return createCompletedAgentRun(room.id, input);
    },
  });

  const childTasks = taskRepo.listChildren(task.id);
  const detail = workflowRepo.detail(run.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);
  const agents = roomAgentRepo.listByRoom(room.id);
  const backendExecutor = agents.find((agent) => agent.agent_id === 'backend-executor');
  assert.ok(planner);

  assert.equal(childTasks.length, 1);
  assert.equal(childTasks[0]?.title, '补充后端资源元数据与查询能力');
  assert.equal(childTasks[0]?.assigned_agent_id, backendExecutor?.id);
  assert.deepEqual(
    calls.filter((call) => call.stage === 'implementation').map((call) => call.agentId),
    ['backend-executor'],
  );
  assert.equal(graphState?.workflowPlan?.tasks[0]?.role, 'planner');
  assert.equal(graphState?.workflowPlan?.tasks[0]?.agent_id, planner.id);
  assert.equal(graphState?.workflowPlan?.tasks[0]?.status, 'completed');
  assert.equal(graphState?.workflowPlan?.tasks[0]?.progress, 100);
  assert.equal(graphState?.workflowPlan?.tasks[1]?.role, 'executor');
  assert.equal(graphState?.workflowPlan?.tasks[1]?.agent_id, backendExecutor?.id);
});

test('graph workflow skips optional executor task when no single agent covers its write scope', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-optional-cross-scope-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Optional Cross Scope', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Optional Cross Scope Room' });
  roomAgentRepo.ensureDefaultPlanner(room.id);
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Skip optional cross-scope executor task',
  });
  const implementationAgents: string[] = [];

  const run = await startGraphWorkflowAfterApproval(task.id, {
    planner: async () => ({
      goal: task.title,
      summary: 'Only the required backend task should run.',
      assumptions: [],
      tasks: [
        {
          title: '补充后端 workflow 诊断',
          description: '实现必需的后端诊断逻辑。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['后端诊断可用'],
          scopeRead: ['packages/backend/src/workflows/graph/nodes.ts'],
          scopeWrite: ['packages/backend/src/workflows/graph/nodes.ts'],
          dependsOn: [],
        },
        {
          title: '必要时同步前后端共享展示字段',
          description: '仅当已有事件字段不足时才补充后端字段并同步前端展示。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['需要时补充共享字段'],
          scopeRead: ['packages/backend/src/types.ts', 'packages/frontend/src/lib/types.ts'],
          scopeWrite: ['packages/backend/src/types.ts', 'packages/frontend/src/lib/types.ts'],
          dependsOn: ['补充后端 workflow 诊断'],
        },
      ],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => {
      if (input.workflowStage === 'implementation') implementationAgents.push(input.agent.agent_id);
      return createCompletedAgentRun(room.id, input);
    },
  });

  const detail = workflowRepo.detail(run.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);
  const children = taskRepo.listChildren(task.id);

  assert.equal(detail?.run.status, 'awaiting_decision');
  assert.deepEqual(implementationAgents, ['backend-executor', 'fullstack-engineer']);
  assert.deepEqual(children.map((child) => child.title), ['补充后端 workflow 诊断', '必要时同步前后端共享展示字段']);
  assert.equal(graphState?.workflowPlan?.tasks[0]?.status, 'completed');
  assert.equal(graphState?.workflowPlan?.tasks[1]?.status, 'completed');
  assert.equal(graphState?.workflowPlan?.tasks[1]?.progress, 100);
});

test('graph workflow assigns required cross-scope executor task to fullstack fallback', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-required-cross-scope-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Required Cross Scope', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Required Cross Scope Room' });
  roomAgentRepo.ensureDefaultPlanner(room.id);
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Block required cross-scope executor task',
  });
  let implementationCalls = 0;

  const run = await startGraphWorkflowAfterApproval(task.id, {
    planner: async () => ({
      goal: task.title,
      summary: 'Required cross-scope task cannot be assigned.',
      assumptions: [],
      tasks: [{
        title: '同步前后端 workflow 状态契约',
        description: '必须同时修改后端状态契约和前端展示类型。',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['前后端契约一致'],
        scopeRead: ['packages/backend/src/types.ts', 'packages/frontend/src/lib/types.ts'],
        scopeWrite: ['packages/backend/src/types.ts', 'packages/frontend/src/lib/types.ts'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => {
      if (input.workflowStage === 'implementation') implementationCalls += 1;
      return createCompletedAgentRun(room.id, input);
    },
  });

  const detail = workflowRepo.detail(run.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);
  const children = taskRepo.listChildren(task.id);

  assert.equal(detail?.run.status, 'awaiting_decision');
  assert.equal(implementationCalls, 1);
  assert.equal(children.length, 1);
  assert.equal(
    children[0]?.assigned_agent_id,
    roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'fullstack-engineer')?.id,
  );
  assert.equal(detail?.run.error, null);
  assert.equal(graphState?.workflowPlan?.tasks[0]?.status, 'completed');
});

test('planning node consumes product-manager background without calling planner again', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-pm-background-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime PM Background', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph PM Background Room' });
  roomAgentRepo.ensureDefaultPlanner(room.id);
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '细化文件管理功能',
    description: [
      '细化文件管理功能，区分用户上传文件和智能体生成 md 文档。',
      '',
      '产品经理方案背景：',
      '实施计划：',
      '1. 补充后端资源元数据与查询能力',
      '- 改动：packages/backend/src/routes.ts',
      '- 验收：后端返回文件来源类型',
      '2. 改造前端资源库展示与详情',
      '- 改动：packages/frontend/src/pages/FilesPage.tsx',
      '- 验收：前端显示来源类型',
      '',
      '验证方式：',
      '- npm run build',
      '',
      '任务意图：implementation',
    ].join('\n'),
  });
  const implementationAgents: string[] = [];

  const run = await startGraphWorkflowAfterApproval(task.id, {
    planner: async () => {
      throw new Error('planner should not be called for product-manager background');
    },
    runAcpAgent: async (input) => {
      if (input.workflowStage === 'implementation') implementationAgents.push(input.agent.agent_id);
      return createCompletedAgentRun(room.id, input);
    },
  });

  const detail = workflowRepo.detail(run.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);

  assert.equal(detail?.run.status, 'awaiting_decision');
  assert.deepEqual(implementationAgents, ['backend-executor', 'frontend-executor']);
  assert.deepEqual(graphState?.plan?.tasks.map((item) => item.title), [
    '补充后端资源元数据与查询能力',
    '改造前端资源库展示与详情',
  ]);
  assert.deepEqual(graphState?.workflowPlan?.tasks.map((item) => item.mode), ['parallel', 'serial', 'serial']);
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

  await startGraphWorkflowAfterApproval(task.id, {
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
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
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

  await startGraphWorkflowAfterApproval(task.id, {
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

  await startGraphWorkflowAfterApproval(task.id, {
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
    () => startGraphWorkflowAfterArtifactApprovals(task.id, {
      supervisor: lowConfidenceSupervisor,
      runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
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
  assert.ok(listRawSteps(run.id).some((step) => step.node_name === 'writing_plans' && step.status === 'failed'));
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

  const run = await startGraphWorkflowAfterApproval(task.id, {
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
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  const detail = workflowRepo.detail(run.id);
  const childTasks = taskRepo.listChildren(task.id);
  const graphState = parseGraphState(detail?.run.graph_state ?? null);
  const assignmentArtifact = detail?.artifacts.find((artifact) => artifact.artifact_type === 'assignment');
  const assignmentMetadata = assignmentArtifact?.metadata
    ? JSON.parse(assignmentArtifact.metadata) as {
      assignments?: Array<{
        taskTitle?: string;
        taskProfile?: { taskType?: string; domains?: string[] };
        assignmentReason?: string;
      }>;
    }
    : null;

  assert.ok(['implementation', 'review', 'verification', 'acceptance'].includes(detail?.run.current_stage ?? ''));
  assert.ok(assignmentArtifact);
  assert.equal(assignmentMetadata?.assignments?.[0]?.taskTitle, 'Implement dispatch');
  assert.equal(assignmentMetadata?.assignments?.[0]?.taskProfile?.taskType, 'backend_feature');
  assert.deepEqual(assignmentMetadata?.assignments?.[0]?.taskProfile?.domains, ['backend']);
  assert.match(assignmentMetadata?.assignments?.[0]?.assignmentReason ?? '', /Selected|Joined|fallback/);
  assert.equal(childTasks.length, 1);
  assert.equal(childTasks[0]?.assigned_agent_id, executor.id);
  assert.equal(graphState?.childTaskIds.length, 1);
  const childEvents = taskEventRepo.listByTask(childTasks[0]!.id);
  assert.ok(childEvents.some((event) => event.type === 'task_created'));
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

  await startGraphWorkflowAfterApproval(task.id, {
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

test('graph dispatch joins global frontend agent for frontend UI task with empty scope', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-global-frontend-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Global Frontend', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Global Frontend Room' });
  roomAgentRepo.ensureDefaultPlanner(room.id);
  const backend = roomAgentRepo.ensureBuiltInAgent(room.id, 'backend-executor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '最近群聊指的是最近访问过的群聊',
    description: '任务目标是在侧边栏最近项目下方展示当前用户最近访问过的群聊，补充 i18n 文案、空态和跳转高亮处理。',
  });

  await startGraphWorkflowAfterApproval(task.id, {
    planner: async () => ({
      goal: task.title,
      summary: '在侧边栏展示最近访问过的群聊',
      assumptions: [],
      tasks: [
        {
          title: '目标是在侧边栏最近项目下方展示当前用户最近访问过',
          description: '在 AppShell/ProjectSidebar 读取并按 visitedAt 倒序展示最近群聊，RoomPage 进入群聊时记录访问，补充 i18n 文案、空态和跳转高亮处理。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['侧边栏最近群聊按访问时间倒序展示'],
          scopeRead: [],
          scopeWrite: [],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  const agents = roomAgentRepo.listByRoom(room.id);
  const frontend = agents.find((agent) => agent.agent_id === 'frontend-executor');
  const fullstack = agents.find((agent) => agent.agent_id === 'fullstack-engineer');
  const children = taskRepo.listChildren(task.id);
  const expectedAgentIds = [frontend?.id, fullstack?.id]
    .filter((id): id is string => typeof id === 'string');

  assert.notEqual(children[0]?.assigned_agent_id, backend.id);
  assert.ok(frontend || fullstack);
  assert.ok(children[0]?.assigned_agent_id && expectedAgentIds.includes(children[0].assigned_agent_id));
});

test('graph dispatch joins global writer for presentation task instead of backend executor', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-presentation-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Presentation', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Presentation Room' });
  roomAgentRepo.ensureDefaultPlanner(room.id);
  const backend = roomAgentRepo.ensureBuiltInAgent(room.id, 'backend-executor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '制作一个项目汇报 PPT',
    description: '整理项目目标、核心功能、截图说明和验收结论，输出演示文稿。',
  });

  await startGraphWorkflowAfterApproval(task.id, {
    planner: async () => ({
      goal: task.title,
      summary: '制作项目汇报演示文稿',
      assumptions: [],
      tasks: [
        {
          title: '制作项目汇报 PPT',
          description: '整理项目目标、核心功能、截图说明和验收结论，输出演示文稿。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['PPT 可以用于产品汇报'],
          scopeRead: [],
          scopeWrite: [],
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

  const agents = roomAgentRepo.listByRoom(room.id);
  const writer = agents.find((agent) => agent.agent_id === 'technical-writer');
  const children = taskRepo.listChildren(task.id);

  assert.ok(writer);
  assert.notEqual(children[0]?.assigned_agent_id, backend.id);
  assert.equal(children[0]?.assigned_agent_id, writer.id);
});

test('graph dispatch ignores supervisor backend hint for presentation task profile', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-presentation-hint-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Presentation Hint', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Presentation Hint Room' });
  roomAgentRepo.ensureDefaultPlanner(room.id);
  const backend = roomAgentRepo.ensureBuiltInAgent(room.id, 'backend-executor');
  const writer = roomAgentRepo.ensureBuiltInAgent(room.id, 'technical-writer');
  const workflow = createPublishedRoomWorkflow(room.id, 'Presentation Hint Workflow');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '制作一个项目汇报 PPT',
    description: '整理项目目标、核心功能、截图说明和验收结论，输出演示文稿。',
  });

  await startGraphWorkflowAfterApproval(task.id, {
    supervisor: async () => ({
      mode: 'select_existing_workflow',
      workflowDefinitionId: workflow.id,
      confidence: 0.92,
      reason: 'Supervisor incorrectly suggests backend executor.',
      assignments: [{
        stage: 'implementation',
        role: 'executor',
        agentId: backend.id,
        reason: 'Incorrect backend hint for presentation task.',
      }],
      fallbackMode: 'default_workflow',
    }),
    planner: async () => ({
      goal: task.title,
      summary: '制作项目汇报演示文稿',
      assumptions: [],
      tasks: [
        {
          title: '制作项目汇报 PPT',
          description: '整理项目目标、核心功能、截图说明和验收结论，输出演示文稿。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['PPT 可以用于产品汇报'],
          scopeRead: [],
          scopeWrite: [],
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

  const child = taskRepo.listChildren(task.id)[0];
  assert.notEqual(child?.assigned_agent_id, backend.id);
  assert.equal(child?.assigned_agent_id, writer.id);
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
  const run = await startGraphWorkflowAfterApproval(task.id, {
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
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
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

  assert.ok(['backend-executor', 'frontend-executor', 'fullstack-engineer'].includes(implementationAgentId ?? ''));
  assert.equal(detail?.run.status, 'awaiting_decision');
  assert.equal(childTasks.length, 1);
  assert.equal(
    childTasks[0]?.assigned_agent_id,
    roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === implementationAgentId)?.id,
  );
  assert.equal(graphState?.status, 'awaiting_decision');
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
  const run = await startGraphWorkflowAfterApproval(task.id, {
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
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
      ],
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
  assert.equal(detail?.run.status, 'awaiting_decision');
  assert.equal(childTasks.length, 1);
  assert.equal(
    childTasks[0]?.assigned_agent_id,
    roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'frontend-executor')?.id,
  );
  assert.equal(graphState?.status, 'awaiting_decision');
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
    workflowPlan: {
      workflow_name: task.title,
      source_message_id: task.id,
      goal: task.title,
      summary: 'Create one frontend child task with invalid assigned executor',
      tasks: [{
        id: 'task-1-update-react-page',
        title: 'Update React page',
        description: 'Modify frontend page.',
        role: 'executor' as const,
        agent_id: backend.id,
        mode: 'parallel' as const,
        depends_on: [],
        status: 'pending' as const,
        progress: 0,
        result_refs: [],
      }],
    },
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
  assert.equal(graphState?.workflowPlan?.tasks[0]?.status, 'blocked');
  assert.equal(graphState?.workflowPlan?.tasks[0]?.progress, 0);
});

test('continueGraphWorkflow waits without looping when implementation agent run is active', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-active-wait-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Active Wait', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Runtime Active Wait Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Wait for active implementation run',
  });
  const child = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: 'Long running child task',
    description: 'This child task is still being implemented.',
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  taskRepo.updateStatus(child.id, 'in_progress');
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
    workflow_definition_snapshot: JSON.stringify({
      id: 'test-active-wait',
      name: 'Test Active Wait',
      description: null,
      builtinKey: null,
      version: 1,
      definition: createTestWorkflowDefinition(),
    }),
  });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: child.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: executor.id,
    sort_order: 1,
  });
  const activeRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: executor.id,
    agent_id: executor.agent_id,
    backend: 'codex',
    task_id: child.id,
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    workflow_stage: 'implementation',
    prompt: 'already running implementation',
  });
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
    plan: {
      goal: task.title,
      summary: 'Wait for active implementation',
      assumptions: [],
      tasks: [{
        title: child.title,
        description: child.description ?? '',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Resume does not start duplicate work'],
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
    currentStepId: step.id,
    activeAgentRunId: activeRun.id,
    childTaskIds: [child.id],
    supervisorAssignments: [],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
    workflowPlan: null,
  }));

  let calls = 0;
  const latest = await continueGraphWorkflow(run.id, {
    runAcpAgent: async () => {
      calls += 1;
      throw new Error('resume should wait for active implementation run');
    },
  });
  const graphState = parseGraphState(latest.graph_state);

  assert.equal(calls, 0);
  assert.equal(latest.status, 'running');
  assert.equal(latest.error, null);
  assert.equal(graphState?.currentNode, 'execute');
  assert.equal(graphState?.currentStepId, step.id);
  assert.equal(graphState?.activeAgentRunId, activeRun.id);
  assert.equal(agentRunRepo.listActiveByWorkflow(run.id).length, 1);
});

test('continueGraphWorkflow block helper syncs running child workflowPlan state', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-block-child-plan-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Block Child Plan', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Runtime Block Child Plan Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Block child plan on shared helper failure',
  });
  const child = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: 'Running child implementation',
    description: 'Shared block helper should fail this child.',
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  const pendingState = emptyAgentWorkflowState({
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
    status: 'running',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState(pendingState),
    workflow_definition_snapshot: '{"invalid": ',
  });
  taskRepo.updateStatus(child.id, 'in_progress');
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: child.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: executor.id,
    assigned_room_agent_id: executor.id,
    prompt: 'running child before block helper failure',
    sort_order: 1,
  });
  const state = {
    ...pendingState,
    workflowRunId: run.id,
    plan: {
      goal: task.title,
      summary: 'Trigger shared block helper.',
      assumptions: [],
      tasks: [{
        title: child.title,
        description: child.description ?? '',
        suggestedRole: 'executor' as const,
        priority: 'normal' as const,
        acceptance: ['Child failure is synchronized'],
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
    workflowPlan: {
      workflow_name: task.title,
      source_message_id: task.id,
      goal: task.title,
      summary: 'Trigger shared block helper.',
      tasks: [{
        id: 'task-1-running-child-implementation',
        title: child.title,
        description: child.description ?? '',
        role: 'executor' as const,
        agent_id: executor.id,
        mode: 'parallel' as const,
        depends_on: [],
        status: 'running' as const,
        progress: 35,
        result_refs: [],
      }],
    },
    currentNode: 'execute' as const,
    currentStepId: step.id,
    activeAgentRunId: null,
    childTaskIds: [child.id],
    childTaskPlanIndexes: { [child.id]: 0 },
    supervisorAssignments: [],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required' as const,
    status: 'running' as const,
    error: null,
  };
  workflowRepo.updateGraphState(run.id, serializeGraphState(state));

  await assert.rejects(
    () => continueGraphWorkflow(run.id),
    /workflow definition snapshot is invalid/,
  );

  const latest = workflowRepo.getRun(run.id);
  const graphState = parseGraphState(latest?.graph_state ?? null);
  const steps = workflowRepo.listSteps(run.id);

  assert.equal(latest?.status, 'blocked');
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.status, 'failed');
  assert.equal(taskRepo.get(child.id)?.status, 'failed');
  assert.equal(graphState?.status, 'blocked');
  assert.equal(graphState?.workflowPlan?.tasks[0]?.status, 'blocked');
});

test('retryGraphWorkflow resets active child tasks and records status events', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-retry-child-events-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Retry Child Events', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Runtime Retry Child Events Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  const acceptor = addAcpWorkflowAgent(room.id, 'acceptor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Retry child event recording',
  });
  const child = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: 'Reset me on retry',
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'blocked',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
    workflow_definition_snapshot: JSON.stringify({
      id: 'test-retry-child-events',
      name: 'Test Retry Child Events',
      description: null,
      builtinKey: null,
      version: 1,
      definition: createTestWorkflowDefinition(),
    }),
  });
  workflowRepo.updateRun(run.id, { error: 'previous implementation failed' });
  taskRepo.updateStatus(child.id, 'failed');
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
    plan: {
      goal: task.title,
      summary: 'Retry a failed child',
      assumptions: [],
      tasks: [{
        title: child.title,
        description: child.description ?? '',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Child is retried'],
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
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [child.id],
    supervisorAssignments: [],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'blocked',
    error: 'previous implementation failed',
    workflowPlan: null,
  }));

  const latest = await retryGraphWorkflow(run.id, {
    runAcpAgent: async (input) => createCompletedAgentRun(room.id, input),
  });

  assert.equal(latest.status, 'running');
  assert.equal(taskRepo.get(child.id)?.status, 'review');
  const statusEvents = taskEventRepo.listByTask(child.id).filter((event) => event.type === 'task_status_changed');
  assert.ok(statusEvents.some((event) => event.payload.next_status === 'todo' && event.payload.graph_retry === true));
  assert.ok(statusEvents.some((event) => event.payload.next_status === 'in_progress'));
  assert.ok(statusEvents.some((event) => event.payload.next_status === 'review'));
  assert.equal(roomAgentRepo.get(executor.id)?.id, executor.id);
  assert.equal(roomAgentRepo.get(reviewer.id)?.id, reviewer.id);
  assert.equal(roomAgentRepo.get(acceptor.id)?.id, acceptor.id);
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

test('execute node maps duplicate child titles by child task id instead of title', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-duplicate-child-title-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Duplicate Child Title', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Duplicate Child Title Room' });
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
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Execute duplicate child title safely',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    graph_version: 'phase-b-v1',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: '补充实现',
    description: '后端实现。',
    assigned_agent_id: backend.id,
    created_from: 'workflow_assignment',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: '补充实现',
    description: '前端实现。',
    assigned_agent_id: frontend.id,
    created_from: 'workflow_assignment',
  });
  const planTasks: ParsedPlan['tasks'] = [
    {
      title: '补充实现',
      description: '补充后端实现。',
      suggestedRole: 'executor',
      priority: 'normal',
      acceptance: ['后端完成'],
      scopeRead: ['packages/backend/src/routes.ts'],
      scopeWrite: ['packages/backend/src/routes.ts'],
      dependsOn: [],
    },
    {
      title: '补充实现',
      description: '补充前端实现。',
      suggestedRole: 'executor',
      priority: 'normal',
      acceptance: ['前端完成'],
      scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
      scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
      dependsOn: [],
    },
  ];
  const state = {
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
    plan: {
      goal: task.title,
      summary: 'Execute duplicate titles without corrupting workflow plan.',
      assumptions: [],
      tasks: planTasks,
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    currentNode: 'dispatch' as const,
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
    approval: 'not_required' as const,
    status: 'running' as const,
    error: null,
    workflowPlan: {
      workflow_name: task.title,
      source_message_id: task.id,
      goal: task.title,
      summary: 'Execute duplicate titles without corrupting workflow plan.',
      tasks: [
        {
          id: 'task-1-duplicate-title',
          title: '补充实现',
          description: '补充后端实现。',
          role: 'executor' as const,
          agent_id: backend.id,
          mode: 'parallel' as const,
          depends_on: [],
          status: 'pending' as const,
          progress: 0,
          result_refs: [],
        },
        {
          id: 'task-2-duplicate-title',
          title: '补充实现',
          description: '补充前端实现。',
          role: 'executor' as const,
          agent_id: frontend.id,
          mode: 'serial' as const,
          depends_on: ['task-1-duplicate-title'],
          status: 'pending' as const,
          progress: 0,
          result_refs: [],
        },
      ],
    },
  };
  const calls: string[] = [];
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async (input) => {
      calls.push(input.agent.id);
      return createCompletedAgentRun(room.id, input);
    },
  }));

  const afterBackend = await nodes.executeNode(state);
  const afterFrontend = await nodes.executeNode(afterBackend);

  assert.deepEqual(calls, [backend.id, frontend.id]);
  assert.equal(afterFrontend.workflowPlan?.tasks[0]?.agent_id, backend.id);
  assert.equal(afterFrontend.workflowPlan?.tasks[0]?.status, 'completed');
  assert.equal(afterFrontend.workflowPlan?.tasks[1]?.agent_id, frontend.id);
  assert.equal(afterFrontend.workflowPlan?.tasks[1]?.status, 'completed');
  assert.ok(afterFrontend.workflowPlan?.tasks[0]?.result_refs.length);
  assert.ok(afterFrontend.workflowPlan?.tasks[1]?.result_refs.length);
});

async function startGraphWorkflowAfterApproval(
  taskId: string,
  deps: Parameters<typeof startGraphWorkflow>[1] = {},
): Promise<WorkflowRun> {
  let run = await startGraphWorkflowAfterArtifactApprovals(taskId, deps);
  if (run.status !== 'awaiting_approval') return run;
  run = ensureApprovedPlanArtifactForRun(run);
  return approveGraphWorkflow(run.id, 'test', deps);
}

async function startGraphWorkflowAfterArtifactApprovals(
  taskId: string,
  deps: Parameters<typeof startGraphWorkflow>[1] = {},
): Promise<WorkflowRun> {
  let run = await startGraphWorkflow(taskId, deps);
  run = await continueAfterApprovedSpecArtifactIfNeeded(ensureApprovedSpecArtifactForRun(run), deps);
  run = await continueAfterApprovedPlanArtifactIfNeeded(ensureApprovedPlanArtifactForRun(run), deps);
  return run;
}

function ensureApprovedSpecArtifactForRun(run: WorkflowRun): WorkflowRun {
  const state = parseGraphState(run.graph_state);
  if (!state || state.approvedSpecArtifactVersionId) return run;
  const approved = approveDraftArtifactVersion(state.draftSpecArtifactVersionId)
    ?? createApprovedSpecArtifactVersion(run.id, state.userGoal);
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...state,
    approvedSpecArtifactVersionId: approved.id,
    draftSpecArtifactVersionId: state.draftSpecArtifactVersionId === approved.id
      ? null
      : state.draftSpecArtifactVersionId,
  }));
  return workflowRepo.getRun(run.id) ?? run;
}

function ensureApprovedPlanArtifactForRun(run: WorkflowRun): WorkflowRun {
  const state = parseGraphState(run.graph_state);
  if (!state || state.approvedPlanArtifactVersionId) return run;
  const approved = approveDraftArtifactVersion(state.draftPlanArtifactVersionId)
    ?? createApprovedPlanArtifactVersion(run.id, state.userGoal);
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...state,
    approvedPlanArtifactVersionId: approved.id,
    draftPlanArtifactVersionId: state.draftPlanArtifactVersionId === approved.id
      ? null
      : state.draftPlanArtifactVersionId,
  }));
  return workflowRepo.getRun(run.id) ?? run;
}

async function continueAfterApprovedSpecArtifactIfNeeded(
  run: WorkflowRun,
  deps: Parameters<typeof startGraphWorkflow>[1],
): Promise<WorkflowRun> {
  if (
    run.status !== 'awaiting_approval' &&
    (run.status !== 'blocked' || !/approved spec artifact/i.test(run.error ?? ''))
  ) {
    return run;
  }
  const state = parseGraphState(run.graph_state);
  if (!state?.approvedSpecArtifactVersionId) return run;
  workflowRepo.updateRun(run.id, { status: 'running', error: null });
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...state,
    currentNode: 'planning',
    superpowersPhase: 'spec_review',
    status: 'running',
    error: null,
  }));
  return continueGraphWorkflow(run.id, deps);
}

async function continueAfterApprovedPlanArtifactIfNeeded(
  run: WorkflowRun,
  deps: Parameters<typeof startGraphWorkflow>[1],
): Promise<WorkflowRun> {
  if (
    run.status !== 'awaiting_approval' &&
    (run.status !== 'blocked' || !/approved plan artifact/i.test(run.error ?? ''))
  ) {
    return run;
  }
  const state = parseGraphState(run.graph_state);
  if (!state?.approvedPlanArtifactVersionId) return run;
  workflowRepo.updateRun(run.id, { status: 'running', error: null });
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...state,
    currentNode: 'planning',
    superpowersPhase: 'plan_review',
    status: 'running',
    error: null,
  }));
  return continueGraphWorkflow(run.id, deps);
}

function approveDraftArtifactVersion(artifactVersionId: string | null | undefined) {
  if (!artifactVersionId) return null;
  const artifact = workflowArtifactVersionRepo.get(artifactVersionId);
  if (!artifact || artifact.status === 'approved') return artifact;
  return workflowArtifactVersionRepo.approve(artifact.id, {
    approved_by: 'test',
    approval_message_id: null,
  });
}

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
    verification: ['npm run build'],
    verificationCommands: [
      { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
    ],
    risks: [],
    needsApproval: true,
  };
}

function createRunnableSuperpowersPlan(title: string): ParsedPlan {
  return {
    ...createApprovalPlan(title),
    tasks: [],
    verification: ['npm run build'],
    verificationCommands: [
      { command: 'npm run build', reason: 'stubbed runtime verification', required: true },
    ],
    needsApproval: false,
  };
}

function createRunnableSuperpowersState(
  workflowRunId: string,
  projectId: string,
  roomId: string,
  taskId: string,
  title: string,
  projectPath: string,
  options: { approvedPlanArtifactVersionId?: string | null } = {},
) {
  const approvedPlanArtifactVersionId = Object.hasOwn(options, 'approvedPlanArtifactVersionId')
    ? options.approvedPlanArtifactVersionId ?? null
    : createApprovedPlanArtifactVersion(workflowRunId, title).id;
  return {
    workflowRunId,
    projectId,
    roomId,
    taskId,
    userGoal: title,
    projectPath,
    plan: {
      ...createRunnableSuperpowersPlan(title),
    },
    workflowPlan: {
      workflow_name: title,
      source_message_id: taskId,
      goal: title,
      summary: `Plan for ${title}`,
      tasks: [],
    },
    currentNode: 'approval' as const,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    childTaskPlanIndexes: {},
    supervisorAssignments: [],
    runtimeProfile: 'superpowers' as const,
    superpowersPhase: 'plan_review',
    designDocPath: 'docs/superpowers/specs/superpowers-design.md',
    designReviewVerdict: 'approved' as const,
    implementationPlanPath: 'docs/superpowers/plans/test-plan.md',
    planReviewVerdict: 'approved' as const,
    approvedPlanArtifactVersionId,
    worktree: null,
    tddEvidence: [],
    tddExemption: null,
    specComplianceReview: null,
    codeQualityReview: null,
    verificationEvidence: [],
    finishBranchDecision: null,
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required' as const,
    status: 'running' as const,
    error: null,
  };
}

function createApprovedPlanArtifactVersion(workflowRunId: string, title: string) {
  const draft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflowRunId,
    artifact_type: 'plan',
    title: 'Runtime Test Plan',
    content: `# Plan\n\n${title}`,
    structured_data: { tasks: [] },
    created_by_agent_id: 'planner',
  });
  const approved = workflowArtifactVersionRepo.approve(draft.id, {
    approved_by: 'test',
    approval_message_id: null,
  });
  assert.ok(approved);
  return approved;
}

function createApprovedSpecArtifactVersion(workflowRunId: string, title: string) {
  const draft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflowRunId,
    artifact_type: 'spec',
    title: 'Runtime Test Spec',
    content: `# Spec\n\n${title}`,
    structured_data: { summary: title },
    created_by_agent_id: 'planner',
  });
  const approved = workflowArtifactVersionRepo.approve(draft.id, {
    approved_by: 'test',
    approval_message_id: null,
  });
  assert.ok(approved);
  return approved;
}

function createSuperpowersV2TestRunWithoutApprovedPlan(): {
  run: WorkflowRun;
  room: ReturnType<typeof roomRepo.create>;
} {
  const projectPath = join(tmpdir(), `graph-runtime-superpowers-approved-plan-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Superpowers Approved Plan Gate', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Superpowers Approved Plan Gate Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Require approved plan artifact before dispatch',
  });
  const run = createGraphWorkflowRun(task.id);
  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path, {
      approvedPlanArtifactVersionId: null,
    }),
    activeSuperpowersStage: 'subagent_driven_development',
    lightweightPlanArtifactVersionId: null,
  }));
  return { run, room };
}

function assertSuperpowersWorkflowRun(run: WorkflowRun): void {
  const superpowersDefinition = workflowDefinitionRepo.getBuiltInByKey('superpowers-development');
  assert.ok(superpowersDefinition);
  const snapshot = JSON.parse(run.workflow_definition_snapshot ?? '{}') as {
    builtinKey?: string | null;
    definition?: WorkflowDefinitionGraph;
  };
  const state = parseGraphState(run.graph_state);

  assert.equal(run.workflow_definition_id, superpowersDefinition.id);
  assert.equal(run.workflow_definition_version, superpowersDefinition.version);
  assert.equal(run.graph_version, SUPERPOWERS_GRAPH_VERSION);
  assert.equal(snapshot.builtinKey, 'superpowers-development');
  assert.equal(snapshot.definition?.metadata?.runtime_profile, 'superpowers');
  assert.equal(state?.runtimeProfile, 'superpowers');
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForGraphRuntime(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await flushImmediate();
    if (predicate()) return;
  }
  throw new Error('timed out waiting for graph runtime condition');
}

function createLegacyGraphWorkflowRun(input: {
  projectId: string;
  projectPath: string;
  roomId: string;
  taskId: string;
  taskTitle: string;
}): WorkflowRun {
  const state = emptyAgentWorkflowState({
    workflowRunId: 'pending',
    projectId: input.projectId,
    roomId: input.roomId,
    taskId: input.taskId,
    userGoal: input.taskTitle,
    projectPath: input.projectPath,
  });
  const run = workflowRepo.createRun({
    room_id: input.roomId,
    project_id: input.projectId,
    task_id: input.taskId,
    status: 'running',
    current_stage: 'planning',
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState(state),
    workflow_definition_snapshot: JSON.stringify({
      id: 'test-legacy-graph',
      name: 'Test Legacy Graph',
      description: null,
      builtinKey: null,
      version: 1,
      definition: createTestWorkflowDefinition(),
    }),
  });
  const nextState = { ...state, workflowRunId: run.id };
  workflowRepo.updateGraphState(run.id, serializeGraphState(nextState));
  return workflowRepo.getRun(run.id) ?? run;
}

function listRawStepNodeNames(workflowRunId: string): Array<string | null> {
  return listRawSteps(workflowRunId).map((step) => step.node_name);
}

function assertOrderedSubsequence<T>(actual: T[], expected: T[]): void {
  let index = 0;
  for (const item of actual) {
    if (item === expected[index]) index += 1;
    if (index === expected.length) return;
  }
  assert.deepEqual(actual, expected);
}

function listRawSteps(workflowRunId: string): Array<{ node_name: string | null; status: string }> {
  return db
    .prepare('SELECT node_name, status FROM workflow_steps WHERE workflow_run_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(workflowRunId) as Array<{ node_name: string | null; status: string }>;
}

function parseArtifactMetadata(artifact: { metadata: string | null } | undefined): Record<string, any> {
  assert.ok(artifact);
  return artifact.metadata ? JSON.parse(artifact.metadata) as Record<string, any> : {};
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

function createCompletedAgentRun(
  roomId: string,
  input: RespondAsAgentInput,
  options: { includeTddEvidence?: boolean; codeReviewOutput?: string; implementationOutput?: string } = {},
) {
  const content = outputForStage(
    input.workflowStage,
    options,
    input.prompt,
  );
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

function outputForStage(
  stage: WorkflowStage | null | undefined,
  options: { includeTddEvidence?: boolean; codeReviewOutput?: string; implementationOutput?: string } = {},
  prompt = '',
): string {
  if (stage === 'planning') {
    if (/当前 Superpowers 阶段：writing_plans/.test(prompt)) {
      return JSON.stringify({
        superpowers: {
          implementationPlanPath: 'docs/superpowers/plans/runtime-test-plan.md',
          planReviewVerdict: 'approved',
        },
      });
    }
    if (/当前 Superpowers 阶段：plan_review/.test(prompt)) {
      return JSON.stringify({
        superpowers: {
          implementationPlanPath: 'docs/superpowers/plans/runtime-test-plan.md',
          planReviewVerdict: 'approved',
        },
      });
    }
    return JSON.stringify({
      superpowers: {
        designDocPath: 'docs/superpowers/specs/runtime-test-design.md',
        designReviewVerdict: 'approved',
        worktree: {
          path: '/tmp/openclaw-room-graph-runtime',
          branchName: 'runtime-test',
          baseRef: 'test-fixture',
        },
      },
    });
  }
  if (stage === 'code_review') {
    if (options.codeReviewOutput) return options.codeReviewOutput;
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
  if (stage === 'implementation' && options.implementationOutput) return options.implementationOutput;
  if (options.includeTddEvidence === false) {
    return JSON.stringify({
      summary: 'implementation output from ACP-only executor',
    });
  }
  return JSON.stringify({
    summary: 'implementation output from ACP-only executor',
    tddEvidence: [
      { stage: 'RED', command: 'node --test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'node --test', passed: true, summary: 'passed' },
    ],
  });
}

function currentProjectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../../../../');
}
