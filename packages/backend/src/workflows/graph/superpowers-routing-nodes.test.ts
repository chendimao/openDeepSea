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

test('routing planner evidence overrides heuristic templates when available', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, any> }> = [];
  const messages: string[] = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage(input) {
      messages.push(input.content);
      return { id: 'message-planner-answer' };
    },
    async invokePlannerStage(input) {
      if (input.stageId === 'intake') {
        return { intent: 'analysis', confidence: 0.94, reason: 'planner selected analysis path' };
      }
      if (input.stageId === 'answer') {
        return { answer: 'planner answer content' };
      }
      if (input.stageId === 'analysis_plan') {
        return { conclusion: 'planner analysis', evidence: ['repo'], risks: ['risk'], recommendations: ['next'] };
      }
      if (input.stageId === 'lightweight_plan') {
        return {
          plan: {
            goal: 'planner lightweight goal',
            summary: 'planner lightweight summary',
            assumptions: ['small scope'],
            tasks: [{
              title: 'Planner task',
              description: 'Use planner generated task',
              suggestedRole: 'custom-lightweight-agent',
              priority: 'high',
              acceptance: ['planner acceptance'],
              scopeRead: ['README.md'],
              scopeWrite: ['README.md'],
              dependsOn: [],
            }],
            reviewFocus: ['planner review'],
            verification: ['git diff --check'],
            verificationCommands: [{ command: 'git diff --check', reason: 'planner selected check', required: true }],
            risks: ['planner risk'],
            needsApproval: false,
          },
        };
      }
      return input.fallbackEvidence;
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-planner-routing',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '为什么 workflow 这么设计？',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const answer = await nodes.answer({ ...initial, selectedIntent: 'answer' });
  const analysis = await nodes.analysisPlan({ ...initial, selectedIntent: 'analysis' });
  const lightweight = await nodes.lightweightPlan({ ...initial, selectedIntent: 'lightweight_task' });

  assert.equal(intake.selectedIntent, 'analysis');
  assert.equal(createdArtifacts[0]?.structured_data.confidence, 0.94);
  assert.equal(messages[0], 'planner answer content');
  assert.equal(analysis.analysisArtifactVersionId, 'artifact-2');
  assert.equal(createdArtifacts[1]?.structured_data.conclusion, 'planner analysis');
  assert.equal(lightweight.plan?.summary, 'planner lightweight summary');
  assert.equal(lightweight.plan?.tasks[0]?.title, 'Planner task');
  assert.equal(lightweight.plan?.tasks[0]?.suggestedRole, 'executor');
  assert.equal(lightweight.plan?.verificationCommands[0]?.command, 'git diff --check');
});

test('intake maps analysis-only planner evidence to the analysis route', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, any> }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
    async invokePlannerStage(input) {
      if (input.stageId === 'intake') {
        return {
          intent: 'analysis_only',
          confidence: 0.93,
          reason: '用户要求只读分析原因，不要改代码。',
        };
      }
      return input.fallbackEvidence;
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-analysis-only-routing',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '分析一下为什么删除项目会报 project has active runs，只需要分析原因，不要改代码',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills(intake);

  assert.equal(intake.selectedIntent, 'analysis');
  assert.equal(createdArtifacts[0]?.structured_data.intent, 'analysis');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'analysis_plan']);
});

test('direct factual answer goals override generic planner analysis evidence', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, unknown> }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
    async invokePlannerStage(input) {
      if (input.stageId === 'intake') {
        return {
          intent: 'analysis',
          confidence: 0.92,
          reason: 'planner selected generic analysis for a factual project question',
        };
      }
      return input.fallbackEvidence;
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-answer-factual-question',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '这个项目的主要用途是什么？只需要简短回答。',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills(intake);

  assert.equal(intake.selectedIntent, 'answer');
  assert.equal(createdArtifacts[0]?.structured_data.intent, 'answer');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'answer']);
});

test('chat answer risk assessment overrides generic analysis routing evidence', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, unknown> }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
    async invokePlannerStage(input) {
      if (input.stageId === 'intake') {
        return {
          intent: 'analysis',
          confidence: 0.6,
          reason: 'generic fallback treated why wording as analysis',
        };
      }
      return input.fallbackEvidence;
    },
  });
  const initial = {
    ...emptyAgentWorkflowState({
      workflowRunId: 'run-chat-answer-risk-assessment',
      projectId: 'project-1',
      roomId: 'room-1',
      taskId: 'task-1',
      userGoal: '为什么这个系统要使用 workflow-first？请用一句话回答。',
      projectPath: '/tmp/project',
    }),
    riskAssessment: {
      taskKind: 'chat_answer' as const,
      riskLevel: 'low' as const,
      requiresApproval: false,
      approvalReason: '',
      confidence: 0.82,
      reasons: ['short chat answer request'],
      scopeRead: [],
      scopeWrite: [],
      verificationCommands: [],
    },
  };

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills(intake);

  assert.equal(intake.selectedIntent, 'answer');
  assert.equal(createdArtifacts[0]?.structured_data.intent, 'answer');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'answer']);
});

