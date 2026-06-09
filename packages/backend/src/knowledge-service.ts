import { db } from './db.js';
import { hashKnowledgeEmbeddingText } from './knowledge-embedding.js';
import { ingestProjectFileIntoKnowledge } from './knowledge-ingestion.js';
import {
  createManualKnowledgeSource,
  createUrlKnowledgeSource,
  importWorkspaceDocuments as importWorkspaceDocumentsIntoKnowledge,
  type KnowledgeImportResult,
  type ManualKnowledgeInput,
  type UrlKnowledgeInput,
  type WorkspaceKnowledgeImportInput,
  type WorkspaceKnowledgeImportResult,
} from './knowledge-imports.js';
import {
  getKnowledgeInsights,
  patchKnowledgeSourceMetadata,
} from './knowledge-governance.js';
import {
  getKnowledgeEmbeddingRuntime,
  testKnowledgeEmbeddingProvider,
  type KnowledgeEmbeddingRuntime,
} from './knowledge-embedding-provider.js';
import {
  rebuildKnowledgeEmbeddings,
  type KnowledgeEmbeddingRebuildResult,
} from './knowledge-embedding-rebuild.js';
import { searchKnowledgeAsync } from './knowledge-search.js';
import { fileRepo } from './repos/files.js';
import { knowledgeRepo } from './repos/knowledge.js';
import { projectRepo } from './repos/projects.js';
import { roomRepo } from './repos/rooms.js';
import type {
  KnowledgeExtractionResponse,
  KnowledgeInsights,
  KnowledgeMetadataPatch,
  KnowledgeRetrievalMode,
  KnowledgeSearchResult,
  KnowledgeSource,
  KnowledgeSourceDetail,
  KnowledgeSourceType,
  KnowledgeStatus,
} from './knowledge-types.js';
import type { ProjectFile } from './types.js';

const MAX_EXTRACTION_RESPONSE_CHARS = 80_000;

