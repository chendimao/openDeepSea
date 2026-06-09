import type {
  KnowledgeChunk,
  KnowledgeRetrievalMode,
  KnowledgeSearchResult,
  KnowledgeSource,
  KnowledgeSourceType,
  KnowledgeStatus,
} from './knowledge-types.js';
import { cosineSimilarity, createLocalHashEmbeddingProvider } from './knowledge-embedding.js';
import { knowledgeRepo } from './repos/knowledge.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const HYBRID_CANDIDATE_LIMIT = 50;

export function searchKnowledge(input: {
  projectId: string;
  roomId?: string;
  query: string;
  mode?: KnowledgeRetrievalMode;
  status?: KnowledgeStatus;
  sourceType?: KnowledgeSourceType;
  limit?: number;
}): KnowledgeSearchResult[] {
  const query = input.query.trim();
  if (!query) return [];
  const mode = input.mode ?? 'keyword';
  if (mode === 'keyword') return keywordSearch({ ...input, query });
  if (mode === 'vector_preview') return vectorSearch({ ...input, query, mode: 'vector_preview' });
  return hybridSearch({ ...input, query });
}

function keywordSearch(input: {
  projectId: string;
  roomId?: string;
  query: string;
  status?: KnowledgeStatus;
  sourceType?: KnowledgeSourceType;
  limit?: number;
}): KnowledgeSearchResult[] {
  return knowledgeRepo.search({
    projectId: input.projectId,
    roomId: input.roomId,
    query: input.query,
    statuses: input.status ? [input.status] : undefined,
    sourceTypes: input.sourceType ? [input.sourceType] : undefined,
    limit: input.limit,
  });
}

