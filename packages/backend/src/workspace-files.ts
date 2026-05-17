import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import type {
  WorkspaceDirectoryEntry,
  WorkspaceFilePreview,
  WorkspaceFileReference,
  WorkspacePathResolution,
  WorkspaceSearchResult,
} from './types.js';

export const WORKSPACE_DIRECTORY_LIMIT = 500;
export const WORKSPACE_PREVIEW_TEXT_LIMIT = 512 * 1024;
export const WORKSPACE_REFERENCE_SIZE_LIMIT = 2 * 1024 * 1024;

const WORKSPACE_SEARCH_LIMIT = 50;
export const WORKSPACE_SEARCH_MAX_DEPTH = 12;
export const WORKSPACE_SEARCH_MAX_DIRECTORIES = 1000;
export const WORKSPACE_SEARCH_MAX_FILES = 10000;
export const WORKSPACE_SEARCH_TIMEOUT_MS = 1500;
const BINARY_PROBE_BYTES = 8192;

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage']);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.vue': 'vue',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.js': 'text/plain',
  '.jsx': 'text/plain',
  '.mjs': 'text/plain',
  '.cjs': 'text/plain',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.scss': 'text/plain',
  '.less': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.sql': 'text/plain',
  '.sh': 'text/plain',
  '.bash': 'text/plain',
  '.zsh': 'text/plain',
  '.py': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.cc': 'text/plain',
  '.hpp': 'text/plain',
  '.rb': 'text/plain',
  '.php': 'text/plain',
  '.vue': 'text/plain',
};

export type WorkspaceFileErrorCode =
  | 'WORKSPACE_PATH_INVALID'
  | 'WORKSPACE_PATH_ABSOLUTE'
  | 'WORKSPACE_PATH_TRAVERSAL'
  | 'WORKSPACE_PATH_NOT_FOUND'
  | 'WORKSPACE_PATH_NOT_DIRECTORY'
  | 'WORKSPACE_PATH_NOT_FILE'
  | 'WORKSPACE_PATH_SYMLINK'
  | 'WORKSPACE_PATH_OUTSIDE_PROJECT'
  | 'WORKSPACE_PATH_IGNORED'
  | 'WORKSPACE_FILE_BINARY'
  | 'WORKSPACE_FILE_TOO_LARGE'
  | 'WORKSPACE_SEARCH_QUERY_INVALID';

export class WorkspaceFileError extends Error {
  readonly code: WorkspaceFileErrorCode;

  constructor(code: WorkspaceFileErrorCode) {
    super(code);
    this.name = 'WorkspaceFileError';
    this.code = code;
  }
}

export function normalizeWorkspacePath(inputPath: string): string {
  if (typeof inputPath !== 'string') {
    throw workspaceFileError('WORKSPACE_PATH_INVALID');
  }
  const normalizedInput = inputPath.trim();
  if (!normalizedInput || normalizedInput === '.') {
    return '';
  }
  if (normalizedInput.includes('\0')) {
    throw workspaceFileError('WORKSPACE_PATH_INVALID');
  }
  if (isAbsolutePath(normalizedInput)) {
    throw workspaceFileError('WORKSPACE_PATH_ABSOLUTE');
  }

  const posixCandidate = normalizedInput.replaceAll('\\', '/');
  const normalized = posix.normalize(posixCandidate);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw workspaceFileError('WORKSPACE_PATH_TRAVERSAL');
  }

  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..')) {
    throw workspaceFileError('WORKSPACE_PATH_TRAVERSAL');
  }
  return segments.join('/');
}

