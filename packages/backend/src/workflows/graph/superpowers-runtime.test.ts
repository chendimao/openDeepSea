import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

import {
  buildSuperpowersRuntimeGraph,
  SUPERPOWERS_GRAPH_VERSION,
  SUPERPOWERS_RUNTIME_PROFILE,
} from './superpowers-runtime.js';
import { emptyAgentWorkflowState, type AgentWorkflowState } from './state.js';
import { createGraphWorkflowRun } from './runtime.js';
import { agentRunRepo } from '../../repos/agent-runs.js';
import { messageRepo } from '../../repos/messages.js';
import { projectRepo } from '../../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../../repos/rooms.js';
import { taskRepo } from '../../repos/tasks.js';
import { workflowRepo } from '../../repos/workflows.js';

test('buildSuperpowersRuntimeGraph exposes Superpowers runtime profile metadata', () => {
  const graph = buildSuperpowersRuntimeGraph();

  assert.equal(graph.graphVersion, SUPERPOWERS_GRAPH_VERSION);
  assert.equal(graph.runtimeProfile, SUPERPOWERS_RUNTIME_PROFILE);
  assert.deepEqual(graph.placeholderNodeTypes, [
    'brainstorming',
    'spec_review',
    'worktree',
    'writing_plans',
    'plan_review',
    'tdd_execute',
    'spec_compliance_review',
    'code_quality_review',
    'finish_branch',
  ]);
});

test('buildSuperpowersRuntimeGraph exposes ordered Superpowers planning phase steps', () => {
  const graph = buildSuperpowersRuntimeGraph();

  assert.deepEqual(
    graph.phaseSteps.slice(0, 5).map((step) => step.nodeName),
    ['brainstorming', 'spec_review', 'worktree', 'writing_plans', 'plan_review'],
  );
});

test('buildSuperpowersRuntimeGraph executable definition runs Superpowers planning gates before dispatch', () => {
  const graph = buildSuperpowersRuntimeGraph();

  assert.deepEqual(
    graph.executableDefinition.nodes.slice(0, 8).map((node) => node.id),
    ['context', 'brainstorming', 'spec_review', 'worktree', 'writing_plans', 'plan_review', 'approval', 'dispatch'],
  );
  assert.deepEqual(
    graph.executableDefinition.edges.slice(0, 7).map((edge) => `${edge.from}->${edge.to}`),
    [
      'context->brainstorming',
      'brainstorming->spec_review',
      'spec_review->worktree',
      'worktree->writing_plans',
      'writing_plans->plan_review',
      'plan_review->approval',
      'approval->dispatch',
    ],
  );
});

test('buildSuperpowersRuntimeGraph executable definition routes TDD execution, reviews, verify, and finish branch before acceptance', () => {
  const graph = buildSuperpowersRuntimeGraph();

  assert.deepEqual(Object.keys(graph.nodes).filter((name) => [
    'tddExecute',
    'specComplianceReview',
    'codeQualityReview',
    'finishBranch',
  ].includes(name)), [
    'tddExecute',
    'specComplianceReview',
    'codeQualityReview',
    'finishBranch',
  ]);
  assert.deepEqual(
    graph.executableDefinition.nodes.slice(-8).map((node) => node.id),
    ['dispatch', 'tdd_execute', 'spec_compliance_review', 'code_quality_review', 'verify', 'finish_branch', 'acceptance', 'memory'],
  );
  assert.ok(graph.executableDefinition.edges.some((edge) =>
    edge.from === 'code_quality_review' && edge.to === 'verify' && edge.condition === 'pass',
  ));
  assert.ok(graph.executableDefinition.edges.some((edge) =>
    edge.from === 'verify' && edge.to === 'finish_branch',
  ));
  assert.ok(graph.executableDefinition.edges.some((edge) =>
    edge.from === 'finish_branch' && edge.to === 'acceptance',
  ));
});

test('Superpowers TDD execute node blocks without RED/GREEN evidence and proceeds with evidence or exemption', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const nodes = graph.nodes as typeof graph.nodes & {
    tddExecute?: (state: ReturnType<typeof emptyAgentWorkflowState>) => Promise<ReturnType<typeof emptyAgentWorkflowState>>;
  };
  const gates = graph as typeof graph & {
    canLeaveTddExecute?: (state: ReturnType<typeof emptyAgentWorkflowState>) => boolean;
  };
  const baseState = emptyAgentWorkflowState({
    workflowRunId: 'run-superpowers-runtime-tdd-gate',
    projectId: 'project-superpowers-runtime-tdd-gate',
    roomId: 'room-superpowers-runtime-tdd-gate',
    taskId: 'task-superpowers-runtime-tdd-gate',
    userGoal: 'TDD evidence gate',
    projectPath: '/tmp/open-deep-sea-superpowers-runtime-tdd-gate',
  });

  assert.equal(typeof nodes.tddExecute, 'function');
  assert.equal(typeof gates.canLeaveTddExecute, 'function');

  const blocked = await nodes.tddExecute(baseState);
  assert.equal(blocked.superpowersPhase, 'tdd_execute');
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.error ?? '', /RED.*GREEN|TDD evidence/i);
  assert.equal(gates.canLeaveTddExecute(blocked), false);

  const withEvidence = await nodes.tddExecute({
    ...baseState,
    tddEvidence: [
      { stage: 'RED', command: 'npm test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'npm test', passed: true, summary: 'passed' },
    ],
  });
  assert.equal(withEvidence.status, 'running');
  assert.equal(withEvidence.error, null);
  assert.equal(gates.canLeaveTddExecute(withEvidence), true);

  const withExemption = await nodes.tddExecute({
    ...baseState,
    tddExemption: {
      reason: 'documentation-only task has no executable behavior',
      approvedBy: 'reviewer-room-agent',
      createdAt: Date.now(),
    },
  });
  assert.equal(withExemption.status, 'running');
  assert.equal(gates.canLeaveTddExecute(withExemption), true);
});

