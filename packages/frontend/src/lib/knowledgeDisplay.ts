export type KnowledgeLocale = 'zh' | 'en';

export type KnowledgeTone = 'success' | 'info' | 'warning' | 'danger' | 'muted' | 'neutral';

export type KnowledgeRetrievalMode = 'keyword' | 'vector_preview' | 'hybrid';

export type KnowledgeSourceStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'disabled'
  | 'stale';

export type KnowledgeSourceType =
  | 'resource_asset'
  | 'uploaded_file'
  | 'agent_document'
  | 'message'
  | 'task'
  | 'workspace_file'
  | 'web_page'
  | 'session_note'
  | 'workspace_doc'
  | 'url'
  | 'manual';

export type KnowledgeSourceIconKey =
  | 'archive'
  | 'file-up'
  | 'file-pen-line'
  | 'message-square-text'
  | 'list-todo'
  | 'file-text'
  | 'globe'
  | 'folder-git-2'
  | 'link'
  | 'book-open';

export interface KnowledgeStatusDisplay {
  label: string;
  tone: KnowledgeTone;
  sortWeight: number;
}

export interface KnowledgeSourceTypeDisplay {
  label: string;
  iconKey: KnowledgeSourceIconKey;
}

export interface KnowledgeRetrievalModeDisplay {
  label: string;
  description: string;
  sortWeight: number;
}

export interface KnowledgeMetadata {
  key_points?: string[];
  decisions?: string[];
  constraints?: string[];
  risks?: string[];
  learnings?: string[];
  content_kind?: string;
  parser?: string;
  parser_version?: string;
  parser_status?: 'complete' | 'partial' | 'metadata_only' | 'requires_sidecar' | 'failed';
  parser_warnings?: string[];
  requires_sidecar?: boolean;
  [key: string]: unknown;
}

export interface KnowledgeSource {
  id: string;
  project_id: string;
  project_name?: string | null;
  room_id?: string | null;
  room_name?: string | null;
  source_type: KnowledgeSourceType;
  source_id?: string | null;
  title: string;
  mime_type?: string | null;
  size?: number | null;
  status: KnowledgeSourceStatus;
  summary?: string | null;
  tags?: string[];
  metadata?: KnowledgeMetadata | null;
  chunk_count?: number | null;
  error?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  last_processed_at?: number | null;
  reference_count?: number | null;
  parser?: string | null;
  parser_version?: string | null;
}

export interface KnowledgeOriginalFile {
  id: string;
  name: string;
  url: string;
  storage_path: string;
  source_type: string;
}

export interface KnowledgeSourceCapabilities {
  preview: boolean;
  download: boolean;
  reprocess: boolean;
  disable: boolean;
  delete: boolean;
}

export interface KnowledgeSourceDetail extends KnowledgeSource {
  latest_extraction_id?: string | null;
  latest_extraction_at?: number | null;
  original_file?: KnowledgeOriginalFile | null;
  capabilities?: KnowledgeSourceCapabilities;
}

export interface KnowledgeExtraction {
  id: string;
  source_id: string;
  plain_text: string;
  markdown: string | null;
  metadata: KnowledgeMetadata;
  created_at: number;
  truncated: boolean;
  returned_char_count: number;
  original_char_count: number;
}

export interface KnowledgeChunk {
  id: string;
  source_id: string;
  extraction_id: string | null;
  chunk_index: number;
  chunk_type: 'plain_text' | 'markdown' | 'code' | 'table' | 'summary' | 'body';
  heading: string | null;
  content: string;
  token_estimate: number | null;
  enabled: 0 | 1;
  metadata: KnowledgeMetadata;
  created_at: number;
}

export interface KnowledgeSearchResult {
  chunk_id: string;
  source_id: string;
  project_id: string;
  source_type: KnowledgeSourceType;
  title: string;
  tags: string[];
  chunk_index: number;
  chunk_type: KnowledgeChunk['chunk_type'];
  heading: string | null;
  content: string;
  snippet: string;
  score: number;
  retrieval_mode?: KnowledgeRetrievalMode;
  ranking?: KnowledgeRankingSignals;
  metadata: KnowledgeMetadata;
  citation: {
    source_id: string;
    source_type: KnowledgeSourceType;
    source_title: string;
    external_source_id: string;
    chunk_id: string;
    chunk_index: number;
    heading: string | null;
    room_id: string | null;
  };
}

