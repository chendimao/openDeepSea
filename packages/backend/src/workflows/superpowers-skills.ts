export const SUPERPOWERS_CORE_SKILL_NAMES = [
  'using-superpowers',
  'brainstorming',
  'using-git-worktrees',
  'writing-plans',
  'subagent-driven-development',
  'executing-plans',
  'test-driven-development',
  'requesting-code-review',
  'receiving-code-review',
  'finishing-a-development-branch',
  'systematic-debugging',
  'verification-before-completion',
  'dispatching-parallel-agents',
  'writing-skills',
] as const;

export type SuperpowersCoreSkillName = typeof SUPERPOWERS_CORE_SKILL_NAMES[number];

export type SuperpowersPhase =
  | 'brainstorming'
  | 'worktree'
  | 'writing_plans'
  | 'tdd_execute'
  | 'spec_compliance_review'
  | 'code_quality_review'
  | 'verify'
  | 'finish_branch';

export const SUPERPOWERS_PHASE_SKILLS: Record<SuperpowersPhase, readonly SuperpowersCoreSkillName[]> = {
  brainstorming: ['using-superpowers', 'brainstorming'],
  worktree: ['using-git-worktrees'],
  writing_plans: ['writing-plans'],
  tdd_execute: ['test-driven-development', 'subagent-driven-development'],
  spec_compliance_review: ['requesting-code-review'],
  code_quality_review: ['requesting-code-review'],
  verify: ['verification-before-completion'],
  finish_branch: ['finishing-a-development-branch'],
};

export function getSuperpowersPhaseSkills(phase: SuperpowersPhase): readonly SuperpowersCoreSkillName[] {
  return SUPERPOWERS_PHASE_SKILLS[phase];
}
