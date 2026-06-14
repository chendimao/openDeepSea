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
import { workflowArtifactVersionRepo, workflowRepo } from '../../repos/workflows.js';

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

test('worktree node records explicit skip decision instead of not_available placeholder', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-worktree-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '轻量修改',
    projectPath: '/tmp/project',
  });

  const next = await graph.nodes.worktree({
    ...state,
    approvedSpecArtifactVersionId: 'artifact-spec-1',
  });

  assert.notEqual(next.worktree?.branchName, 'not_available');
  assert.equal(next.worktreeDecision?.action, 'skip');
  assert.match(next.worktreeDecision?.reason ?? '', /当前工作区|skip/i);
});

test('buildSuperpowersRuntimeGraph executable definition starts with planner route gates', () => {
  const graph = buildSuperpowersRuntimeGraph();
  const edgeIds = new Set(graph.executableDefinition.edges.map((edge) => `${edge.from}->${edge.to}:${edge.condition ?? ''}`));

  assert.deepEqual(
    graph.executableDefinition.nodes.slice(0, 8).map((node) => node.id),
    ['context', 'intake', 'route_skills', 'answer', 'analysis_plan', 'lightweight_plan', 'brainstorming', 'spec_review'],
  );
  assert.equal(edgeIds.has('context->intake:'), true);
  assert.equal(edgeIds.has('intake->route_skills:'), true);
  assert.equal(edgeIds.has('route_skills->answer:answer'), true);
  assert.equal(edgeIds.has('route_skills->analysis_plan:analysis'), true);
  assert.equal(edgeIds.has('route_skills->lightweight_plan:lightweight_task'), true);
  assert.equal(edgeIds.has('route_skills->brainstorming:standard_development'), true);
});

test('buildSuperpowersRuntimeGraph executable definition routes TDD execution, reviews, verify, and finish branch before acceptance', () => {
  const graph = buildSuperpowersRuntimeGraph();
  const nodeIds = new Set(graph.executableDefinition.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.executableDefinition.edges.map((edge) => `${edge.from}->${edge.to}:${edge.condition ?? ''}`));

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
  for (const id of ['dispatch', 'execute', 'spec_compliance_review', 'code_quality_review', 'verification', 'finish_branch', 'acceptance', 'memory']) {
    assert.equal(nodeIds.has(id), true, `missing node ${id}`);
  }
  assert.equal(edgeIds.has('dispatch->execute:'), true);
  assert.equal(edgeIds.has('execute->execute:has_runnable_child'), true);
  assert.equal(edgeIds.has('execute->spec_compliance_review:done'), true);
  assert.equal(edgeIds.has('code_quality_review->verification:pass'), true);
  assert.equal(edgeIds.has('verification->finish_branch:'), true);
  assert.equal(edgeIds.has('finish_branch->acceptance:completed'), true);
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

test('Superpowers review change requests keep TDD exemption evidence for documentation repair loops', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const nodes = graph.nodes as typeof graph.nodes & {
    specComplianceReview?: (state: ReturnType<typeof emptyAgentWorkflowState>) => Promise<ReturnType<typeof emptyAgentWorkflowState>>;
  };
  const baseState = emptyAgentWorkflowState({
    workflowRunId: 'run-superpowers-runtime-review-tdd-exemption',
    projectId: 'project-superpowers-runtime-review-tdd-exemption',
    roomId: 'room-superpowers-runtime-review-tdd-exemption',
    taskId: 'task-superpowers-runtime-review-tdd-exemption',
    userGoal: 'Review documentation repair keeps exemption',
    projectPath: '/tmp/open-deep-sea-superpowers-runtime-review-tdd-exemption',
  });
  const tddExemption = {
    reason: 'documentation-only task has no executable behavior',
    approvedBy: 'workflow-runtime',
    createdAt: Date.now(),
  };

  const afterSpecChanges = await nodes.specComplianceReview!({
    ...baseState,
    tddExemption,
    specComplianceReview: {
      verdict: 'changes_requested',
      findings: ['README change needs a traceability note'],
      reviewedAt: null,
    },
  });

  assert.equal(afterSpecChanges.reviewVerdict, 'changes_requested');
  assert.deepEqual(afterSpecChanges.tddExemption, tddExemption);
});

test('Superpowers review treats commit-only feedback as finish-branch concern', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const nodes = graph.nodes as typeof graph.nodes & {
    specComplianceReview?: (state: ReturnType<typeof emptyAgentWorkflowState>) => Promise<ReturnType<typeof emptyAgentWorkflowState>>;
  };
  const baseState = emptyAgentWorkflowState({
    workflowRunId: 'run-superpowers-runtime-review-commit-only',
    projectId: 'project-superpowers-runtime-review-commit-only',
    roomId: 'room-superpowers-runtime-review-commit-only',
    taskId: 'task-superpowers-runtime-review-commit-only',
    userGoal: 'Review documentation commit-only feedback',
    projectPath: '/tmp/open-deep-sea-superpowers-runtime-review-commit-only',
  });

  const afterSpecChanges = await nodes.specComplianceReview!({
    ...baseState,
    specComplianceReview: {
      verdict: 'changes_requested',
      findings: [
        'README.md:3 内容符合任务要求，未发现运行时回归风险。',
        '.git:1 缺少提交闭环证据，git add README.md 失败并返回 fatal: not a git repository。',
      ],
      reviewedAt: null,
    },
  });

  assert.equal(afterSpecChanges.reviewVerdict, 'pass');
  assert.equal(afterSpecChanges.error, null);
  assert.equal(afterSpecChanges.specComplianceReview?.verdict, 'approved');
});

