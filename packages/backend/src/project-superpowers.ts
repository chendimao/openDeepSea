import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_SUPERPOWERS_SKILLS_RELATIVE_PATH = join('project-superpowers', 'skills');

export const PROJECT_SUPERPOWERS_SKILL_SOURCE_WARNING =
  'Do not read or invoke same-name skills from ~/.agents/skills, ~/.codex/skills, or ~/.codex/superpowers.';

export interface ProjectSuperpowersSkill {
  name: string;
  path: string;
  content: string;
}

export function resolveProjectSuperpowersSkillPath(skillName: string): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, PROJECT_SUPERPOWERS_SKILLS_RELATIVE_PATH, skillName, 'SKILL.md'),
    join(moduleDir, '..', 'src', PROJECT_SUPERPOWERS_SKILLS_RELATIVE_PATH, skillName, 'SKILL.md'),
    join(process.cwd(), 'packages', 'backend', 'src', PROJECT_SUPERPOWERS_SKILLS_RELATIVE_PATH, skillName, 'SKILL.md'),
    join(process.cwd(), 'src', PROJECT_SUPERPOWERS_SKILLS_RELATIVE_PATH, skillName, 'SKILL.md'),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function loadProjectSuperpowersSkill(skillName: string): ProjectSuperpowersSkill | null {
  const path = resolveProjectSuperpowersSkillPath(skillName);
  if (!path) return null;
  return {
    name: skillName,
    path,
    content: readFileSync(path, 'utf-8').trim(),
  };
}

export function loadProjectSuperpowersSkills(skillNames: readonly string[]): ProjectSuperpowersSkill[] {
  const seen = new Set<string>();
  return skillNames
    .filter((skillName) => {
      if (seen.has(skillName)) return false;
      seen.add(skillName);
      return true;
    })
    .map(loadProjectSuperpowersSkill)
    .filter((skill): skill is ProjectSuperpowersSkill => skill !== null);
}

export function formatProjectSuperpowersSkill(skill: ProjectSuperpowersSkill): string {
  return [
    `Skill: superpowers:${skill.name}`,
    'Source: project-builtin',
    `Path: ${skill.path}`,
    'Instructions:',
    skill.content,
    '',
  ].join('\n');
}
