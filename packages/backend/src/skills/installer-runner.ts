import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { posix as pathPosix } from 'node:path';
import type { SkillExecutableRuntime, SkillPermissions } from './types.js';

const MAX_FILE_BYTES = 1024 * 1024;
const SKIPPED_PACKAGE_DIRS = new Set(['.git', 'node_modules']);

export interface SkillsShPackageFile {
  path: string;
  content: string;
}

export interface SkillsShPackage {
  id: string;
  skillId: string | null;
  source: string | null;
  installLabel: string;
  version: string | null;
  revision: string | null;
  files: SkillsShPackageFile[];
}


export interface SkillsShMetadata {
  version: string | null;
  revision: string | null;
}

export interface SkillsShManifest {
  name: string | null;
  description: string | null;
  version: string | null;
  revision: string | null;
  runtime: SkillExecutableRuntime | null;
  entrypoint: string | null;
  permissions: SkillPermissions | null;
}

export interface MaterializedSkillsShPackage {
  checksum: string;
  installedFiles: string[];
}

export function createSkillsShPackage(raw: unknown, fallbackInstallLabel?: string): SkillsShPackage {
  const record = selectPackageRecord(raw);
  assertPublicRegistry(record);

  const id = firstString(record.id, record.package_id, record.packageId)
    ?? fallbackInstallLabel
    ?? '';
  const skillId = firstString(record.skillId, record.skill_id, record.slug) ?? skillIdFromLabel(id);
  const source = firstString(record.source, record.repository, record.repo) ?? sourceFromLabel(id);
  const installLabel = firstString(record.installLabel, record.install_label)
    ?? fallbackInstallLabel
    ?? labelFromParts(source, skillId)
    ?? id;
  const version = firstString(record.version, record.package_version, record.packageVersion);
  const revision = firstString(record.revision, record.package_revision, record.packageRevision, record.sha, record.hash);
  const files = normalizePackageFiles(record.files ?? record.contents);

  if (!installLabel.trim()) throw new Error('skills.sh package install label is required');
  if (files.length === 0) throw new Error('skills.sh package must include files');

  return {
    id: id || installLabel,
    skillId,
    source,
    installLabel,
    version,
    revision,
    files,
  };
}

export function normalizeSkillsShManifest(raw: unknown): SkillsShManifest {
  const record = asRecord(raw);
  if (!record) throw new Error('skill.json must be a JSON object');

  const runtimeValue = firstString(record.runtime, record.runtime_type, record.runtimeType);
  const entrypoint = firstString(record.entrypoint, record.main);
  const runtime = normalizeRuntime(runtimeValue);

  if ((runtimeValue || entrypoint) && !runtime) {
    throw new Error('skill.json runtime must be node, python, or shell');
  }
  if (runtime && !entrypoint) {
    throw new Error('skill.json entrypoint is required for executable skills');
  }
  if (entrypoint) assertSafeRelativePath(entrypoint, 'entrypoint must be a safe relative path');

  return {
    name: firstString(record.name) ?? null,
    description: firstString(record.description, record.summary) ?? null,
    version: firstString(record.version, record.package_version, record.packageVersion) ?? null,
    revision: firstString(record.revision, record.package_revision, record.packageRevision, record.sha) ?? null,
    runtime,
    entrypoint: entrypoint ?? null,
    permissions: runtime ? normalizePermissions(record.permissions) : null,
  };
}



export function readSkillsShPackageMetadata(pkg: SkillsShPackage): SkillsShMetadata | null {
  const metadata = pkg.files.find((file) => file.path === 'metadata.json');
  if (!metadata) return null;
  try {
    const record = asRecord(JSON.parse(metadata.content) as unknown);
    if (!record) return null;
    return normalizeSkillsShMetadataRecord(record);
  } catch (err) {
    throw new Error(`invalid metadata.json: ${(err as Error).message}`);
  }
}

function normalizeSkillsShMetadataRecord(record: Record<string, unknown>): SkillsShMetadata {
  return {
    version: firstString(record.version, record.package_version, record.packageVersion) ?? null,
    revision: firstString(record.revision, record.package_revision, record.packageRevision, record.sha, record.hash) ?? null,
  };
}

