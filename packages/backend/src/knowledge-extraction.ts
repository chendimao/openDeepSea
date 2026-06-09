import { createHash } from 'node:crypto';
import type { KnowledgeChunkType } from './knowledge-types.js';
import {
  buildParserMetadata,
  extractCsvTableMetadata,
  extractStructuredTextMetadata,
  isSidecarDocument,
} from './knowledge-parser-capabilities.js';

const TEXT_MIME_MARKERS = ['text/', 'json', 'xml', 'yaml', 'csv', 'markdown'];
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.json', '.csv', '.yaml', '.yml', '.xml'];

export interface KnowledgeExtractInput {
  title: string;
  mimeType: string | null;
  content: string | null;
}

export interface KnowledgeExtractResult {
  parser: string;
  parserVersion: string;
  plainText: string;
  markdown: string | null;
  layout: Record<string, unknown> | null;
  table: Record<string, unknown> | null;
  image: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  contentHash: string;
}

export interface KnowledgeSummaryResult {
  summary: string;
  tags: string[];
  keyPoints: string[];
  contentKind: string;
}

export interface KnowledgeChunkDraft {
  chunk_index: number;
  chunk_type: KnowledgeChunkType;
  title: string;
  content: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  page_start: number | null;
  page_end: number | null;
  token_estimate: number;
  content_hash: string;
  enabled: 0 | 1;
}

export async function extractKnowledgeText(input: KnowledgeExtractInput): Promise<KnowledgeExtractResult> {
  const mimeType = (input.mimeType ?? '').toLowerCase();
  if (mimeType.startsWith('image/')) {
    const metadata = buildParserMetadata({
      title: input.title,
      mimeType: input.mimeType,
      parser: 'image-metadata',
      status: 'metadata_only',
      capabilities: ['metadata', 'image_metadata'],
      warnings: ['OCR sidecar is not configured'],
      requiresSidecar: true,
    });
    return {
      parser: 'image-metadata',
      parserVersion: '1',
      plainText: '',
      markdown: null,
      layout: null,
      table: null,
      image: { kind: 'image', title: input.title, mimeType: input.mimeType },
      metadata,
      contentHash: hashText(`${input.title}:${input.mimeType ?? ''}`),
    };
  }

  if (!isTextLike(input.title, mimeType) || input.content === null) {
    const requiresSidecar = isSidecarDocument(input.title, mimeType);
    const parser = requiresSidecar ? 'sidecar-required' : 'metadata-only';
    return {
      parser,
      parserVersion: '1',
      plainText: '',
      markdown: null,
      layout: null,
      table: null,
      image: null,
      metadata: buildParserMetadata({
        title: input.title,
        mimeType: input.mimeType,
        parser,
        status: requiresSidecar ? 'requires_sidecar' : 'metadata_only',
        capabilities: ['metadata'],
        warnings: requiresSidecar
          ? ['Document parser sidecar is not configured']
          : ['No text parser is available for this source type'],
        requiresSidecar,
      }),
      contentHash: hashText(`${input.title}:${input.mimeType ?? ''}`),
    };
  }

  const normalized = normalizeText(input.content);
  const markdown = isMarkdown(input.title, mimeType) ? normalized : null;
  const csv = isTableLike(input.title, mimeType) ? extractCsvTableMetadata(normalized) : null;
  const structured = extractStructuredTextMetadata({
    title: input.title,
    mimeType,
    content: normalized,
  });
  const extraMetadata: Record<string, unknown> = {
    ...(csv?.metadata ?? {}),
    ...(structured?.metadata ?? {}),
  };
  const parserWarnings = Array.isArray(extraMetadata.parser_warnings)
    ? extraMetadata.parser_warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  delete extraMetadata.parser_warnings;
  return {
    parser: 'builtin-text',
    parserVersion: '1',
    plainText: normalized,
    markdown,
    layout: structured?.layout ?? null,
    table: csv?.table ?? null,
    image: null,
    metadata: buildParserMetadata({
      title: input.title,
      mimeType: input.mimeType,
      parser: 'builtin-text',
      status: 'complete',
      capabilities: [
        'text',
        ...(markdown ? ['markdown'] : []),
        ...(csv ? ['table'] : []),
        ...(structured ? ['structure'] : []),
        'chunks',
      ],
      warnings: parserWarnings,
      extras: extraMetadata,
    }),
    contentHash: hashText(normalized),
  };
}

export function summarizeKnowledgeText(text: string, title: string): KnowledgeSummaryResult {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const keyPoints = lines
    .slice(0, 5)
    .map((line) => line.replace(/^#+\s*/, '').slice(0, 160));
  const summaryBase = keyPoints.length > 0 ? keyPoints.join('；') : `${title} 暂无可提取文本内容`;

  return {
    summary: summaryBase.slice(0, 300),
    tags: deriveTags(`${title}\n${text}`).slice(0, 8),
    keyPoints,
    contentKind: inferContentKind(title, text),
  };
}

export function splitKnowledgeChunks(input: {
  title: string;
  text: string;
  maxChars?: number;
}): KnowledgeChunkDraft[] {
  const maxChars = Math.max(12, input.maxChars ?? 1800);
  const text = normalizeText(input.text);
  if (!text) return [];

  const chunks: KnowledgeChunkDraft[] = [];
  let offset = 0;
  while (offset < text.length) {
    const content = text.slice(offset, offset + maxChars);
    chunks.push({
      chunk_index: chunks.length,
      chunk_type: 'body',
      title: input.title,
      content,
      summary: content.slice(0, 160),
      metadata: { tags: deriveTags(content).slice(0, 5) },
      page_start: null,
      page_end: null,
      token_estimate: estimateTokens(content),
      content_hash: hashText(content),
      enabled: 1,
    });
    offset += maxChars;
  }

  return chunks;
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isTextLike(title: string, mimeType: string): boolean {
  const lowerTitle = title.toLowerCase();
  return TEXT_MIME_MARKERS.some((marker) => mimeType.includes(marker)) ||
    TEXT_EXTENSIONS.some((extension) => lowerTitle.endsWith(extension));
}

function isMarkdown(title: string, mimeType: string): boolean {
  const lowerTitle = title.toLowerCase();
  return mimeType.includes('markdown') || lowerTitle.endsWith('.md') || lowerTitle.endsWith('.markdown');
}

function isTableLike(title: string, mimeType: string): boolean {
  return mimeType.includes('csv') || title.toLowerCase().endsWith('.csv');
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function deriveTags(value: string): string[] {
  const candidates = [
    ['Markdown', /markdown|\.md/i],
    ['图片', /image|png|jpg|jpeg|webp|gif|截图|图片/i],
    ['表格', /csv|xlsx|表格|清单/i],
    ['设计', /设计|布局|UI|视觉/i],
    ['验收', /验收|测试|验证/i],
    ['计划', /计划|任务|路线/i],
    ['风险', /风险|失败|错误/i],
    ['知识库', /知识库|资源库|索引/i],
  ] as const;
  const tags = candidates
    .filter(([, pattern]) => pattern.test(value))
    .map(([tag]) => tag);
  return tags.length > 0 ? [...new Set(tags)] : ['资料'];
}

function inferContentKind(title: string, text: string): string {
  const corpus = `${title}\n${text}`;
  if (/验收|测试|验证/.test(corpus)) return '验收';
  if (/设计|布局|UI|视觉/.test(corpus)) return '设计';
  if (/风险|约束|决定|结论/.test(corpus)) return '决策';
  if (/清单|csv|xlsx|表格/i.test(corpus)) return '表格';
  return '资料';
}