test('Superpowers review keeps implementation defects actionable even with commit feedback', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const nodes = graph.nodes as typeof graph.nodes & {
    specComplianceReview?: (state: ReturnType<typeof emptyAgentWorkflowState>) => Promise<ReturnType<typeof emptyAgentWorkflowState>>;
  };
  const baseState = emptyAgentWorkflowState({
    workflowRunId: 'run-superpowers-runtime-review-mixed-feedback',
    projectId: 'project-superpowers-runtime-review-mixed-feedback',
    roomId: 'room-superpowers-runtime-review-mixed-feedback',
    taskId: 'task-superpowers-runtime-review-mixed-feedback',
    userGoal: 'Review mixed implementation and commit feedback',
    projectPath: '/tmp/open-deep-sea-superpowers-runtime-review-mixed-feedback',
  });

  const afterSpecChanges = await nodes.specComplianceReview!({
    ...baseState,
    specComplianceReview: {
      verdict: 'changes_requested',
      findings: [
        'src/index.ts:12 缺少测试覆盖，当前行为回归风险仍未解决。',
        '.git:1 缺少提交闭环证据，git commit 尚未执行。',
      ],
      reviewedAt: null,
    },
  });

  assert.equal(afterSpecChanges.reviewVerdict, 'changes_requested');
  assert.equal(afterSpecChanges.error, 'Superpowers spec compliance review requested changes');
  assert.equal(afterSpecChanges.specComplianceReview, null);
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

test('Superpowers review nodes retry once when reviewer omits required JSON evidence', async () => {
  const projectPath = `/tmp/superpowers-review-runtime-retry-${Date.now()}`;
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Superpowers review retry project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Superpowers review retry room' });
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
    title: 'Retry missing reviewer evidence',
  });
  const run = createGraphWorkflowRun(task.id);
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
    tddExemption: {
      reason: 'documentation-only',
      approvedBy: 'test',
      createdAt: Date.now(),
    },
    plan: {
      goal: task.title,
      summary: task.title,
      assumptions: [],
      tasks: [],
      reviewFocus: [],
      verification: ['git status --short'],
      verificationCommands: [{ command: 'git status --short', reason: 'verify', required: true }],
      risks: [],
      needsApproval: false,
    },
    implementationPlanPath: 'workflow-artifact:lightweight-plan',
  }));

  const validReviewOutput = JSON.stringify({
    superpowers: {
      specComplianceReview: {
        verdict: 'approved',
        findings: [],
        reviewedAt: '2026-06-13T00:00:00.000Z',
      },
    },
  });
  const prompts: string[] = [];
  const graph = buildSuperpowersRuntimeGraph({
    runAcpAgent: async (input) => {
      prompts.push(input.prompt);
      const output = prompts.length === 1
        ? '我会按审查员角色做只读核查，但没有输出 JSON。'
        : validReviewOutput;
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
      const completedRun = agentRunRepo.updateStatus(runRecord.id, 'completed', { stdout: output }) ?? runRecord;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: output,
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
  const reviewStep = workflowRepo.listSteps(run.id).find((step) => step.node_name === 'spec_compliance_review');

  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /上一次审查回复没有包含 workflow runtime 可解析/);
  assert.equal(latest.specComplianceReview?.verdict, 'approved');
  assert.equal(latest.reviewVerdict, 'pass');
  assert.equal(reviewStep?.status, 'completed');
  assert.equal(reviewStep?.result, validReviewOutput);
});

