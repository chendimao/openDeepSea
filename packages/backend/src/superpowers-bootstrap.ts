import {
  formatProjectSuperpowersSkill,
  loadProjectSuperpowersSkill,
  loadProjectSuperpowersSkills,
  PROJECT_SUPERPOWERS_SKILL_SOURCE_WARNING,
} from './project-superpowers.js';
import type { SuperpowersBootstrapOwner } from './types.js';

const USING_SUPERPOWERS_SKILL = 'using-superpowers';
const DEVELOPMENT_WORKFLOW_SKILLS = [
  'brainstorming',
  'writing-plans',
  'subagent-driven-development',
  'executing-plans',
  'test-driven-development',
  'systematic-debugging',
  'requesting-code-review',
  'receiving-code-review',
  'verification-before-completion',
  'finishing-a-development-branch',
] as const;

let cachedBootstrap: string | null | undefined;

export interface SuperpowersBootstrapDecisionInput {
  prompt: string;
  userPrompt?: string;
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
    'Do not call provider-native Skill/use_skill/activate_skill tools. If a relevant project-builtin skill block is present below, follow that injected block directly.',
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
  if (shouldInjectDevelopmentWorkflowSkills(prompt)) selected.push(...DEVELOPMENT_WORKFLOW_SKILLS);
  return selected;
}

function shouldInjectDevelopmentWorkflowSkills(prompt: string): boolean {
  return /brainstorming|头脑风暴|新增|添加|设置项|功能|需求|workflow/i.test(prompt);
}

function getProjectSuperpowersSkillBlock(prompt: string): string | null {
  const skills = loadProjectSuperpowersSkills(selectProjectSuperpowersSkillNames(prompt));
  if (skills.length === 0) return null;

  return [
    '<OPENDEEPSEA_PROJECT_SUPERPOWERS>',
    'OpenDeepSea project-owned Superpowers skills are loaded below.',
    'Use these project-builtin skill instructions as the source of truth.',
    PROJECT_SUPERPOWERS_SKILL_SOURCE_WARNING,
    'ACP filesystem/search/shell tools remain available according to the agent runtime permission policy; provider-native skill-loading tools remain disabled for project-owned Superpowers.',
    '',
    ...skills.map(formatProjectSuperpowersSkill),
    '</OPENDEEPSEA_PROJECT_SUPERPOWERS>',
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
  const projectSkills = getProjectSuperpowersSkillBlock(input.userPrompt ?? input.prompt);
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