export async function resolveWorkspacePath(projectPath: string, inputPath = ''): Promise<WorkspacePathResolution> {
  const projectRealPath = await resolveProjectRealPath(projectPath);
  const relativePath = normalizeWorkspacePath(inputPath);
  const segments = relativePath ? relativePath.split('/') : [];
  let absolutePath = projectRealPath;
  let symlinkTargetRelativePath: string | null = null;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    absolutePath = join(absolutePath, segment);

    const entryStats = await readLstatOrThrow(absolutePath);
    if (!entryStats.isSymbolicLink()) continue;
    const isTerminal = index === segments.length - 1;
    if (!isTerminal) {
      throw workspaceFileError('WORKSPACE_PATH_SYMLINK');
    }

    const targetPath = await readSymlinkTargetPathOrThrow(absolutePath, projectRealPath);
    const targetRelativePath = toRelativeProjectPath(projectRealPath, targetPath);
    if (targetRelativePath === null) {
      throw workspaceFileError('WORKSPACE_PATH_OUTSIDE_PROJECT');
    }
    if (isIgnoredWorkspacePath(targetRelativePath)) {
      throw workspaceFileError('WORKSPACE_PATH_IGNORED');
    }

    const targetStats = await readStatOrThrow(absolutePath);
    if (targetStats.isDirectory()) {
      throw workspaceFileError('WORKSPACE_PATH_SYMLINK');
    }
    absolutePath = targetPath;
    symlinkTargetRelativePath = targetRelativePath;
  }

  if (!isSubPath(absolutePath, projectRealPath)) {
    throw workspaceFileError('WORKSPACE_PATH_OUTSIDE_PROJECT');
  }

  return {
    projectRealPath,
    relativePath,
    absolutePath,
    symlinkTargetRelativePath,
  };
}

export function isIgnoredWorkspacePath(inputPath: string): boolean {
  const normalized = normalizeIgnoredPath(inputPath);
  if (!normalized) return false;
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (IGNORED_DIRECTORIES.has(segment)) return true;
  }
  const baseName = segments[segments.length - 1] ?? '';
  return isIgnoredFileName(baseName);
}

export async function listWorkspaceDirectory(projectPath: string, inputPath = ''): Promise<WorkspaceDirectoryEntry[]> {
  const resolved = await resolveWorkspacePath(projectPath, inputPath);
  ensureWorkspacePathAllowed(resolved.relativePath, resolved.symlinkTargetRelativePath);

  const directoryStats = await lstat(resolved.absolutePath);
  if (!directoryStats.isDirectory()) {
    throw workspaceFileError('WORKSPACE_PATH_NOT_DIRECTORY');
  }

  let names: string[];
  try {
    names = await readdir(resolved.absolutePath);
  } catch (error) {
    if (isSkippableFsError(error)) return [];
    throw error;
  }
  names.sort((left, right) => left.localeCompare(right));

  const visibleEntries: WorkspaceDirectoryEntry[] = [];
  for (const name of names) {
    const relativeEntryPath = joinRelativePath(resolved.relativePath, name);
    if (isIgnoredWorkspacePath(relativeEntryPath)) continue;

    const absoluteEntryPath = join(resolved.absolutePath, name);
    let entryStats;
    try {
      entryStats = await lstat(absoluteEntryPath);
    } catch (error) {
      if (isSkippableFsError(error)) continue;
      throw error;
    }

    if (entryStats.isSymbolicLink()) {
      const targetPath = await readSymlinkTargetPathOrNull(absoluteEntryPath, resolved.projectRealPath);
      if (!targetPath) continue;
      const targetRelativePath = toRelativeProjectPath(resolved.projectRealPath, targetPath);
      if (targetRelativePath === null || isIgnoredWorkspacePath(targetRelativePath)) continue;

      let targetStats;
      try {
        targetStats = await stat(absoluteEntryPath);
      } catch (error) {
        if (isSkippableFsError(error)) continue;
        throw error;
      }
      if (targetStats.isDirectory()) continue;

      visibleEntries.push({
        name,
        path: relativeEntryPath,
        type: 'file',
        size: targetStats.size,
        mimeType: inferMimeType(name),
        language: inferLanguage(name),
      });
      continue;
    }

    const isDirectory = entryStats.isDirectory();
    visibleEntries.push({
      name,
      path: relativeEntryPath,
      type: isDirectory ? 'directory' : 'file',
      size: isDirectory ? null : entryStats.size,
      mimeType: isDirectory ? null : inferMimeType(name),
      language: isDirectory ? null : inferLanguage(name),
    });
  }

  visibleEntries.sort(compareWorkspaceEntries);
  return visibleEntries.slice(0, WORKSPACE_DIRECTORY_LIMIT);
}

