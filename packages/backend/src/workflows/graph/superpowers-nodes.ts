import { canLeaveTddExecute, canLeaveVerify, canLeaveWritingPlans } from './superpowers-gates.js';
import { buildStagePrompt, buildSuperpowersPhasePrompt } from '../prompts.js';
import { parseReviewVerdict } from '../plan-parser.js';
import { ensureWorkflowAgentsForRun } from '../agent-provisioning.js';
import { applySuperpowersEvidencePatch, parseSuperpowersEvidence } from './superpowers-evidence.js';
import { buildSuperpowersInvocationPrompt, parseRequiredSuperpowersEvidence } from '../superpowers-invocation.js';
import { workflowArtifactVersionRepo } from '../../repos/workflows.js';
import type { GraphTools } from './tools.js';
import { serializeGraphState, type AgentWorkflowState, type SuperpowersReviewVerdict } from './state.js';
import type { TaskArtifactType, WorkflowDefinitionNodeType, WorkflowRole, WorkflowStage } from '../../types.js';

export type SuperpowersPlanningNodeName =
  | 'brainstorming'
  | 'spec_review'
  | 'worktree'
  | 'writing_plans'
  | 'plan_review';

export type SuperpowersExecutionNodeName =
  | 'tdd_execute'
  | 'spec_compliance_review'
  | 'code_quality_review'
  | 'finish_branch';

export type SuperpowersRouteNodeName = SuperpowersPlanningNodeName | SuperpowersExecutionNodeName;

export interface SuperpowersPhaseStep {
  nodeName: SuperpowersPlanningNodeName;
  nodeType: WorkflowDefinitionNodeType;
  label: string;
  stage: WorkflowStage;
  role: WorkflowRole;
  gate?: 'design_review' | 'plan_review';
}

export interface SuperpowersRuntimeNodes {
  brainstorming: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  specReview: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  worktree: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  writingPlans: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  planReview: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  tddExecute: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  specComplianceReview: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  codeQualityReview: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
  finishBranch: (state: AgentWorkflowState) => Promise<AgentWorkflowState>;
}

export const SUPERPOWERS_PLANNING_PHASE_STEPS: readonly SuperpowersPhaseStep[] = [
  {
    nodeName: 'brainstorming',
    nodeType: 'brainstorming',
    label: 'Brainstorming',
    stage: 'planning',
    role: 'planner',
  },
  {
    nodeName: 'spec_review',
    nodeType: 'spec_review',
    label: 'Spec Review',
    stage: 'planning',
    role: 'reviewer',
    gate: 'design_review',
  },
  {
    nodeName: 'worktree',
    nodeType: 'worktree',
    label: 'Worktree',
    stage: 'planning',
    role: 'coordinator',
  },
  {
    nodeName: 'writing_plans',
    nodeType: 'writing_plans',
    label: 'Writing Plans',
    stage: 'planning',
    role: 'planner',
  },
  {
    nodeName: 'plan_review',
    nodeType: 'plan_review',
    label: 'Plan Review',
    stage: 'planning',
    role: 'reviewer',
    gate: 'plan_review',
  },
];

const DEFAULT_DESIGN_DOC_PATH = 'docs/superpowers/specs/superpowers-design.md';
const DEFAULT_IMPLEMENTATION_PLAN_PATH = 'docs/superpowers/plans/superpowers-implementation-plan.md';
const DEFAULT_FINISH_BRANCH_REASON = '等待用户选择分支收尾方式';
const REVIEW_OUTPUT_RETRY_LIMIT = 1;

export const SUPERPOWERS_FINISH_BRANCH_OPTIONS = [
  'merge_local',
  'create_pr',
  'keep_branch',
  'discard_work',
] as const;

