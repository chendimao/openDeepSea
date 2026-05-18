import type { SelectedSkill } from './selector.js';

export function formatSkillPrompt(skills: SelectedSkill[]): string {
  if (skills.length === 0) return '';
  return [
    'OpenDeepSea active skills for this runtime:',
    '',
    ...skills.map(formatSelectedSkill),
  ].join('\n');
}

function formatSelectedSkill(selected: SelectedSkill): string {
  return [
    `Skill: ${selected.skill.name}`,
    `Reason: ${selected.reasons.join('; ')}`,
    `Priority: ${selected.effectivePriority}`,
    selected.skill.description ? `Description: ${selected.skill.description}` : null,
    selected.truncated ? 'Truncated: true' : null,
    'Instructions:',
    selected.instructions,
    '',
  ].filter((line): line is string => line !== null).join('\n');
}