test('Superpowers review nodes expose reroute metadata when reviews request changes', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const nodes = graph.nodes as typeof graph.nodes & {
    specComplianceReview?: (state: ReturnType<typeof emptyAgentWorkflowState>) => Promise<ReturnType<typeof emptyAgentWorkflowState>>;
    codeQualityReview?: (state: ReturnType<typeof emptyAgentWorkflowState>) => Promise<ReturnType<typeof emptyAgentWorkflowState>>;
  };
  const baseState = emptyAgentWorkflowState({
    workflowRunId: 'run-superpowers-runtime-review-reroute',
    projectId: 'project-superpowers-runtime-review-reroute',
    roomId: 'room-superpowers-runtime-review-reroute',
    taskId: 'task-superpowers-runtime-review-reroute',
    userGoal: 'Review reroutes',
    projectPath: '/tmp/open-deep-sea-superpowers-runtime-review-reroute',
  });

  assert.equal(typeof nodes.specComplianceReview, 'function');
  assert.equal(typeof nodes.codeQualityReview, 'function');

  const afterSpecChanges = await nodes.specComplianceReview({
    ...baseState,
    specComplianceReview: {
      verdict: 'changes_requested',
      findings: ['Implementation misses the plan'],
      reviewedAt: null,
    },
  });
  assert.equal(afterSpecChanges.superpowersPhase, 'spec_compliance_review');
  assert.equal(afterSpecChanges.reviewVerdict, 'changes_requested');

  const afterCodeChanges = await nodes.codeQualityReview({
    ...baseState,
    codeQualityReview: {
      verdict: 'changes_requested',
      findings: ['Important regression risk'],
      reviewedAt: null,
    },
  });
  assert.equal(afterCodeChanges.superpowersPhase, 'code_quality_review');
  assert.equal(afterCodeChanges.error, 'Superpowers code quality review requested changes');
  assert.equal(afterCodeChanges.reviewVerdict, 'changes_requested');
});

test('Superpowers review nodes invoke current room reviewer agent and parse JSON verdict', async () => {
  const projectPath = `/tmp/superpowers-review-runtime-project-${Date.now()}`;
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Superpowers review runtime project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Superpowers review runtime room' });
  const reviewer = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'reviewer-agent',
    agent_name: 'Reviewer Agent',
  });
  roomAgentRepo.setWorkflowRole(reviewer.id, 'reviewer');
  roomAgentRepo.setAcp(reviewer.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: [],
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Check reviewer invocation',
  });
  const run = createGraphWorkflowRun(task.id);
  const reviewOutput = JSON.stringify({
    verdict: 'pass',
    findings: ['reviewed via agent'],
    requiredFixes: [],
    riskLevel: 'low',
  });

  workflowRepo.updateGraphState(run.id, JSON.stringify({
    ...emptyAgentWorkflowState({
      workflowRunId: run.id,
      projectId: project.id,
      roomId: room.id,
      taskId: task.id,
      userGoal: task.title,
      projectPath: project.path,
    }),
    runtimeProfile: 'superpowers',
    superpowersPhase: 'spec_compliance_review',
    tddEvidence: [
      { stage: 'RED', command: 'npm test', passed: false, summary: 'red' },
      { stage: 'GREEN', command: 'npm test', passed: true, summary: 'green' },
    ],
    plan: {
      goal: task.title,
      summary: task.title,
      assumptions: [],
      tasks: [],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [{ command: 'npm run build', reason: 'verify', required: true }],
      risks: [],
      needsApproval: false,
    },
    implementationPlanPath: 'docs/superpowers/plans/check-review.md',
  }));

  const calls: string[] = [];
  const graph = buildSuperpowersRuntimeGraph({
    runAcpAgent: async (input) => {
      calls.push(`${input.workflowStage}:${input.agent.agent_id}`);
      const runRecord = agentRunRepo.create({
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
      const completedRun = agentRunRepo.updateStatus(runRecord.id, 'completed', { stdout: reviewOutput }) ?? runRecord;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: reviewOutput,
        message_type: 'agent_stream',
      });
      return {
        run: completedRun,
        message,
        status: 'completed',
      };
    },
  });

  const latest = await graph.nodes.specComplianceReview(emptyAgentWorkflowState({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
  }));
  assert.deepEqual(calls, ['code_review:reviewer-agent']);
  assert.equal(latest.specComplianceReview?.verdict, 'approved');
  assert.equal(latest.specComplianceReview?.findings[0], 'reviewed via agent');
  assert.equal(latest.superpowersPhase, 'spec_compliance_review');
  const reviewStep = workflowRepo.listSteps(run.id).find((step) => step.node_name === 'spec_compliance_review');
  assert.equal(reviewStep?.status, 'completed');
  assert.ok(reviewStep?.agent_run_id);
  assert.equal(reviewStep?.result, reviewOutput);
});