export async function readSkillsShMetadata(dir: string): Promise<SkillsShMetadata | null> {
  let raw: string;
  try {
    raw = await readFile(resolve(dir, 'metadata.json'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  try {
    const record = asRecord(JSON.parse(raw) as unknown);
    if (!record) return null;
    return normalizeSkillsShMetadataRecord(record);
  } catch (err) {
    throw new Error(`invalid metadata.json: ${(err as Error).message}`);
  }
}

export async function readSkillsShManifest(dir: string): Promise<SkillsShManifest | null> {
  let raw: string;
  try {
    raw = await readFile(resolve(dir, 'skill.json'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  try {
    return normalizeSkillsShManifest(JSON.parse(raw) as unknown);
  } catch (err) {
    throw new Error(`invalid skill.json: ${(err as Error).message}`);
  }
}

export async function writeSkillsShPackage(pkg: SkillsShPackage, targetDir: string): Promise<MaterializedSkillsShPackage> {
  const root = resolve(targetDir);
  const files = pkg.files
    .filter((file) => !shouldSkipPackagePath(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash('sha256');
  const installedFiles: string[] = [];

  await mkdir(root, { recursive: true });
  for (const file of files) {
    assertSafeRelativePath(file.path, 'unsafe package path');
    const content = Buffer.from(file.content, 'utf-8');
    if (content.byteLength > MAX_FILE_BYTES) {
      throw new Error(`package file is too large: ${file.path}`);
    }
    const target = resolve(root, ...file.path.split('/'));
    if (!isPathInside(root, target)) throw new Error(`unsafe package path: ${file.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    hash.update(file.path);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
    installedFiles.push(file.path);
  }

  if (!installedFiles.includes('SKILL.md')) {
    const skillInstructions = files.find((file) => file.path === 'AGENTS.md');
    if (!skillInstructions) throw new Error('SKILL.md or AGENTS.md is required');
    const target = resolve(root, 'SKILL.md');
    const content = Buffer.from(skillInstructions.content, 'utf-8');
    await writeFile(target, content);
    hash.update('SKILL.md');
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
    installedFiles.push('SKILL.md');
  }

  return {
    checksum: hash.digest('hex'),
    installedFiles,
  };
}

export function assertSafeRelativePath(value: string, message = 'unsafe package path'): void {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${message}: path is empty`);
  if (normalized.includes('\0') || normalized.includes('\\')) throw new Error(`${message}: ${value}`);
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) throw new Error(`${message}: ${value}`);
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`${message}: ${value}`);
  const posixNormalized = pathPosix.normalize(normalized);
  if (posixNormalized !== normalized || posixNormalized.startsWith('../')) {
    throw new Error(`${message}: ${value}`);
  }
}

function normalizePackageFiles(raw: unknown): SkillsShPackageFile[] {
  if (Array.isArray(raw)) {
    return raw.map(normalizePackageFile).filter((file): file is SkillsShPackageFile => file !== null);
  }
  const record = asRecord(raw);
  if (!record) return [];
  return Object.entries(record).map(([path, value]) => {
    const content = normalizeFileContent(value);
    if (content === null) throw new Error(`package file content must be text: ${path}`);
    assertSafeRelativePath(path, 'unsafe package path');
    return { path, content };
  });
}

function normalizePackageFile(raw: unknown): SkillsShPackageFile | null {
  const record = asRecord(raw);
  if (!record) return null;
  const path = firstString(record.path, record.name, record.filename);
  if (!path) return null;
  const content = normalizeFileContent(record.content ?? record.contents ?? record.text ?? record.data);
  if (content === null) throw new Error(`package file content must be text: ${path}`);
  assertSafeRelativePath(path, 'unsafe package path');
  return { path, content };
}

function normalizeFileContent(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  const record = asRecord(raw);
  if (!record) return null;
  const content = firstString(record.content, record.contents, record.text, record.data);
  if (content === null) return null;
  const encoding = firstString(record.encoding);
  if (encoding === 'base64') return Buffer.from(content, 'base64').toString('utf-8');
  return content;
}

function normalizePermissions(raw: unknown): SkillPermissions {
  const record = asRecord(raw) ?? {};
  const filesystem = firstString(record.filesystem) ?? 'project';
  if (filesystem !== 'project') throw new Error('skill.json permissions.filesystem must be project');
  const network = typeof record.network === 'boolean' ? record.network : false;
  const commandsRaw = record.commands;
  if (commandsRaw !== undefined && (!Array.isArray(commandsRaw) || !commandsRaw.every((item) => typeof item === 'string'))) {
    throw new Error('skill.json permissions.commands must be a string array');
  }
  return {
    filesystem: 'project',
    network,
    commands: Array.isArray(commandsRaw) ? commandsRaw : [],
  };
}

function selectPackageRecord(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record) throw new Error('skills.sh package response must be a JSON object');
  for (const key of ['package', 'skill']) {
    const nested = asRecord(record[key]);
    if (nested) return nested;
  }
  const data = asRecord(record.data);
  if (data) {
    for (const key of ['package', 'skill']) {
      const nested = asRecord(data[key]);
      if (nested) return nested;
    }
    if (data.files || data.contents) return data;
  }
  return record;
}

function assertPublicRegistry(record: Record<string, unknown>): void {
  const registry = firstString(record.registry, record.registry_url, record.registryUrl);
  if (registry) assertAllowedPublicUrl(registry);
  const source = firstString(record.source, record.repository, record.repo);
  if (source && looksLikeUrl(source)) assertAllowedPublicUrl(source);
}

function assertAllowedPublicUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const host = url.hostname.toLocaleLowerCase();
  if (!['skills.sh', 'www.skills.sh', 'github.com', 'raw.githubusercontent.com'].includes(host)) {
    throw new Error('private registries are not supported');
  }
}

function looksLikeUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

function shouldSkipPackagePath(value: string): boolean {
  return value.split('/').some((part) => SKIPPED_PACKAGE_DIRS.has(part));
}

function normalizeRuntime(value: string | null): SkillExecutableRuntime | null {
  if (value === 'node' || value === 'python' || value === 'shell') return value;
  return null;
}

function labelFromParts(source: string | null, skillId: string | null): string | null {
  if (!source || !skillId) return null;
  return `${source}/${skillId}`;
}

function sourceFromLabel(label: string): string | null {
  const parts = label.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  return parts.slice(0, -1).join('/');
}

function skillIdFromLabel(label: string): string | null {
  const parts = label.split('/').filter(Boolean);
  return parts.at(-1) ?? null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isPathInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}
