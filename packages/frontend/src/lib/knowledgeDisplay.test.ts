import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterKnowledgeSources,
  getKnowledgeRetrievalModeDisplay,
  getKnowledgeStatusFilterOptions,
  getKnowledgeSourceTypeDisplay,
  getKnowledgeStatusDisplay,
  summarizeKnowledgeInsights,
  summarizeKnowledgeStats,
  type KnowledgeRetrievalMode,
  type KnowledgeSource,
  type KnowledgeSourceType,
} from './knowledgeDisplay';

test('knowledge status display maps label, tone, and sort weight in zh and en', () => {
  assert.deepEqual(getKnowledgeStatusDisplay('ready', 'zh'), {
    label: '已提取',
    tone: 'success',
    sortWeight: 50,
  });
  assert.deepEqual(getKnowledgeStatusDisplay('processing', 'en'), {
    label: 'Processing',
    tone: 'info',
    sortWeight: 20,
  });
  assert.equal(getKnowledgeStatusDisplay('failed', 'zh').label, '失败');
  assert.equal(getKnowledgeStatusDisplay('failed', 'zh').tone, 'danger');
  assert.equal(
    getKnowledgeStatusDisplay('failed', 'zh').sortWeight < getKnowledgeStatusDisplay('ready', 'zh').sortWeight,
    true,
  );
  assert.equal(
    getKnowledgeStatusDisplay('disabled', 'zh').sortWeight > getKnowledgeStatusDisplay('ready', 'zh').sortWeight,
    true,
  );
});

test('knowledge status filter options include pending for rail filters', () => {
  assert.deepEqual(getKnowledgeStatusFilterOptions(), [
    '',
    'ready',
    'pending',
    'processing',
    'failed',
    'stale',
    'disabled',
  ]);
});

test('knowledge source type display maps localized labels and icon keys', () => {
  assert.deepEqual(getKnowledgeSourceTypeDisplay('uploaded_file', 'zh'), {
    label: '上传文件',
    iconKey: 'file-up',
  });
  assert.deepEqual(getKnowledgeSourceTypeDisplay('agent_document', 'en'), {
    label: 'Agent document',
    iconKey: 'file-pen-line',
  });
  assert.equal(getKnowledgeSourceTypeDisplay('web_page', 'zh').label, '网页导入');
  assert.equal(getKnowledgeSourceTypeDisplay('session_note', 'en').iconKey, 'message-square-text');
});

test('knowledge source type display covers backend source types and falls back for unknown types', () => {
  const backendSourceTypes: KnowledgeSourceType[] = [
    'resource_asset',
    'uploaded_file',
    'agent_document',
    'message',
    'task',
    'workspace_file',
    'workspace_doc',
    'web_page',
    'session_note',
    'url',
    'manual',
  ];

  for (const sourceType of backendSourceTypes) {
    const display = getKnowledgeSourceTypeDisplay(sourceType, 'zh');
    assert.notEqual(display.label, '');
    assert.notEqual(display.iconKey, '');
  }
  assert.deepEqual(getKnowledgeSourceTypeDisplay('external_feed', 'en'), {
    label: 'external_feed',
    iconKey: 'file-text',
  });
});

test('knowledge retrieval mode display maps labels and sort order', () => {
  assert.equal(getKnowledgeRetrievalModeDisplay('keyword', 'zh').label, '关键词');
  assert.equal(getKnowledgeRetrievalModeDisplay('vector_preview', 'zh').label, '向量预览');
  assert.equal(getKnowledgeRetrievalModeDisplay('hybrid', 'zh').label, '混合');
  const modes: KnowledgeRetrievalMode[] = ['hybrid', 'keyword', 'vector_preview'];
  assert.deepEqual(
    modes.sort((left, right) =>
      getKnowledgeRetrievalModeDisplay(left).sortWeight -
      getKnowledgeRetrievalModeDisplay(right).sortWeight,
    ),
    ['keyword', 'vector_preview', 'hybrid'],
  );
});