test('Superpowers brainstorming node invokes planner agent and records required evidence', async () => {
  const projectPath = `/tmp/superpowers-planner-runtime-project-${Date.now()}`;
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Superpowers planner runtime project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Superpowers planner runtime room' });
  const planner = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'planner-agent',
    agent_name: 'Planner Agent',
  });
  roomAgentRepo.setWorkflowRole(planner.id, 'planner');
  roomAgentRepo.setAcp(planner.id, {
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
    title: 'Run planner brainstorming',
  });
  const run = createGraphWorkflowRun(task.id);
  const planningOutput = JSON.stringify({
    superpowers: {
      designDocPath: 'docs/superpowers/specs/runtime-planner-design.md',
    },
  });
  const calls: string[] = [];
  const graph = buildSuperpowersRuntimeGraph({
    runAcpAgent: async (input) => {
      calls.push(`${input.workflowStage}:${input.agent.agent_id}`);
      assert.match(input.prompt, /当前 Superpowers 阶段：brainstorming/);
      assert.match(input.prompt, /你是 planner controller/);
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
      const completedRun = agentRunRepo.updateStatus(runRecord.id, 'completed', { stdout: planningOutput }) ?? runRecord;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: planningOutput,
        message_type: 'agent_stream',
      });
      return { run: completedRun, message, status: 'completed' };
    },
  });

  const latest = await graph.nodes.brainstorming(emptyAgentWorkflowState({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
  }));

  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? '', /^planning:/);
  assert.equal(latest.superpowersPhase, 'brainstorming');
  assert.equal(latest.designDocPath, 'docs/superpowers/specs/runtime-planner-design.md');
  assert.equal(latest.status, 'running');
  assert.equal(latest.error, null);
  const brainstormingStep = workflowRepo.listSteps(run.id).find((step) => step.node_name === 'brainstorming');
  assert.equal(brainstormingStep?.status, 'completed');
  assert.ok(brainstormingStep?.agent_run_id);
  assert.equal(brainstormingStep?.result, planningOutput);
  const draftSpec = workflowArtifactVersionRepo.get(latest.draftSpecArtifactVersionId ?? '');
  assert.equal(draftSpec?.workflow_run_id, run.id);
  assert.equal(draftSpec?.artifact_type, 'spec');
  assert.equal(draftSpec?.status, 'draft');
  assert.equal(draftSpec?.created_by_agent_id, calls[0]?.split(':')[1]);
  assert.equal(draftSpec?.content, planningOutput);
});

