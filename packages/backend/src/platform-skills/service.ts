import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type {
  PlatformSkill,
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

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 1024 * 1024;
const PLATFORM_SKILL_METADATA_FILE = '.opendeepsea-platform-skill.json';

export const PLATFORM_PROVIDERS: PlatformSkillProvider[] = ['codex', 'claudecode', 'opencode'];

export interface InstallDirectoryInput {
  sourceDir: string;
  targets: PlatformSkillProvider[];
  installMode: Exclude<PlatformSkillInstallMode, 'unknown'>;
  sourceLabel: string | null;
}

interface InstallTargetPlan {
  provider: PlatformSkillProvider;
  root: string;
  target: string;
}

interface InstallPlan {
  sourceDir: string;
  safeName: string;
  targets: InstallTargetPlan[];
}

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

export async function assertCanInstallDirectoryToPlatforms(input: Pick<InstallDirectoryInput, 'sourceDir' | 'targets'>): Promise<void> {
  await createInstallPlan(input.sourceDir, input.targets);
}

export async function installDirectoryToPlatforms(input: InstallDirectoryInput): Promise<PlatformSkill[]> {
  const plan = await createInstallPlan(input.sourceDir, input.targets);

  const installed: PlatformSkill[] = [];
  for (const { provider, root, target } of plan.targets) {
    await mkdir(root, { recursive: true });
    if (input.installMode === 'symlink') {
      await symlink(plan.sourceDir, target, 'dir');
    } else {
      await copySkillDirectoryAtomically(plan.sourceDir, target);
    }
    await writePlatformSkillMetadata(target, { sourceLabel: input.sourceLabel });
    installed.push(await readPlatformSkill(provider, root, plan.safeName, input.sourceLabel));
  }
  return installed;
}

export async function removePlatformSkill(provider: PlatformSkillProvider, skillName: string): Promise<boolean> {
  const root = resolve(resolvePlatformRoot(provider));
  assertSafeSkillDirectoryName(skillName);
  const target = resolve(root, skillName);
  if (!isPathInside(root, target)) {
    throw new Error('refusing to remove a skill outside the platform skills directory');
  }
  const targetStats = await lstat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!targetStats) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}

async function createInstallPlan(inputSourceDir: string, targets: PlatformSkillProvider[]): Promise<InstallPlan> {
  const sourceDir = resolve(inputSourceDir);
  const sourceStats = await stat(sourceDir).catch(() => null);
  if (!sourceStats?.isDirectory()) throw new Error('source skill path must be a directory');

  const manifest = await readManifest(sourceDir).catch(() => null);
  if (!manifest) throw new Error('SKILL.md is required');
  const safeName = sanitizeSkillName(manifest.name || basename(sourceDir));
  assertSafeSkillDirectoryName(safeName);

  const seen = new Set<PlatformSkillProvider>();
  const plans: InstallTargetPlan[] = [];
  for (const provider of targets) {
    if (seen.has(provider)) throw new Error(`duplicate install target: ${provider}`);
    seen.add(provider);
    const root = resolve(resolvePlatformRoot(provider));
    const target = resolve(root, safeName);
    if (!isPathInside(root, target)) throw new Error('target skill path escapes platform root');
    const targetStats = await lstat(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (targetStats) throw new Error(`${provider} skill "${safeName}" already exists`);
    plans.push({ provider, root, target });
  }

  return { sourceDir, safeName, targets: plans };
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

function sanitizeSkillName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
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

async function copySkillDirectoryAtomically(source: string, target: string): Promise<void> {
  const tempTarget = await mkdtemp(join(dirname(target), `.tmp-${basename(target)}-`));
  let published = false;
  try {
    await copySkillDirectory(source, tempTarget, source);
    await rename(tempTarget, target);
    published = true;
  } finally {
    if (!published) {
      await rm(tempTarget, { recursive: true, force: true });
    }
  }
}

async function copySkillDirectory(source: string, target: string, root: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source);
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const sourceEntry = join(source, entry);
    const targetEntry = join(target, entry);
    const entryStat = await lstat(sourceEntry);
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory()) {
      await copySkillDirectory(sourceEntry, targetEntry, root);
      continue;
    }
    if (!entryStat.isFile()) continue;
    if (entryStat.size > MAX_FILE_BYTES) continue;
    const resolved = resolve(sourceEntry);
    if (!isPathInside(root, resolved)) continue;
    await copyFile(sourceEntry, targetEntry);
  }
}

interface PlatformSkillMetadata {
  sourceLabel: string | null;
}

async function writePlatformSkillMetadata(skillPath: string, metadata: PlatformSkillMetadata): Promise<void> {
  await writeFile(
    join(skillPath, PLATFORM_SKILL_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf-8',
  );
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
