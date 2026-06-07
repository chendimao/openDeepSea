import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  readdir,
  readFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import type {
  PlatformSkill,
  PlatformSkillAggregate,
  PlatformSkillDefinition,
  PlatformSkillInstallMode,
  PlatformSkillProvider,
  PlatformSkillSummary,
} from './types.js';

const PLATFORM_LABELS: Record<PlatformSkillProvider, string> = {
  codex: 'Codex',
  claudecode: 'Claude Code',
  opencode: 'OpenCode',
};

const PLATFORM_SKILL_METADATA_FILE = '.opendeepsea-platform-skill.json';

export const PLATFORM_PROVIDERS: PlatformSkillProvider[] = ['codex', 'claudecode', 'opencode'];

interface ParsedSkillManifest {
  name: string;
  description: string | null;
  version: string | null;
}

export function getPlatformDefinitions(): PlatformSkillDefinition[] {
  return PLATFORM_PROVIDERS.map((provider) => ({
    provider,
    label: PLATFORM_LABELS[provider],
    root: resolvePlatformRoot(provider),
  }));
}

export function resolvePlatformRoot(provider: PlatformSkillProvider): string {
  const home = homedir();
  if (provider === 'codex') {
    return join(process.env.CODEX_HOME?.trim() || join(home, '.codex'), 'skills');
  }
  if (provider === 'claudecode') {
    return join(home, '.claude', 'skills');
  }
  return join(home, '.config', 'opencode', 'skills');
}

export async function listPlatformSummaries(): Promise<PlatformSkillSummary[]> {
  return Promise.all(getPlatformDefinitions().map(async (definition) => {
    const skills = await listPlatformSkills(definition.provider);
    const rootExists = existsSync(definition.root);
    const rootWritable = await isWritable(definition.root);
    return {
      ...definition,
      rootExists,
      rootWritable,
      installedCount: skills.length,
      issues: rootExists && !rootWritable ? ['skills root is not writable'] : [],
    };
  }));
}

export async function listPlatformSkills(provider: PlatformSkillProvider): Promise<PlatformSkill[]> {
  const root = resolve(resolvePlatformRoot(provider));
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const skills = await Promise.all(entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => readPlatformSkill(provider, root, entry.name)));
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listPlatformSkillAggregates(): Promise<PlatformSkillAggregate[]> {
  const byProvider = await Promise.all(
    PLATFORM_PROVIDERS.map(async (provider) => ({
      provider,
      skills: await listPlatformSkills(provider),
    })),
  );
  const byName = new Map<string, PlatformSkillAggregate>();

  for (const { provider, skills } of byProvider) {
    for (const skill of skills) {
      const aggregate = byName.get(skill.name) ?? createEmptyAggregate(skill.name);
      aggregate.installations[provider] = skill;
      aggregate.installModes[provider] = skill.installMode;
      if (aggregate.description === null) {
        aggregate.description = skill.description;
      }
      aggregate.lastModifiedAt = maxTimestamp(aggregate.lastModifiedAt, skill.lastModifiedAt);
      for (const issue of skill.issues) {
        aggregate.issues.push({ provider, message: issue });
      }
      byName.set(skill.name, aggregate);
    }
  }

  const aggregates = [...byName.values()];
  for (const aggregate of aggregates) {
    aggregate.providers = PLATFORM_PROVIDERS.filter((provider) => Boolean(aggregate.installations[provider]));
    aggregate.missingProviders = PLATFORM_PROVIDERS.filter((provider) => !aggregate.installations[provider]);
    aggregate.valid = aggregate.providers.length > 0 && aggregate.issues.length === 0;
  }

  return aggregates.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPlatformSkill(provider: PlatformSkillProvider, skillName: string): Promise<PlatformSkill | null> {
  const root = resolve(resolvePlatformRoot(provider));
  try {
    assertSafeSkillDirectoryName(skillName);
  } catch {
    return null;
  }
  const target = resolve(root, skillName);
  if (!isPathInside(root, target)) return null;
  const targetStats = await lstat(target).catch(() => null);
  if (!targetStats) return null;
  return readPlatformSkill(provider, root, skillName);
}

async function readPlatformSkill(
  provider: PlatformSkillProvider,
  root: string,
  entryName: string,
  sourceLabel: string | null = null,
): Promise<PlatformSkill> {
  const skillPath = resolve(root, entryName);
  const issues: string[] = [];
  let installMode: PlatformSkillInstallMode = 'unknown';
  let lastModifiedAt: number | null = null;
  let manifest: ParsedSkillManifest | null = null;
  const manifestPath = join(skillPath, 'SKILL.md');
  const metadata = await readPlatformSkillMetadata(skillPath).catch((err) => {
    issues.push((err as Error).message);
    return null;
  });

  try {
    const entryStat = await lstat(skillPath);
    installMode = entryStat.isSymbolicLink() ? 'symlink' : 'copy';
    lastModifiedAt = Math.trunc(entryStat.mtimeMs);
  } catch (err) {
    issues.push((err as Error).message);
  }

  if (!existsSync(manifestPath)) {
    issues.push('SKILL.md is required');
  } else {
    try {
      manifest = await readManifest(skillPath);
    } catch (err) {
      issues.push((err as Error).message);
    }
  }

  return {
    provider,
    name: entryName,
    description: manifest?.description ?? null,
    path: skillPath,
    manifestPath: existsSync(manifestPath) ? manifestPath : null,
    installMode,
    sourceLabel: sourceLabel ?? metadata?.sourceLabel ?? null,
    version: manifest?.version ?? null,
    lastModifiedAt,
    valid: issues.length === 0,
    issues,
  };
}

function createEmptyAggregate(name: string): PlatformSkillAggregate {
  return {
    name,
    displayName: name,
    description: null,
    providers: [],
    missingProviders: [],
    installations: {},
    installModes: {},
    valid: false,
    issues: [],
    lastModifiedAt: null,
  };
}

function maxTimestamp(current: number | null, next: number | null): number | null {
  if (current === null) return next;
  if (next === null) return current;
  return Math.max(current, next);
}

async function readManifest(dir: string): Promise<ParsedSkillManifest | null> {
  const raw = await readFile(join(dir, 'SKILL.md'), 'utf-8');
  const frontmatter = parseFrontmatter(raw);
  return {
    name: frontmatter.name ?? basename(dir),
    description: frontmatter.description ?? fallbackDescription(raw),
    version: frontmatter.version ?? null,
  };
}

function parseFrontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith('---\n')) return {};
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return {};

  const values: Record<string, string> = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    values[match[1]!] = stripQuotes(match[2]!.trim());
  }
  return values;
}

function fallbackDescription(raw: string): string | null {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const first = body.split('\n').map((line) => line.trim()).find(Boolean);
  return first ? first.replace(/^#+\s*/, '') : null;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function assertSafeSkillDirectoryName(value: string): void {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    throw new Error('skill name must be a safe directory name');
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error('skill name must be a safe directory name');
  }
}

interface PlatformSkillMetadata {
  sourceLabel: string | null;
}

async function readPlatformSkillMetadata(skillPath: string): Promise<PlatformSkillMetadata | null> {
  const raw = await readFile(join(skillPath, PLATFORM_SKILL_METADATA_FILE), 'utf-8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') return null;
  const sourceLabel = (parsed as { sourceLabel?: unknown }).sourceLabel;
  return {
    sourceLabel: typeof sourceLabel === 'string' && sourceLabel.trim() ? sourceLabel : null,
  };
}

async function isWritable(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}