export function createSuperpowersRuntimeNodes(tools?: GraphTools): SuperpowersRuntimeNodes {
  return {
    async brainstorming(state) {
      if (tools) {
        return runSuperpowersPlannerPhase({
          nodeName: 'brainstorming',
          state,
          tools,
          requiredSkills: ['brainstorming'],
          expectedEvidence: ['designDocPath'],
          roleInstruction: '你是 planner controller，负责完成 brainstorming 并产出可审查 spec/design artifact。',
          artifactTitle: 'Superpowers Brainstorming Evidence',
          artifactType: 'analysis',
        });
      }
      const designDocPath = normalizePath(state.designDocPath) ?? DEFAULT_DESIGN_DOC_PATH;
      return {
        ...state,
        superpowersPhase: 'brainstorming',
        designDocPath,
        status: state.status === 'blocked' ? 'running' : state.status,
        error: state.status === 'blocked' ? null : state.error,
      };
    },

    async specReview(state) {
      const verdict = normalizePath(state.designDocPath) ? 'approved' : 'failed';
      return {
        ...state,
        superpowersPhase: 'spec_review',
        designReviewVerdict: verdict,
        status: verdict === 'approved' ? state.status : 'blocked',
        error: verdict === 'approved' ? state.error : 'Superpowers spec review requires designDocPath',
      };
    },

    async worktree(state) {
      const decision = {
        action: 'skip' as const,
        path: state.projectPath,
        branchName: null,
        reason: '当前工作区复用 session workspace；执行隔离由后续 using-git-worktrees 集成创建。',
      };
      return {
        ...state,
        superpowersPhase: 'worktree',
        worktreeDecision: decision,
        worktree: {
          path: decision.path,
          branchName: 'current-workspace',
          baseRef: decision.reason,
        },
      };
    },

    async writingPlans(state) {
      if (tools) {
        return runSuperpowersPlannerPhase({
          nodeName: 'writing_plans',
          state,
          tools,
          requiredSkills: ['writing-plans'],
          expectedEvidence: ['implementationPlanPath'],
          roleInstruction: '你是 planner controller，负责基于已确认 spec 编写可执行 plan artifact。',
          artifactTitle: 'Superpowers Writing Plans Evidence',
          artifactType: 'plan',
        });
      }
      const implementationPlanPath = normalizePath(state.implementationPlanPath) ?? DEFAULT_IMPLEMENTATION_PLAN_PATH;
      return {
        ...state,
        superpowersPhase: 'writing_plans',
        implementationPlanPath,
        status: state.status === 'blocked' ? 'running' : state.status,
        error: state.status === 'blocked' ? null : state.error,
      };
    },

    async planReview(state) {
      const verdict: SuperpowersReviewVerdict = normalizePath(state.implementationPlanPath) ? 'approved' : 'failed';
      return {
        ...state,
        superpowersPhase: 'plan_review',
        planReviewVerdict: verdict,
        status: verdict === 'approved' ? state.status : 'blocked',
        error: verdict === 'approved' ? state.error : 'Superpowers plan review requires implementationPlanPath',
      };
    },

    async tddExecute(state) {
      const canLeave = canLeaveTddExecute(state);
      return {
        ...state,
        superpowersPhase: 'tdd_execute',
        status: canLeave ? (state.status === 'blocked' ? 'running' : state.status) : 'blocked',
        error: canLeave
          ? null
          : 'Superpowers TDD evidence gate requires RED failed and GREEN passed records or an explicit exemption',
      };
    },

    async specComplianceReview(state) {
      return runSuperpowersReview('spec_compliance_review', state, tools);
    },

    async codeQualityReview(state) {
      return runSuperpowersReview('code_quality_review', state, tools);
    },

    async finishBranch(state) {
      if (!canLeaveVerify(state)) {
        return {
          ...state,
          superpowersPhase: 'finish_branch',
          status: 'blocked',
          error: 'Superpowers finish branch requires fresh passed required verification evidence',
        };
      }

      const finishBranchDecision = state.finishBranchDecision ?? {
        decision: null,
        options: [...SUPERPOWERS_FINISH_BRANCH_OPTIONS],
        reason: DEFAULT_FINISH_BRANCH_REASON,
        decidedAt: null,
      };
      const hasDecision = Boolean(finishBranchDecision.decision);
      return {
        ...state,
        superpowersPhase: 'finish_branch',
        finishBranchDecision,
        status: hasDecision
          ? (state.status === 'blocked' || state.status === 'awaiting_decision' ? 'running' : state.status)
          : 'awaiting_decision',
        error: null,
      };
    },
  };
}

