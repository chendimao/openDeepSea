import { canLeaveTddExecute, canLeaveVerify, canLeaveWritingPlans } from './superpowers-gates.js';
import type { AgentWorkflowState, SuperpowersReviewVerdict } from './state.js';
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

export function createSuperpowersRuntimeNodes(): SuperpowersRuntimeNodes {
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
      const review = state.specComplianceReview ?? {
        verdict: 'approved' as const,
        findings: [],
        reviewedAt: null,
      };
      return applyReviewState(state, 'spec_compliance_review', review.verdict, review.findings);
    },

    async codeQualityReview(state) {
      const review = state.codeQualityReview ?? {
        verdict: 'approved' as const,
        findings: [],
        reviewedAt: null,
      };
      return applyReviewState(state, 'code_quality_review', review.verdict, review.findings);
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

  return {
    ...state,
    superpowersPhase: phase,
    reviewFindings: findings,
    reviewVerdict: 'pass',
    status: state.status === 'blocked' ? 'running' : state.status,
    error: null,
  };
}