export async function readWorkspaceFilePreview(projectPath: string, inputPath: string): Promise<WorkspaceFilePreview> {
  const resolved = await resolveWorkspacePath(projectPath, inputPath);
  ensureWorkspacePathAllowed(resolved.relativePath, resolved.symlinkTargetRelativePath);

  const fileHandle = await openWorkspaceFileForRead(resolved.absolutePath);
  try {
    const fileStats = await fileHandle.stat();
    if (!fileStats.isFile()) {
      throw workspaceFileError('WORKSPACE_PATH_NOT_FILE');
    }
    const fileSize = fileStats.size;
    const maxReadSize = Math.min(fileSize, WORKSPACE_PREVIEW_TEXT_LIMIT);
    const contentBuffer = await readHandleBytes(fileHandle, maxReadSize);
    if (!isTextBuffer(contentBuffer)) {
      throw workspaceFileError('WORKSPACE_FILE_BINARY');
    }
    return buildPreviewFromBuffer(resolved.relativePath, fileSize, contentBuffer, WORKSPACE_PREVIEW_TEXT_LIMIT);
  } finally {
    await fileHandle.close();
  }
}

export async function readWorkspaceFileReference(projectPath: string, inputPath: string): Promise<WorkspaceFileReference> {
  const resolved = await resolveWorkspacePath(projectPath, inputPath);
  ensureWorkspacePathAllowed(resolved.relativePath, resolved.symlinkTargetRelativePath);

  const fileHandle = await openWorkspaceFileForRead(resolved.absolutePath);
  try {
    const fileStats = await fileHandle.stat();
    if (!fileStats.isFile()) {
      throw workspaceFileError('WORKSPACE_PATH_NOT_FILE');
    }
    if (fileStats.size > WORKSPACE_REFERENCE_SIZE_LIMIT) {
      throw workspaceFileError('WORKSPACE_FILE_TOO_LARGE');
    }
    const contentBuffer = await readHandleBytes(fileHandle, fileStats.size);
    const isBinary = !isTextBuffer(contentBuffer);
    return {
      path: resolved.relativePath,
      size: fileStats.size,
      mimeType: inferMimeType(resolved.relativePath),
      language: inferLanguage(resolved.relativePath),
      isBinary,
      content: isBinary ? null : contentBuffer.toString('utf-8'),
      truncated: false,
      bytes: contentBuffer,
    };
  } finally {
    await fileHandle.close();
  }
}

