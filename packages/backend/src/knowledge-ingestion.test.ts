import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectFile } from './types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-ingestion-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { fileRepo } = await import('./repos/files.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const { ingestProjectFileIntoKnowledge } = await import('./knowledge-ingestion.js');

test('ingestProjectFileIntoKnowledge indexes uploaded text file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-ingestion-project-'));
  const storedPath = join(root, 'notes.txt');
  writeFileSync(storedPath, '深海知识库说明\n部署 A12 浮标。');
  const project = projectRepo.create({ name: 'Knowledge Ingestion', path: root });
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'notes.txt',
    stored_name: 'notes.txt',
    mime_type: 'text/plain',
    size: 64,
    url: `/uploads/files/${project.id}/notes.txt`,
    storage_path: storedPath,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  const source = await ingestProjectFileIntoKnowledge(file);

  assert.equal(source.status, 'ready');
  assert.equal(source.source_type, 'uploaded_file');
  assert.equal(source.source_id, file.id);
  assert.ok(knowledgeRepo.getLatestExtraction(source.id)?.plain_text?.includes('A12'));
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: 'A12' }).length, 1);
});

test('ingestProjectFileIntoKnowledge preserves agent document source metadata when ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-ingestion-agent-'));
  const project = projectRepo.create({ name: 'Agent Knowledge Ingestion', path: root });
  const file = createAgentDocumentFile({
    projectId: project.id,
    content: '智能体任务产物\n部署 A12 浮标。',
    sourceAgentId: 'agent-planner',
    sourceTaskId: 'task-42',
  });

  const source = await ingestProjectFileIntoKnowledge(file);

  assert.equal(source.status, 'ready');
  assert.equal(source.error, null);
  assert.equal(source.source_type, 'agent_document');
  assert.equal(source.source_id, file.id);
  assert.equal(source.metadata.file_id, file.id);
  assert.equal(source.metadata.source_label, '智能体生成');
  assert.equal(source.metadata.source_agent_id, 'agent-planner');
  assert.equal(source.metadata.source_task_id, 'task-42');
  assert.deepEqual(source.metadata.key_points, ['智能体任务产物', '部署 A12 浮标。']);
});

test('ingestProjectFileIntoKnowledge records source error then clears it after successful re-ingest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-ingestion-retry-'));
  const project = projectRepo.create({ name: 'Retry Knowledge Ingestion', path: root });
  const failedFile = createAgentDocumentFile({
    projectId: project.id,
    id: 'asset:retry-agent-doc',
    storedName: 'retry-agent-doc',
    content: null,
    sourceAgentId: 'agent-reviewer',
    sourceTaskId: 'task-retry',
  });

  const failedSource = await ingestProjectFileIntoKnowledge(failedFile);

  assert.equal(failedSource.status, 'failed');
  assert.match(failedSource.error ?? '', /agent document content is missing/);
  assert.equal(failedSource.metadata.source_agent_id, 'agent-reviewer');
  assert.equal(failedSource.metadata.source_task_id, 'task-retry');
  assert.equal(knowledgeRepo.getLatestExtraction(failedSource.id)?.metadata.error, failedSource.error);

  const readySource = await ingestProjectFileIntoKnowledge({
    ...failedFile,
    content: '重试后生成有效内容。\n部署 A12 浮标。',
    size: 48,
  });

  assert.equal(readySource.id, failedSource.id);
  assert.equal(readySource.status, 'ready');
  assert.equal(readySource.error, null);
  assert.equal(readySource.metadata.source_agent_id, 'agent-reviewer');
  assert.equal(readySource.metadata.source_task_id, 'task-retry');
  assert.equal(knowledgeRepo.getLatestExtraction(readySource.id)?.metadata.error, null);
});