export interface KnowledgeRankingSignals {
  keywordScore?: number;
  vectorScore?: number;
  titleMatch: boolean;
  tagMatch: boolean;
  summaryMatch: boolean;
  recencyBoost: number;
  finalScore: number;
}

export interface KnowledgeInsightGroup {
  count: number;
  source_ids: string[];
}

export interface KnowledgeInsights {
  duplicates: KnowledgeInsightGroup;
  stale: KnowledgeInsightGroup;
  parser_incomplete: KnowledgeInsightGroup;
  empty_index: KnowledgeInsightGroup;
}

export type KnowledgeInsightKey = keyof KnowledgeInsights;

export interface KnowledgeInsightSummaryItem {
  key: KnowledgeInsightKey;
  label: string;
  tone: KnowledgeTone;
  count: number;
  sourceIds: string[];
  sortWeight: number;
}

export interface KnowledgeInsightsSummary {
  totalIssues: number;
  items: KnowledgeInsightSummaryItem[];
}

export interface ManualKnowledgeInput {
  title: string;
  content: string;
  tags?: string[];
  roomId?: string;
}

export interface UrlKnowledgeInput {
  url: string;
  title?: string;
  content?: string;
  tags?: string[];
  roomId?: string;
}

export interface WorkspaceKnowledgeImportInput {
  paths: string[];
  tags?: string[];
  roomId?: string;
}

export interface KnowledgeMetadataPatch {
  key_points?: string[];
  decisions?: string[];
  constraints?: string[];
  risks?: string[];
  learnings?: string[];
}

export interface KnowledgeImportResult {
  source: KnowledgeSource;
  extraction?: KnowledgeExtraction | null;
  chunks?: KnowledgeChunk[];
}

export interface WorkspaceKnowledgeImportResult {
  created: KnowledgeSource[];
  failed: Array<{ path: string; error: string }>;
}

export interface KnowledgeSourceFilters {
  keyword?: string;
  status?: KnowledgeSourceStatus | '';
  statuses?: KnowledgeSourceStatus[];
  sourceType?: KnowledgeSourceType | '';
  sourceTypes?: KnowledgeSourceType[];
  projectId?: string;
  roomId?: string;
  tags?: string[];
}

export interface KnowledgeStats {
  total: number;
  ready: number;
  processing: number;
  failed: number;
  chunks: number;
  totalSize: number;
}

const KNOWLEDGE_STATUS_DISPLAY: Record<KnowledgeSourceStatus, Record<KnowledgeLocale, string> & {
  tone: KnowledgeTone;
  sortWeight: number;
}> = {
  failed: {
    zh: '失败',
    en: 'Failed',
    tone: 'danger',
    sortWeight: 10,
  },
  processing: {
    zh: 'AI 分析中',
    en: 'Processing',
    tone: 'info',
    sortWeight: 20,
  },
  pending: {
    zh: '待索引',
    en: 'Pending',
    tone: 'neutral',
    sortWeight: 30,
  },
  stale: {
    zh: '已过期',
    en: 'Stale',
    tone: 'warning',
    sortWeight: 40,
  },
  ready: {
    zh: '已提取',
    en: 'Ready',
    tone: 'success',
    sortWeight: 50,
  },
  disabled: {
    zh: '已禁用',
    en: 'Disabled',
    tone: 'muted',
    sortWeight: 60,
  },
};

const KNOWLEDGE_SOURCE_TYPE_DISPLAY: Record<KnowledgeSourceType, Record<KnowledgeLocale, string> & {
  iconKey: KnowledgeSourceIconKey;
}> = {
  resource_asset: {
    zh: '资源资产',
    en: 'Resource asset',
    iconKey: 'archive',
  },
  uploaded_file: {
    zh: '上传文件',
    en: 'Uploaded file',
    iconKey: 'file-up',
  },
  agent_document: {
    zh: '智能体文档',
    en: 'Agent document',
    iconKey: 'file-pen-line',
  },
  message: {
    zh: '消息',
    en: 'Message',
    iconKey: 'message-square-text',
  },
  task: {
    zh: '任务',
    en: 'Task',
    iconKey: 'list-todo',
  },
  workspace_file: {
    zh: '工作区文件',
    en: 'Workspace file',
    iconKey: 'file-text',
  },
  workspace_doc: {
    zh: '工作区文档',
    en: 'Workspace doc',
    iconKey: 'folder-git-2',
  },
  web_page: {
    zh: '网页导入',
    en: 'Web page',
    iconKey: 'globe',
  },
  session_note: {
    zh: '会话摘录',
    en: 'Session note',
    iconKey: 'message-square-text',
  },
  url: {
    zh: 'URL',
    en: 'URL',
    iconKey: 'link',
  },
  manual: {
    zh: '手动条目',
    en: 'Manual entry',
    iconKey: 'book-open',
  },
};

