import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USING_SUPERPOWERS_RELATIVE_PATH = join('superpowers', 'skills', 'using-superpowers', 'SKILL.md');
const USER_SUPERPOWERS_SKILL_PATH = join('.codex', 'superpowers', 'skills', 'using-superpowers', 'SKILL.md');
const USER_AGENTS_SKILL_PATH = join('.agents', 'skills', 'using-superpowers', 'SKILL.md');

let cachedBootstrap: string | null | undefined;

function resolveUsingSuperpowersSkillPath(): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, USING_SUPERPOWERS_RELATIVE_PATH),
    join(moduleDir, '..', 'src', USING_SUPERPOWERS_RELATIVE_PATH),
    join(process.cwd(), 'packages', 'backend', 'src', USING_SUPERPOWERS_RELATIVE_PATH),
    join(process.cwd(), 'src', USING_SUPERPOWERS_RELATIVE_PATH),
    join(homedir(), USER_SUPERPOWERS_SKILL_PATH),
    join(homedir(), USER_AGENTS_SKILL_PATH),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function getSuperpowersSessionBootstrap(): string | null {
  if (cachedBootstrap !== undefined) return cachedBootstrap;

  const skillPath = resolveUsingSuperpowersSkillPath();
  if (!skillPath) {
    cachedBootstrap = null;
    return cachedBootstrap;
  }

  const usingSuperpowersContent = readFileSync(skillPath, 'utf-8').trim();
  cachedBootstrap = [
    '<EXTREMELY_IMPORTANT>',
    'You have superpowers.',
    '',
    "**Below is the full content of your 'superpowers:using-superpowers' skill - your introduction to using skills. For all other skills, use the native Skill tool when available, or inspect the matching project skill instructions before responding:**",
    '',
    usingSuperpowersContent,
    '',
    '</EXTREMELY_IMPORTANT>',
  ].join('\n');
  return cachedBootstrap;
}

export function prependSuperpowersSessionBootstrap(prompt: string): string {
  const bootstrap = getSuperpowersSessionBootstrap();
  if (!bootstrap || prompt.includes('<EXTREMELY_IMPORTANT>\nYou have superpowers.')) return prompt;
  return [bootstrap, '', prompt].join('\n');
}