test('Superpowers finish branch node records default keep branch decision and available options', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-superpowers-runtime-finish-branch',
    projectId: 'project-superpowers-runtime-finish-branch',
    roomId: 'room-superpowers-runtime-finish-branch',
    taskId: 'task-superpowers-runtime-finish-branch',
    userGoal: 'Finish branch gate',
    projectPath: '/tmp/open-deep-sea-superpowers-runtime-finish-branch',
  });

  const afterFinishBranch = await graph.nodes.finishBranch({
    ...state,
    verificationEvidence: [
      {
        command: 'npm run build',
        status: 'passed',
        required: true,
        fresh: true,
        recordedAt: '2026-05-21T00:00:00.000Z',
      },
    ],
  });
  const finishBranchDecision = afterFinishBranch.finishBranchDecision as (
    AgentWorkflowState['finishBranchDecision'] & { options?: string[] }
  );

  assert.equal(afterFinishBranch.superpowersPhase, 'finish_branch');
  assert.equal(finishBranchDecision?.decision, 'keep_branch');
  assert.deepEqual(finishBranchDecision?.options, [
    'merge_local',
    'create_pr',
    'keep_branch',
    'discard_work',
  ]);
  assert.equal(finishBranchDecision?.reason, 'awaiting explicit closeout automation');
  assert.equal(afterFinishBranch.status, 'running');
  assert.equal(afterFinishBranch.error, null);
});

test('Superpowers planning nodes record phase artifacts and review verdicts', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-superpowers-runtime-test',
    projectId: 'project-superpowers-runtime-test',
    roomId: 'room-superpowers-runtime-test',
    taskId: 'task-superpowers-runtime-test',
    userGoal: 'Implement Superpowers planning gates',
    projectPath: '/tmp/open-deep-sea-superpowers-runtime-test',
  });

  const afterBrainstorming = await graph.nodes.brainstorming(state);
  assert.equal(afterBrainstorming.superpowersPhase, 'brainstorming');
  assert.equal(afterBrainstorming.designDocPath, 'docs/superpowers/specs/superpowers-design.md');

  const afterSpecReview = await graph.nodes.specReview(afterBrainstorming);
  assert.equal(afterSpecReview.superpowersPhase, 'spec_review');
  assert.equal(afterSpecReview.designReviewVerdict, 'approved');

  const afterWorktree = await graph.nodes.worktree(afterSpecReview);
  assert.equal(afterWorktree.superpowersPhase, 'worktree');
  assert.equal(afterWorktree.worktree?.path, '/tmp/open-deep-sea-superpowers-runtime-test');
  assert.equal(afterWorktree.worktree?.branchName, 'not_available');
  assert.match(afterWorktree.worktree?.baseRef ?? '', /skipped/);

  const afterWritingPlans = await graph.nodes.writingPlans(afterWorktree);
  assert.equal(afterWritingPlans.superpowersPhase, 'writing_plans');
  assert.equal(afterWritingPlans.implementationPlanPath, 'docs/superpowers/plans/superpowers-implementation-plan.md');

  const afterPlanReview = await graph.nodes.planReview(afterWritingPlans);
  assert.equal(afterPlanReview.superpowersPhase, 'plan_review');
  assert.equal(afterPlanReview.planReviewVerdict, 'approved');
  assert.equal(graph.canDispatch(afterPlanReview), true);
});

test('Superpowers runtime blocks dispatch when implementation plan path is missing', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-superpowers-runtime-test-blocked',
    projectId: 'project-superpowers-runtime-test-blocked',
    roomId: 'room-superpowers-runtime-test-blocked',
    taskId: 'task-superpowers-runtime-test-blocked',
    userGoal: 'Dispatch must wait for a plan path',
    projectPath: '/tmp/open-deep-sea-superpowers-runtime-test-blocked',
  });

  const reviewedState = {
    ...state,
    designDocPath: 'docs/superpowers/specs/superpowers-design.md',
    designReviewVerdict: 'approved' as const,
    planReviewVerdict: 'approved' as const,
  };

  assert.equal(graph.canDispatch(reviewedState), false);

  const afterPlanReview = await graph.nodes.planReview(reviewedState);
  assert.equal(afterPlanReview.status, 'blocked');
  assert.match(afterPlanReview.error ?? '', /implementationPlanPath/);
  assert.equal(graph.canDispatch(afterPlanReview), false);
});