const KNOWLEDGE_RETRIEVAL_MODE_DISPLAY: Record<KnowledgeRetrievalMode, Record<KnowledgeLocale, string> & {
  description: Record<KnowledgeLocale, string>;
  sortWeight: number;
}> = {
  keyword: {
    zh: '关键词',
    en: 'Keyword',
    description: {
      zh: 'FTS 关键词匹配',
      en: 'FTS keyword match',
    },
    sortWeight: 10,
  },
  vector_preview: {
    zh: '向量预览',
    en: 'Vector preview',
    description: {
      zh: '本地 hash embedding 预览',
      en: 'Local hash embedding preview',
    },
    sortWeight: 20,
  },
  hybrid: {
    zh: '混合',
    en: 'Hybrid',
    description: {
      zh: '关键词与向量信号合并',
      en: 'Keyword and vector signals',
    },
    sortWeight: 30,
  },
};

const KNOWLEDGE_INSIGHT_DISPLAY: Record<KnowledgeInsightKey, Record<KnowledgeLocale, string> & {
  tone: KnowledgeTone;
  sortWeight: number;
}> = {
  parser_incomplete: {
    zh: '解析待补全',
    en: 'Parser incomplete',
    tone: 'warning',
    sortWeight: 10,
  },
  duplicates: {
    zh: '重复内容',
    en: 'Duplicates',
    tone: 'info',
    sortWeight: 20,
  },
  stale: {
    zh: '待刷新',
    en: 'Stale',
    tone: 'warning',
    sortWeight: 30,
  },
  empty_index: {
    zh: '空索引',
    en: 'Empty index',
    tone: 'danger',
    sortWeight: 40,
  },
};

const KNOWLEDGE_STATUS_FILTER_OPTIONS: ReadonlyArray<KnowledgeSourceStatus | ''> = [
  '',
  'ready',
  'pending',
  'processing',
  'failed',
  'stale',
  'disabled',
];

export function getKnowledgeStatusDisplay(
  status: KnowledgeSourceStatus,
  locale: KnowledgeLocale = 'zh',
): KnowledgeStatusDisplay {
  const display = KNOWLEDGE_STATUS_DISPLAY[status];
  return {
    label: display[locale],
    tone: display.tone,
    sortWeight: display.sortWeight,
  };
}

export function getKnowledgeStatusFilterOptions(): Array<KnowledgeSourceStatus | ''> {
  return [...KNOWLEDGE_STATUS_FILTER_OPTIONS];
}

export function getKnowledgeSourceTypeDisplay(
  sourceType: KnowledgeSourceType | string,
  locale: KnowledgeLocale = 'zh',
): KnowledgeSourceTypeDisplay {
  const display = KNOWLEDGE_SOURCE_TYPE_DISPLAY[sourceType as KnowledgeSourceType] ?? {
    zh: sourceType || '未知类型',
    en: sourceType || 'Unknown type',
    iconKey: 'file-text' as const,
  };
  return {
    label: display[locale],
    iconKey: display.iconKey,
  };
}

export function getKnowledgeRetrievalModeDisplay(
  mode: KnowledgeRetrievalMode,
  locale: KnowledgeLocale = 'zh',
): KnowledgeRetrievalModeDisplay {
  const display = KNOWLEDGE_RETRIEVAL_MODE_DISPLAY[mode];
  return {
    label: display[locale],
    description: display.description[locale],
    sortWeight: display.sortWeight,
  };
}