export function canDispatchSuperpowersRuntime(state: AgentWorkflowState): boolean {
  return canLeaveWritingPlans(state) && hasApprovedPlanArtifactVersion(state);
}

function hasApprovedPlanArtifactVersion(state: AgentWorkflowState): boolean {
  const approvedPlanId = normalizePath(state.approvedPlanArtifactVersionId);
  const lightweightPlanId = normalizePath(state.lightweightPlanArtifactVersionId);
  return Boolean(
    (approvedPlanId && isApprovedPlanArtifact(approvedPlanId, state.workflowRunId, 'plan')) ||
    (lightweightPlanId && isApprovedPlanArtifact(lightweightPlanId, state.workflowRunId, 'lightweight_plan')),
  );
}

function isApprovedPlanArtifact(
  artifactVersionId: string,
  workflowRunId: string,
  artifactType: 'plan' | 'lightweight_plan',
): boolean {
  const artifact = workflowArtifactVersionRepo.get(artifactVersionId);
  return artifact?.workflow_run_id === workflowRunId &&
    artifact.artifact_type === artifactType &&
    artifact.status === 'approved';
}

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function applyReviewState(
  state: AgentWorkflowState,
  phase: SuperpowersExecutionNodeName,
  verdict: SuperpowersReviewVerdict,
  findings: string[],
): AgentWorkflowState {
  if (verdict === 'changes_requested' && isCompletionOnlyReviewFeedback(findings)) {
    const review = {
      verdict: 'approved' as const,
      findings,
      reviewedAt: null,
    };
    return {
      ...state,
      superpowersPhase: phase,
      specComplianceReview: phase === 'spec_compliance_review' ? review : state.specComplianceReview,
      codeQualityReview: phase === 'code_quality_review' ? review : state.codeQualityReview,
      reviewFindings: findings,
      reviewVerdict: 'pass',
      status: state.status === 'blocked' ? 'running' : state.status,
      error: null,
    };
  }

  if (verdict === 'changes_requested') {
    return {
      ...state,
      superpowersPhase: phase,
      tddEvidence: [],
      tddExemption: state.tddExemption,
      specComplianceReview: phase === 'spec_compliance_review' ? null : state.specComplianceReview,
      codeQualityReview: phase === 'code_quality_review' ? null : state.codeQualityReview,
      reviewFindings: findings,
      reviewVerdict: 'changes_requested',
      status: state.status === 'blocked' ? 'running' : state.status,
      error: phase === 'spec_compliance_review'
        ? 'Superpowers spec compliance review requested changes'
        : 'Superpowers code quality review requested changes',
    };
  }

  if (verdict === 'failed') {
    return {
      ...state,
      superpowersPhase: phase,
      reviewFindings: findings,
      reviewVerdict: 'failed',
      status: 'blocked',
      error: phase === 'spec_compliance_review'
        ? 'Superpowers spec compliance review failed'
        : 'Superpowers code quality review failed',
    };
  }

  if (verdict === 'pending') {
    return {
      ...state,
      superpowersPhase: phase,
      reviewFindings: findings,
      status: 'blocked',
      error: phase === 'spec_compliance_review'
        ? 'Superpowers spec compliance review is pending'
        : 'Superpowers code quality review is pending',
    };
  }

  const currentReview = phase === 'spec_compliance_review'
    ? state.specComplianceReview
    : state.codeQualityReview;
  const review = currentReview ?? {
    verdict: 'approved' as const,
    findings,
    reviewedAt: null,
  };

  return {
    ...state,
    superpowersPhase: phase,
    specComplianceReview: phase === 'spec_compliance_review' ? review : state.specComplianceReview,
    codeQualityReview: phase === 'code_quality_review' ? review : state.codeQualityReview,
    reviewFindings: findings,
    reviewVerdict: 'pass',
    status: state.status === 'blocked' ? 'running' : state.status,
    error: null,
  };
}

