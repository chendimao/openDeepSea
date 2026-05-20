import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSuperpowersRuntimeGraph,
  SUPERPOWERS_GRAPH_VERSION,
  SUPERPOWERS_RUNTIME_PROFILE,
} from './superpowers-runtime.js';
import { emptyAgentWorkflowState } from './state.js';

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