export function summarizeKnowledgeInsights(
  insights: KnowledgeInsights | null | undefined,
  locale: KnowledgeLocale = 'zh',
): KnowledgeInsightsSummary {
  if (!insights) return { totalIssues: 0, items: [] };
  const items = (Object.keys(KNOWLEDGE_INSIGHT_DISPLAY) as KnowledgeInsightKey[])
    .map((key) => {
      const display = KNOWLEDGE_INSIGHT_DISPLAY[key];
      const group = insights[key];
      return {
        key,
        label: display[locale],
        tone: display.tone,
        count: group.count,
        sourceIds: group.source_ids,
        sortWeight: display.sortWeight,
      };
    })
    .filter((item) => item.count > 0)
    .sort((left, right) => (right.count - left.count) || (left.sortWeight - right.sortWeight));

  return {
    totalIssues: items.reduce((sum, item) => sum + item.count, 0),
    items,
  };
}

export function knowledgeSourceMatchesKeyword(
  source: KnowledgeSource,
  keyword: string,
  locale: KnowledgeLocale = 'zh',
): boolean {
  const needle = normalizeSearchText(keyword);
  if (!needle) return true;

  const statusDisplay = getKnowledgeStatusDisplay(source.status, locale);
  const sourceTypeDisplay = getKnowledgeSourceTypeDisplay(source.source_type, locale);
  return collectSearchValues(source, statusDisplay.label, sourceTypeDisplay.label)
    .some((value) => normalizeSearchText(value).includes(needle));
}

export function knowledgeSourceMatchesFilters(
  source: KnowledgeSource,
  filters: KnowledgeSourceFilters,
  locale: KnowledgeLocale = 'zh',
): boolean {
  if (filters.projectId && source.project_id !== filters.projectId) return false;
  if (filters.roomId && source.room_id !== filters.roomId) return false;
  if (filters.status && source.status !== filters.status) return false;
  if (filters.statuses?.length && !filters.statuses.includes(source.status)) return false;
  if (filters.sourceType && source.source_type !== filters.sourceType) return false;
  if (filters.sourceTypes?.length && !filters.sourceTypes.includes(source.source_type)) return false;
  if (filters.tags?.length) {
    const sourceTags = new Set((source.tags ?? []).map((tag) => normalizeSearchText(tag)));
    if (!filters.tags.every((tag) => sourceTags.has(normalizeSearchText(tag)))) return false;
  }
  return knowledgeSourceMatchesKeyword(source, filters.keyword ?? '', locale);
}

export function filterKnowledgeSources(
  sources: KnowledgeSource[],
  filters: KnowledgeSourceFilters,
  locale: KnowledgeLocale = 'zh',
): KnowledgeSource[] {
  return sources.filter((source) => knowledgeSourceMatchesFilters(source, filters, locale));
}

export function summarizeKnowledgeStats(sources: KnowledgeSource[]): KnowledgeStats {
  return sources.reduce<KnowledgeStats>(
    (stats, source) => {
      stats.total += 1;
      if (source.status === 'ready') stats.ready += 1;
      if (source.status === 'processing' || source.status === 'pending') stats.processing += 1;
      if (source.status === 'failed') stats.failed += 1;
      stats.chunks += source.chunk_count ?? 0;
      stats.totalSize += source.size ?? 0;
      return stats;
    },
    {
      total: 0,
      ready: 0,
      processing: 0,
      failed: 0,
      chunks: 0,
      totalSize: 0,
    },
  );
}

export function sortKnowledgeSourcesByStatus(sources: KnowledgeSource[]): KnowledgeSource[] {
  return [...sources].sort((left, right) => {
    const statusDiff = getKnowledgeStatusDisplay(left.status).sortWeight
      - getKnowledgeStatusDisplay(right.status).sortWeight;
    if (statusDiff !== 0) return statusDiff;
    return (right.updated_at ?? 0) - (left.updated_at ?? 0);
  });
}

export function formatKnowledgeSize(size: number | null | undefined): string {
  if (!size || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** exponent;
  const precision = value >= 10 || exponent === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[exponent]}`;
}

function collectSearchValues(
  source: KnowledgeSource,
  statusLabel: string,
  sourceTypeLabel: string,
): string[] {
  return [
    source.id,
    source.project_id,
    source.project_name,
    source.room_id,
    source.room_name,
    source.source_type,
    source.source_id,
    source.title,
    source.mime_type,
    source.status,
    statusLabel,
    sourceTypeLabel,
    source.summary,
    source.error,
    source.parser,
    source.parser_version,
    ...(source.tags ?? []),
    ...flattenMetadataValues(source.metadata),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function flattenMetadataValues(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => flattenMetadataValues(item));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
      key,
      ...flattenMetadataValues(item),
    ]);
  }
  return [];
}

function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}
