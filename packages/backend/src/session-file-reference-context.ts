import { lstat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileRepo } from './repos/files.js';
import type { Project, ProjectFile } from './types.js';
import {
  isIgnoredWorkspacePath,
  normalizeWorkspacePath,
  readWorkspaceFilePreview,
  resolveWorkspacePath,
} from './workspace-files.js';

const MAX_WORKSPACE_FILE_CHARS = 24 * 1024;
const MAX_WORKSPACE_TOTAL_CHARS = 64 * 1024;
const MAX_AGENT_DOCUMENT_CHARS = 16 * 1024;
const MAX_LIBRARY_TOTAL_CHARS = 32 * 1024;
const MAX_SESSION_FILE_REFS = 12;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

export interface SessionFileReferenceContext {
  promptAddition: string;
  imagePaths: string[];
}

export async function buildSessionFileReferenceContext(input: {
  project: Project;
  workspacePath: string;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
}): Promise<SessionFileReferenceContext> {
  const blocks: string[] = [];
  const imagePaths: string[] = [];
  let workspaceBudget = MAX_WORKSPACE_TOTAL_CHARS;
  let libraryBudget = MAX_LIBRARY_TOTAL_CHARS;

  for (const ref of normalizeRefList(input.workspaceFileRefs)) {
    let safePath: string;
    try {
      safePath = normalizeWorkspacePath(ref);
    } catch {
      continue;
    }
    if (!safePath || isIgnoredWorkspacePath(safePath)) continue;

    if (isImagePath(safePath)) {
      const imagePath = await resolveWorkspaceImagePath(input.workspacePath, safePath);
      if (imagePath) imagePaths.push(imagePath);
      blocks.push(renderMetadataBlock(`Source Metadata: ${safePath}`, [
        'Image file passed as image path when supported.',
        'Content not auto-injected.',
      ]));
      continue;
    }

    if (workspaceBudget <= 0) {
      blocks.push(renderMetadataBlock(`Source Metadata: ${safePath}`, [
        'Content omitted because workspace reference budget is exhausted.',
      ]));
      continue;
    }

    try {
      const preview = await readWorkspaceFilePreview(input.workspacePath, safePath);
      const limit = Math.min(MAX_WORKSPACE_FILE_CHARS, workspaceBudget);
      const content = preview.content.slice(0, limit);
      const truncated = preview.truncated || preview.content.length > limit;
      workspaceBudget -= content.length;
      blocks.push(renderContentBlock(`Source: ${safePath}`, content, truncated));
    } catch {
      blocks.push(renderMetadataBlock(`Source Metadata: ${safePath}`, ['Content not auto-injected.']));
    }
  }

  for (const ref of normalizeRefList(input.libraryFileRefs)) {
    const file = fileRepo.get(ref);
    if (!file || file.project_id !== input.project.id || file.deleted_at !== null) continue;
    if (file.source_type === 'agent_document' && file.content && libraryBudget > 0) {
      const limit = Math.min(MAX_AGENT_DOCUMENT_CHARS, libraryBudget);
      const content = file.content.slice(0, limit);
      const truncated = file.content.length > limit;
      libraryBudget -= content.length;
      blocks.push(renderContentBlock(`Library: ${file.original_name}`, content, truncated));
      continue;
    }
    blocks.push(renderLibraryMetadataBlock(file));
  }

  return {
    promptAddition: blocks.length > 0 ? ['## Referenced Files', ...blocks].join('\n\n') : '',
    imagePaths: [...new Set(imagePaths)],
  };
}

function normalizeRefList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, MAX_SESSION_FILE_REFS);
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function resolveWorkspaceImagePath(projectPath: string, safePath: string): Promise<string | null> {
  try {
    const resolved = await resolveWorkspacePath(projectPath, safePath);
    const stats = await lstat(resolved.absolutePath);
    return stats.isFile() ? resolved.absolutePath : null;
  } catch {
    return null;
  }
}

function renderContentBlock(title: string, content: string, truncated: boolean): string {
  const suffix = truncated ? '\n...(truncated)' : '';
  return [`### ${title}`, '```', `${content}${suffix}`, '```'].join('\n');
}

function renderMetadataBlock(title: string, lines: string[]): string {
  return [`### ${title}`, ...lines.map((line) => `- ${line}`)].join('\n');
}

function renderLibraryMetadataBlock(file: ProjectFile): string {
  return renderMetadataBlock(`Library Metadata: ${file.original_name}`, [
    `MIME: ${file.mime_type}`,
    `Size: ${file.size}`,
    `Source type: ${file.source_type}`,
    `URL: ${file.url || '(none)'}`,
    'Content not auto-injected.',
  ]);
}
