import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  KnowledgeChunk,
  KnowledgeChunkType,
  KnowledgeExtraction,
  KnowledgeSearchResult,
  KnowledgeSource,
  KnowledgeSourceListItem,
  KnowledgeSourceType,
  KnowledgeStatus,
  KnowledgeUsageRefInput,
} from '../knowledge-types.js';

interface EnsureSourceInput {
  project_id: string;
  room_id?: string | null;
  source_type: KnowledgeSourceType;
  source_id: string;
  title: string;
  description?: string | null;
  mime_type?: string | null;
  size?: number | null;
  uri?: string | null;
  content_hash?: string | null;
  parser?: string | null;
  parser_version?: string | null;
  summary?: string | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  status?: KnowledgeStatus;
  error?: string | null;
}

interface SourceListFilters {
  projectId: string;
  roomId?: string;
  status?: KnowledgeStatus;
  statuses?: KnowledgeStatus[];
  sourceTypes?: KnowledgeSourceType[];
  query?: string;
  limit?: number;
}

interface SaveExtractionInput {
  source_id: string;
  plain_text?: string;
  markdown?: string | null;
  layout?: Record<string, unknown> | null;
  table?: Record<string, unknown> | null;
  image?: Record<string, unknown> | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ReplaceChunksInput {
  source_id: string;
  extraction_id?: string | null;
  chunks: Array<{
    chunk_index?: number;
    chunk_type: KnowledgeChunkType;
    heading?: string | null;
    content: string;
    token_estimate?: number | null;
    metadata?: Record<string, unknown> | null;
    title?: string;
    summary?: string | null;
    content_hash?: string;
    page_start?: number | null;
    page_end?: number | null;
    enabled?: 0 | 1;
    project_id?: string;
    room_id?: string | null;
  }>;
}

interface UpdateSourceStatusInput {
  status: KnowledgeStatus;
  error?: string | null;
  tags?: string[];
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  last_processed_at?: number | null;
}

interface SearchFilters {
  projectId: string;
  query: string;
  sourceId?: string;
  roomId?: string;
  statuses?: KnowledgeStatus[];
  sourceTypes?: KnowledgeSourceType[];
  limit?: number;
}

interface KnowledgeSourceRow extends Omit<KnowledgeSource, 'tags' | 'metadata'> {
  tags_json: string;
  metadata_json: string;
}

interface KnowledgeSourceListRow extends KnowledgeSourceRow {
  chunk_count: number;
  latest_extraction_id: string | null;
  latest_extraction_at: number | null;
}

interface KnowledgeExtractionRow extends Omit<KnowledgeExtraction, 'metadata'> {
  metadata_json: string;
}

interface KnowledgeChunkRow extends Omit<KnowledgeChunk, 'metadata'> {
  metadata_json: string;
}

interface KnowledgeSearchRow {
  chunk_id: string;
  source_id: string;
  external_source_id: string;
  project_id: string;
  source_type: KnowledgeSourceType;
  title: string;
  tags_json: string;
  chunk_index: number;
  chunk_type: KnowledgeChunkType;
  heading: string | null;
  content: string;
  snippet: string | null;
  score: number;
  room_id: string | null;
  metadata_json: string;
}

export const knowledgeRepo = {
  ensureSource(input: EnsureSourceInput): KnowledgeSource {
    const existing = db
      .prepare(
        `SELECT * FROM knowledge_sources
         WHERE project_id = ? AND source_type = ? AND source_id = ?`,
      )
      .get(input.project_id, input.source_type, input.source_id) as KnowledgeSourceRow | undefined;
    const ts = now();

    if (existing) {
      const next = {
        room_id: input.room_id === undefined ? existing.room_id : input.room_id,
        description: input.description === undefined ? existing.description : input.description,
        mime_type: input.mime_type === undefined ? existing.mime_type : input.mime_type,
        size: input.size === undefined ? existing.size : input.size,
        uri: input.uri === undefined ? existing.uri : input.uri,
        content_hash: input.content_hash === undefined ? existing.content_hash : input.content_hash,
        parser: input.parser === undefined ? existing.parser : input.parser,
        parser_version: input.parser_version === undefined ? existing.parser_version : input.parser_version,
        summary: input.summary === undefined ? existing.summary : input.summary,
        tags: input.tags === undefined ? parseTags(existing.tags_json) : normalizeTags(input.tags ?? []),
        metadata: input.metadata === undefined ? parseMetadata(existing.metadata_json) : input.metadata ?? {},
        status: input.status ?? existing.status,
        error: input.error === undefined ? existing.error : input.error,
      };
      db.prepare(
        `UPDATE knowledge_sources
         SET room_id = ?,
             title = ?,
             description = ?,
             mime_type = ?,
             size = ?,
             uri = ?,
             content_hash = ?,
             parser = ?,
             parser_version = ?,
             summary = ?,
             tags_json = ?,
             metadata_json = ?,
             status = ?,
             error = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        next.room_id,
        input.title,
        next.description,
        next.mime_type,
        next.size,
        next.uri,
        next.content_hash,
        next.parser,
        next.parser_version,
        next.summary,
        stringifyJson(next.tags),
        stringifyJson(next.metadata),
        next.status,
        next.error,
        ts,
        existing.id,
      );
      return this.getSource(existing.id)!;
    }

    const id = nanoid(16);
    db.prepare(
      `INSERT INTO knowledge_sources (
        id, project_id, room_id, source_type, source_id, title, description, mime_type, size, uri, content_hash,
        parser, parser_version, summary, tags_json, metadata_json, status, error, created_at, updated_at,
        indexed_at, last_processed_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      id,
      input.project_id,
      input.room_id ?? null,
      input.source_type,
      input.source_id,
      input.title,
      input.description ?? null,
      input.mime_type ?? null,
      input.size ?? null,
      input.uri ?? null,
      input.content_hash ?? null,
      input.parser ?? null,
      input.parser_version ?? null,
      input.summary ?? null,
      stringifyJson(normalizeTags(input.tags)),
      stringifyJson(input.metadata ?? {}),
      input.status ?? 'pending',
      input.error ?? null,
      ts,
      ts,
    );
    return this.getSource(id)!;
  },

  getSource(id: string): KnowledgeSource | undefined {
    const row = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(id) as KnowledgeSourceRow | undefined;
    return row ? mapSource(row) : undefined;
  },

  listSources(filters: SourceListFilters): KnowledgeSourceListItem[] {
    const clauses = ['knowledge_sources.project_id = @projectId'];
    const params: Record<string, string | number> = { projectId: filters.projectId };
    if (filters.roomId) {
      clauses.push('knowledge_sources.room_id = @roomId');
      params.roomId = filters.roomId;
    }
    const statuses = filters.statuses && filters.statuses.length > 0
      ? filters.statuses
      : filters.status
        ? [filters.status]
        : [];
    addNamedInClause(clauses, params, 'knowledge_sources.status', 'status', statuses);
    addNamedInClause(clauses, params, 'knowledge_sources.source_type', 'sourceType', filters.sourceTypes ?? []);
    const query = filters.query?.trim();
    if (query) {
      clauses.push(
        `(knowledge_sources.title LIKE @query ESCAPE '\\'
          OR COALESCE(knowledge_sources.description, '') LIKE @query ESCAPE '\\'
          OR COALESCE(knowledge_sources.summary, '') LIKE @query ESCAPE '\\'
          OR knowledge_sources.tags_json LIKE @query ESCAPE '\\'
          OR knowledge_sources.source_id LIKE @query ESCAPE '\\')`,
      );
      params.query = `%${escapeLike(query)}%`;
    }
    params.limit = normalizeLimit(filters.limit, 100, 500);

    const rows = db
      .prepare(
        `SELECT
           knowledge_sources.*,
           COUNT(knowledge_chunks.id) AS chunk_count,
           (
             SELECT knowledge_extractions.id
             FROM knowledge_extractions
             WHERE knowledge_extractions.source_id = knowledge_sources.id
             ORDER BY knowledge_extractions.created_at DESC, knowledge_extractions.rowid DESC
             LIMIT 1
           ) AS latest_extraction_id,
           (
             SELECT knowledge_extractions.created_at
             FROM knowledge_extractions
             WHERE knowledge_extractions.source_id = knowledge_sources.id
             ORDER BY knowledge_extractions.created_at DESC, knowledge_extractions.rowid DESC
             LIMIT 1
           ) AS latest_extraction_at
         FROM knowledge_sources
         LEFT JOIN knowledge_chunks ON knowledge_chunks.source_id = knowledge_sources.id
         WHERE ${clauses.join(' AND ')}
         GROUP BY knowledge_sources.id
         ORDER BY knowledge_sources.updated_at DESC
         LIMIT @limit`,
      )
      .all(params) as KnowledgeSourceListRow[];

    return rows.map(mapSourceListItem);
  },

  saveExtraction(input: SaveExtractionInput): KnowledgeExtraction {
    const id = nanoid(16);
    const ts = now();
    const metadata = buildExtractionMetadata(input);
    db.prepare(
      `INSERT INTO knowledge_extractions (id, source_id, plain_text, markdown, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.source_id,
      input.plain_text ?? '',
      input.markdown ?? null,
      stringifyJson(metadata),
      ts,
    );
    db.prepare('UPDATE knowledge_sources SET updated_at = ? WHERE id = ?').run(ts, input.source_id);
    return this.getLatestExtraction(input.source_id)!;
  },

  getLatestExtraction(sourceId: string): KnowledgeExtraction | undefined {
    const row = db
      .prepare(
        `SELECT * FROM knowledge_extractions
         WHERE source_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(sourceId) as KnowledgeExtractionRow | undefined;
    return row ? mapExtraction(row) : undefined;
  },

  replaceChunks(inputOrSourceId: ReplaceChunksInput | string, chunks?: ReplaceChunksInput['chunks']): KnowledgeChunk[] {
    const input = typeof inputOrSourceId === 'string'
      ? { source_id: inputOrSourceId, chunks: chunks ?? [] }
      : inputOrSourceId;
    const source = this.getSource(input.source_id);
    if (!source) throw new Error('source_id is invalid');
    const extractionId = typeof inputOrSourceId === 'string'
      ? this.getLatestExtraction(input.source_id)?.id ?? null
      : input.extraction_id ?? null;
    if (extractionId) {
      const extraction = db
        .prepare('SELECT id FROM knowledge_extractions WHERE id = ? AND source_id = ?')
        .get(extractionId, input.source_id) as { id: string } | undefined;
      if (!extraction) throw new Error('extraction_id does not belong to source_id');
    }

    const replace = db.transaction(() => {
      const ts = now();
      db.prepare('DELETE FROM knowledge_chunk_fts WHERE source_id = ?').run(input.source_id);
      db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(input.source_id);

      const insertChunk = db.prepare(
        `INSERT INTO knowledge_chunks (
          id, source_id, extraction_id, chunk_index, chunk_type, heading, content,
          token_estimate, enabled, metadata_json, created_at
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = db.prepare(
        `INSERT INTO knowledge_chunk_fts (chunk_id, source_id, project_id, title, heading, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      for (const [index, chunk] of input.chunks.entries()) {
        const id = nanoid(16);
        const chunkIndex = chunk.chunk_index ?? index;
        insertChunk.run(
          id,
          input.source_id,
          extractionId,
          chunkIndex,
          chunk.chunk_type,
          chunk.heading ?? chunk.title ?? null,
          chunk.content,
          chunk.token_estimate ?? null,
          chunk.enabled ?? 1,
          stringifyJson(buildChunkMetadata(chunk)),
          ts,
        );
        insertFts.run(
          id,
          input.source_id,
          source.project_id,
          source.title,
          chunk.heading ?? chunk.title ?? '',
          chunk.content,
        );
      }

      db.prepare('UPDATE knowledge_sources SET updated_at = ?, indexed_at = ? WHERE id = ?')
        .run(ts, ts, input.source_id);
    });

    replace();
    return this.listChunks(input.source_id);
  },

  clearChunks(sourceId: string): void {
    const source = this.getSource(sourceId);
    if (!source) throw new Error('source_id is invalid');
    const clear = db.transaction(() => {
      const ts = now();
      db.prepare('DELETE FROM knowledge_chunk_fts WHERE source_id = ?').run(sourceId);
      db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(sourceId);
      db.prepare('UPDATE knowledge_sources SET updated_at = ?, indexed_at = NULL WHERE id = ?').run(ts, sourceId);
    });
    clear();
  },

  listChunks(sourceId: string): KnowledgeChunk[] {
    const rows = db
      .prepare(
        `SELECT * FROM knowledge_chunks
         WHERE source_id = ?
         ORDER BY chunk_index ASC`,
      )
      .all(sourceId) as KnowledgeChunkRow[];
    return rows.map(mapChunk);
  },

  updateSourceStatus(id: string, patch: UpdateSourceStatusInput): KnowledgeSource | undefined {
    const existing = this.getSource(id);
    if (!existing) return undefined;
    const ts = now();
    db.prepare(
      `UPDATE knowledge_sources
       SET status = ?,
           error = ?,
           tags_json = ?,
           summary = ?,
           metadata_json = ?,
           updated_at = ?,
           indexed_at = CASE WHEN ? = 'ready' THEN COALESCE(indexed_at, ?) ELSE indexed_at END,
           last_processed_at = ?
       WHERE id = ?`,
    ).run(
      patch.status,
      patch.error === undefined ? existing.error : patch.error,
      stringifyJson(patch.tags === undefined ? existing.tags : normalizeTags(patch.tags)),
      patch.summary === undefined ? existing.summary : patch.summary,
      stringifyJson(patch.metadata === undefined ? existing.metadata : patch.metadata ?? {}),
      ts,
      patch.status,
      ts,
      patch.last_processed_at === undefined ? existing.last_processed_at : patch.last_processed_at,
      id,
    );
    return this.getSource(id);
  },

  setChunksEnabled(sourceId: string, enabled: 0 | 1): KnowledgeChunk[] {
    const source = this.getSource(sourceId);
    if (!source) throw new Error('source_id is invalid');
    const ts = now();
    db.prepare('UPDATE knowledge_chunks SET enabled = ? WHERE source_id = ?').run(enabled, sourceId);
    db.prepare('UPDATE knowledge_sources SET updated_at = ? WHERE id = ?').run(ts, sourceId);
    return this.listChunks(sourceId);
  },

  deleteSource(sourceId: string): boolean {
    const source = this.getSource(sourceId);
    if (!source) return false;
    db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId);
    return true;
  },

  countUsageRefs(sourceId: string): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM knowledge_usage_refs WHERE source_id = ?')
      .get(sourceId) as { count: number } | undefined;
    return row?.count ?? 0;
  },

  recordUsageRef(input: KnowledgeUsageRefInput): void {
    db.prepare(
      `INSERT INTO knowledge_usage_refs (id, project_id, source_id, chunk_id, ref_type, ref_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(16),
      input.project_id,
      input.source_id,
      input.chunk_id ?? null,
      input.ref_type,
      input.ref_id,
      stringifyJson(input.metadata ?? {}),
      now(),
    );
  },

  search(filters: SearchFilters): KnowledgeSearchResult[] {
    const matchQuery = buildFtsQuery(filters.query);
    if (!matchQuery) return [];

    const statuses = filters.statuses && filters.statuses.length > 0 ? filters.statuses : ['ready'];
    const clauses = [
      'knowledge_chunk_fts MATCH ?',
      'knowledge_chunk_fts.project_id = ?',
      'knowledge_chunks.enabled = 1',
      `knowledge_sources.status IN (${statuses.map(() => '?').join(', ')})`,
    ];
    const params: Array<string | number> = [matchQuery, filters.projectId, ...statuses];
    if (filters.sourceId) {
      clauses.push('knowledge_chunks.source_id = ?');
      params.push(filters.sourceId);
    }
    if (filters.roomId) {
      clauses.push('knowledge_sources.room_id = ?');
      params.push(filters.roomId);
    }
    if (filters.sourceTypes && filters.sourceTypes.length > 0) {
      clauses.push(`knowledge_sources.source_type IN (${filters.sourceTypes.map(() => '?').join(', ')})`);
      params.push(...filters.sourceTypes);
    }
    const limit = normalizeLimit(filters.limit, 20, 100);

    const rows = db
      .prepare(
        `SELECT
           knowledge_chunks.id AS chunk_id,
           knowledge_chunks.source_id AS source_id,
           knowledge_sources.source_id AS external_source_id,
           knowledge_sources.project_id AS project_id,
           knowledge_sources.source_type AS source_type,
           knowledge_sources.title AS title,
           knowledge_sources.tags_json AS tags_json,
           knowledge_chunks.chunk_index AS chunk_index,
           knowledge_chunks.chunk_type AS chunk_type,
           knowledge_chunks.heading AS heading,
           knowledge_chunks.content AS content,
           snippet(knowledge_chunk_fts, 5, '<mark>', '</mark>', '...', 24) AS snippet,
           bm25(knowledge_chunk_fts) AS score,
           knowledge_sources.room_id AS room_id,
           knowledge_chunks.metadata_json AS metadata_json
         FROM knowledge_chunk_fts
         JOIN knowledge_chunks ON knowledge_chunks.id = knowledge_chunk_fts.chunk_id
         JOIN knowledge_sources ON knowledge_sources.id = knowledge_chunks.source_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY score ASC, knowledge_chunks.chunk_index ASC
         LIMIT ?`,
      )
      .all(...params, limit) as KnowledgeSearchRow[];

    return rows.map(mapSearchResult);
  },
};

function mapSource(row: KnowledgeSourceRow): KnowledgeSource {
  return {
    id: row.id,
    project_id: row.project_id,
    room_id: row.room_id,
    source_type: row.source_type,
    source_id: row.source_id,
    title: row.title,
    description: row.description,
    mime_type: row.mime_type,
    size: row.size,
    uri: row.uri,
    content_hash: row.content_hash,
    parser: row.parser,
    parser_version: row.parser_version,
    summary: row.summary,
    tags: parseTags(row.tags_json),
    metadata: parseMetadata(row.metadata_json),
    status: row.status,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    indexed_at: row.indexed_at,
    last_processed_at: row.last_processed_at,
  };
}

function mapSourceListItem(row: KnowledgeSourceListRow): KnowledgeSourceListItem {
  return {
    ...mapSource(row),
    chunk_count: row.chunk_count,
    latest_extraction_id: row.latest_extraction_id,
    latest_extraction_at: row.latest_extraction_at,
  };
}

function mapExtraction(row: KnowledgeExtractionRow): KnowledgeExtraction {
  return {
    id: row.id,
    source_id: row.source_id,
    plain_text: row.plain_text,
    markdown: row.markdown,
    metadata: parseMetadata(row.metadata_json),
    created_at: row.created_at,
  };
}

function mapChunk(row: KnowledgeChunkRow): KnowledgeChunk {
  return {
    id: row.id,
    source_id: row.source_id,
    extraction_id: row.extraction_id,
    chunk_index: row.chunk_index,
    chunk_type: row.chunk_type,
    heading: row.heading,
    content: row.content,
    token_estimate: row.token_estimate,
    enabled: row.enabled,
    metadata: parseMetadata(row.metadata_json),
    created_at: row.created_at,
  };
}

function mapSearchResult(row: KnowledgeSearchRow): KnowledgeSearchResult {
  return {
    chunk_id: row.chunk_id,
    source_id: row.source_id,
    external_source_id: row.external_source_id,
    project_id: row.project_id,
    source_type: row.source_type,
    title: row.title,
    tags: parseTags(row.tags_json),
    chunk_index: row.chunk_index,
    chunk_type: row.chunk_type,
    heading: row.heading,
    content: row.content,
    snippet: row.snippet ?? row.content,
    score: row.score,
    metadata: parseMetadata(row.metadata_json),
    citation: {
      source_id: row.source_id,
      source_type: row.source_type,
      source_title: row.title,
      external_source_id: row.external_source_id,
      chunk_id: row.chunk_id,
      chunk_index: row.chunk_index,
      heading: row.heading,
      room_id: row.room_id,
    },
  };
}

function normalizeTags(tags: string[] | null | undefined): string[] {
  if (!tags) return [];
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function buildExtractionMetadata(input: SaveExtractionInput): Record<string, unknown> {
  return pruneUndefined({
    ...(input.metadata ?? {}),
    layout: input.layout,
    table: input.table,
    image: input.image,
    error: input.error,
  });
}

function buildChunkMetadata(chunk: ReplaceChunksInput['chunks'][number]): Record<string, unknown> {
  return pruneUndefined({
    ...(chunk.metadata ?? {}),
    summary: chunk.summary,
    content_hash: chunk.content_hash,
    page_start: chunk.page_start,
    page_end: chunk.page_end,
    enabled: chunk.enabled,
    project_id: chunk.project_id,
    room_id: chunk.room_id,
  });
}

function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function parseTags(value: string | null): string[] {
  const parsed = parseJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}

function parseMetadata(value: string | null): Record<string, unknown> {
  const parsed = parseJson(value, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function parseJson(value: string | null, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value as number), max));
}

function addNamedInClause<T extends string>(
  clauses: string[],
  params: Record<string, string | number>,
  column: string,
  paramPrefix: string,
  values: T[],
): void {
  if (values.length === 0) return;
  const placeholders = values.map((value, index) => {
    const key = `${paramPrefix}${index}`;
    params[key] = value;
    return `@${key}`;
  });
  clauses.push(`${column} IN (${placeholders.join(', ')})`);
}

function buildFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