test('Superpowers writing plans node creates draft plan artifact version for user approval', async () => {
  const projectPath = `/tmp/superpowers-planner-plan-artifact-${Date.now()}`;
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Superpowers planner plan artifact project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Superpowers planner plan artifact room' });
  const planner = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'planner-agent-plan-artifact',
    agent_name: 'Planner Agent Plan Artifact',
  });
  roomAgentRepo.setWorkflowRole(planner.id, 'planner');
  roomAgentRepo.setAcp(planner.id, {
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
    title: 'Run planner writing plans artifact',
  });
  const run = createGraphWorkflowRun(task.id);
  const planningOutput = [
    'plan completed',
    '',
    '```json',
    JSON.stringify({
      superpowers: {
        implementationPlanPath: 'docs/superpowers/plans/runtime-planner-plan.md',
      },
    }),
    '```',
  ].join('\n');
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
      const completedRun = agentRunRepo.updateStatus(runRecord.id, 'completed', { stdout: planningOutput }) ?? runRecord;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: planningOutput,
        message_type: 'agent_stream',
      });
      return { run: completedRun, message, status: 'completed' };
    },
  });

  const latest = await graph.nodes.writingPlans(emptyAgentWorkflowState({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
  }));

  assert.equal(latest.implementationPlanPath, 'docs/superpowers/plans/runtime-planner-plan.md');
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? '', /^planning:/);
  const draftPlan = workflowArtifactVersionRepo.get(latest.draftPlanArtifactVersionId ?? '');
  assert.equal(draftPlan?.workflow_run_id, run.id);
  assert.equal(draftPlan?.artifact_type, 'plan');
  assert.equal(draftPlan?.status, 'draft');
  assert.equal(draftPlan?.created_by_agent_id, calls[0]?.split(':')[1]);
  assert.equal(draftPlan?.content, planningOutput);
});

test('Superpowers writing plans node links revision drafts to artifact change requests', async () => {
  const projectPath = `/tmp/superpowers-planner-plan-revision-${Date.now()}`;
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Superpowers planner plan revision project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Superpowers planner plan revision room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Revise planner writing plans artifact',
  });
  const run = createGraphWorkflowRun(task.id);
  const previousDraft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: run.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v1',
    structured_data: { tasks: [] },
    created_by_agent_id: 'planner',
  });
  const planningOutput = [
    'plan revised',
    '',
    '```json',
    JSON.stringify({
      superpowers: {
        implementationPlanPath: 'docs/superpowers/plans/runtime-planner-plan-v2.md',
      },
    }),
    '```',
  ].join('\n');
  const graph = buildSuperpowersRuntimeGraph({
    runAcpAgent: async (input) => {
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
      const completedRun = agentRunRepo.updateStatus(runRecord.id, 'completed', { stdout: planningOutput }) ?? runRecord;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: planningOutput,
        message_type: 'agent_stream',
      });
      return { run: completedRun, message, status: 'completed' };
    },
  });

  const latest = await graph.nodes.writingPlans({
    ...emptyAgentWorkflowState({
      workflowRunId: run.id,
      projectId: project.id,
      roomId: room.id,
      taskId: task.id,
      userGoal: task.title,
      projectPath: project.path,
    }),
    draftPlanArtifactVersionId: previousDraft.id,
    artifactChangeRequestMessageId: 'msg-change-plan',
  });

  const draftPlan = workflowArtifactVersionRepo.get(latest.draftPlanArtifactVersionId ?? '');
  assert.notEqual(draftPlan?.id, previousDraft.id);
  assert.equal(draftPlan?.version, 2);
  assert.equal(draftPlan?.change_request_message_id, 'msg-change-plan');
  assert.equal(draftPlan?.supersedes_artifact_version_id, previousDraft.id);
  assert.equal(workflowArtifactVersionRepo.get(previousDraft.id)?.status, 'superseded');
  assert.equal(latest.artifactChangeRequestMessageId, null);
});

