import { hashText } from './knowledge-extraction.js';
import {
  getKnowledgeEmbeddingProvider,
  getKnowledgeEmbeddingRuntime,
  sanitizeEmbeddingProviderError,
  type FetchLike,
} from './knowledge-embedding-provider.js';
import type { KnowledgeChunk, KnowledgeSource } from './knowledge-types.js';
import { db } from './db.js';
import { knowledgeRepo } from './repos/knowledge.js';
import { projectRepo } from './repos/projects.js';

export interface KnowledgeEmbeddingRebuildResult {
  project_id: string;
  source_id?: string;
  provider: string;
  model: string;
  scanned_chunks: number;
  rebuilt_chunks: number;
  skipped_chunks: number;
  failed_chunks: Array<{ chunk_id: string; source_id: string; error: string }>;
}

export interface KnowledgeEmbeddingRebuildInput {
  projectId: string;
  sourceId?: string;
  limit?: number;
  fetchImpl?: FetchLike;
}

export async function rebuildKnowledgeEmbeddings(
  input: KnowledgeEmbeddingRebuildInput,
): Promise<KnowledgeEmbeddingRebuildResult> {
  const project = projectRepo.get(input.projectId);
  if (!project) throw new Error('project not found');

  const sources = listReadySources(project.id, input.sourceId);
  if (sources.length === 0) {
    const runtime = getKnowledgeEmbeddingRuntime();
    return createRebuildResult({
      projectId: project.id,
      sourceId: input.sourceId,
      provider: runtime.provider,
      model: runtime.model,
    });
  }

  const provider = getKnowledgeEmbeddingProvider({ fetchImpl: input.fetchImpl });
  const result = createRebuildResult({
    projectId: project.id,
    sourceId: input.sourceId,
    provider: provider.id,
    model: provider.model,
  });
  const limit = clampRebuildLimit(input.limit);
  let attemptedChunks = 0;

  for (const source of sources) {
    const chunks = knowledgeRepo.listChunks(source.id).filter((chunk) => chunk.enabled === 1);
    for (const chunk of chunks) {
      if (attemptedChunks >= limit) return result;
      result.scanned_chunks += 1;

      const embeddingText = buildEmbeddingText(source, chunk);
      const contentHash = hashText(embeddingText);
      const existing = knowledgeRepo.getChunkEmbedding(chunk.id);
      if (
        existing
        && existing.provider === provider.id
        && existing.model === provider.model
        && existing.content_hash === contentHash
        && (provider.dimensions <= 0 || existing.dimensions === provider.dimensions)
      ) {
        result.skipped_chunks += 1;
        continue;
      }

      try {
        attemptedChunks += 1;
        const vector = await provider.embed(embeddingText);
        knowledgeRepo.upsertChunkEmbedding({
          chunk_id: chunk.id,
          source_id: source.id,
          project_id: source.project_id,
          provider: provider.id,
          model: provider.model,
          dimensions: vector.length,
          vector,
          content_hash: contentHash,
        });
        result.rebuilt_chunks += 1;
      } catch (err) {
        result.failed_chunks.push({
          chunk_id: chunk.id,
          source_id: source.id,
          error: sanitizeEmbeddingProviderError(err, ''),
        });
      }
    }
  }

  return result;
}

function createRebuildResult(input: {
  projectId: string;
  sourceId?: string;
  provider: string;
  model: string;
}): KnowledgeEmbeddingRebuildResult {
  return {
    project_id: input.projectId,
    ...(input.sourceId ? { source_id: input.sourceId } : {}),
    provider: input.provider,
    model: input.model,
    scanned_chunks: 0,
    rebuilt_chunks: 0,
    skipped_chunks: 0,
    failed_chunks: [],
  };
}

function listReadySources(projectId: string, sourceId?: string): KnowledgeSource[] {
  if (sourceId) {
    const source = knowledgeRepo.getSource(sourceId);
    return source && source.project_id === projectId && source.status === 'ready' ? [source] : [];
  }

  const rows = db
    .prepare(
      `SELECT id
       FROM knowledge_sources
       WHERE project_id = ? AND status = 'ready'
       ORDER BY updated_at DESC, id DESC`,
    )
    .all(projectId) as Array<{ id: string }>;
  return rows
    .map((row) => knowledgeRepo.getSource(row.id))
    .filter((source): source is KnowledgeSource => Boolean(source));
}

function buildEmbeddingText(source: KnowledgeSource, chunk: KnowledgeChunk): string {
  return [source.title, chunk.heading, chunk.content].filter(Boolean).join('\n');
}

function clampRebuildLimit(value: number | undefined): number {
  const normalized = Math.trunc(value ?? 100);
  if (!Number.isFinite(normalized)) return 100;
  return Math.max(1, Math.min(500, normalized));
}
