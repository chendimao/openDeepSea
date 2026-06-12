import type {
  WorkflowDefinitionGraph,
  WorkflowDefinitionNode,
  WorkflowDefinitionNodeType,
  WorkflowRole,
  WorkflowStage,
} from '../../types.js';
import {
  listSuperpowersStages,
  type SuperpowersStageController,
  type SuperpowersStageDefinition,
  type SuperpowersStageId,
} from '../superpowers-stage-registry.js';
import {
  SUPERPOWERS_RUNTIME_PROFILE,
  SUPERPOWERS_WORKFLOW_DEFINITION_KEY,
} from './superpowers-runtime-constants.js';

const ROUTE_STAGE_IDS = [
  'intake',
  'route_skills',
  'answer',
  'analysis_plan',
  'lightweight_plan',
  'brainstorming',
  'spec_review',
  'spec_confirm',
  'writing_plans',
  'plan_review',
  'plan_confirm',
  'agent_assignment',
  'worktree',
  'dispatch',
  'execute',
  'debug_plan',
  'debug_plan_confirm',
  'systematic_debugging',
  'review_plan',
  'reviewer_assignment',
  'spec_compliance_review',
  'code_quality_review',
  'verification',
  'finish_branch',
  'acceptance',
  'memory',
] as const satisfies readonly SuperpowersStageId[];

const NODE_TYPE_BY_STAGE: Record<(typeof ROUTE_STAGE_IDS)[number], WorkflowDefinitionNodeType> = {
  intake: 'intake',
  route_skills: 'route_skills',
  answer: 'answer',
  analysis_plan: 'analysis_plan',
  lightweight_plan: 'lightweight_plan',
  brainstorming: 'brainstorming',
  spec_review: 'spec_review',
  spec_confirm: 'approval_gate',
  writing_plans: 'writing_plans',
  plan_review: 'plan_review',
  plan_confirm: 'approval_gate',
  agent_assignment: 'agent_assignment',
  worktree: 'worktree',
  dispatch: 'dispatch',
  execute: 'tdd_execute',
  debug_plan: 'debug_plan',
  debug_plan_confirm: 'approval_gate',
  systematic_debugging: 'systematic_debugging',
  review_plan: 'review_plan',
  reviewer_assignment: 'reviewer_assignment',
  spec_compliance_review: 'spec_compliance_review',
  code_quality_review: 'code_quality_review',
  verification: 'verify',
  finish_branch: 'finish_branch',
  acceptance: 'acceptance',
  memory: 'memory',
};

const LABEL_BY_STAGE: Partial<Record<SuperpowersStageId, string>> = {
  intake: 'Planner Intake',
  route_skills: 'Route Skills',
  answer: 'Answer',
  analysis_plan: 'Analysis Plan',
  lightweight_plan: 'Lightweight Plan',
  agent_assignment: 'Agent Assignment',
  debug_plan: 'Debug Plan',
  debug_plan_confirm: 'Debug Plan Confirm',
  systematic_debugging: 'Systematic Debugging',
  review_plan: 'Review Plan',
  reviewer_assignment: 'Reviewer Assignment',
  verification: 'Verification',
};

export function buildSuperpowersRouteDefinition(): WorkflowDefinitionGraph {
  const stageById = new Map(listSuperpowersStages().map((stage) => [stage.id, stage]));

  return {
    metadata: {
      runtime_profile: SUPERPOWERS_RUNTIME_PROFILE,
      gate_policy: SUPERPOWERS_WORKFLOW_DEFINITION_KEY,
    },
    nodes: [
      { id: 'context', type: 'context', label: '上下文', stage: 'analysis' },
      ...ROUTE_STAGE_IDS.map((id) => createRouteNode(id, stageById.get(id))),
    ],
    edges: createRouteEdges(),
  };
}

