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
  assert.equal(planned.status, 'awaiting_approval');
  assert.equal(planned.approval, 'pending');
  assert.match(planned.error ?? '', /user confirmation/i);
  assert.equal(createdArtifacts[0]?.artifact_type, 'lightweight_plan');
});

test('lightweightPlan uses docs verification for README-only tasks', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, any> }> = [];
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
    workflowRunId: 'run-lightweight-readme',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '轻量修改 README 文档，追加一行说明',
    projectPath: '/tmp/project',
  });

  const planned = await nodes.lightweightPlan(initial);

  assert.equal(planned.plan?.verificationCommands[0]?.command, 'git status --short');
  assert.equal(planned.plan?.tasks[0]?.scopeWrite[0], 'README.md');
  assert.equal(createdArtifacts[0]?.structured_data.verificationCommands[0]?.command, 'git status --short');
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

test('agentAssignment creates artifact with fullstack executor fallback', async () => {
  const artifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: any }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      artifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${artifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-1' };
    },
    listAvailableWorkflowAgents() {
      return [{
        id: 'fullstack-engineer',
        name: '全栈工程师',
        provider: 'codex',
        capabilities: ['frontend', 'backend', 'testing'],
        workflowRoles: ['executor'],
        acpEnabled: true,
        available: true,
        fallback: true,
      }];
    },
  });
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-assignment-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '实现设置页',
    projectPath: '/tmp/project',
  });

  const next = await nodes.agentAssignment({
    ...state,
    selectedIntent: 'standard_development',
    plan: {
      goal: '实现设置页',
      summary: '实现设置页',
      assumptions: [],
      tasks: [{
        title: '实现设置页',
        description: '修改前端页面',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['页面可构建'],
        scopeRead: ['packages/frontend/src/pages'],
        scopeWrite: ['packages/frontend/src/pages/SettingsPage.tsx'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [{ command: 'npm run build', reason: 'build', required: true }],
      risks: [],
      needsApproval: true,
    },
  });

  assert.equal(next.agentAssignmentArtifactVersionId, 'artifact-1');
  assert.equal(next.agentAssignments?.[0]?.assignedAgentId, 'fullstack-engineer');
  assert.equal(artifacts[0]?.artifact_type, 'agent_assignment');
  assert.equal(artifacts[0]?.structured_data.assignments[0].assignedAgentId, 'fullstack-engineer');
  assert.match(artifacts[0]?.structured_data.assignments[0].fallbackReason, /全栈工程师/);
});
