import type { KnowledgeSource } from './knowledge-types.js';
import { hashText, splitKnowledgeChunks, summarizeKnowledgeText } from './knowledge-extraction.js';
import { knowledgeRepo } from './repos/knowledge.js';
import { projectRepo } from './repos/projects.js';
import { sessionMessageRepo, sessionRepo } from './repos/sessions.js';

const MAX_NOTE_TITLE_CHARS = 80;
const MAX_METADATA_ITEMS = 8;
const MAX_METADATA_ITEM_CHARS = 240;

export interface SessionKnowledgeNoteMetadata {
  decisions: string[];
  constraints: string[];
  risks: string[];
  learnings: string[];
}

export interface SessionKnowledgeNoteResult {
  source: KnowledgeSource;
  deduplicated: boolean;
  metadata: SessionKnowledgeNoteMetadata;
}

export function createSessionKnowledgeNote(input: {
  sessionId: string;
  messageId?: string | null;
  title?: string | null;
  content?: string | null;
}): SessionKnowledgeNoteResult {
  const session = sessionRepo.get(input.sessionId);
  if (!session) throw new Error('session not found');
  const project = projectRepo.get(session.project_id);
  if (!project) throw new Error('project not found');

  const sourceMessage = input.messageId ? sessionMessageRepo.get(input.messageId) : undefined;
  if (input.messageId && !sourceMessage) throw new Error('message not found');
  if (sourceMessage && sourceMessage.session_id !== session.id) {
    throw new Error('message does not belong to session');
  }

  const content = normalizeNoteContent(input.content ?? sourceMessage?.content ?? '');
  if (!content) throw new Error('knowledge note content is required');

  const contentHash = hashText(content);
  const sourceId = `session_note:${session.id}:${contentHash.slice(0, 24)}`;
  const metadata = extractSessionKnowledgeNoteMetadata(content);
  const existing = knowledgeRepo.getSourceByExternalId({
    projectId: project.id,
    sourceType: 'session_note',
    sourceId,
  });
  if (existing) {
    return {
      source: existing,
      deduplicated: true,
      metadata: readNoteMetadata(existing.metadata),
    };
  }

  const title = buildNoteTitle(input.title, content, metadata);
  const summary = summarizeKnowledgeText(content, title);
  let source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'session_note',
    source_id: sourceId,
    title,
    mime_type: 'text/markdown',
    size: Buffer.byteLength(content),
    status: 'processing',
    content_hash: contentHash,
    parser: 'session-note',
    parser_version: '1',
    summary: null,
    tags: [],
    metadata: buildSourceMetadata({
      sessionId: session.id,
      messageId: sourceMessage?.id ?? input.messageId ?? null,
      sourceRole: sourceMessage?.role ?? null,
      sourceAgentId: sourceMessage?.sender_id ?? null,
      contentHash,
      metadata,
    }),
  });
  const extraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: content,
    markdown: content,
    metadata: {
      session_id: session.id,
      source_message_id: sourceMessage?.id ?? input.messageId ?? null,
      content_hash: contentHash,
    },
  });
  const chunks = splitKnowledgeChunks({ title, text: content });
  knowledgeRepo.replaceChunks({
    source_id: source.id,
    extraction_id: extraction.id,
    chunks: chunks.map((chunk) => ({
      ...chunk,
      project_id: project.id,
      room_id: null,
    })),
  });
  source = knowledgeRepo.updateSourceStatus(source.id, {
    status: 'ready',
    error: null,
    summary: summary.summary,
    tags: mergeTags(['会话沉淀'], summary.tags),
    metadata: buildSourceMetadata({
      sessionId: session.id,
      messageId: sourceMessage?.id ?? input.messageId ?? null,
      sourceRole: sourceMessage?.role ?? null,
      sourceAgentId: sourceMessage?.sender_id ?? null,
      contentHash,
      metadata,
      keyPoints: summary.keyPoints,
      contentKind: summary.contentKind,
    }),
    last_processed_at: Date.now(),
  }) ?? source;

  return {
    source,
    deduplicated: false,
    metadata,
  };
}

export function extractSessionKnowledgeNoteMetadata(content: string): SessionKnowledgeNoteMetadata {
  const lines = content
    .split(/\r?\n/)
    .map((line) => normalizeMetadataLine(line))
    .filter(Boolean);
  return {
    decisions: collectMetadataItems(lines, [
      /决策|决定|结论|采用|确认|选型/u,
    ]),
    constraints: collectMetadataItems(lines, [
      /约束|限制|不做|禁止|必须|边界/u,
    ]),
    risks: collectMetadataItems(lines, [
      /风险|问题|阻塞|失败|注意/u,
    ]),
    learnings: collectMetadataItems(lines, [
      /经验|教训|复盘|正确做法|学到/u,
    ]),
  };
}

function normalizeNoteContent(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
}

function buildNoteTitle(
  explicitTitle: string | null | undefined,
  content: string,
  metadata: SessionKnowledgeNoteMetadata,
): string {
  const normalizedTitle = explicitTitle?.trim();
  if (normalizedTitle) return truncateTitle(normalizedTitle);
  const markdownTitle = content.match(/^#{1,2}\s+(.+?)\s*$/m)?.[1]?.trim();
  if (markdownTitle) return truncateTitle(markdownTitle);
  const firstDecision = metadata.decisions[0]?.trim();
  if (firstDecision) return truncateTitle(firstDecision.replace(/^(决策|决定|结论)[:：]\s*/u, ''));
  const firstLine = content.split(/\n+/).map((line) => normalizeMetadataLine(line)).find(Boolean);
  return truncateTitle(firstLine || '会话知识笔记');
}

function truncateTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= MAX_NOTE_TITLE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_NOTE_TITLE_CHARS - 3).trimEnd()}...`;
}

function normalizeMetadataLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectMetadataItems(lines: string[], patterns: RegExp[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    const normalized = truncateMetadataItem(line);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(normalized);
    if (items.length >= MAX_METADATA_ITEMS) break;
  }
  return items;
}

function truncateMetadataItem(value: string): string {
  const normalized = value.trim();
  return normalized.length <= MAX_METADATA_ITEM_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_METADATA_ITEM_CHARS - 3).trimEnd()}...`;
}

function buildSourceMetadata(input: {
  sessionId: string;
  messageId: string | null;
  sourceRole: string | null;
  sourceAgentId: string | null;
  contentHash: string;
  metadata: SessionKnowledgeNoteMetadata;
  keyPoints?: string[];
  contentKind?: string;
}): Record<string, unknown> {
  return {
    session_id: input.sessionId,
    source_message_id: input.messageId,
    source_role: input.sourceRole,
    source_agent_id: input.sourceAgentId,
    content_hash: input.contentHash,
    decisions: input.metadata.decisions,
    constraints: input.metadata.constraints,
    risks: input.metadata.risks,
    learnings: input.metadata.learnings,
    key_points: input.keyPoints ?? [],
    content_kind: input.contentKind ?? '知识笔记',
  };
}

function readNoteMetadata(metadata: Record<string, unknown>): SessionKnowledgeNoteMetadata {
  return {
    decisions: readStringArray(metadata.decisions),
    constraints: readStringArray(metadata.constraints),
    risks: readStringArray(metadata.risks),
    learnings: readStringArray(metadata.learnings),
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function mergeTags(...groups: string[][]): string[] {
  return [...new Set(groups.flat().map((tag) => tag.trim()).filter(Boolean))].slice(0, 8);
}
