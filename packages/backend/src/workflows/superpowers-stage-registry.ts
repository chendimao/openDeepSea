export const SUPERPOWERS_V2_GRAPH_VERSION = 'superpowers-v2';

export type SuperpowersStageController = 'planner' | 'worker' | 'reviewer' | 'verifier' | 'user';
export type SuperpowersStageId =
  | 'intake'
  | 'route_skills'
  | 'answer'
  | 'analysis_plan'
  | 'lightweight_plan'
  | 'brainstorming'
  | 'spec_review'
  | 'spec_confirm'
  | 'writing_plans'
  | 'plan_review'
  | 'plan_confirm'
  | 'worktree'
  | 'dispatch'
  | 'execute'
  | 'debug_plan'
  | 'debug_plan_confirm'
  | 'debug'
  | 'systematic_debugging'
  | 'review_plan'
  | 'reviewer_assignment'
  | 'agent_assignment'
  | 'spec_compliance_review'
  | 'code_quality_review'
  | 'verification'
  | 'finish_branch'
  | 'acceptance'
  | 'memory';

export interface SuperpowersStageDefinition {
  id: SuperpowersStageId;
  controller: SuperpowersStageController;
  requiredSkills: string[];
  requiredInputs: string[];
  expectedArtifacts: string[];
  gates: string[];
  next: SuperpowersStageId[];
}

