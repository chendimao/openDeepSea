import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_SUPERPOWERS_SKILL_CONTENT } from './project-superpowers-skills.js';
import type { SuperpowersBootstrapOwner } from './types.js';

const SUPERPOWERS_SKILLS_RELATIVE_PATH = join('superpowers', 'skills');
const USING_SUPERPOWERS_SKILL = 'using-superpowers';
const PROJECT_SKILL_SOURCE_WARNING = 'Do not read or invoke same-name skills from ~/.agents/skills, ~/.codex/skills, or ~/.codex/superpowers.';

let cachedBootstrap: string | null | undefined;

export interface SuperpowersBootstrapDecisionInput {
  prompt: string;
  owner: SuperpowersBootstrapOwner;
  workflowRunId?: string | null;
}

export interface SuperpowersBootstrapDecision {
  prompt: string;
  injected: boolean;
  source: SuperpowersBootstrapOwner;
  skill: 'superpowers:using-superpowers' | null;
  skipReason: 'workflow_run' | 'provider_owner' | 'disabled' | 'already_present' | 'skill_missing' | null;
}

interface ProjectSuperpowersSkill {
  name: string;
  path: string;
  content: string;
}

function resolveProjectSuperpowersSkillPath(skillName: string): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, SUPERPOWERS_SKILLS_RELATIVE_PATH, skillName, 'SKILL.md'),
    join(moduleDir, '..', 'src', SUPERPOWERS_SKILLS_RELATIVE_PATH, skillName, 'SKILL.md'),
    join(process.cwd(), 'packages', 'backend', 'src', SUPERPOWERS_SKILLS_RELATIVE_PATH, skillName, 'SKILL.md'),
    join(process.cwd(), 'src', SUPERPOWERS_SKILLS_RELATIVE_PATH, skillName, 'SKILL.md'),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function loadProjectSuperpowersSkill(skillName: string): ProjectSuperpowersSkill | null {
  const path = resolveProjectSuperpowersSkillPath(skillName);
  if (!path) {
    const content = PROJECT_SUPERPOWERS_SKILL_CONTENT[skillName];
    if (!content) return null;
    return {
      name: skillName,
      path: join(process.cwd(), 'packages', 'backend', 'src', SUPERPOWERS_SKILLS_RELATIVE_PATH, skillName, 'SKILL.md'),
      content,
    };
  }
  return {
    name: skillName,
    path,
    content: readFileSync(path, 'utf-8').trim(),
  };
}

export function getSuperpowersSessionBootstrap(): string | null {
  if (cachedBootstrap !== undefined) return cachedBootstrap;

  const usingSuperpowers = loadProjectSuperpowersSkill(USING_SUPERPOWERS_SKILL);
  if (!usingSuperpowers) {
    cachedBootstrap = null;
    return cachedBootstrap;
  }

  cachedBootstrap = [
    '<EXTREMELY_IMPORTANT>',
    'You have superpowers.',
    '',
    "**Below is the full content of your 'superpowers:using-superpowers' skill - your introduction to using skills. For this project-owned session, use the project-builtin Superpowers skill blocks loaded below as the source of truth for any additional skills:**",
    '',
    usingSuperpowers.content,
    '',
    '</EXTREMELY_IMPORTANT>',
  ].join('\n');
  return cachedBootstrap;
}

export function prependSuperpowersSessionBootstrap(prompt: string): string {
  return applySuperpowersBootstrap({
    prompt,
    owner: 'project',
    workflowRunId: null,
  }).prompt;
}

function selectProjectSuperpowersSkillNames(prompt: string): string[] {
  const selected = [USING_SUPERPOWERS_SKILL];
  if (shouldInjectBrainstorming(prompt)) selected.push('brainstorming');
  return selected;
}

function shouldInjectBrainstorming(prompt: string): boolean {
  return /brainstorming|头脑风暴|新增|添加|设置项|功能|需求|workflow/i.test(prompt);
}

function getProjectSuperpowersSkillBlock(prompt: string): string | null {
  const skills = selectProjectSuperpowersSkillNames(prompt)
    .map(loadProjectSuperpowersSkill)
    .filter((skill): skill is ProjectSuperpowersSkill => skill !== null);
  if (skills.length === 0) return null;

  return [
    '<OPENDEEPSEA_PROJECT_SUPERPOWERS>',
    'OpenDeepSea project-owned Superpowers skills are loaded below.',
    'Use these project-builtin skill instructions as the source of truth.',
    PROJECT_SKILL_SOURCE_WARNING,
    'ACP filesystem/search/shell tools remain available according to the agent runtime permission policy.',
    '',
    ...skills.map(formatProjectSuperpowersSkill),
    '</OPENDEEPSEA_PROJECT_SUPERPOWERS>',
  ].join('\n');
}

function formatProjectSuperpowersSkill(skill: ProjectSuperpowersSkill): string {
  return [
    `Skill: superpowers:${skill.name}`,
    'Source: project-builtin',
    `Path: ${skill.path}`,
    'Instructions:',
    skill.content,
    '',
  ].join('\n');
}

export function applySuperpowersBootstrap(input: SuperpowersBootstrapDecisionInput): SuperpowersBootstrapDecision {
  if (input.workflowRunId) {
    return {
      prompt: input.prompt,
      injected: false,
      source: input.owner,
      skill: null,
      skipReason: 'workflow_run',
    };
  }

  if (input.owner === 'provider') {
    return {
      prompt: input.prompt,
      injected: false,
      source: 'provider',
      skill: null,
      skipReason: 'provider_owner',
    };
  }

  if (input.owner === 'disabled') {
    return {
      prompt: input.prompt,
      injected: false,
      source: 'disabled',
      skill: null,
      skipReason: 'disabled',
    };
  }

  if (input.prompt.includes('<EXTREMELY_IMPORTANT>\nYou have superpowers.')) {
    return {
      prompt: input.prompt,
      injected: false,
      source: 'project',
      skill: 'superpowers:using-superpowers',
      skipReason: 'already_present',
    };
  }

  const bootstrap = getSuperpowersSessionBootstrap();
  const projectSkills = getProjectSuperpowersSkillBlock(input.prompt);
  if (!bootstrap || !projectSkills) {
    return {
      prompt: input.prompt,
      injected: false,
      source: 'project',
      skill: 'superpowers:using-superpowers',
      skipReason: 'skill_missing',
    };
  }

  return {
    prompt: [bootstrap, '', projectSkills, '', input.prompt].join('\n'),
    injected: true,
    source: 'project',
    skill: 'superpowers:using-superpowers',
    skipReason: null,
  };
}
