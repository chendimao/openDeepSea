import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyAgentWorkflowState } from './state.js';
import { createSuperpowersRoutingNodes } from './superpowers-routing-nodes.js';
import type { WorkflowArtifactVersionType } from '../../types.js';

test('routeSkills records answer route and completes through answer node', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: unknown }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-answer-1' };
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '这个项目是什么？',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills({
    ...intake,
    selectedIntent: 'answer',
  });
  const answered = await nodes.answer(routed);

  assert.equal(routed.selectedIntent, 'answer');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'answer']);
  assert.equal(answered.status, 'completed');
  assert.equal(answered.currentNode, 'answer');
  assert.equal(createdArtifacts.some((artifact) => artifact.artifact_type === 'intent_routing'), true);
});

test('lightweightPlan creates a confirmable lightweight plan artifact', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, unknown> }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-lightweight-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '轻量修改文案',
    projectPath: '/tmp/project',
  });

  const planned = await nodes.lightweightPlan(initial);

  assert.equal(planned.currentNode, 'lightweight_plan');
  assert.equal(planned.activeSuperpowersStage, 'lightweight_plan');
  assert.equal(planned.lightweightPlanArtifactVersionId, 'artifact-1');
  assert.equal(planned.plan?.needsApproval, false);
  assert.equal(planned.status, 'blocked');
  assert.match(planned.error ?? '', /approved plan artifact/i);
  assert.equal(createdArtifacts[0]?.artifact_type, 'lightweight_plan');
});

test('debugPlan and reviewPlan create plan artifacts for their routes', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, unknown> }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-plan-routes-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '修复测试失败并审查代码',
    projectPath: '/tmp/project',
  });

  const debug = await nodes.debugPlan(initial);
  const review = await nodes.reviewPlan(initial);

  assert.equal(debug.currentNode, 'debug_plan');
  assert.equal(debug.draftPlanArtifactVersionId, 'artifact-1');
  assert.equal(review.currentNode, 'review_plan');
  assert.equal(review.draftPlanArtifactVersionId, 'artifact-2');
  assert.deepEqual(createdArtifacts.map((artifact) => artifact.artifact_type), ['plan', 'plan']);
  assert.equal(createdArtifacts[0]?.structured_data.mode, 'debug');
  assert.equal(createdArtifacts[1]?.structured_data.mode, 'review_only');
});
