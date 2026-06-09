import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-rag-')), 'test.db');

const { db } = await import('./db.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const {
  listKnowledgeSourcesForAgent,
  readKnowledgeChunkForAgent,
  readKnowledgeSourceSummaryForAgent,
  searchKnowledgeForAgent,
} = await import('./knowledge-rag.js');

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-rag-${name}-`)),
  });
}

function createReadySource(input: {
  projectId: string;
  roomId?: string | null;
  title: string;
  summary?: string | null;
  extractionText?: string;
  chunks: string[];
}) {
  const source = knowledgeRepo.ensureSource({
    project_id: input.projectId,
    room_id: input.roomId ?? null,
    source_type: 'uploaded_file',
    source_id: `${input.title}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: input.title,
    status: 'ready',
    summary: input.summary ?? null,
    tags: ['RAG', '验收'],
    metadata: { storage_path: '/tmp/should-not-leak.md' },
  });
  const extraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: input.extractionText ?? input.chunks.join('\n'),
    markdown: input.extractionText ?? input.chunks.join('\n'),
  });
  const chunks = knowledgeRepo.replaceChunks({
    source_id: source.id,
    extraction_id: extraction.id,
    chunks: input.chunks.map((content, index) => ({
      chunk_index: index,
      chunk_type: 'body',
      heading: `Section ${index + 1}`,
      content,
      token_estimate: content.length,
      metadata: { page_start: index + 1, storage_path: '/tmp/should-not-leak.md' },
    })),
  });
  return { source, extraction, chunks };
}

test('searchKnowledgeForAgent returns hybrid citations and records agent usage refs', () => {
  const project = createProject('search');
  const room = roomRepo.create({ project_id: project.id, name: 'RAG Room' });
  const { source, chunks } = createReadySource({
    projectId: project.id,
    roomId: room.id,
    title: 'A12 runbook',
    summary: 'A12 部署操作手册',
    chunks: [
      'A12 deployment requires database backup and smoke verification.',
      'A12 rollback uses the previous package.',
    ],
  });

  const response = searchKnowledgeForAgent({
    projectId: project.id,
    roomId: room.id,
    query: 'A12 deployment',
    limit: 3,
    usage: {
      refType: 'agent_run',
      refId: 'agent-run-1',
      metadata: { agent_id: 'planner' },
    },
  });

  assert.equal(response.source, 'openclaw.knowledge.search');
  assert.equal(response.scope.project_id, project.id);
  assert.equal(response.scope.room_id, room.id);
  assert.equal(response.retrieval_mode, 'hybrid');
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.source_id, source.id);
  assert.equal(response.results[0]?.chunk_id, chunks[0]?.id);
  assert.match(response.results[0]?.content ?? '', /database backup/);
  assert.equal(response.citations[0]?.key, `knowledge:${source.id}#chunk:${chunks[0]?.id}`);
  assert.equal(knowledgeRepo.countUsageRefs(source.id), 1);

  const usageRow = db.prepare('SELECT ref_type, ref_id, metadata_json FROM knowledge_usage_refs WHERE source_id = ?').get(source.id) as
    | { ref_type: string; ref_id: string; metadata_json: string }
    | undefined;
  assert.equal(usageRow?.ref_type, 'agent_run');
  assert.equal(usageRow?.ref_id, 'agent-run-1');
  assert.match(usageRow?.metadata_json ?? '', /planner/);
  assert.match(usageRow?.metadata_json ?? '', /hybrid/);
  assert.match(usageRow?.metadata_json ?? '', /A12 deployment/);
});

test('searchKnowledgeForAgent supports explicit keyword search mode', () => {
  const project = createProject('search-mode');
  createReadySource({
    projectId: project.id,
    title: 'A12 mode runbook',
    chunks: ['A12 mode search content.'],
  });

  const response = searchKnowledgeForAgent({
    projectId: project.id,
    query: 'A12 mode',
    mode: 'keyword',
  });

  assert.equal(response.retrieval_mode, 'keyword');
  assert.equal(response.results.length, 1);
});

test('readKnowledgeChunkForAgent rejects chunks outside the project scope', () => {
  const project = createProject('chunk-project');
  const otherProject = createProject('chunk-other');
  const { chunks } = createReadySource({
    projectId: otherProject.id,
    title: 'Foreign runbook',
    chunks: ['Foreign A12 deployment notes.'],
  });

  assert.throws(
    () => readKnowledgeChunkForAgent({ projectId: project.id, chunkId: chunks[0]!.id }),
    /knowledge chunk not found/,
  );
});

test('readKnowledgeSourceSummaryForAgent returns short full context and downgrades long full context', () => {
  const project = createProject('summary');
  const short = createReadySource({
    projectId: project.id,
    title: 'Short note',
    summary: '短资料摘要',
    extractionText: '短资料可以完整注入。',
    chunks: ['短资料可以完整注入。'],
  });
  const long = createReadySource({
    projectId: project.id,
    title: 'Long note',
    summary: '长资料摘要',
    extractionText: 'A'.repeat(90_000),
    chunks: ['A'.repeat(20_000)],
  });

  const full = readKnowledgeSourceSummaryForAgent({
    projectId: project.id,
    sourceId: short.source.id,
    mode: 'auto',
  });
  assert.equal(full.retrieval_mode, 'full_context');
  assert.match(full.results.content ?? '', /完整注入/);
  assert.equal(full.results.truncated, false);

  const downgraded = readKnowledgeSourceSummaryForAgent({
    projectId: project.id,
    sourceId: long.source.id,
    mode: 'full',
  });
  assert.equal(downgraded.retrieval_mode, 'summary');
  assert.equal(downgraded.results.content, undefined);
  assert.match(downgraded.warnings?.join('\n') ?? '', /full_context_unavailable/);
});

test('listKnowledgeSourcesForAgent returns safe source summaries without local paths', () => {
  const project = createProject('list');
  const room = roomRepo.create({ project_id: project.id, name: 'List Room' });
  const { source } = createReadySource({
    projectId: project.id,
    roomId: room.id,
    title: 'List source',
    summary: '可列出的知识源',
    chunks: ['List source content.'],
  });

  const response = listKnowledgeSourcesForAgent({
    projectId: project.id,
    roomId: room.id,
    limit: 10,
  });

  assert.equal(response.source, 'openclaw.knowledge.list_sources');
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.id, source.id);
  assert.equal(response.results[0]?.title, 'List source');
  assert.equal(JSON.stringify(response).includes('/tmp/should-not-leak'), false);
});