const STAGES: SuperpowersStageDefinition[] = [
  { id: 'intake', controller: 'planner', requiredSkills: ['using-superpowers'], requiredInputs: ['user_message'], expectedArtifacts: ['intent_routing'], gates: ['artifact_schema'], next: ['route_skills'] },
  { id: 'route_skills', controller: 'planner', requiredSkills: ['using-superpowers'], requiredInputs: ['intent_routing'], expectedArtifacts: ['superpowers_routing'], gates: ['artifact_schema'], next: ['answer', 'analysis_plan', 'lightweight_plan', 'brainstorming', 'debug_plan', 'review_plan'] },
  { id: 'brainstorming', controller: 'planner', requiredSkills: ['brainstorming'], requiredInputs: ['user_message'], expectedArtifacts: ['spec'], gates: ['artifact_schema'], next: ['spec_review'] },
  { id: 'spec_review', controller: 'reviewer', requiredSkills: ['brainstorming'], requiredInputs: ['spec'], expectedArtifacts: ['spec_review'], gates: ['review_clear'], next: ['spec_confirm'] },
  { id: 'spec_confirm', controller: 'user', requiredSkills: [], requiredInputs: ['spec_review'], expectedArtifacts: ['approved_spec_version'], gates: ['user_confirm'], next: ['writing_plans'] },
  { id: 'writing_plans', controller: 'planner', requiredSkills: ['writing-plans'], requiredInputs: ['approved_spec_version'], expectedArtifacts: ['plan'], gates: ['artifact_schema'], next: ['plan_review'] },
  { id: 'plan_review', controller: 'reviewer', requiredSkills: ['writing-plans'], requiredInputs: ['plan'], expectedArtifacts: ['plan_review'], gates: ['review_clear'], next: ['plan_confirm'] },
  { id: 'plan_confirm', controller: 'user', requiredSkills: [], requiredInputs: ['plan_review'], expectedArtifacts: ['approved_plan_version'], gates: ['user_confirm'], next: ['worktree', 'dispatch'] },
  { id: 'lightweight_plan', controller: 'planner', requiredSkills: ['using-superpowers'], requiredInputs: ['user_message'], expectedArtifacts: ['lightweight_plan'], gates: ['artifact_schema', 'user_confirm'], next: ['plan_confirm'] },
  { id: 'analysis_plan', controller: 'planner', requiredSkills: ['brainstorming'], requiredInputs: ['user_message'], expectedArtifacts: ['analysis_plan'], gates: ['artifact_schema'], next: ['memory'] },
  { id: 'answer', controller: 'planner', requiredSkills: [], requiredInputs: ['user_message'], expectedArtifacts: ['answer'], gates: [], next: [] },
  { id: 'agent_assignment', controller: 'planner', requiredSkills: ['subagent-driven-development'], requiredInputs: ['approved_plan_version'], expectedArtifacts: ['agent_assignment'], gates: ['artifact_schema'], next: ['worktree', 'systematic_debugging'] },
  { id: 'worktree', controller: 'planner', requiredSkills: ['using-git-worktrees'], requiredInputs: ['approved_plan_version'], expectedArtifacts: ['worktree'], gates: ['artifact_schema'], next: ['dispatch'] },
  { id: 'dispatch', controller: 'planner', requiredSkills: ['subagent-driven-development'], requiredInputs: ['approved_plan_version'], expectedArtifacts: ['agent_assignments'], gates: ['artifact_schema'], next: ['execute'] },
  { id: 'execute', controller: 'worker', requiredSkills: ['test-driven-development'], requiredInputs: ['assigned_task'], expectedArtifacts: ['tddEvidence'], gates: ['artifact_schema'], next: ['spec_compliance_review'] },
  { id: 'debug_plan', controller: 'planner', requiredSkills: ['systematic-debugging'], requiredInputs: ['failure_context'], expectedArtifacts: ['debug_plan'], gates: ['artifact_schema'], next: ['debug_plan_confirm'] },
  { id: 'debug_plan_confirm', controller: 'user', requiredSkills: [], requiredInputs: ['debug_plan'], expectedArtifacts: ['approved_debug_plan'], gates: ['user_confirm'], next: ['agent_assignment'] },
  { id: 'debug', controller: 'worker', requiredSkills: ['systematic-debugging'], requiredInputs: ['failure_context'], expectedArtifacts: ['debuggingEvidence'], gates: ['root_cause'], next: ['verification'] },
  { id: 'systematic_debugging', controller: 'worker', requiredSkills: ['systematic-debugging'], requiredInputs: ['approved_debug_plan'], expectedArtifacts: ['debuggingEvidence'], gates: ['root_cause'], next: ['verification'] },
  { id: 'review_plan', controller: 'planner', requiredSkills: ['requesting-code-review'], requiredInputs: ['user_message'], expectedArtifacts: ['review_plan'], gates: ['artifact_schema'], next: ['reviewer_assignment'] },
  { id: 'reviewer_assignment', controller: 'planner', requiredSkills: ['requesting-code-review'], requiredInputs: ['review_plan'], expectedArtifacts: ['agent_assignment'], gates: ['agent_available'], next: ['spec_compliance_review'] },
  { id: 'spec_compliance_review', controller: 'reviewer', requiredSkills: ['requesting-code-review'], requiredInputs: ['diff', 'approved_plan_version'], expectedArtifacts: ['specComplianceReview'], gates: ['review_clear'], next: ['code_quality_review', 'execute'] },
  { id: 'code_quality_review', controller: 'reviewer', requiredSkills: ['requesting-code-review'], requiredInputs: ['diff'], expectedArtifacts: ['codeQualityReview'], gates: ['review_clear'], next: ['verification', 'execute'] },
  { id: 'verification', controller: 'verifier', requiredSkills: ['verification-before-completion'], requiredInputs: ['verification_commands'], expectedArtifacts: ['verificationEvidence'], gates: ['fresh_evidence'], next: ['finish_branch'] },
  { id: 'finish_branch', controller: 'planner', requiredSkills: ['finishing-a-development-branch'], requiredInputs: ['verificationEvidence'], expectedArtifacts: ['finishBranchDecision'], gates: ['user_confirm'], next: ['acceptance'] },
  { id: 'acceptance', controller: 'planner', requiredSkills: [], requiredInputs: ['approved_plan_version', 'verificationEvidence'], expectedArtifacts: ['acceptance'], gates: ['completion_audit'], next: ['memory'] },
  { id: 'memory', controller: 'planner', requiredSkills: [], requiredInputs: ['acceptance'], expectedArtifacts: ['memory'], gates: [], next: [] },
];

export function listSuperpowersStages(): SuperpowersStageDefinition[] {
  return STAGES.map((stage) => ({
    ...stage,
    requiredSkills: [...stage.requiredSkills],
    requiredInputs: [...stage.requiredInputs],
    expectedArtifacts: [...stage.expectedArtifacts],
    gates: [...stage.gates],
    next: [...stage.next],
  }));
}

export function getSuperpowersStage(id: SuperpowersStageId): SuperpowersStageDefinition | null {
  return listSuperpowersStages().find((stage) => stage.id === id) ?? null;
}