export const knowledgeService = {
  getDetail(sourceId: string): KnowledgeSourceDetail | undefined {
    const source = knowledgeRepo.getSource(sourceId);
    if (!source) return undefined;

    const project = projectRepo.get(source.project_id);
    const room = source.room_id ? roomRepo.get(source.room_id) : undefined;
    const latestExtraction = knowledgeRepo.getLatestExtraction(source.id);
    const chunks = knowledgeRepo.listChunks(source.id);
    const originalFile = getOriginalFile(source);

    return {
      ...source,
      project_name: project?.name ?? null,
      room_name: room?.name ?? null,
      chunk_count: chunks.length,
      latest_extraction_id: latestExtraction?.id ?? null,
      latest_extraction_at: latestExtraction?.created_at ?? null,
      reference_count: knowledgeRepo.countUsageRefs(source.id),
      original_file: originalFile
        ? {
            id: originalFile.id,
            name: originalFile.original_name,
            url: originalFile.url,
            storage_path: originalFile.storage_path ?? '',
            source_type: originalFile.source_type,
          }
        : null,
      capabilities: {
        preview: Boolean(originalFile?.url || source.source_type === 'agent_document'),
        download: Boolean(originalFile?.url && source.source_type === 'uploaded_file'),
        reprocess: Boolean(originalFile),
        disable: source.status !== 'disabled',
        delete: true,
      },
    };
  },

  getExtraction(sourceId: string): KnowledgeExtractionResponse | undefined {
    const extraction = knowledgeRepo.getLatestExtraction(sourceId);
    if (!extraction) return undefined;

    const originalPlainText = extraction.plain_text ?? '';
    const originalMarkdown = extraction.markdown ?? null;
    const plainText = originalPlainText.slice(0, MAX_EXTRACTION_RESPONSE_CHARS);
    const markdown = originalMarkdown && originalMarkdown.length > MAX_EXTRACTION_RESPONSE_CHARS
      ? originalMarkdown.slice(0, MAX_EXTRACTION_RESPONSE_CHARS)
      : originalMarkdown;

    return {
      ...extraction,
      plain_text: plainText,
      markdown,
      truncated: originalPlainText.length > MAX_EXTRACTION_RESPONSE_CHARS ||
        (originalMarkdown?.length ?? 0) > MAX_EXTRACTION_RESPONSE_CHARS ||
        extraction.metadata.truncated === true,
      returned_char_count: plainText.length,
      original_char_count: numberMetadata(extraction.metadata.original_char_count) ?? originalPlainText.length,
    };
  },

  search(input: {
    projectId: string;
    roomId?: string;
    query: string;
    status?: KnowledgeStatus;
    sourceType?: KnowledgeSourceType;
    mode?: KnowledgeRetrievalMode;
    limit?: number;
  }): Promise<KnowledgeSearchResult[]> {
    return searchKnowledgeAsync({
      projectId: input.projectId,
      roomId: input.roomId,
      query: input.query,
      status: input.status,
      sourceType: input.sourceType,
      mode: input.mode,
      limit: input.limit,
    });
  },

  getEmbeddingStatus(input: { projectId?: string }) {
    return getKnowledgeEmbeddingStatus(input);
  },

  testEmbeddingProvider() {
    return testKnowledgeEmbeddingProvider();
  },

  rebuildEmbeddings(input: {
    projectId: string;
    sourceId?: string;
    limit?: number;
  }): Promise<KnowledgeEmbeddingRebuildResult> {
    validateKnowledgeEmbeddingRebuildScope(input);
    return rebuildKnowledgeEmbeddings(input);
  },

  async reprocess(sourceId: string): Promise<KnowledgeSource | undefined> {
    const source = knowledgeRepo.getSource(sourceId);
    if (!source) return undefined;

    const originalFile = getOriginalFile(source);
    if (!originalFile) {
      return knowledgeRepo.updateSourceStatus(source.id, {
        status: 'failed',
        error: 'original resource is missing',
        metadata: {
          ...source.metadata,
          error: 'original resource is missing',
        },
        last_processed_at: Date.now(),
      });
    }

    return ingestProjectFileIntoKnowledge(originalFile);
  },

  updateStatus(sourceId: string, input: {
    status?: 'ready' | 'disabled' | 'stale';
    enabled?: 0 | 1 | boolean;
    tags?: string[];
    summary?: string | null;
    metadataPatch?: KnowledgeMetadataPatch;
  }): KnowledgeSource | undefined {
    const source = knowledgeRepo.getSource(sourceId);
    if (!source) return undefined;

    const explicitEnabled = normalizeEnabled(input.enabled);
    if (input.status === 'disabled' || explicitEnabled === 0) {
      knowledgeRepo.setChunksEnabled(source.id, 0);
      const updated = knowledgeRepo.updateSourceStatus(source.id, {
        status: 'disabled',
        tags: input.tags,
        summary: input.summary,
        metadata: {
          ...source.metadata,
          previous_status: source.status,
        },
      });
      return applyMetadataPatchIfPresent(updated, input.metadataPatch);
    }

    if (input.status === 'ready' || explicitEnabled === 1) {
      knowledgeRepo.setChunksEnabled(source.id, 1);
      const updated = knowledgeRepo.updateSourceStatus(source.id, {
        status: input.status === 'ready' ? 'ready' : getRestoredStatus(source),
        error: null,
        tags: input.tags,
        summary: input.summary,
        metadata: {
          ...source.metadata,
          previous_status: null,
        },
      });
      return applyMetadataPatchIfPresent(updated, input.metadataPatch);
    }

    const updated = knowledgeRepo.updateSourceStatus(source.id, {
      status: input.status ?? source.status,
      tags: input.tags,
      summary: input.summary,
    });
    return applyMetadataPatchIfPresent(updated, input.metadataPatch);
  },

  deleteSource(sourceId: string): boolean {
    return knowledgeRepo.deleteSource(sourceId);
  },

  getInsights(input: { projectId: string; roomId?: string }): KnowledgeInsights {
    return getKnowledgeInsights(input);
  },

  createManualKnowledge(input: ManualKnowledgeInput): KnowledgeImportResult {
    return createManualKnowledgeSource(input);
  },

  createUrlKnowledge(input: UrlKnowledgeInput): KnowledgeImportResult {
    return createUrlKnowledgeSource(input);
  },

  importWorkspaceDocuments(input: WorkspaceKnowledgeImportInput): Promise<WorkspaceKnowledgeImportResult> {
    return importWorkspaceDocumentsIntoKnowledge(input);
  },
};

interface KnowledgeEmbeddingStatusChunkRow {
  source_id: string;
  source_title: string;
  chunk_id: string;
  heading: string | null;
  content: string;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding_content_hash: string | null;
}

interface KnowledgeEmbeddingStatus {
  runtime: KnowledgeEmbeddingRuntime;
  project_id?: string;
  total_enabled_chunks: number;
  embedded_chunks: number;
  stale_chunks: number;
  missing_chunks: number;
  failed_sources: number;
}