function isCompletionOnlyReviewFeedback(findings: string[]): boolean {
  if (findings.length === 0) return false;
  let hasCompletionGate = false;
  return findings.every((finding) => {
    const text = finding.toLowerCase();
    const mentionsCompletionGate =
      text.includes('commit') ||
      text.includes('git add') ||
      text.includes('git commit') ||
      text.includes('提交') ||
      text.includes('自动提交') ||
      text.includes('收尾') ||
      text.includes('完成前') ||
      text.includes('not a git repository') ||
      text.includes('fatal: not a git repository') ||
      text.includes('.git');
    if (mentionsCompletionGate) hasCompletionGate = true;
    const isPassingContext =
      text.includes('符合') ||
      text.includes('通过') ||
      text.includes('未发现') ||
      text.includes('不涉及') ||
      text.includes('not affect') ||
      text.includes('no issue') ||
      text.includes('no defect') ||
      text.includes('no regression');
    return mentionsCompletionGate || isPassingContext;
  }) && hasCompletionGate;
}

function hasExecutableWorkflowRole(agents: ReturnType<GraphTools['readWorkflowContext']>['agents'], role: WorkflowRole): boolean {
  return agents.some((agent) =>
    agent.left_at === null &&
    agent.workflow_role === role &&
    agent.acp_enabled === 1 &&
    Boolean(agent.acp_backend),
  );
}

