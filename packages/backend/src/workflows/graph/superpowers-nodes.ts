import { canLeaveWritingPlans } from './superpowers-gates.js';
import type { AgentWorkflowState, SuperpowersReviewVerdict } from './state.js';
import type { WorkflowDefinitionNodeType, WorkflowRole, WorkflowStage } from '../../types.js';

export type SuperpowersPlanningNodeName =
  | 'brainstorming'
  | 'spec_review'
  | 'worktree'
  | 'writing_plans'
  | 'plan_review';

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