function getKnowledgeEmbeddingStatus(input: { projectId?: string }): KnowledgeEmbeddingStatus {
  if (input.projectId !== undefined && !projectRepo.get(input.projectId)) {
    throw new Error('project not found');
  }

  const runtime = getKnowledgeEmbeddingRuntime();
  const projectFilter = input.projectId !== undefined ? 'AND knowledge_sources.project_id = @projectId' : '';
  const params = input.projectId !== undefined ? { projectId: input.projectId } : {};
  const rows = db
    .prepare(
      `SELECT
         knowledge_sources.id AS source_id,
         knowledge_sources.title AS source_title,
         knowledge_chunks.id AS chunk_id,
         knowledge_chunks.heading AS heading,
         knowledge_chunks.content AS content,
         knowledge_chunk_embeddings.provider AS embedding_provider,
         knowledge_chunk_embeddings.model AS embedding_model,
         knowledge_chunk_embeddings.dimensions AS embedding_dimensions,
         knowledge_chunk_embeddings.content_hash AS embedding_content_hash
       FROM knowledge_chunks
       JOIN knowledge_sources ON knowledge_sources.id = knowledge_chunks.source_id
       LEFT JOIN knowledge_chunk_embeddings ON knowledge_chunk_embeddings.chunk_id = knowledge_chunks.id
       WHERE knowledge_chunks.enabled = 1
         AND knowledge_sources.status = 'ready'
         ${projectFilter}`,
    )
    .all(params) as KnowledgeEmbeddingStatusChunkRow[];
  const failedSourcesRow = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM knowledge_sources
       WHERE status = 'failed'
       ${input.projectId !== undefined ? 'AND project_id = @projectId' : ''}`,
    )
    .get(params) as { count: number } | undefined;
  let embeddedChunks = 0;
  let missingChunks = 0;
  let staleChunks = 0;

  for (const row of rows) {
    if (!row.embedding_provider) {
      missingChunks += 1;
      continue;
    }
    const contentHash = hashKnowledgeEmbeddingText(row.source_title, row);
    const fresh =
      row.embedding_provider === runtime.provider &&
      row.embedding_model === runtime.model &&
      row.embedding_content_hash === contentHash &&
      (runtime.dimensions === null || row.embedding_dimensions === runtime.dimensions);
    if (fresh) {
      embeddedChunks += 1;
    } else {
      staleChunks += 1;
    }
  }

  return {
    runtime,
    ...(input.projectId !== undefined ? { project_id: input.projectId } : {}),
    total_enabled_chunks: rows.length,
    embedded_chunks: embeddedChunks,
    stale_chunks: staleChunks,
    missing_chunks: missingChunks,
    failed_sources: failedSourcesRow?.count ?? 0,
  };
}

function validateKnowledgeEmbeddingRebuildScope(input: { projectId: string; sourceId?: string }): void {
  if (input.sourceId === undefined) return;
  const source = knowledgeRepo.getSource(input.sourceId);
  if (!source || source.project_id !== input.projectId) {
    throw new Error('knowledge source not found');
  }
  if (source.status !== 'ready') {
    throw new Error('knowledge source is not ready');
  }
}

function getOriginalFile(source: KnowledgeSource): ProjectFile | null {
  if (source.source_type === 'uploaded_file' || source.source_type === 'agent_document') {
    const direct = fileRepo.get(source.source_id);
    if (direct) return direct;
  }

  if (source.source_type === 'agent_document' && !source.source_id.startsWith('asset:')) {
    const assetFile = fileRepo.get(`asset:${source.source_id}`);
    if (assetFile) return assetFile;
  }

  const fileId = typeof source.metadata.file_id === 'string' ? source.metadata.file_id : null;
  return fileId ? fileRepo.get(fileId) ?? null : null;
}

function numberMetadata(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeEnabled(value: 0 | 1 | boolean | undefined): 0 | 1 | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 1 ? 1 : 0;
}

function applyMetadataPatchIfPresent(
  source: KnowledgeSource | undefined,
  metadataPatch: KnowledgeMetadataPatch | undefined,
): KnowledgeSource | undefined {
  if (!source || !metadataPatch) return source;
  return patchKnowledgeSourceMetadata(source.id, metadataPatch);
}

function getRestoredStatus(source: KnowledgeSource): 'ready' | 'stale' {
  const previousStatus = source.metadata.previous_status;
  if (previousStatus === 'ready' || previousStatus === 'stale') return previousStatus;
  return knowledgeRepo.listChunks(source.id).some((chunk) => chunk.enabled === 1) ? 'ready' : 'stale';
}