async function runSuperpowersPlannerPhase(input: {
  nodeName: 'brainstorming' | 'writing_plans';
  state: AgentWorkflowState;
  tools: GraphTools;
  requiredSkills: string[];
  expectedEvidence: string[];
  roleInstruction: string;
  artifactTitle: string;
  artifactType: TaskArtifactType;
}): Promise<AgentWorkflowState> {
  const context = input.tools.readWorkflowContext(input.state.workflowRunId);
  let agents = context.agents;
  if (!hasExecutableWorkflowRole(agents, 'planner')) {
    const provisioning = ensureWorkflowAgentsForRun({
      roomId: context.room.id,
      agents,
      roles: ['planner'],
    });
    agents = provisioning.agents;
    for (const agent of provisioning.joinedAgents) {
      input.tools.broadcastAgentJoined(context.room.id, agent);
    }
  }
  const planner = input.tools.selectAgentForRole('planner', agents);
  if (!planner) {
    return {
      ...input.state,
      superpowersPhase: input.nodeName,
      activeSuperpowersStage: input.nodeName,
      status: 'blocked',
      error: `No planner available for Superpowers ${input.nodeName}`,
      recoveryState: {
        reason: 'missing_planner_agent',
        failedStage: input.nodeName,
        retryable: true,
      },
    };
  }

  const promptContext = {
    projectName: context.project.name,
    projectPath: context.project.path,
    room: context.room,
    task: context.task,
    agents,
    workflowContext: context.workflowContext,
    childTasks: input.tools.listChildTasks(context.task.id),
    memoryContext: context.memories,
  };
  const basePrompt = [
    buildStagePrompt('planning', promptContext),
    buildSuperpowersPhasePrompt(input.nodeName, promptContext),
  ].join('\n\n');
  const prompt = buildSuperpowersInvocationPrompt({
    stageId: input.nodeName,
    controller: 'planner',
    requiredSkills: input.requiredSkills,
    roleInstruction: input.roleInstruction,
    context: basePrompt,
    expectedEvidence: input.expectedEvidence,
  });
  const step = input.tools.createGraphStep({
    workflow_run_id: context.run.id,
    task_id: context.task.id,
    stage: 'planning',
    node_name: input.nodeName,
    status: 'running',
    room_agent_id: planner.id,
    assigned_room_agent_id: planner.id,
    prompt,
    sort_order: input.tools.nextStepSortOrder(context.run.id),
  });
  input.tools.broadcastStepCreated(context.room.id, step);
  input.tools.updateGraphState(context.run.id, serializeGraphState({
    ...input.state,
    currentNode: input.nodeName,
    currentStepId: step.id,
    activeAgentRunId: null,
    superpowersPhase: input.nodeName,
    activeSuperpowersStage: input.nodeName,
    status: input.state.status === 'blocked' ? 'running' : input.state.status,
    error: null,
    recoveryState: null,
  }));

  let runResult: Awaited<ReturnType<GraphTools['runAcpAgent']>>;
  try {
    runResult = await input.tools.runAcpAgent({
      agent: planner,
      projectPath: context.project.path,
      roomId: context.room.id,
      prompt,
      taskId: context.task.id,
      workflowRunId: context.run.id,
      workflowStepId: step.id,
      workflowStage: 'planning',
    });
  } catch (error) {
    const message = (error as Error).message;
    const failedStep = input.tools.updateGraphStep(step.id, {
      status: 'failed',
      error: message,
    });
    if (failedStep) input.tools.broadcastStepUpdated(context.room.id, failedStep);
    return {
      ...input.state,
      superpowersPhase: input.nodeName,
      activeSuperpowersStage: input.nodeName,
      currentStepId: step.id,
      status: 'blocked',
      error: message,
      recoveryState: {
        reason: /timeout/i.test(message) ? 'timeout' : 'agent_invocation_failed',
        failedStage: input.nodeName,
        retryable: true,
      },
    };
  }

  const output = runResult.run.stdout || runResult.message.content;
  if (runResult.status !== 'completed') {
    const error = runResult.run.error ?? (runResult.status === 'cancelled' ? 'Agent run cancelled' : 'Agent run failed');
    const failedStep = input.tools.updateGraphStep(step.id, {
      status: runResult.status === 'cancelled' ? 'cancelled' : 'failed',
      agent_run_id: runResult.run.id,
      result: output,
      result_message_id: runResult.message.id,
      error,
    });
    if (failedStep) input.tools.broadcastStepUpdated(context.room.id, failedStep);
    return {
      ...input.state,
      activeAgentRunId: runResult.run.id,
      currentStepId: step.id,
      superpowersPhase: input.nodeName,
      activeSuperpowersStage: input.nodeName,
      status: 'blocked',
      error,
      recoveryState: {
        reason: runResult.status === 'cancelled' ? 'agent_cancelled' : 'agent_run_failed',
        failedStage: input.nodeName,
        retryable: true,
      },
    };
  }

  const parsed = parseRequiredSuperpowersEvidence(output, input.expectedEvidence);
  if (!parsed.ok) {
    const failedStep = input.tools.updateGraphStep(step.id, {
      status: 'failed',
      agent_run_id: runResult.run.id,
      result: output,
      result_message_id: runResult.message.id,
      error: parsed.error,
    });
    if (failedStep) input.tools.broadcastStepUpdated(context.room.id, failedStep);
    return {
      ...input.state,
      activeAgentRunId: runResult.run.id,
      currentStepId: step.id,
      superpowersPhase: input.nodeName,
      activeSuperpowersStage: input.nodeName,
      status: 'blocked',
      error: parsed.error,
      recoveryState: {
        reason: 'missing_required_evidence',
        failedStage: input.nodeName,
        retryable: true,
      },
    };
  }

  const artifact = input.tools.createArtifact({
    task_id: context.task.id,
    workflow_run_id: context.run.id,
    workflow_step_id: step.id,
    artifact_type: input.artifactType,
    title: input.artifactTitle,
    content: output,
  });
  input.tools.broadcastArtifactCreated(context.room.id, artifact);
  const completedStep = input.tools.updateGraphStep(step.id, {
    status: 'completed',
    agent_run_id: runResult.run.id,
    result: output,
    result_message_id: runResult.message.id,
    error: null,
  });
  if (completedStep) input.tools.broadcastStepUpdated(context.room.id, completedStep);
  const draftVersion = createPlannerArtifactVersionDraft({
    workflowRunId: context.run.id,
    nodeName: input.nodeName,
    plannerAgentId: planner.agent_id,
    artifactTitle: input.artifactTitle,
    content: output,
    evidence: parsed.evidence,
    changeRequestMessageId: input.state.artifactChangeRequestMessageId,
    supersedesArtifactVersionId: input.nodeName === 'brainstorming'
      ? input.state.artifactChangeRequestArtifactVersionId ?? input.state.draftSpecArtifactVersionId
      : input.state.artifactChangeRequestArtifactVersionId ?? input.state.draftPlanArtifactVersionId,
  });
  return {
    ...applySuperpowersEvidencePatch(input.state, parsed.evidence),
    ...(input.nodeName === 'brainstorming'
      ? { draftSpecArtifactVersionId: draftVersion.id }
      : { draftPlanArtifactVersionId: draftVersion.id }),
    activeAgentRunId: runResult.run.id,
    currentStepId: step.id,
    superpowersPhase: input.nodeName,
    activeSuperpowersStage: input.nodeName,
    status: input.state.status === 'blocked' ? 'running' : input.state.status,
    error: null,
    recoveryState: null,
    artifactChangeRequestMessageId: null,
    artifactChangeRequestArtifactVersionId: null,
  };
}

