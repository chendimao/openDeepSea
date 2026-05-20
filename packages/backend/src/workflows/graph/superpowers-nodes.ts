import { canLeaveTddExecute, canLeaveVerify, canLeaveWritingPlans } from './superpowers-gates.js';
import { buildStagePrompt, buildSuperpowersPhasePrompt } from '../prompts.js';
import { parseReviewVerdict } from '../plan-parser.js';
import { ensureWorkflowAgentsForRun } from '../agent-provisioning.js';
import type { GraphTools } from './tools.js';
import { serializeGraphState, type AgentWorkflowState, type SuperpowersReviewVerdict } from './state.js';
import type { WorkflowDefinitionNodeType, WorkflowRole, WorkflowStage } from '../../types.js';

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
const DEFAULT_FINISH_BRANCH_REASON = 'awaiting explicit closeout automation';

export const SUPERPOWERS_FINISH_BRANCH_OPTIONS = [
  'merge_local',
  'create_pr',
  'keep_branch',
  'discard_work',
] as const;

export function createSuperpowersRuntimeNodes(tools?: GraphTools): SuperpowersRuntimeNodes {
  return {
    async brainstorming(state) {
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
      return {
        ...state,
        superpowersPhase: 'worktree',
        worktree: {
          path: state.projectPath,
          branchName: 'not_available',
          baseRef: 'skipped: worktree handling is not implemented in this runtime node yet',
        },
      };
    },

    async writingPlans(state) {
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

      return {
        ...state,
        superpowersPhase: 'finish_branch',
        finishBranchDecision: state.finishBranchDecision ?? {
          decision: 'keep_branch',
          options: SUPERPOWERS_FINISH_BRANCH_OPTIONS,
          reason: DEFAULT_FINISH_BRANCH_REASON,
          decidedAt: new Date().toISOString(),
        } as unknown as AgentWorkflowState['finishBranchDecision'],
        status: state.status === 'blocked' ? 'running' : state.status,
        error: null,
      };
    },
  };
}

export function canDispatchSuperpowersRuntime(state: AgentWorkflowState): boolean {
  return canLeaveWritingPlans(state);
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
  if (verdict === 'changes_requested') {
    return {
      ...state,
      superpowersPhase: phase,
      tddEvidence: [],
      tddExemption: null,
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

function hasExecutableWorkflowRole(agents: ReturnType<GraphTools['readWorkflowContext']>['agents'], role: WorkflowRole): boolean {
  return agents.some((agent) =>
    agent.left_at === null &&
    agent.workflow_role === role &&
    agent.acp_enabled === 1 &&
    Boolean(agent.acp_backend),
  );
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

  const runResult = await tools.runAcpAgent({
    agent: reviewer,
    projectPath: context.project.path,
    roomId: context.room.id,
    prompt: step.prompt ?? '',
    taskId: context.task.id,
    workflowRunId: context.run.id,
    workflowStepId: step.id,
    workflowStage: 'code_review',
  });
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

  let verdict;
  try {
    verdict = parseReviewVerdict(output);
  } catch {
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

  const reviewedAt = runResult.run.completed_at ? new Date(runResult.run.completed_at).toISOString() : null;
  const review = {
    verdict: verdict.verdict === 'pass' ? 'approved' : verdict.verdict,
    findings: verdict.findings,
    reviewedAt,
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
  const finalStatus = verdict.verdict === 'failed' ? 'failed' : 'completed';
  const finalError = verdict.verdict === 'failed'
    ? (phase === 'spec_compliance_review'
      ? 'Superpowers spec compliance review failed'
      : 'Superpowers code quality review failed')
    : null;
  const completedStep = tools.updateGraphStep(step.id, {
    status: finalStatus,
    agent_run_id: runResult.run.id,
    result: output,
    result_message_id: runResult.message.id,
    error: finalError,
  });
  if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);
  return applyReviewState(nextState, phase, verdict.verdict as SuperpowersReviewVerdict, verdict.findings);
}