test('knowledge insights summarize actionable counts', () => {
  const summary = summarizeKnowledgeInsights({
    duplicates: { count: 2, source_ids: ['a', 'b'] },
    stale: { count: 1, source_ids: ['c'] },
    parser_incomplete: { count: 3, source_ids: ['d', 'e', 'f'] },
    empty_index: { count: 1, source_ids: ['g'] },
  });

  assert.equal(summary.totalIssues, 7);
  assert.equal(summary.items[0]?.key, 'parser_incomplete');
  assert.equal(summary.items[0]?.label, '解析待补全');
});

test('knowledge source filters compose keyword, status, source type, project, and room', () => {
  const sources = [
    createSource({
      id: 'source-uploaded-ready',
      project_id: 'project-alpha',
      project_name: 'Deepsea App',
      room_id: 'room-ui',
      room_name: '前端指挥室',
      source_type: 'uploaded_file',
      title: '知识库交互稿.pdf',
      status: 'ready',
      summary: '高密度资源工作台设计稿，包含 inspector 与 command bar。',
      tags: ['设计', '知识库'],
    }),
    createSource({
      id: 'source-agent-processing',
      project_id: 'project-alpha',
      project_name: 'Deepsea App',
      room_id: 'room-agent',
      room_name: 'Agent 联调',
      source_type: 'agent_document',
      title: '执行总结.md',
      status: 'processing',
      summary: '前端实现阶段输出。',
      tags: ['总结'],
    }),
    createSource({
      id: 'source-web-failed',
      project_id: 'project-beta',
      project_name: 'Docs Import',
      room_id: 'room-research',
      room_name: '调研',
      source_type: 'web_page',
      title: 'RAGFlow DeepDoc 调研',
      status: 'failed',
      summary: '解析外部网页失败。',
      tags: ['调研', 'OCR'],
      error: 'timeout',
    }),
  ];

  assert.deepEqual(
    filterKnowledgeSources(sources, { keyword: 'inspector' }).map((source) => source.id),
    ['source-uploaded-ready'],
  );
  assert.deepEqual(
    filterKnowledgeSources(sources, { status: 'processing' }).map((source) => source.id),
    ['source-agent-processing'],
  );
  assert.deepEqual(
    filterKnowledgeSources(sources, { sourceType: 'web_page' }).map((source) => source.id),
    ['source-web-failed'],
  );
  assert.deepEqual(
    filterKnowledgeSources(sources, { projectId: 'project-alpha', roomId: 'room-ui' }).map((source) => source.id),
    ['source-uploaded-ready'],
  );
  assert.deepEqual(
    filterKnowledgeSources(sources, {
      keyword: '调研',
      status: 'failed',
      sourceType: 'web_page',
      projectId: 'project-beta',
      roomId: 'room-research',
    }).map((source) => source.id),
    ['source-web-failed'],
  );
});

test('knowledge source keyword search includes backend error field', () => {
  const source = createSource({
    id: 'source-backend-error',
    status: 'failed',
    error: 'agent document content is missing',
  });

  assert.deepEqual(
    filterKnowledgeSources([source], { keyword: 'content is missing' }).map((item) => item.id),
    ['source-backend-error'],
  );
});

test('knowledge stats summarize totals, ready, processing, failed, chunks, and size', () => {
  const stats = summarizeKnowledgeStats([
    createSource({ id: 'ready-1', status: 'ready', size: 1000, chunk_count: 12 }),
    createSource({ id: 'processing-1', status: 'processing', size: 2000, chunk_count: 3 }),
    createSource({ id: 'pending-1', status: 'pending', size: 500, chunk_count: 0 }),
    createSource({ id: 'failed-1', status: 'failed', size: null, chunk_count: 1 }),
  ]);

  assert.deepEqual(stats, {
    total: 4,
    ready: 1,
    processing: 2,
    failed: 1,
    chunks: 16,
    totalSize: 3500,
  });
});

function createSource(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: 'source-1',
    project_id: 'project-1',
    project_name: 'Project One',
    room_id: null,
    room_name: null,
    source_type: 'uploaded_file',
    source_id: 'file-1',
    title: 'resource.md',
    mime_type: 'text/markdown',
    size: 128,
    status: 'ready',
    summary: 'Resource summary.',
    tags: [],
    metadata: null,
    chunk_count: 0,
    error: null,
    created_at: 1,
    updated_at: 1,
    last_processed_at: 1,
    reference_count: 0,
    ...overrides,
  };
}
