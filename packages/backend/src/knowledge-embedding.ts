import { createHash } from 'node:crypto';
import type { KnowledgeChunk } from './knowledge-types.js';
import { hashText } from './knowledge-extraction.js';
import { knowledgeRepo } from './repos/knowledge.js';

export interface KnowledgeEmbeddingProvider {
  id: string;
  model: string;
  dimensions: number;
  embed(text: string): number[];
}

export function createLocalHashEmbeddingProvider(input: { dimensions?: number } = {}): KnowledgeEmbeddingProvider {
  const dimensions = Math.max(8, Math.trunc(input.dimensions ?? 256));
  return {
    id: 'local-hash',
    model: 'local-hash-v1',
    dimensions,
    embed(text: string): number[] {
      const vector = new Array<number>(dimensions).fill(0);
      for (const token of tokenizeEmbeddingText(text)) {
        const digest = createHash('sha256').update(token).digest();
        const index = digest.readUInt16BE(0) % dimensions;
        vector[index] += 1;
      }
      return normalizeVector(vector);
    },
  };
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function rebuildSourceEmbeddings(
  sourceId: string,
  provider: KnowledgeEmbeddingProvider = createLocalHashEmbeddingProvider(),
): number {
  const source = knowledgeRepo.getSource(sourceId);
  if (!source) throw new Error('knowledge source not found');
  const chunks = knowledgeRepo.listChunks(source.id).filter((chunk) => chunk.enabled === 1);
  for (const chunk of chunks) {
    knowledgeRepo.upsertChunkEmbedding({
      chunk_id: chunk.id,
      source_id: source.id,
      project_id: source.project_id,
      provider: provider.id,
      model: provider.model,
      dimensions: provider.dimensions,
      vector: provider.embed(buildEmbeddingText(source.title, chunk)),
      content_hash: hashText(chunk.content),
    });
  }
  return chunks.length;
}

function buildEmbeddingText(sourceTitle: string, chunk: KnowledgeChunk): string {
  return [sourceTitle, chunk.heading, chunk.content].filter(Boolean).join('\n');
}

function tokenizeEmbeddingText(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}
