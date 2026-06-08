import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileRepo } from './repos/files.js';
import { knowledgeRepo } from './repos/knowledge.js';
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
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

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
    const knowledgeBlock = renderKnowledgeReferenceBlock(input.project.id, file, libraryBudget);
    if (knowledgeBlock) {
      libraryBudget -= knowledgeBlock.usedChars;
      blocks.push(knowledgeBlock.block);
      continue;
    }
    if (file.source_type === 'agent_document' && file.content && libraryBudget > 0) {
      const limit = Math.min(MAX_AGENT_DOCUMENT_CHARS, libraryBudget);
      const content = file.content.slice(0, limit);
      const truncated = file.content.length > limit;
      libraryBudget -= content.length;
      blocks.push(renderContentBlock(`Library: ${file.original_name}`, content, truncated));
      continue;
    }
    if (file.source_type === 'uploaded_file') {
      if (isImageFile(file)) {
        const imagePath = await resolveUploadedFilePath(file);
        if (imagePath) imagePaths.push(imagePath);
        blocks.push(renderMetadataBlock(`Library Metadata: ${file.original_name}`, [
          'Image file passed as image path when supported.',
          `MIME: ${file.mime_type}`,
          `Size: ${file.size}`,
        ]));
        continue;
      }
      if (isTextFile(file) && libraryBudget > 0) {
        const content = await readUploadedTextFile(file, libraryBudget);
        if (content) {
          libraryBudget -= content.content.length;
          blocks.push(renderContentBlock(`Library: ${file.original_name}`, content.content, content.truncated));
          continue;
        }
      }
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

function isImageFile(file: ProjectFile): boolean {
  return file.mime_type.startsWith('image/') || isImagePath(file.original_name) || isImagePath(file.storage_path);
}

function isTextFile(file: ProjectFile): boolean {
  const mimeType = file.mime_type.toLowerCase();
  return mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('yaml') ||
    TEXT_EXTENSIONS.has(extname(file.original_name).toLowerCase()) ||
    TEXT_EXTENSIONS.has(extname(file.storage_path ?? '').toLowerCase());
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

async function resolveUploadedFilePath(file: ProjectFile): Promise<string | null> {
  if (!file.storage_path) return null;
  try {
    const stats = await lstat(file.storage_path);
    if (!stats.isFile()) return null;
    return realpath(file.storage_path);
  } catch {
    return null;
  }
}

async function readUploadedTextFile(
  file: ProjectFile,
  budget: number,
): Promise<{ content: string; truncated: boolean } | null> {
  if (!file.storage_path || budget <= 0) return null;
  try {
    const stats = await lstat(file.storage_path);
    if (!stats.isFile()) return null;
    const raw = await readFile(file.storage_path, 'utf8');
    const limit = Math.min(MAX_AGENT_DOCUMENT_CHARS, budget);
    const content = raw.slice(0, limit);
    return {
      content,
      truncated: raw.length > limit,
    };
  } catch {
    return null;
  }
}

function renderContentBlock(title: string, content: string, truncated: boolean): string {
  const suffix = truncated ? '\n...(truncated)' : '';
  return [`### ${title}`, '```', `${content}${suffix}`, '```'].join('\n');
}

function renderKnowledgeReferenceBlock(
  projectId: string,
  file: ProjectFile,
  budget: number,
): { block: string; usedChars: number } | null {
  if (budget <= 0) return null;
  const sourceType = file.source_type === 'agent_document' ? 'agent_document' : 'uploaded_file';
  const source = knowledgeRepo.listSources({
    projectId,
    sourceTypes: [sourceType],
    query: file.id,
    limit: 20,
  }).find((item) => item.source_id === file.id);
  if (!source || source.status !== 'ready') return null;

  const chunks = knowledgeRepo.listChunks(source.id).filter((chunk) => chunk.enabled === 1);
  if (chunks.length > 0) {
    const renderedChunks: string[] = [];
    let usedChars = 0;
    for (const chunk of chunks.slice(0, 8)) {
      if (usedChars >= budget) break;
      const limit = Math.min(chunk.content.length, budget - usedChars);
      const content = chunk.content.slice(0, limit);
      usedChars += content.length;
      renderedChunks.push([
        `#### chunk_id: ${chunk.id}`,
        `chunk_index: ${chunk.chunk_index}`,
        `truncated: ${chunk.content.length > limit ? 'true' : 'false'}`,
        '```',
        content,
        '```',
      ].join('\n'));
    }
    if (renderedChunks.length === 0) return null;
    return {
      usedChars,
      block: [
        `### Knowledge: ${source.title}`,
        `source_id: ${source.id}`,
        `source_type: ${source.source_type}`,
        `citation_key: knowledge:${source.id}`,
        ...renderedChunks,
      ].join('\n'),
    };
  }

  const extraction = knowledgeRepo.getLatestExtraction(source.id);
  if (!extraction?.plain_text) return null;
  const content = extraction.plain_text.slice(0, budget);
  return {
    usedChars: content.length,
    block: [
      `### Knowledge: ${source.title}`,
      `source_id: ${source.id}`,
      `extraction_id: ${extraction.id}`,
      `source_type: ${source.source_type}`,
      `truncated: ${extraction.plain_text.length > content.length ? 'true' : 'false'}`,
      `citation_key: knowledge:${source.id}`,
      '```',
      content,
      '```',
    ].join('\n'),
  };
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
