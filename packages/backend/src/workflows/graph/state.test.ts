import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentWorkflowState } from './state.js';

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

test('parseGraphState defaults missing workflowPlan and child task mappings for existing runs', () => {
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-legacy',
    projectId: 'project-legacy',
    roomId: 'room-legacy',
    taskId: 'task-legacy',
    userGoal: 'Legacy state',
    projectPath: tempDir,
  });
  const legacyJson = JSON.stringify(Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== 'workflowPlan' && key !== 'childTaskPlanIndexes'),
  ));

  const parsed = parseGraphState(legacyJson);

  assert.equal(parsed?.workflowPlan, null);
  assert.deepEqual(parsed?.childTaskPlanIndexes, {});
});

test('parseGraphState preserves Superpowers workflow state fields', () => {
  const state = {
    ...emptyAgentWorkflowState({
      workflowRunId: 'run-superpowers',
      projectId: 'project-superpowers',
      roomId: 'room-superpowers',
      taskId: 'task-superpowers',
      userGoal: 'Superpowers state',
      projectPath: tempDir,
    }),
    runtimeProfile: 'superpowers' as const,
    superpowersPhase: 'brainstorming',
    designDocPath: 'docs/superpowers/specs/example.md',
    implementationPlanPath: null,
  };

  const parsed = parseGraphState(serializeGraphState(state));

  assert.equal(parsed?.runtimeProfile, 'superpowers');
  assert.equal(parsed?.superpowersPhase, 'brainstorming');
  assert.equal(parsed?.designDocPath, 'docs/superpowers/specs/example.md');
  assert.equal(parsed?.implementationPlanPath, null);
});

test('parseGraphState preserves Superpowers TDD exemption fields', () => {
  const state = {
    ...emptyAgentWorkflowState({
      workflowRunId: 'run-superpowers-exemption',
      projectId: 'project-superpowers-exemption',
      roomId: 'room-superpowers-exemption',
      taskId: 'task-superpowers-exemption',
      userGoal: 'Superpowers exemption state',
      projectPath: tempDir,
    }),
    tddExemption: {
      reason: 'legacy service lacks stable fixture',
      approvedBy: 'reviewer-2',
      createdAt: 1710000000000,
    },
  };

  const parsed = parseGraphState(serializeGraphState(state));

  assert.deepEqual(parsed?.tddExemption, {
    reason: 'legacy service lacks stable fixture',
    approvedBy: 'reviewer-2',
    createdAt: 1710000000000,
  });
});

test('parseGraphState preserves Superpowers finish branch decision options', () => {
  const options: NonNullable<AgentWorkflowState['finishBranchDecision']>['options'] = [
    'merge_local',
    'create_pr',
    'keep_branch',
    'discard_work',
  ];
  const state = {
    ...emptyAgentWorkflowState({
      workflowRunId: 'run-superpowers-finish-branch',
      projectId: 'project-superpowers-finish-branch',
      roomId: 'room-superpowers-finish-branch',
      taskId: 'task-superpowers-finish-branch',
      userGoal: 'Superpowers finish branch state',
      projectPath: tempDir,
    }),
    finishBranchDecision: {
      decision: 'keep_branch' as const,
      options,
      reason: 'awaiting explicit closeout automation',
      decidedAt: '2026-05-20T00:00:00.000Z',
    },
  };

  const parsed = parseGraphState(serializeGraphState(state));

  assert.deepEqual(parsed?.finishBranchDecision, {
    decision: 'keep_branch',
    options: ['merge_local', 'create_pr', 'keep_branch', 'discard_work'],
    reason: 'awaiting explicit closeout automation',
    decidedAt: '2026-05-20T00:00:00.000Z',
  });
});

test('parseGraphState preserves risk assessment approval card and agent events', () => {
  const verificationCommands = [{
    command: 'npm run build -w @openclaw-room/backend',
    reason: 'compile workflow state metadata',
    required: true,
  }];
  const riskAssessment: NonNullable<AgentWorkflowState['riskAssessment']> = {
    taskKind: 'backend_change',
    riskLevel: 'medium',
    requiresApproval: true,
    approvalReason: 'workflow shared contract schema or types changes require approval',
    confidence: 0.82,
    reasons: ['workflow/shared contract schema or types changes require approval'],
    scopeRead: ['packages/backend/src/workflows/graph/state.ts'],
    scopeWrite: ['packages/backend/src/workflows/graph/state.ts'],
    verificationCommands,
  };
  const approvalCard: NonNullable<AgentWorkflowState['approvalCard']> = {
    riskLevel: 'medium',
    taskKind: 'backend_change',
    summary: 'Approval required for backend_change',
    approvalReason: 'workflow shared contract schema or types changes require approval',
    agents: ['backend-executor'],
    executionMode: 'serial',
    scopeRead: ['packages/backend/src/workflows/graph/state.ts'],
    scopeWrite: ['packages/backend/src/workflows/graph/state.ts'],
    verification: verificationCommands,
    risks: ['state schema drift'],
    assumptions: ['Task 4 will extract agent events later'],
  };
  const agentEvents: NonNullable<AgentWorkflowState['agentEvents']> = [{
    id: 'event-1',
    type: 'approval_requested',
    message: 'Approval requested for medium-risk workflow state change',
    createdAt: '2026-06-10T00:00:00.000Z',
    payload: { riskLevel: 'medium' },
  }];
  const state = {
    ...emptyAgentWorkflowState({
      workflowRunId: 'run-risk-metadata',
      projectId: 'project-risk-metadata',
      roomId: 'room-risk-metadata',
      taskId: 'task-risk-metadata',
      userGoal: 'Risk metadata state',
      projectPath: tempDir,
    }),
    riskAssessment,
    approvalCard,
    agentEvents,
  };

  const parsed = parseGraphState(serializeGraphState(state));
  const parsedWithMetadata = parsed as typeof parsed & {
    riskAssessment?: unknown;
    approvalCard?: unknown;
    agentEvents?: unknown;
  };

  assert.deepEqual(parsedWithMetadata.riskAssessment, riskAssessment);
  assert.deepEqual(parsedWithMetadata.approvalCard, approvalCard);
  assert.deepEqual(parsedWithMetadata.agentEvents, agentEvents);
});

test('emptyAgentWorkflowState defaults risk metadata fields', () => {
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-empty-risk-metadata',
    projectId: 'project-empty-risk-metadata',
    roomId: 'room-empty-risk-metadata',
    taskId: 'task-empty-risk-metadata',
    userGoal: 'Empty risk metadata state',
    projectPath: tempDir,
  }) as ReturnType<typeof emptyAgentWorkflowState> & {
    riskAssessment?: unknown;
    approvalCard?: unknown;
    agentEvents?: unknown;
  };

  assert.equal(state.riskAssessment, null);
  assert.equal(state.approvalCard, null);
  assert.deepEqual(state.agentEvents, []);
});
