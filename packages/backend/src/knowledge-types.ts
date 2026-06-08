export type KnowledgeSourceType =
  | 'resource_asset'
  | 'uploaded_file'
  | 'agent_document'
  | 'message'
  | 'task'
  | 'workspace_file'
  | 'workspace_doc'
  | 'web_page'
  | 'session_note'
  | 'url'
  | 'manual';

export type KnowledgeStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'stale' | 'disabled';

export type KnowledgeChunkType = 'plain_text' | 'markdown' | 'code' | 'table' | 'summary' | 'body';

export interface KnowledgeSource {
  id: string;
  project_id: string;
  room_id: string | null;
  source_type: KnowledgeSourceType;
  source_id: string;
  title: string;
  description: string | null;
  mime_type: string | null;
  size: number | null;
  uri: string | null;
  content_hash: string | null;
  parser: string | null;
  parser_version: string | null;
  summary: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  status: KnowledgeStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
  indexed_at: number | null;
  last_processed_at: number | null;
}

export interface KnowledgeSourceListItem extends KnowledgeSource {
  chunk_count: number;
  latest_extraction_id: string | null;
  latest_extraction_at: number | null;
}

export interface KnowledgeExtraction {
  id: string;
  source_id: string;
  plain_text: string;
  markdown: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
}

export interface KnowledgeChunk {
  id: string;
  source_id: string;
  extraction_id: string | null;
  chunk_index: number;
  chunk_type: KnowledgeChunkType;
  heading: string | null;
  content: string;
  token_estimate: number | null;
  enabled: 0 | 1;
  metadata: Record<string, unknown>;
  created_at: number;
}

export interface KnowledgeCitation {
  source_id: string;
  source_type: KnowledgeSourceType;
  source_title: string;
  external_source_id: string;
  chunk_id: string;
  chunk_index: number;
  heading: string | null;
  room_id: string | null;
}

export interface KnowledgeSearchResult {
  chunk_id: string;
  source_id: string;
  external_source_id: string;
  project_id: string;
  source_type: KnowledgeSourceType;
  title: string;
  tags: string[];
  chunk_index: number;
  chunk_type: KnowledgeChunkType;
  heading: string | null;
  content: string;
  snippet: string;
  score: number;
  metadata: Record<string, unknown>;
  citation: KnowledgeCitation;
}
