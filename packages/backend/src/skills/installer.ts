import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import { loadSkillFromDirectory } from './loader.js';
import { skillRepo } from './repo.js';
import type { Skill } from './types.js';
import {
  readSkillsShManifest,
  readSkillsShMetadata,
  writeSkillsShPackage,
  type SkillsShPackage,
} from './installer-runner.js';
import { SkillsShClient } from './skills-sh-client.js';

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 1024 * 1024;

export function getSkillsRoot(): string {
  return process.env.OPENDEEPSEA_SKILLS_DIR?.trim() || join(homedir(), '.opendeepsea', 'skills');
}

export interface InstallSkillsShOptions {
  client?: SkillsShClient;
}

export interface SkillsShUpdateResult {
  skillId: string;
  hasUpdate: boolean;
  currentVersion: string | null;
  currentRevision: string | null;
  availableVersion: string | null;
  availableRevision: string | null;
  checkedAt: number;
}

export async function importLocalSkill(sourcePath: string): Promise<Skill> {
  const source = sourcePath.trim();
  if (!source) throw new Error('local skill path is required');
  const sourceRealPath = resolve(source);
  let sourceStat;
  try {
    sourceStat = await stat(sourceRealPath);
  } catch {
    throw new Error('local skill path does not exist');
  }
  if (!sourceStat.isDirectory()) throw new Error('local skill path must be a directory');
  if (!existsSync(join(sourceRealPath, 'SKILL.md'))) throw new Error('SKILL.md is required');

  const id = nanoid();
  const skillsRoot = resolve(getSkillsRoot());
  const installPath = join(skillsRoot, id);
  await mkdir(skillsRoot, { recursive: true });
  await copySkillDirectory(sourceRealPath, installPath, sourceRealPath);

  const loaded = await loadSkillFromDirectory(installPath);
  const checksum = createHash('sha256')
    .update(await readFile(join(installPath, 'SKILL.md')))
    .digest('hex');

  try {
    return skillRepo.createSkill({
      id,
      name: loaded.name,
      description: loaded.description,
      source_type: 'local_directory',
      source_uri: sourceRealPath,
      install_path: installPath,
      manifest_path: loaded.manifestPath,
      runtime_scopes: loaded.runtimeScopes,
      trigger_mode: loaded.triggerMode,
      trigger_keywords: loaded.triggerKeywords,
      enabled: true,
      priority: loaded.priority,
      checksum,
    });
  } catch (err) {
    await rm(installPath, { recursive: true, force: true });
    throw err;
  }
}

export async function installSkillsShSkill(installLabel: string, options: InstallSkillsShOptions = {}): Promise<Skill> {
  const label = installLabel.trim();
  if (!label) throw new Error('skills.sh install label is required');

  const client = options.client ?? new SkillsShClient();
  const pkg = await client.fetchPackage(label);
  const id = nanoid();
  const skillsRoot = resolve(getSkillsRoot());
  const installPath = join(skillsRoot, id);
  await mkdir(skillsRoot, { recursive: true });

  try {
    const materialized = await writeSkillsShPackage(pkg, installPath);
    const loaded = await loadSkillFromDirectory(installPath);
    const manifest = await readSkillsShManifest(installPath);
    const metadata = await readSkillsShMetadata(installPath);
    const version = manifest?.version ?? metadata?.version ?? pkg.version;
    const revision = manifest?.revision ?? metadata?.revision ?? pkg.revision;

    return skillRepo.createSkill({
      id,
      name: manifest?.name ?? loaded.name,
      description: manifest?.description ?? loaded.description,
      source_type: 'skills_sh',
      source_uri: `skills.sh/${pkg.installLabel}`,
      install_path: installPath,
      manifest_path: loaded.manifestPath,
      runtime_scopes: loaded.runtimeScopes,
      trigger_mode: loaded.triggerMode,
      trigger_keywords: loaded.triggerKeywords,
      enabled: true,
      priority: loaded.priority,
      checksum: materialized.checksum,
      package_version: version,
      package_revision: revision,
      runtime_type: manifest?.runtime ?? null,
      entrypoint: manifest?.entrypoint ?? null,
      permissions: manifest?.permissions ?? null,
      install_source_label: pkg.installLabel,
      update_check_mode: 'startup',
      update_apply_mode: 'prompt',
    });
  } catch (err) {
    await rm(installPath, { recursive: true, force: true });
    throw err;
  }
}

export async function checkSkillsShUpdate(skill: Skill, options: InstallSkillsShOptions = {}): Promise<SkillsShUpdateResult> {
  if (skill.source_type !== 'skills_sh') {
    throw new Error('only skills.sh skills support update checks');
  }
  const installLabel = skill.install_source_label ?? skill.source_uri?.replace(/^skills\.sh\//, '') ?? '';
  if (!installLabel) throw new Error('skills.sh install source label is required');

  const client = options.client ?? new SkillsShClient();
  const remote = await client.fetchPackageMetadata(installLabel);
  const checkedAt = Date.now();
  const availableVersion = remote.version;
  const availableRevision = remote.revision;
  const hasUpdate = hasRemoteUpdate(skill, remote);

  skillRepo.updateSkill(skill.id, {
    last_update_checked_at: checkedAt,
    available_version: availableVersion,
    available_revision: availableRevision,
  });

  return {
    skillId: skill.id,
    hasUpdate,
    currentVersion: skill.package_version,
    currentRevision: skill.package_revision,
    availableVersion,
    availableRevision,
    checkedAt,
  };
}

export async function removeInstalledSkill(skill: Skill): Promise<void> {
  const skillsRoot = resolve(getSkillsRoot());
  const installPath = resolve(skill.install_path);
  if (!isPathInside(skillsRoot, installPath)) {
    throw new Error('refusing to remove a skill outside the managed skills directory');
  }
  await rm(installPath, { recursive: true, force: true });
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

function isPathInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

export function installedPathLabel(skill: Skill): string {
  return basename(skill.install_path);
}

function hasRemoteUpdate(skill: Skill, remote: SkillsShPackage): boolean {
  if (remote.version !== null && remote.version !== skill.package_version) return true;
  if (remote.revision !== null && remote.revision !== skill.package_revision) return true;
  return false;
}
