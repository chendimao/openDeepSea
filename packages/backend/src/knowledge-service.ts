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
import { searchKnowledge } from './knowledge-search.js';
import { fileRepo } from './repos/files.js';
import { knowledgeRepo } from './repos/knowledge.js';
import { projectRepo } from './repos/projects.js';
import { roomRepo } from './repos/rooms.js';
import type {
  KnowledgeExtractionResponse,
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
  }): KnowledgeSearchResult[] {
    return searchKnowledge({
      projectId: input.projectId,
      roomId: input.roomId,
      query: input.query,
      status: input.status,
      sourceType: input.sourceType,
      mode: input.mode,
      limit: input.limit,
    });
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
  }): KnowledgeSource | undefined {
    const source = knowledgeRepo.getSource(sourceId);
    if (!source) return undefined;

    const explicitEnabled = normalizeEnabled(input.enabled);
    if (input.status === 'disabled' || explicitEnabled === 0) {
      knowledgeRepo.setChunksEnabled(source.id, 0);
      return knowledgeRepo.updateSourceStatus(source.id, {
        status: 'disabled',
        tags: input.tags,
        summary: input.summary,
        metadata: {
          ...source.metadata,
          previous_status: source.status,
        },
      });
    }

    if (input.status === 'ready' || explicitEnabled === 1) {
      knowledgeRepo.setChunksEnabled(source.id, 1);
      return knowledgeRepo.updateSourceStatus(source.id, {
        status: input.status === 'ready' ? 'ready' : getRestoredStatus(source),
        error: null,
        tags: input.tags,
        summary: input.summary,
        metadata: {
          ...source.metadata,
          previous_status: null,
        },
      });
    }

    return knowledgeRepo.updateSourceStatus(source.id, {
      status: input.status ?? source.status,
      tags: input.tags,
      summary: input.summary,
    });
  },

  deleteSource(sourceId: string): boolean {
    return knowledgeRepo.deleteSource(sourceId);
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

function getRestoredStatus(source: KnowledgeSource): 'ready' | 'stale' {
  const previousStatus = source.metadata.previous_status;
  if (previousStatus === 'ready' || previousStatus === 'stale') return previousStatus;
  return knowledgeRepo.listChunks(source.id).some((chunk) => chunk.enabled === 1) ? 'ready' : 'stale';
}
