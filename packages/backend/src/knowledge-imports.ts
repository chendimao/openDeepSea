import { basename } from 'node:path';
import { nanoid } from 'nanoid';
import { rebuildSourceEmbeddings } from './knowledge-embedding.js';
import {
  extractKnowledgeText,
  hashText,
  splitKnowledgeChunks,
  summarizeKnowledgeText,
} from './knowledge-extraction.js';
import type { KnowledgeChunk, KnowledgeExtraction, KnowledgeSource } from './knowledge-types.js';
import { knowledgeRepo } from './repos/knowledge.js';
import { projectRepo } from './repos/projects.js';
import { roomRepo } from './repos/rooms.js';
import { readWorkspaceFilePreview } from './workspace-files.js';

export interface ManualKnowledgeInput {
  projectId: string;
  roomId?: string;
  title: string;
  content: string;
  tags?: string[];
}

export interface UrlKnowledgeInput {
  projectId: string;
  roomId?: string;
  url: string;
  title?: string;
  content?: string;
  tags?: string[];
}

export interface WorkspaceKnowledgeImportInput {
  projectId: string;
  roomId?: string;
  paths: string[];
  tags?: string[];
}

export interface KnowledgeImportResult {
  source: KnowledgeSource;
  extraction: KnowledgeExtraction | null;
  chunks: KnowledgeChunk[];
}

export interface WorkspaceKnowledgeImportResult {
  created: KnowledgeSource[];
  failed: Array<{ path: string; error: string }>;
}

export function createManualKnowledgeSource(input: ManualKnowledgeInput): KnowledgeImportResult {
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title) throw new Error('title is required');
  if (!content) throw new Error('content is required');
  validateProjectRoom(input.projectId, input.roomId);

  return createContentKnowledgeSource({
    projectId: input.projectId,
    roomId: input.roomId,
    sourceType: 'manual',
    sourceId: `manual:${nanoid(12)}`,
    title,
    mimeType: 'text/plain',
    content,
    tags: input.tags,
    metadata: {
      import_type: 'manual',
    },
  });
}

export function createUrlKnowledgeSource(input: UrlKnowledgeInput): KnowledgeImportResult {
  const project = validateProjectRoom(input.projectId, input.roomId);
  const url = parseHttpUrl(input.url);
  const title = input.title?.trim() || deriveUrlTitle(url);
  const tags = input.tags ?? [];
  const content = input.content?.trim();

  if (content) {
    return createContentKnowledgeSource({
      projectId: project.id,
      roomId: input.roomId,
      sourceType: 'url',
      sourceId: url.href,
      title,
      mimeType: 'text/plain',
      uri: url.href,
      content,
      tags,
      metadata: {
        import_type: 'url',
        url: url.href,
        host: url.hostname,
        requires_fetch: false,
      },
    });
  }

  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    room_id: input.roomId,
    source_type: 'url',
    source_id: url.href,
    title,
    uri: url.href,
    status: 'stale',
    content_hash: hashText(url.href),
    parser: 'metadata-only',
    parser_version: '1',
    tags,
    metadata: {
      import_type: 'url',
      url: url.href,
      host: url.hostname,
      requires_fetch: true,
      parser_status: 'metadata_only',
      parser_capabilities: ['metadata'],
      parser_warnings: ['URL content was not fetched by Phase 4A import'],
      requires_sidecar: false,
    },
  });
  return { source, extraction: null, chunks: [] };
}

export async function importWorkspaceDocuments(
  input: WorkspaceKnowledgeImportInput,
): Promise<WorkspaceKnowledgeImportResult> {
  const project = validateProjectRoom(input.projectId, input.roomId);
  const created: KnowledgeSource[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (const path of input.paths) {
    try {
      const preview = await readWorkspaceFilePreview(project.path, path);
      if (preview.truncated) throw new Error('WORKSPACE_FILE_TOO_LARGE');
      const result = createContentKnowledgeSource({
        projectId: project.id,
        roomId: input.roomId,
        sourceType: 'workspace_doc',
        sourceId: preview.path,
        title: basename(preview.path) || preview.path,
        mimeType: preview.mimeType,
        size: preview.size,
        uri: `workspace://${preview.path}`,
        content: preview.content,
        tags: input.tags,
        metadata: {
          import_type: 'workspace_doc',
          workspace_path: preview.path,
          language: preview.language,
          truncated: preview.truncated,
          original_char_count: preview.size,
          indexed_char_count: preview.content.length,
        },
      });
      created.push(result.source);
    } catch (error) {
      failed.push({
        path,
        error: error instanceof Error ? error.message : 'workspace import failed',
      });
    }
  }

  return { created, failed };
}

function createContentKnowledgeSource(input: {
  projectId: string;
  roomId?: string;
  sourceType: 'manual' | 'url' | 'workspace_doc';
  sourceId: string;
  title: string;
  mimeType: string;
  size?: number | null;
  uri?: string | null;
  content: string;
  tags?: string[];
  metadata: Record<string, unknown>;
}): KnowledgeImportResult {
  const extracted = extractKnowledgeText({
    title: input.title,
    mimeType: input.mimeType,
    content: input.content,
  });
  const summary = summarizeKnowledgeText(extracted.plainText, input.title);
  const sourceMetadata = {
    ...input.metadata,
    ...extracted.metadata,
    key_points: summary.keyPoints,
    content_kind: summary.contentKind,
    error: null,
  };

  const source = knowledgeRepo.ensureSource({
    project_id: input.projectId,
    room_id: input.roomId,
    source_type: input.sourceType,
    source_id: input.sourceId,
    title: input.title,
    mime_type: input.mimeType,
    size: input.size ?? Buffer.byteLength(input.content),
    uri: input.uri,
    status: 'ready',
    content_hash: extracted.contentHash,
    parser: extracted.parser,
    parser_version: extracted.parserVersion,
    summary: summary.summary,
    tags: input.tags ?? summary.tags,
    metadata: sourceMetadata,
    error: null,
  });
  const extraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: extracted.plainText,
    markdown: extracted.markdown,
    layout: extracted.layout,
    table: extracted.table,
    image: extracted.image,
    error: null,
    metadata: sourceMetadata,
  });
  const chunks = knowledgeRepo.replaceChunks(source.id, splitKnowledgeChunks({
    title: input.title,
    text: extracted.plainText,
  }).map((chunk) => ({
    ...chunk,
    project_id: input.projectId,
    room_id: input.roomId,
  })));
  rebuildSourceEmbeddings(source.id);

  return {
    source: knowledgeRepo.getSource(source.id)!,
    extraction,
    chunks,
  };
}

function validateProjectRoom(projectId: string, roomId?: string) {
  const project = projectRepo.get(projectId);
  if (!project) throw new Error('project not found');
  if (roomId) {
    const room = roomRepo.get(roomId);
    if (!room) throw new Error('room not found');
    if (room.project_id !== project.id) throw new Error('room does not belong to project');
  }
  return project;
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  url.hash = '';
  return url;
}

function deriveUrlTitle(url: URL): string {
  const pathSegment = url.pathname.split('/').filter(Boolean).at(-1);
  return pathSegment ? `${url.hostname}/${pathSegment}` : url.hostname;
}