test('ingestProjectFileIntoKnowledge fails agent document with null content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-ingestion-null-agent-'));
  const project = projectRepo.create({ name: 'Null Agent Knowledge Ingestion', path: root });
  const file = createAgentDocumentFile({
    projectId: project.id,
    id: 'asset:null-agent-doc',
    storedName: 'null-agent-doc',
    content: null,
  });

  const source = await ingestProjectFileIntoKnowledge(file);

  assert.equal(source.status, 'failed');
  assert.match(source.error ?? '', /agent document content is missing/);
  assert.equal(knowledgeRepo.listChunks(source.id).length, 0);
});

test('ingestProjectFileIntoKnowledge clears stale chunks when re-ingest fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-ingestion-stale-'));
  const project = projectRepo.create({ name: 'Stale Knowledge Ingestion', path: root });
  const readyFile = createAgentDocumentFile({
    projectId: project.id,
    id: 'asset:stale-agent-doc',
    storedName: 'stale-agent-doc',
    content: '旧内容会被索引。\n部署 STALE_A12 浮标。',
  });

  const readySource = await ingestProjectFileIntoKnowledge(readyFile);
  assert.equal(readySource.status, 'ready');
  assert.equal(knowledgeRepo.listChunks(readySource.id).length, 1);
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: 'STALE_A12' }).length, 1);

  const failedSource = await ingestProjectFileIntoKnowledge({
    ...readyFile,
    content: null,
    size: 0,
  });

  assert.equal(failedSource.id, readySource.id);
  assert.equal(failedSource.status, 'failed');
  assert.match(failedSource.error ?? '', /agent document content is missing/);
  assert.equal(knowledgeRepo.listChunks(failedSource.id).length, 0);
  assert.equal(knowledgeRepo.search({
    projectId: project.id,
    query: 'STALE_A12',
    statuses: ['failed'],
  }).length, 0);
});

test('ingestProjectFileIntoKnowledge truncates oversized text before saving and records metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-ingestion-truncate-'));
  const storedPath = join(root, 'oversized.txt');
  writeFileSync(storedPath, `${'A'.repeat(250_000)}TAIL_SHOULD_NOT_BE_INDEXED`);
  const project = projectRepo.create({ name: 'Truncated Knowledge Ingestion', path: root });
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'oversized.txt',
    stored_name: 'oversized.txt',
    mime_type: 'text/plain',
    size: 250_026,
    url: `/uploads/files/${project.id}/oversized.txt`,
    storage_path: storedPath,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  const source = await ingestProjectFileIntoKnowledge(file);

  assert.equal(source.status, 'ready');
  assert.equal(source.metadata.truncated, true);
  assert.equal(source.metadata.original_char_count, 250_026);
  assert.equal(source.metadata.indexed_char_count, 200_000);
  const extraction = knowledgeRepo.getLatestExtraction(source.id);
  assert.equal(extraction?.plain_text.length, 200_000);
  assert.equal(extraction?.plain_text.includes('TAIL_SHOULD_NOT_BE_INDEXED'), false);
});

function createAgentDocumentFile(input: {
  projectId: string;
  id?: string;
  storedName?: string;
  content: string | null;
  sourceAgentId?: string | null;
  sourceTaskId?: string | null;
}): ProjectFile {
  return {
    id: input.id ?? 'asset:agent-doc-1',
    project_id: input.projectId,
    source_type: 'agent_document',
    original_name: 'agent-doc.md',
    stored_name: input.storedName ?? 'agent-doc-1',
    mime_type: 'text/markdown',
    size: input.content === null ? 0 : Buffer.byteLength(input.content),
    url: '',
    storage_path: '',
    uploaded_by_id: null,
    uploaded_by_name: null,
    source_message_id: null,
    source_room_id: null,
    source_agent_id: input.sourceAgentId ?? null,
    source_task_id: input.sourceTaskId ?? null,
    source_display_name: input.sourceAgentId ?? '智能体',
    source_label: '智能体生成',
    source_context_id: input.sourceTaskId ?? null,
    source_context_name: input.sourceTaskId ? '任务' : null,
    source_context_type: input.sourceTaskId ? 'task' : null,
    content: input.content,
    created_at: Date.now(),
    deleted_at: null,
  };
}