function createPlannerArtifactVersionDraft(input: {
  workflowRunId: string;
  nodeName: 'brainstorming' | 'writing_plans';
  plannerAgentId: string;
  artifactTitle: string;
  content: string;
  evidence: Record<string, unknown>;
  changeRequestMessageId?: string | null;
  supersedesArtifactVersionId?: string | null;
}) {
  return workflowArtifactVersionRepo.createDraft({
    workflow_run_id: input.workflowRunId,
    artifact_type: input.nodeName === 'brainstorming' ? 'spec' : 'plan',
    title: input.artifactTitle,
    content: input.content,
    structured_data: input.evidence,
    created_by_agent_id: input.plannerAgentId,
    change_request_message_id: input.changeRequestMessageId ?? null,
    supersedes_artifact_version_id: input.supersedesArtifactVersionId ?? null,
  });
}

async function runSuperpowersReview(
  phase: 'spec_compliance_review' | 'code_quality_review',
  state: AgentWorkflowState,
  tools?: GraphTools,
): Promise<AgentWorkflowState> {
  const existingReview = phase === 'spec_compliance_review' ? state.specComplianceReview : state.codeQualityReview;
  if (existingReview) {
    return applyReviewState(
      state,
      phase,
      existingReview.verdict,
      existingReview.findings,
    );
  }

  if (!tools) {
    return applyReviewState(
      state,
      phase,
      'approved',
      [],
    );
  }

  const context = tools.readWorkflowContext(state.workflowRunId);
  let reviewAgents = context.agents;
  if (!hasExecutableWorkflowRole(reviewAgents, 'reviewer')) {
    const provisioning = ensureWorkflowAgentsForRun({
      roomId: context.room.id,
      agents: reviewAgents,
      roles: ['reviewer'],
    });
    reviewAgents = provisioning.agents;
    for (const agent of provisioning.joinedAgents) {
      tools.broadcastAgentJoined(context.room.id, agent);
    }
  }
  const reviewer = tools.selectAgentForRole('reviewer', reviewAgents);
  if (!reviewer) {
    return applyReviewState(state, phase, 'failed', ['No reviewer available for Superpowers review']);
  }

  const step = tools.createGraphStep({
    workflow_run_id: context.run.id,
    task_id: context.task.id,
    stage: 'code_review',
    node_name: phase as never,
    status: 'running',
    room_agent_id: reviewer.id,
    assigned_room_agent_id: reviewer.id,
    prompt: buildStagePrompt('code_review', {
      projectName: context.project.name,
      projectPath: context.project.path,
      room: context.room,
      task: context.task,
      agents: reviewAgents,
      workflowContext: context.workflowContext,
      childTasks: tools.listChildTasks(context.task.id),
      memoryContext: context.memories,
    }) + '\n\n' + buildSuperpowersPhasePrompt(
      phase === 'spec_compliance_review' ? 'spec_compliance_review' : 'code_quality_review',
      {
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: context.task,
        agents: reviewAgents,
        workflowContext: context.workflowContext,
        childTasks: tools.listChildTasks(context.task.id),
        memoryContext: context.memories,
      },
    ),
    sort_order: tools.nextStepSortOrder(context.run.id),
  });
  tools.broadcastStepCreated(context.room.id, step);
  tools.updateGraphState(context.run.id, serializeGraphState({
    ...state,
    currentNode: phase,
    currentStepId: step.id,
    activeAgentRunId: null,
    status: state.status === 'blocked' ? 'running' : state.status,
    error: null,
  }));

  const firstRunResult = await tools.runAcpAgent({
    agent: reviewer,
    projectPath: context.project.path,
    roomId: context.room.id,
    prompt: step.prompt ?? '',
    taskId: context.task.id,
    workflowRunId: context.run.id,
    workflowStepId: step.id,
    workflowStage: 'code_review',
  });
  let runResult = firstRunResult;
  const output = runResult.run.stdout || runResult.message.content;
  if (runResult.status !== 'completed') {
    const error = runResult.run.error ?? (runResult.status === 'cancelled' ? 'Agent run cancelled' : 'Agent run failed');
    const failedStep = tools.updateGraphStep(step.id, {
      status: runResult.status === 'cancelled' ? 'cancelled' : 'failed',
      agent_run_id: runResult.run.id,
      result: output,
      result_message_id: runResult.message.id,
      error,
    });
    if (failedStep) tools.broadcastStepUpdated(context.room.id, failedStep);
    return applyReviewState({
      ...state,
      activeAgentRunId: runResult.run.id,
      currentStepId: step.id,
    }, phase, 'failed', [error]);
  }

  const artifact = tools.createArtifact({
    task_id: context.task.id,
    workflow_run_id: context.run.id,
    workflow_step_id: step.id,
    artifact_type: 'review',
    title: phase === 'spec_compliance_review' ? '规格符合审查' : '代码质量审查',
    content: output,
  });
  tools.broadcastArtifactCreated(context.room.id, artifact);

  let reviewOutput;
  try {
    reviewOutput = parseSuperpowersReviewOutput(output, phase);
  } catch {
    const retryResult = await retryInvalidReviewOutput({
      phase,
      state,
      tools,
      context,
      reviewer,
      stepId: step.id,
      invalidOutput: output,
      retryCount: REVIEW_OUTPUT_RETRY_LIMIT,
    });
    if (retryResult) {
      runResult = retryResult.runResult;
      reviewOutput = retryResult.reviewOutput;
    } else {
    const failedStep = tools.updateGraphStep(step.id, {
      status: 'failed',
      agent_run_id: runResult.run.id,
      result: output,
      result_message_id: runResult.message.id,
      error: 'Invalid Superpowers review output',
    });
    if (failedStep) tools.broadcastStepUpdated(context.room.id, failedStep);
    return applyReviewState({
      ...state,
      activeAgentRunId: runResult.run.id,
      currentStepId: step.id,
    }, phase, 'failed', ['Invalid Superpowers review output']);
    }
  }

  const finalOutput = runResult.run.stdout || runResult.message.content;
  const reviewedAt = runResult.run.completed_at ? new Date(runResult.run.completed_at).toISOString() : null;
  const review = {
    verdict: reviewOutput.verdict,
    findings: reviewOutput.findings,
    reviewedAt: reviewOutput.reviewedAt ?? reviewedAt,
  } as const;
  const nextState = phase === 'spec_compliance_review'
    ? {
      ...state,
      activeAgentRunId: runResult.run.id,
      currentStepId: step.id,
      specComplianceReview: review,
    }
    : {
      ...state,
      activeAgentRunId: runResult.run.id,
      currentStepId: step.id,
      codeQualityReview: review,
    };
  const finalStatus = reviewOutput.verdict === 'failed' ? 'failed' : 'completed';
  const finalError = reviewOutput.verdict === 'failed'
    ? (phase === 'spec_compliance_review'
      ? 'Superpowers spec compliance review failed'
      : 'Superpowers code quality review failed')
    : null;
  const completedStep = tools.updateGraphStep(step.id, {
    status: finalStatus,
    agent_run_id: runResult.run.id,
    result: finalOutput,
    result_message_id: runResult.message.id,
    error: finalError,
  });
  if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);
  return applyReviewState(nextState, phase, reviewOutput.verdict, reviewOutput.findings);
}

