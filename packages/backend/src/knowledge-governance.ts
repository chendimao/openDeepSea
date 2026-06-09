import type {
  KnowledgeInsightGroup,
  KnowledgeInsights,
  KnowledgeMetadataPatch,
  KnowledgeSource,
  KnowledgeSourceListItem,
} from './knowledge-types.js';
import { knowledgeRepo } from './repos/knowledge.js';

const ALLOWED_METADATA_PATCH_KEYS = new Set<keyof KnowledgeMetadataPatch>([
  'key_points',
  'decisions',
  'constraints',
  'risks',
  'learnings',
]);

const INCOMPLETE_PARSER_STATUSES = new Set(['partial', 'metadata_only', 'requires_sidecar']);

export function getKnowledgeInsights(input: { projectId: string; roomId?: string }): KnowledgeInsights {
  const sources = knowledgeRepo.listSources({
    projectId: input.projectId,
    roomId: input.roomId,
    limit: 500,
  });

  return {
    duplicates: summarizeDuplicateContent(sources),
    stale: summarizeSources(sources.filter((source) => source.status === 'stale')),
    parser_incomplete: summarizeSources(sources.filter((source) => isParserIncomplete(source.metadata))),
    empty_index: summarizeSources(sources.filter((source) => source.status === 'ready' && source.chunk_count === 0)),
  };
}

export function patchKnowledgeSourceMetadata(sourceId: string, patch: KnowledgeMetadataPatch): KnowledgeSource {
  assertSupportedMetadataPatch(patch);
  const source = knowledgeRepo.getSource(sourceId);
  if (!source) throw new Error('knowledge source not found');

  const normalized = normalizeMetadataPatch(patch);
  return knowledgeRepo.updateSourceStatus(source.id, {
    status: source.status,
    error: source.error,
    tags: source.tags,
    summary: source.summary,
    metadata: {
      ...source.metadata,
      ...normalized,
    },
  })!;
}

export function normalizeMetadataPatch(patch: KnowledgeMetadataPatch): KnowledgeMetadataPatch {
  assertSupportedMetadataPatch(patch);
  const normalized: KnowledgeMetadataPatch = {};
  for (const key of ALLOWED_METADATA_PATCH_KEYS) {
    if (patch[key] === undefined) continue;
    normalized[key] = normalizeFactArray(patch[key]);
  }
  return normalized;
}

function summarizeDuplicateContent(sources: KnowledgeSourceListItem[]): KnowledgeInsightGroup {
  const byHash = new Map<string, KnowledgeSourceListItem[]>();
  for (const source of sources) {
    if (!source.content_hash) continue;
    const bucket = byHash.get(source.content_hash) ?? [];
    bucket.push(source);
    byHash.set(source.content_hash, bucket);
  }
  return summarizeSources(
    [...byHash.values()]
      .filter((group) => group.length > 1)
      .flat(),
  );
}

function summarizeSources(sources: Array<Pick<KnowledgeSourceListItem, 'id'>>): KnowledgeInsightGroup {
  return {
    count: sources.length,
    source_ids: sources.map((source) => source.id),
  };
}

function isParserIncomplete(metadata: Record<string, unknown>): boolean {
  return typeof metadata.parser_status === 'string' && INCOMPLETE_PARSER_STATUSES.has(metadata.parser_status);
}

function assertSupportedMetadataPatch(patch: KnowledgeMetadataPatch): void {
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_METADATA_PATCH_KEYS.has(key as keyof KnowledgeMetadataPatch)) {
      throw new Error(`unsupported metadata field: ${key}`);
    }
  }
}

function normalizeFactArray(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.slice(0, 240))
    .slice(0, 12);
}