function createRouteNode(
  id: (typeof ROUTE_STAGE_IDS)[number],
  stage: SuperpowersStageDefinition | undefined,
): WorkflowDefinitionNode {
  return {
    id,
    type: NODE_TYPE_BY_STAGE[id],
    label: LABEL_BY_STAGE[id] ?? id,
    stage: inferWorkflowStage(id),
    role: controllerToRole(stage?.controller),
    metadata: {
      runtime_profile: SUPERPOWERS_RUNTIME_PROFILE,
      required_skill_names: stage?.requiredSkills ?? [],
      ...(stage?.gates?.length ? { gate_policy: stage.gates.join(',') } : {}),
    },
  };
}

function createRouteEdges(): WorkflowDefinitionGraph['edges'] {
  return [
    { from: 'context', to: 'intake' },
    { from: 'intake', to: 'route_skills' },
    { from: 'route_skills', to: 'answer', condition: 'answer' },
    { from: 'route_skills', to: 'analysis_plan', condition: 'analysis' },
    { from: 'route_skills', to: 'lightweight_plan', condition: 'lightweight_task' },
    { from: 'route_skills', to: 'brainstorming', condition: 'standard_development' },
    { from: 'route_skills', to: 'debug_plan', condition: 'debug' },
    { from: 'route_skills', to: 'review_plan', condition: 'review_only' },
    { from: 'analysis_plan', to: 'memory', condition: 'completed' },
    { from: 'lightweight_plan', to: 'plan_confirm' },
    { from: 'brainstorming', to: 'spec_review' },
    { from: 'spec_review', to: 'spec_confirm' },
    { from: 'spec_confirm', to: 'writing_plans', condition: 'approved' },
    { from: 'writing_plans', to: 'plan_review' },
    { from: 'plan_review', to: 'plan_confirm' },
    { from: 'plan_confirm', to: 'agent_assignment', condition: 'approved' },
    { from: 'agent_assignment', to: 'worktree' },
    { from: 'agent_assignment', to: 'systematic_debugging', condition: 'debug' },
    { from: 'worktree', to: 'dispatch' },
    { from: 'dispatch', to: 'execute' },
    { from: 'execute', to: 'execute', condition: 'has_runnable_child' },
    { from: 'execute', to: 'spec_compliance_review', condition: 'done' },
    { from: 'debug_plan', to: 'debug_plan_confirm' },
    { from: 'debug_plan_confirm', to: 'agent_assignment', condition: 'approved' },
    { from: 'systematic_debugging', to: 'verification' },
    { from: 'review_plan', to: 'reviewer_assignment' },
    { from: 'reviewer_assignment', to: 'spec_compliance_review' },
    { from: 'spec_compliance_review', to: 'execute', condition: 'changes_requested' },
    { from: 'spec_compliance_review', to: 'code_quality_review', condition: 'pass' },
    { from: 'code_quality_review', to: 'execute', condition: 'changes_requested' },
    { from: 'code_quality_review', to: 'verification', condition: 'pass' },
    { from: 'verification', to: 'finish_branch' },
    { from: 'finish_branch', to: 'acceptance', condition: 'completed' },
    { from: 'acceptance', to: 'memory', condition: 'completed' },
  ];
}

function inferWorkflowStage(id: SuperpowersStageId): WorkflowStage {
  if (id === 'intake' || id === 'route_skills' || id === 'analysis_plan') return 'analysis';
  if (id === 'agent_assignment' || id === 'reviewer_assignment') return 'assignment';
  if (id === 'execute' || id === 'systematic_debugging') return 'implementation';
  if (id === 'spec_compliance_review' || id === 'code_quality_review' || id === 'verification') return 'code_review';
  if (id === 'finish_branch' || id === 'acceptance' || id === 'memory' || id === 'answer') return 'acceptance';
  return 'planning';
}

function controllerToRole(controller: SuperpowersStageController | undefined): WorkflowRole | null {
  if (controller === 'planner') return 'planner';
  if (controller === 'worker') return 'executor';
  if (controller === 'reviewer' || controller === 'verifier') return 'reviewer';
  return null;
}