async function retryInvalidReviewOutput(input: {
  phase: 'spec_compliance_review' | 'code_quality_review';
  state: AgentWorkflowState;
  tools: GraphTools;
  context: ReturnType<GraphTools['readWorkflowContext']>;
  reviewer: ReturnType<GraphTools['selectAgentForRole']> & {};
  stepId: string;
  invalidOutput: string;
  retryCount: number;
}): Promise<{
  runResult: Awaited<ReturnType<GraphTools['runAcpAgent']>>;
  reviewOutput: { verdict: SuperpowersReviewVerdict; findings: string[]; reviewedAt: string | null };
} | null> {
  let lastOutput = input.invalidOutput;
  for (let attempt = 1; attempt <= input.retryCount; attempt += 1) {
    const retryPrompt = buildStrictReviewRetryPrompt(input.phase, input.state, lastOutput);
    const runResult = await input.tools.runAcpAgent({
      agent: input.reviewer,
      projectPath: input.context.project.path,
      roomId: input.context.room.id,
      prompt: retryPrompt,
      taskId: input.context.task.id,
      workflowRunId: input.context.run.id,
      workflowStepId: input.stepId,
      workflowStage: 'code_review',
    });
    lastOutput = runResult.run.stdout || runResult.message.content;
    if (runResult.status !== 'completed') return null;
    try {
      return {
        runResult,
        reviewOutput: parseSuperpowersReviewOutput(lastOutput, input.phase),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function buildStrictReviewRetryPrompt(
  phase: 'spec_compliance_review' | 'code_quality_review',
  state: AgentWorkflowState,
  invalidOutput: string,
): string {
  const field = phase === 'spec_compliance_review' ? 'specComplianceReview' : 'codeQualityReview';
  return [
    '上一次审查回复没有包含 workflow runtime 可解析的 Superpowers review JSON，因此不能通过门禁。',
    '现在只执行一次严格格式修复：基于已完成的实现、计划、验证证据和上一次输出，给出审查结论。',
    '不要输出过程说明，不要说“我会审查”。必须直接输出一个 fenced JSON 代码块。',
    'verdict 只能是 approved、changes_requested、failed 或 pending。',
    '',
    '当前任务目标：',
    state.userGoal,
    '',
    '上一次无效输出：',
    invalidOutput.slice(0, 4_000),
    '',
    '输出格式：',
    '```json',
    '{',
    '  "superpowers": {',
    `    "${field}": {`,
    '      "verdict": "approved",',
    '      "findings": [],',
    '      "reviewedAt": "2026-06-13T00:00:00.000Z"',
    '    }',
    '  }',
    '}',
    '```',
  ].join('\n');
}

function parseSuperpowersReviewOutput(
  output: string,
  phase: 'spec_compliance_review' | 'code_quality_review',
): { verdict: SuperpowersReviewVerdict; findings: string[]; reviewedAt: string | null } {
  const evidence = parseSuperpowersEvidence(output);
  const review = phase === 'spec_compliance_review'
    ? evidence.specComplianceReview
    : evidence.codeQualityReview;
  if (review) return review;

  const legacyVerdict = parseReviewVerdict(output);
  return {
    verdict: legacyVerdict.verdict === 'pass' ? 'approved' : legacyVerdict.verdict,
    findings: legacyVerdict.findings,
    reviewedAt: null,
  };
}
