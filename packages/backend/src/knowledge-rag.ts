import { db } from './db.js';
import { searchKnowledge } from './knowledge-search.js';
import { knowledgeRepo } from './repos/knowledge.js';
import { projectRepo } from './repos/projects.js';
import { roomRepo } from './repos/rooms.js';
import type {
  KnowledgeChunk,
  KnowledgeRankingSignals,
  KnowledgeRetrievalMode as KnowledgeSearchMode,
  KnowledgeSearchResult,
  KnowledgeSource,
  KnowledgeUsageRefInput,
} from './knowledge-types.js';

const SEARCH_CONTENT_CHARS = 1_200;
const CHUNK_CONTENT_CHARS = 8_000;
const FULL_CONTEXT_CHARS = 40_000;
const SUMMARY_CONTENT_CHARS = 2_000;

export type KnowledgeRetrievalMode = KnowledgeSearchMode | 'focused' | 'full_context' | 'summary';

export interface KnowledgeAgentUsage {
  refType: KnowledgeUsageRefInput['ref_type'];
  refId: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeAgentCitation {
  key: string;
  source_id: string;
  chunk_id?: string | null;
  title: string;
  room_id?: string | null;
}

export interface KnowledgeAgentToolResponse<T> {
  source: string;
  scope: {
    project_id: string;
    room_id?: string;
  };
  generated_at: number;
  retrieval_mode?: KnowledgeRetrievalMode;
  results: T;
  citations: KnowledgeAgentCitation[];
  warnings?: string[];
}

export interface KnowledgeAgentSearchResult {
  source_id: string;
  chunk_id: string;
  title: string;
  source_type: string;
  chunk_index: number;
  chunk_type: string;
  heading: string | null;
  snippet: string;
  content: string;
  truncated: boolean;
  score: number;
  ranking?: KnowledgeRankingSignals;
  citation_key: string;
}

export interface KnowledgeAgentChunkResult {
  source_id: string;
  chunk_id: string;
  title: string;
  chunk_index: number;
  chunk_type: string;
  heading: string | null;
  content: string;
  truncated: boolean;
  citation_key: string;
}

export interface KnowledgeAgentSourceSummary {
  id: string;
  title: string;
  source_type: string;
  status: string;
  summary: string | null;
  tags: string[];
  chunk_count: number;
  latest_extraction_id: string | null;
  content?: string;
  truncated?: boolean;
  citation_key: string;
}

export interface KnowledgeAgentSourceListItem {
  id: string;
  title: string;
  source_type: string;
  status: string;
  summary: string | null;
  tags: string[];
  chunk_count: number;
  room_id: string | null;
  updated_at: number;
  citation_key: string;
}

export function searchKnowledgeForAgent(input: {
  projectId: string;
  roomId?: string | null;
  query: string;
  mode?: KnowledgeSearchMode;
  limit?: number;
  usage?: KnowledgeAgentUsage | null;
}): KnowledgeAgentToolResponse<KnowledgeAgentSearchResult[]> {
  const scope = resolveScope(input.projectId, input.roomId);
  const mode = input.mode ?? 'hybrid';
  const results = searchKnowledge({
    projectId: scope.project_id,
    roomId: scope.room_id,
    query: input.query,
    mode,
    limit: normalizeLimit(input.limit, 5, 10),
  });
  const mapped = results.map(toSearchResult);
  recordResultUsage(scope.project_id, results, input.usage, 'search', {
    retrieval_mode: mode,
    query: input.query,
  });
  return {
    source: 'openclaw.knowledge.search',
    scope,
    generated_at: Date.now(),
    retrieval_mode: mode,
    results: mapped,
    citations: results.map((result) => citationFromSearchResult(result)),
  };
}

export function readKnowledgeChunkForAgent(input: {
  projectId: string;
  chunkId: string;
  usage?: KnowledgeAgentUsage | null;
}): KnowledgeAgentToolResponse<KnowledgeAgentChunkResult> {
  const project = requireProject(input.projectId);
  const row = getChunkRow(input.chunkId);
  if (!row) throw new Error('knowledge chunk not found');
  const source = knowledgeRepo.getSource(row.source_id);
  if (!source || source.project_id !== project.id) throw new Error('knowledge chunk not found');
  const content = truncateText(row.content, CHUNK_CONTENT_CHARS);
  recordUsage(project.id, source.id, row.id, input.usage, 'read_chunk');
  return {
    source: 'openclaw.knowledge.read_chunk',
    scope: { project_id: project.id, ...(source.room_id ? { room_id: source.room_id } : {}) },
    generated_at: Date.now(),
    retrieval_mode: 'focused',
    results: {
      source_id: source.id,
      chunk_id: row.id,
      title: source.title,
      chunk_index: row.chunk_index,
      chunk_type: row.chunk_type,
      heading: row.heading,
      content: content.text,
      truncated: content.truncated,
      citation_key: chunkCitationKey(source.id, row.id),
    },
    citations: [citationFromSource(source, row.id)],
  };
}

export function readKnowledgeSourceSummaryForAgent(input: {
  projectId: string;
  sourceId: string;
  mode?: 'auto' | 'full' | 'summary';
  usage?: KnowledgeAgentUsage | null;
}): KnowledgeAgentToolResponse<KnowledgeAgentSourceSummary> {
  const project = requireProject(input.projectId);
  const source = knowledgeRepo.getSource(input.sourceId);
  if (!source || source.project_id !== project.id) throw new Error('knowledge source not found');
  const latestExtraction = knowledgeRepo.getLatestExtraction(source.id);
  const listItem = knowledgeRepo.listSources({ projectId: project.id, limit: 500 })
    .find((item) => item.id === source.id);
  const content = latestExtraction?.markdown || latestExtraction?.plain_text || '';
  const requestedMode = input.mode ?? 'auto';
  const canReturnFull = content.length > 0 && content.length <= FULL_CONTEXT_CHARS;
  const shouldReturnFull = requestedMode === 'full' || (requestedMode === 'auto' && canReturnFull);
  const warnings: string[] = [];
  let retrievalMode: KnowledgeRetrievalMode = 'summary';
  let returnedContent: string | undefined;
  let truncated: boolean | undefined;

  if (shouldReturnFull && canReturnFull) {
    retrievalMode = 'full_context';
    returnedContent = content;
    truncated = false;
  } else if (requestedMode === 'full' && !canReturnFull) {
    warnings.push('full_context_unavailable: source extraction exceeds safe full-context limit');
  }

  if (!returnedContent && requestedMode !== 'summary' && content && content.length <= SUMMARY_CONTENT_CHARS) {
    returnedContent = content;
    truncated = false;
  }

  recordUsage(project.id, source.id, null, input.usage, retrievalMode);
  return {
    source: 'openclaw.knowledge.source_summary',
    scope: { project_id: project.id, ...(source.room_id ? { room_id: source.room_id } : {}) },
    generated_at: Date.now(),
    retrieval_mode: retrievalMode,
    results: {
      id: source.id,
      title: source.title,
      source_type: source.source_type,
      status: source.status,
      summary: source.summary,
      tags: source.tags,
      chunk_count: listItem?.chunk_count ?? knowledgeRepo.listChunks(source.id).length,
      latest_extraction_id: latestExtraction?.id ?? null,
      ...(returnedContent ? { content: returnedContent, truncated: truncated ?? false } : {}),
      citation_key: sourceCitationKey(source.id),
    },
    citations: [citationFromSource(source, null)],
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function listKnowledgeSourcesForAgent(input: {
  projectId: string;
  roomId?: string | null;
  limit?: number;
}): KnowledgeAgentToolResponse<KnowledgeAgentSourceListItem[]> {
  const scope = resolveScope(input.projectId, input.roomId);
  const sources = knowledgeRepo.listSources({
    projectId: scope.project_id,
    roomId: scope.room_id,
    limit: normalizeLimit(input.limit, 20, 100),
  });
  return {
    source: 'openclaw.knowledge.list_sources',
    scope,
    generated_at: Date.now(),
    results: sources.map((source) => ({
      id: source.id,
      title: source.title,
      source_type: source.source_type,
      status: source.status,
      summary: source.summary,
      tags: source.tags,
      chunk_count: source.chunk_count,
      room_id: source.room_id,
      updated_at: source.updated_at,
      citation_key: sourceCitationKey(source.id),
    })),
    citations: sources.map((source) => citationFromSource(source, null)),
  };
}

export function buildKnowledgeAgentToolPrompt(input: {
  projectId: string;
  roomId?: string | null;
}): string {
  const roomOption = input.roomId ? ` --room ${input.roomId}` : '';
  return [
    'OpenDeepSea 知识库工具：',
    '- 你可以通过只读命令检索当前项目知识库，不要读取 SQLite 文件、上传目录或本机绝对路径。',
    '- 当用户问题涉及项目资料、设计、验收、历史文档、上传文件或智能体文档事实时，先调用知识库工具再回答。',
    `- 当前 projectId: ${input.projectId}`,
    input.roomId ? `- 当前 roomId: ${input.roomId}` : null,
    '- 常用命令：',
    `  - npm run openclaw:knowledge -- search --project ${input.projectId}${roomOption} --query "<关键词>" --mode hybrid --limit 5`,
    `  - npm run openclaw:knowledge -- read-chunk --project ${input.projectId} --chunk <chunkId>`,
    `  - npm run openclaw:knowledge -- source-summary --project ${input.projectId} --source <sourceId> --mode auto`,
    `  - npm run openclaw:knowledge -- list-sources --project ${input.projectId}${roomOption} --limit 20`,
    '- 回答中引用工具返回的 citation key，例如 `knowledge:<sourceId>#chunk:<chunkId>`。',
    '- 如果工具返回为空，说明当前 scope 没有可用知识，不要编造来源。',
  ].filter((line): line is string => line !== null).join('\n');
}

function resolveScope(projectId: string, roomId?: string | null): { project_id: string; room_id?: string } {
  const project = requireProject(projectId);
  if (!roomId) return { project_id: project.id };
  const room = roomRepo.get(roomId);
  if (!room || room.project_id !== project.id) throw new Error('room does not belong to project');
  return { project_id: project.id, room_id: room.id };
}

function requireProject(projectId: string) {
  const project = projectRepo.get(projectId);
  if (!project) throw new Error('project not found');
  return project;
}

function toSearchResult(result: KnowledgeSearchResult): KnowledgeAgentSearchResult {
  const content = truncateText(result.content, SEARCH_CONTENT_CHARS);
  return {
    source_id: result.source_id,
    chunk_id: result.chunk_id,
    title: result.title,
    source_type: result.source_type,
    chunk_index: result.chunk_index,
    chunk_type: result.chunk_type,
    heading: result.heading,
    snippet: stripMarks(result.snippet),
    content: content.text,
    truncated: content.truncated,
    score: result.score,
    ...(result.ranking ? { ranking: result.ranking } : {}),
    citation_key: chunkCitationKey(result.source_id, result.chunk_id),
  };
}

function getChunkRow(chunkId: string): KnowledgeChunk | undefined {
  return db.prepare('SELECT * FROM knowledge_chunks WHERE id = ?').get(chunkId) as KnowledgeChunk | undefined;
}

function citationFromSearchResult(result: KnowledgeSearchResult): KnowledgeAgentCitation {
  return {
    key: chunkCitationKey(result.source_id, result.chunk_id),
    source_id: result.source_id,
    chunk_id: result.chunk_id,
    title: result.title,
    room_id: result.citation.room_id,
  };
}

function citationFromSource(source: KnowledgeSource, chunkId: string | null): KnowledgeAgentCitation {
  return {
    key: chunkId ? chunkCitationKey(source.id, chunkId) : sourceCitationKey(source.id),
    source_id: source.id,
    chunk_id: chunkId,
    title: source.title,
    room_id: source.room_id,
  };
}

function sourceCitationKey(sourceId: string): string {
  return `knowledge:${sourceId}`;
}

function chunkCitationKey(sourceId: string, chunkId: string): string {
  return `${sourceCitationKey(sourceId)}#chunk:${chunkId}`;
}

function recordResultUsage(
  projectId: string,
  results: KnowledgeSearchResult[],
  usage: KnowledgeAgentUsage | null | undefined,
  action: string,
  metadata: Record<string, unknown> = {},
): void {
  for (const result of results) {
    recordUsage(projectId, result.source_id, result.chunk_id, usage, action, {
      ...metadata,
      ...(result.ranking ? { ranking: result.ranking } : {}),
    });
  }
}

function recordUsage(
  projectId: string,
  sourceId: string,
  chunkId: string | null,
  usage: KnowledgeAgentUsage | null | undefined,
  action: string,
  metadata: Record<string, unknown> = {},
): void {
  if (!usage?.refId) return;
  knowledgeRepo.recordUsageRef({
    project_id: projectId,
    source_id: sourceId,
    chunk_id: chunkId,
    ref_type: usage.refType,
    ref_id: usage.refId,
    metadata: {
      ...(usage.metadata ?? {}),
      action,
      ...metadata,
    },
  });
}

function normalizeLimit(value: number | undefined, defaultLimit: number, maxLimit: number): number {
  if (!Number.isFinite(value)) return defaultLimit;
  return Math.max(1, Math.min(maxLimit, Math.floor(value ?? defaultLimit)));
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

function stripMarks(value: string): string {
  return value.replace(/<\/?mark>/g, '').trim();
}