test('Superpowers writing plans node blocks when planner omits required evidence', async () => {
  const projectPath = `/tmp/superpowers-planner-missing-evidence-${Date.now()}`;
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Superpowers planner missing evidence project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Superpowers planner missing evidence room' });
  const planner = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'planner-agent-missing-evidence',
    agent_name: 'Planner Agent Missing Evidence',
  });
  roomAgentRepo.setWorkflowRole(planner.id, 'planner');
  roomAgentRepo.setAcp(planner.id, {
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
    title: 'Run planner writing plans',
  });
  const run = createGraphWorkflowRun(task.id);
  const graph = buildSuperpowersRuntimeGraph({
    runAcpAgent: async (input) => {
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
      const completedRun = agentRunRepo.updateStatus(runRecord.id, 'completed', { stdout: '自然语言完成了' }) ?? runRecord;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: '自然语言完成了',
        message_type: 'agent_stream',
      });
      return { run: completedRun, message, status: 'completed' };
    },
  });

  const latest = await graph.nodes.writingPlans(emptyAgentWorkflowState({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
  }));

  assert.equal(latest.status, 'blocked');
  assert.equal(latest.recoveryState?.reason, 'missing_required_evidence');
  assert.equal(latest.recoveryState?.failedStage, 'writing_plans');
  assert.match(latest.error ?? '', /missing required evidence.*implementationPlanPath/);
  const writingPlansStep = workflowRepo.listSteps(run.id).find((step) => step.node_name === 'writing_plans');
  assert.equal(writingPlansStep?.status, 'failed');
  assert.match(writingPlansStep?.error ?? '', /missing required evidence.*implementationPlanPath/);
});

test('finishBranch blocks for user decision instead of silently choosing keep_branch', async () => {
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
  assert.equal(afterFinishBranch.status, 'awaiting_decision');
  assert.equal(finishBranchDecision?.decision, null);
  assert.deepEqual(finishBranchDecision?.options, [
    'merge_local',
    'create_pr',
    'keep_branch',
    'discard_work',
  ]);
  assert.equal(finishBranchDecision?.reason, '等待用户选择分支收尾方式');
  assert.equal(afterFinishBranch.error, null);
});

test('Superpowers planning nodes record phase artifacts and review verdicts', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const projectPath = `/tmp/open-deep-sea-superpowers-runtime-test-${Date.now()}`;
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({
    name: 'Superpowers runtime planning project',
    path: projectPath,
  });
  const room = roomRepo.create({
    project_id: project.id,
    name: 'Superpowers runtime planning room',
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Implement Superpowers planning gates',
  });
  const run = createGraphWorkflowRun(task.id);
  const state = emptyAgentWorkflowState({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath,
  });

  const afterBrainstorming = await graph.nodes.brainstorming(state);
  assert.equal(afterBrainstorming.superpowersPhase, 'brainstorming');
  assert.equal(afterBrainstorming.designDocPath, 'docs/superpowers/specs/superpowers-design.md');

  const afterSpecReview = await graph.nodes.specReview(afterBrainstorming);
  assert.equal(afterSpecReview.superpowersPhase, 'spec_review');
  assert.equal(afterSpecReview.designReviewVerdict, 'approved');

  const afterWorktree = await graph.nodes.worktree(afterSpecReview);
  assert.equal(afterWorktree.superpowersPhase, 'worktree');
  assert.equal(afterWorktree.worktree?.path, projectPath);
  assert.equal(afterWorktree.worktree?.branchName, 'current-workspace');
  assert.equal(afterWorktree.worktreeDecision?.action, 'skip');
  assert.match(afterWorktree.worktree?.baseRef ?? '', /当前工作区/);

  const afterWritingPlans = await graph.nodes.writingPlans(afterWorktree);
  assert.equal(afterWritingPlans.superpowersPhase, 'writing_plans');
  assert.equal(afterWritingPlans.implementationPlanPath, 'docs/superpowers/plans/superpowers-implementation-plan.md');

  const afterPlanReview = await graph.nodes.planReview(afterWritingPlans);
  assert.equal(afterPlanReview.superpowersPhase, 'plan_review');
  assert.equal(afterPlanReview.planReviewVerdict, 'approved');
  const draft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: afterPlanReview.workflowRunId,
    artifact_type: 'plan',
    title: 'Runtime Test Plan',
    content: '# Runtime Test Plan',
    structured_data: { tasks: [] },
    created_by_agent_id: 'planner',
  });
  const approved = workflowArtifactVersionRepo.approve(draft.id, { approved_by: 'superpowers-runtime-test' });
  assert.ok(approved);
  assert.equal(graph.canDispatch({
    ...afterPlanReview,
    approvedPlanArtifactVersionId: approved.id,
  }), true);
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