export async function searchWorkspaceFiles(
  projectPath: string,
  query: string,
  inputPath = '',
): Promise<WorkspaceSearchResult[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    throw workspaceFileError('WORKSPACE_SEARCH_QUERY_INVALID');
  }

  const resolved = await resolveWorkspacePath(projectPath, inputPath);
  ensureWorkspacePathAllowed(resolved.relativePath, resolved.symlinkTargetRelativePath);

  const rootStats = await lstat(resolved.absolutePath);
  if (!rootStats.isDirectory()) {
    throw workspaceFileError('WORKSPACE_PATH_NOT_DIRECTORY');
  }

  const results: WorkspaceSearchResult[] = [];
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath, depth: 0 },
  ];
  let queueIndex = 0;
  let visitedDirectories = 0;
  let visitedFiles = 0;
  const startedAt = Date.now();

  while (queueIndex < queue.length && results.length < WORKSPACE_SEARCH_LIMIT) {
    if (visitedDirectories >= WORKSPACE_SEARCH_MAX_DIRECTORIES) break;
    if (visitedFiles >= WORKSPACE_SEARCH_MAX_FILES) break;
    if (Date.now() - startedAt >= WORKSPACE_SEARCH_TIMEOUT_MS) break;

    const current = queue[queueIndex];
    queueIndex += 1;
    if (!current) break;
    visitedDirectories += 1;

    let names: string[];
    try {
      names = await readdir(current.absolutePath);
    } catch (error) {
      if (isSkippableFsError(error)) continue;
      throw error;
    }
    names.sort((left, right) => left.localeCompare(right));

    for (const name of names) {
      const relativeEntryPath = joinRelativePath(current.relativePath, name);
      if (isIgnoredWorkspacePath(relativeEntryPath)) continue;

      const absoluteEntryPath = join(current.absolutePath, name);
      let entryStats;
      try {
        entryStats = await lstat(absoluteEntryPath);
      } catch (error) {
        if (isSkippableFsError(error)) continue;
        throw error;
      }

      if (entryStats.isSymbolicLink()) {
        const targetPath = await readSymlinkTargetPathOrNull(absoluteEntryPath, resolved.projectRealPath);
        if (!targetPath) continue;
        const targetRelativePath = toRelativeProjectPath(resolved.projectRealPath, targetPath);
        if (targetRelativePath === null || isIgnoredWorkspacePath(targetRelativePath)) continue;

        let targetStats;
        try {
          targetStats = await stat(absoluteEntryPath);
        } catch (error) {
          if (isSkippableFsError(error)) continue;
          throw error;
        }
        if (!targetStats.isFile()) continue;

        visitedFiles += 1;
        if (visitedFiles > WORKSPACE_SEARCH_MAX_FILES) break;
        if (Date.now() - startedAt >= WORKSPACE_SEARCH_TIMEOUT_MS) break;

        if (name.toLowerCase().includes(normalizedQuery)) {
          results.push({ path: relativeEntryPath, name, type: 'file' });
          if (results.length >= WORKSPACE_SEARCH_LIMIT) break;
        }
        continue;
      }

      if (entryStats.isDirectory()) {
        if (current.depth < WORKSPACE_SEARCH_MAX_DEPTH) {
          queue.push({
            absolutePath: absoluteEntryPath,
            relativePath: relativeEntryPath,
            depth: current.depth + 1,
          });
        }
        continue;
      }

      visitedFiles += 1;
      if (visitedFiles > WORKSPACE_SEARCH_MAX_FILES) break;
      if (Date.now() - startedAt >= WORKSPACE_SEARCH_TIMEOUT_MS) break;

      if (name.toLowerCase().includes(normalizedQuery)) {
        results.push({ path: relativeEntryPath, name, type: 'file' });
        if (results.length >= WORKSPACE_SEARCH_LIMIT) break;
      }
    }
  }

  return results.slice(0, WORKSPACE_SEARCH_LIMIT);
}

function normalizeIgnoredPath(inputPath: string): string {
  if (typeof inputPath !== 'string') return '';
  const trimmed = inputPath.trim();
  if (!trimmed || trimmed === '.') return '';
  return trimmed.replaceAll('\\', '/').replace(/^\/+/, '');
}

function isIgnoredFileName(baseName: string): boolean {
  if (baseName === '.env' || baseName.startsWith('.env.')) return true;
  const lowerBaseName = baseName.toLowerCase();
  return lowerBaseName.endsWith('.pem')
    || lowerBaseName.endsWith('.key')
    || lowerBaseName.endsWith('.sqlite')
    || lowerBaseName.endsWith('.db');
}

