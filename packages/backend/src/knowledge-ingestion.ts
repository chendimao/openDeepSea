import { readFile } from 'node:fs/promises';
import type { ProjectFile } from './types.js';
import { knowledgeRepo } from './repos/knowledge.js';
import {
  extractKnowledgeText,
  hashText,
  splitKnowledgeChunks,
  summarizeKnowledgeText,
} from './knowledge-extraction.js';

type KnowledgeSourceResult = ReturnType<typeof knowledgeRepo.getSource> extends infer T ? NonNullable<T> : never;

const MAX_KNOWLEDGE_TEXT_CHARS = 200_000;

interface ProjectFileContent {
  content: string | null;
  metadata: Record<string, unknown>;
}

export async function ingestProjectFileIntoKnowledge(file: ProjectFile): Promise<KnowledgeSourceResult> {
  const sourceType = file.source_type === 'agent_document' ? 'agent_document' : 'uploaded_file';
  const sourceMetadata = buildSourceMetadata(file);
  let source = knowledgeRepo.ensureSource({
    project_id: file.project_id,
    room_id: file.source_room_id,
    source_type: sourceType,
    source_id: file.id,
    title: file.original_name,
    mime_type: file.mime_type,
    size: file.size,
    status: 'processing',
    content_hash: hashText(`${file.id}:${file.original_name}:${file.mime_type}:${file.size}`),
    parser: null,
    parser_version: null,
    summary: null,
    tags: [],
    metadata: sourceMetadata,
  });

  try {
    const rawContent = await readProjectFileContent(file);
    const extracted = await extractKnowledgeText({
      title: file.original_name,
      mimeType: file.mime_type,
      content: rawContent.content,
    });
    source = knowledgeRepo.ensureSource({
      project_id: file.project_id,
      room_id: file.source_room_id,
      source_type: sourceType,
      source_id: file.id,
      title: file.original_name,
      mime_type: file.mime_type,
      size: file.size,
      status: 'processing',
      content_hash: extracted.contentHash,
      parser: extracted.parser,
      parser_version: extracted.parserVersion,
      summary: null,
      tags: [],
      metadata: mergeMetadata(sourceMetadata, rawContent.metadata),
    });
    knowledgeRepo.saveExtraction({
      source_id: source.id,
      plain_text: extracted.plainText,
      markdown: extracted.markdown,
      layout: extracted.layout,
      table: extracted.table,
      image: extracted.image,
      error: null,
      metadata: rawContent.metadata,
    });

    const summary = summarizeKnowledgeText(extracted.plainText, file.original_name);
    const chunks = splitKnowledgeChunks({ title: file.original_name, text: extracted.plainText });
    knowledgeRepo.replaceChunks(source.id, chunks.map((chunk) => ({
      ...chunk,
      project_id: file.project_id,
      room_id: file.source_room_id,
    })));
    knowledgeRepo.updateSourceStatus(source.id, {
      status: 'ready',
      summary: summary.summary,
      tags: summary.tags,
      error: null,
      metadata: mergeMetadata(source.metadata, sourceMetadata, rawContent.metadata, {
        key_points: summary.keyPoints,
        content_kind: summary.contentKind,
        error: null,
      }),
      last_processed_at: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'knowledge ingestion failed';
    knowledgeRepo.saveExtraction({
      source_id: source.id,
      error: message,
    });
    knowledgeRepo.clearChunks(source.id);
    knowledgeRepo.updateSourceStatus(source.id, {
      status: 'failed',
      error: message,
      metadata: mergeMetadata(source.metadata, sourceMetadata, { error: message }),
      last_processed_at: Date.now(),
    });
  }

  return knowledgeRepo.getSource(source.id)!;
}

async function readProjectFileContent(file: ProjectFile): Promise<ProjectFileContent> {
  if (file.source_type === 'agent_document') {
    if (file.content === null) throw new Error('agent document content is missing');
    return limitProjectFileContent(file.content);
  }
  if (!isTextLikeFile(file) || !file.storage_path) return { content: null, metadata: {} };
  return limitProjectFileContent(await readFile(file.storage_path, 'utf8'));
}

function limitProjectFileContent(content: string): ProjectFileContent {
  if (content.length <= MAX_KNOWLEDGE_TEXT_CHARS) return { content, metadata: {} };
  return {
    content: content.slice(0, MAX_KNOWLEDGE_TEXT_CHARS),
    metadata: {
      truncated: true,
      original_char_count: content.length,
      indexed_char_count: MAX_KNOWLEDGE_TEXT_CHARS,
      max_indexed_char_count: MAX_KNOWLEDGE_TEXT_CHARS,
    },
  };
}

function buildSourceMetadata(file: ProjectFile): Record<string, unknown> {
  return {
    file_id: file.id,
    source_label: file.source_label,
    source_agent_id: file.source_agent_id,
    source_task_id: file.source_task_id,
  };
}

function mergeMetadata(...values: Array<Record<string, unknown>>): Record<string, unknown> {
  return Object.assign({}, ...values);
}

function isTextLikeFile(file: ProjectFile): boolean {
  const mimeType = file.mime_type.toLowerCase();
  return mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('yaml') ||
    mimeType.includes('csv') ||
    /\.(txt|md|markdown|json|csv|yaml|yml|xml)$/i.test(file.original_name);
}
