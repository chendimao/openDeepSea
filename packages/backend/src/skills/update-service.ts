import { skillRepo } from './repo.js';
import { checkSkillsShUpdate } from './installer.js';
import type { Skill } from './types.js';

export async function runSkillsShStartupUpdateCheck(): Promise<void> {
  const skills = skillRepo.listSkills();
  const targets = skills.filter((skill) => shouldCheckStartupUpdate(skill));
  await Promise.all(targets.map(async (skill) => {
    try {
      await checkSkillsShUpdate(skill);
    } catch (err) {
      console.warn(`[skills-update] startup check failed for ${skill.id}: ${(err as Error).message}`);
    }
  }));
}

function shouldCheckStartupUpdate(skill: Skill): boolean {
  return skill.source_type === 'skills_sh' && skill.update_check_mode === 'startup';
}