function joinRelativePath(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent}/${name}`;
}

function compareWorkspaceEntries(left: WorkspaceDirectoryEntry, right: WorkspaceDirectoryEntry): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function inferLanguage(fileName: string): string | null {
  const extension = inferExtension(fileName);
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

function inferMimeType(fileName: string): string {
  const extension = inferExtension(fileName);
  return MIME_BY_EXTENSION[extension] ?? 'text/plain';
}

function inferExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === lower.length - 1) return '';
  return lower.slice(dotIndex);
}

function isTextBuffer(content: Buffer): boolean {
  if (content.length === 0) return true;
  const probeLength = Math.min(content.length, BINARY_PROBE_BYTES);
  let suspiciousBytes = 0;

  for (let index = 0; index < probeLength; index += 1) {
    const byte = content[index];
    if (typeof byte !== 'number') break;
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte <= 126) continue;
    if (byte >= 160) continue;
    suspiciousBytes += 1;
  }

  return suspiciousBytes / probeLength < 0.3;
}

function buildPreviewFromBuffer(
  relativePath: string,
  fileSize: number,
  content: Buffer,
  maxBytes: number,
): WorkspaceFilePreview {
  return {
    path: relativePath,
    size: fileSize,
    mimeType: inferMimeType(relativePath),
    language: inferLanguage(relativePath),
    content: content.toString('utf-8'),
    truncated: fileSize > maxBytes,
  };
}

async function openWorkspaceFileForRead(filePath: string) {
  const readonly = fsConstants.O_RDONLY;
  const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  const flags = typeof noFollow === 'number' ? readonly | noFollow : readonly;
  try {
    return await open(filePath, flags);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ELOOP') {
      throw workspaceFileError('WORKSPACE_PATH_SYMLINK');
    }
    if (typeof noFollow === 'number' && isNoFollowUnsupportedError(code)) {
      return open(filePath, readonly);
    }
    if (isSkippableFsError(error)) {
      throw workspaceFileError('WORKSPACE_PATH_NOT_FOUND');
    }
    throw error;
  }
}

async function readHandleBytes(fileHandle: Awaited<ReturnType<typeof open>>, byteLength: number): Promise<Buffer> {
  if (byteLength <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const { bytesRead } = await fileHandle.read(buffer, offset, byteLength - offset, offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  return offset === byteLength ? buffer : buffer.subarray(0, offset);
}

function isAbsolutePath(inputPath: string): boolean {
  if (isAbsolute(inputPath)) return true;
  return /^[A-Za-z]:[\\/]/.test(inputPath);
}

function isSubPath(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

function toRelativeProjectPath(projectRealPath: string, targetAbsolutePath: string): string | null {
  if (!isSubPath(targetAbsolutePath, projectRealPath)) return null;
  const rel = relative(projectRealPath, targetAbsolutePath).replaceAll('\\', '/');
  if (!rel || rel === '.') return '';
  return rel;
}

function workspaceFileError(code: WorkspaceFileErrorCode): WorkspaceFileError {
  return new WorkspaceFileError(code);
}

function ensureWorkspacePathAllowed(relativePath: string, symlinkTargetRelativePath: string | null = null): void {
  if (relativePath && isIgnoredWorkspacePath(relativePath)) {
    throw workspaceFileError('WORKSPACE_PATH_IGNORED');
  }
  if (symlinkTargetRelativePath && isIgnoredWorkspacePath(symlinkTargetRelativePath)) {
    throw workspaceFileError('WORKSPACE_PATH_IGNORED');
  }
}

async function readLstatOrThrow(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (isSkippableFsError(error)) {
      throw workspaceFileError('WORKSPACE_PATH_NOT_FOUND');
    }
    throw error;
  }
}

async function readStatOrThrow(targetPath: string) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (isSkippableFsError(error)) {
      throw workspaceFileError('WORKSPACE_PATH_NOT_FOUND');
    }
    throw error;
  }
}

async function readSymlinkTargetPathOrThrow(symlinkPath: string, projectRealPath: string): Promise<string> {
  let targetPath: string;
  try {
    targetPath = await realpath(symlinkPath);
  } catch {
    throw workspaceFileError('WORKSPACE_PATH_SYMLINK');
  }
  if (!isSubPath(targetPath, projectRealPath)) {
    throw workspaceFileError('WORKSPACE_PATH_OUTSIDE_PROJECT');
  }
  return targetPath;
}

async function readSymlinkTargetPathOrNull(symlinkPath: string, projectRealPath: string): Promise<string | null> {
  let targetPath: string;
  try {
    targetPath = await realpath(symlinkPath);
  } catch {
    return null;
  }
  if (!isSubPath(targetPath, projectRealPath)) {
    return null;
  }
  return targetPath;
}

async function resolveProjectRealPath(projectPath: string): Promise<string> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw workspaceFileError('WORKSPACE_PATH_INVALID');
  }
  let projectRealPath: string;
  try {
    projectRealPath = await realpath(projectPath);
  } catch (error) {
    if (isSkippableFsError(error)) {
      throw workspaceFileError('WORKSPACE_PATH_NOT_FOUND');
    }
    throw error;
  }
  const projectStats = await lstat(projectRealPath);
  if (!projectStats.isDirectory()) {
    throw workspaceFileError('WORKSPACE_PATH_NOT_DIRECTORY');
  }
  return projectRealPath;
}

function isSkippableFsError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';
}

function isNoFollowUnsupportedError(code: string | undefined): boolean {
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP';
}