function vectorSearch(input: {
  projectId: string;
  roomId?: string;
  query: string;
  mode: Extract<KnowledgeRetrievalMode, 'vector_preview' | 'hybrid'>;
  status?: KnowledgeStatus;
  sourceType?: KnowledgeSourceType;
  limit?: number;
}): KnowledgeSearchResult[] {
  const limit = normalizeLimit(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const provider = createLocalHashEmbeddingProvider();
  const queryVector = provider.embed(input.query);
  const embeddings = knowledgeRepo.listChunkEmbeddings({
    projectId: input.projectId,
    provider: provider.id,
    model: provider.model,
  });
  const results: KnowledgeSearchResult[] = [];

  for (const embedding of embeddings) {
    const source = knowledgeRepo.getSource(embedding.source_id);
    if (!source || !sourceMatches(source, input)) continue;
    const chunk = knowledgeRepo.listChunks(source.id).find((item) => item.id === embedding.chunk_id);
    if (!chunk || chunk.enabled !== 1) continue;
    const vectorScore = Math.max(0, cosineSimilarity(queryVector, embedding.vector));
    if (vectorScore <= 0) continue;
    const ranking = buildRanking({
      query: input.query,
      source,
      keywordScore: undefined,
      vectorScore,
    });
    results.push({
      chunk_id: chunk.id,
      source_id: source.id,
      external_source_id: source.source_id,
      project_id: source.project_id,
      source_type: source.source_type,
      title: source.title,
      tags: source.tags,
      chunk_index: chunk.chunk_index,
      chunk_type: chunk.chunk_type,
      heading: chunk.heading,
      content: chunk.content,
      snippet: buildSnippet(chunk.content),
      score: vectorScore,
      retrieval_mode: input.mode,
      ranking,
      metadata: chunk.metadata,
      citation: {
        source_id: source.id,
        source_type: source.source_type,
        source_title: source.title,
        external_source_id: source.source_id,
        chunk_id: chunk.id,
        chunk_index: chunk.chunk_index,
        heading: chunk.heading,
        room_id: source.room_id,
      },
    });
  }

  return results
    .sort((left, right) => (right.ranking?.finalScore ?? right.score) - (left.ranking?.finalScore ?? left.score))
    .slice(0, limit);
}

function hybridSearch(input: {
  projectId: string;
  roomId?: string;
  query: string;
  status?: KnowledgeStatus;
  sourceType?: KnowledgeSourceType;
  limit?: number;
}): KnowledgeSearchResult[] {
  const limit = normalizeLimit(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const merged = new Map<string, KnowledgeSearchResult>();
  const keywordResults = keywordSearch({ ...input, limit: Math.max(limit, HYBRID_CANDIDATE_LIMIT) });
  keywordResults.forEach((result, index) => {
    const source = knowledgeRepo.getSource(result.source_id);
    const keywordScore = 1 / (index + 1);
    const ranking = buildRanking({
      query: input.query,
      source,
      keywordScore,
      vectorScore: undefined,
    });
    merged.set(result.chunk_id, {
      ...result,
      score: ranking.finalScore,
      retrieval_mode: 'hybrid',
      ranking,
    });
  });

  const vectorResults = vectorSearch({ ...input, mode: 'hybrid', limit: Math.max(limit, HYBRID_CANDIDATE_LIMIT) });
  for (const vectorResult of vectorResults) {
    const existing = merged.get(vectorResult.chunk_id);
    const source = knowledgeRepo.getSource(vectorResult.source_id);
    if (existing) {
      const ranking = buildRanking({
        query: input.query,
        source,
        keywordScore: existing.ranking?.keywordScore,
        vectorScore: vectorResult.ranking?.vectorScore,
      });
      merged.set(existing.chunk_id, {
        ...existing,
        score: ranking.finalScore,
        retrieval_mode: 'hybrid',
        ranking,
      });
    } else {
      merged.set(vectorResult.chunk_id, {
        ...vectorResult,
        retrieval_mode: 'hybrid',
      });
    }
  }

  return [...merged.values()]
    .sort((left, right) => {
      const scoreDelta = (right.ranking?.finalScore ?? right.score) - (left.ranking?.finalScore ?? left.score);
      if (Math.abs(scoreDelta) > 0.000001) return scoreDelta;
      return left.chunk_index - right.chunk_index;
    })
    .slice(0, limit);
}

function sourceMatches(
  source: KnowledgeSource,
  filters: {
    projectId: string;
    roomId?: string;
    status?: KnowledgeStatus;
    sourceType?: KnowledgeSourceType;
  },
): boolean {
  if (source.project_id !== filters.projectId) return false;
  if (filters.roomId && source.room_id !== filters.roomId) return false;
  if (source.status !== (filters.status ?? 'ready')) return false;
  if (filters.sourceType && source.source_type !== filters.sourceType) return false;
  return true;
}

function buildRanking(input: {
  query: string;
  source: KnowledgeSource | undefined;
  keywordScore?: number;
  vectorScore?: number;
}) {
  const terms = getQueryTerms(input.query);
  const titleMatch = matchesAnyTerm(input.source?.title, terms);
  const tagMatch = Boolean(input.source?.tags.some((tag) => matchesAnyTerm(tag, terms)));
  const summaryMatch = matchesAnyTerm(input.source?.summary, terms);
  const recencyBoost = input.source ? calculateRecencyBoost(input.source.updated_at) : 0;
  const finalScore =
    (input.keywordScore ?? 0) * 0.55 +
    (input.vectorScore ?? 0) * 0.35 +
    (titleMatch ? 0.08 : 0) +
    (tagMatch ? 0.05 : 0) +
    (summaryMatch ? 0.05 : 0) +
    recencyBoost;
  return {
    ...(input.keywordScore === undefined ? {} : { keywordScore: roundScore(input.keywordScore) }),
    ...(input.vectorScore === undefined ? {} : { vectorScore: roundScore(input.vectorScore) }),
    titleMatch,
    tagMatch,
    summaryMatch,
    recencyBoost: roundScore(recencyBoost),
    finalScore: roundScore(finalScore),
  };
}

function calculateRecencyBoost(updatedAt: number): number {
  const ageMs = Math.max(0, Date.now() - updatedAt);
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(0, 0.05 - (ageMs / dayMs) * 0.001);
}

function getQueryTerms(query: string): string[] {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((term) => term.toLowerCase());
}

function matchesAnyTerm(value: string | null | undefined, terms: string[]): boolean {
  const normalized = value?.toLowerCase() ?? '';
  return terms.some((term) => normalized.includes(term));
}

function buildSnippet(content: string): string {
  return content.length <= 240 ? content : `${content.slice(0, 237)}...`;
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value as number), max));
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}