test('question-shaped analysis requests use the analysis route instead of direct answer', async () => {
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft() {
      return { id: 'artifact-analysis-question' };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-analysis-question',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '分析一下当前项目为什么会报 project has active runs，只需要分析原因，不要改代码',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills(intake);

  assert.equal(intake.selectedIntent, 'analysis');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'analysis_plan']);
});

test('debug planner aliases and debug-shaped goals route to debug_plan before analysis', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, unknown> }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
    async invokePlannerStage(input) {
      if (input.stageId === 'intake') {
        return {
          intent: 'debug_plan',
          confidence: 0.93,
          reason: '用户明确要求先给 debug_plan，不要直接修改文件。',
        };
      }
      return input.fallbackEvidence;
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-debug-alias',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: 'debug：分析为什么删除项目时可能提示 project has active runs，先给 debug_plan，不要直接修改文件。',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills(intake);

  assert.equal(intake.selectedIntent, 'debug');
  assert.equal(createdArtifacts[0]?.structured_data.intent, 'debug');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'debug_plan']);
});

test('explicit debug goals override generic planner analysis evidence', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, unknown> }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
    async invokePlannerStage(input) {
      if (input.stageId === 'intake') {
        return {
          intent: 'analysis',
          confidence: 0.94,
          reason: 'planner treated read-only debug planning as analysis',
        };
      }
      return input.fallbackEvidence;
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-debug-explicit',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: 'debug：分析为什么删除项目时可能提示 project has active runs，先给 debug_plan，不要直接修改文件。',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills(intake);

  assert.equal(intake.selectedIntent, 'debug');
  assert.equal(createdArtifacts[0]?.structured_data.intent, 'debug');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'debug_plan']);
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
  assert.equal(debug.status, 'awaiting_approval');
  assert.equal(debug.approval, 'pending');
  assert.match(debug.error ?? '', /debug plan/i);
  assert.equal(review.currentNode, 'review_plan');
  assert.equal(review.draftPlanArtifactVersionId, 'artifact-2');
  assert.deepEqual(createdArtifacts.map((artifact) => artifact.artifact_type), ['plan', 'plan']);
  assert.equal(createdArtifacts[0]?.structured_data.mode, 'debug');
  assert.equal(createdArtifacts[1]?.structured_data.mode, 'review_only');
});

test('routeSkills keeps development requests with review wording on standard development path', async () => {
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft() {
      return { id: 'artifact-1' };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
  });

  const development = await nodes.routeSkills(emptyAgentWorkflowState({
    workflowRunId: 'run-standard-review-wording',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '新增一个标准开发功能，创建模块和测试脚本，并完成审查和验证。',
    projectPath: '/tmp/project',
  }));

  const reviewOnly = await nodes.routeSkills(emptyAgentWorkflowState({
    workflowRunId: 'run-review-only',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-2',
    userGoal: '请审查当前 diff，指出 bug 和遗漏验证。',
    projectPath: '/tmp/project',
  }));

  assert.equal(development.selectedIntent, 'standard_development');
  assert.deepEqual(development.selectedPath, ['intake', 'route_skills', 'brainstorming']);
  assert.equal(reviewOnly.selectedIntent, 'review_only');
  assert.deepEqual(reviewOnly.selectedPath, ['intake', 'route_skills', 'review_plan']);
});

test('explicit implementation goals override generic planner review-only evidence', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: Record<string, unknown> }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
    async invokePlannerStage(input) {
      if (input.stageId === 'intake') {
        return {
          intent: 'review_only',
          confidence: 0.93,
          reason: 'planner over-weighted incidental review wording',
        };
      }
      return input.fallbackEvidence;
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-standard-over-review',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-standard',
    userGoal: '实现一个设置页功能，创建前端界面和必要测试，并完成审查验证。',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills(intake);

  assert.equal(intake.selectedIntent, 'standard_development');
  assert.equal(createdArtifacts[0]?.structured_data.intent, 'standard_development');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'brainstorming']);
});

test('routeSkills prioritizes lightweight and pure review intents over incidental wording', async () => {
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft() {
      return { id: 'artifact-1' };
    },
    createAssistantMessage() {
      return { id: 'message-unused' };
    },
  });

  const lightweight = await nodes.routeSkills(emptyAgentWorkflowState({
    workflowRunId: 'run-lightweight-review-wording',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-lightweight',
    userGoal: '轻量任务：在 README.md 追加一行项目说明。请走轻量流程，完成审查和验证。',
    projectPath: '/tmp/project',
  }));

  const reviewOnly = await nodes.routeSkills(emptyAgentWorkflowState({
    workflowRunId: 'run-pure-review-no-edit',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-review',
    userGoal: '请审查当前项目代码和测试，指出潜在问题与缺失验证。只做代码审查，不要修改文件。',
    projectPath: '/tmp/project',
  }));

  assert.equal(lightweight.selectedIntent, 'lightweight_task');
  assert.deepEqual(lightweight.selectedPath, ['intake', 'route_skills', 'lightweight_plan']);
  assert.equal(reviewOnly.selectedIntent, 'review_only');
  assert.deepEqual(reviewOnly.selectedPath, ['intake', 'route_skills', 'review_plan']);
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
