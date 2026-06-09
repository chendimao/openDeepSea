import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FetchLike } from './knowledge-embedding-provider.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-embedding-rebuild-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { settingsRepo } = await import('./repos/settings.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const { rebuildKnowledgeEmbeddings } = await import('./knowledge-embedding-rebuild.js');

test('rebuildKnowledgeEmbeddings rebuilds stale chunks and skips unchanged chunks', async () => {
  resetKnowledgeEmbeddingSettings();
  const project = createProject('stale-skip');
  const source = createReadySource(project.id, 'manual:stale-skip', 'A12 验收');
  const [chunk] = createChunks(source.id, [
    { heading: '截图', content: 'A12 验收需要截图。' },
  ]);

  const first = await rebuildKnowledgeEmbeddings({ projectId: project.id });

  assert.equal(first.project_id, project.id);
  assert.equal(first.provider, 'local-hash');
  assert.equal(first.model, 'local-hash-v1');
  assert.equal(first.scanned_chunks, 1);
  assert.equal(first.rebuilt_chunks, 1);
  assert.equal(first.skipped_chunks, 0);
  assert.deepEqual(first.failed_chunks, []);
  assert.equal(knowledgeRepo.getChunkEmbedding(chunk!.id)?.content_hash.length, 64);

  const second = await rebuildKnowledgeEmbeddings({ projectId: project.id });

  assert.equal(second.scanned_chunks, 1);
  assert.equal(second.rebuilt_chunks, 0);
  assert.equal(second.skipped_chunks, 1);
  assert.deepEqual(second.failed_chunks, []);
});

test('rebuildKnowledgeEmbeddings limit does not get stuck on already fresh chunks', async () => {
  resetKnowledgeEmbeddingSettings();
  const project = createProject('limit-fresh-prefix');
  const source = createReadySource(project.id, 'manual:limit-fresh-prefix', 'Limit Fresh Prefix');
  createChunks(source.id, [
    { heading: 'First', content: 'first chunk' },
    { heading: 'Second', content: 'second chunk' },
  ]);

  const first = await rebuildKnowledgeEmbeddings({ projectId: project.id, limit: 1 });
  const second = await rebuildKnowledgeEmbeddings({ projectId: project.id, limit: 1 });
  const third = await rebuildKnowledgeEmbeddings({ projectId: project.id, limit: 1 });

  assert.equal(first.scanned_chunks, 1);
  assert.equal(first.rebuilt_chunks, 1);
  assert.equal(first.skipped_chunks, 0);
  assert.equal(second.scanned_chunks, 2);
  assert.equal(second.rebuilt_chunks, 1);
  assert.equal(second.skipped_chunks, 1);
  assert.equal(third.scanned_chunks, 2);
  assert.equal(third.rebuilt_chunks, 0);
  assert.equal(third.skipped_chunks, 2);
});

test('rebuildKnowledgeEmbeddings reaches stale sources beyond the first source page', async () => {
  resetKnowledgeEmbeddingSettings();
  const project = createProject('source-page-starvation');
  const staleSource = createReadySource(project.id, 'manual:source-page-stale', 'Old Stale Source');
  const [staleChunk] = createChunks(staleSource.id, [
    { heading: 'Stale', content: 'stale source after fresh page' },
  ]);

  for (let index = 0; index < 500; index += 1) {
    const source = createReadySource(
      project.id,
      `manual:source-page-fresh-${index}`,
      `Fresh Source ${index}`,
    );
    createChunks(source.id, [
      { heading: 'Fresh', content: `fresh source ${index}` },
    ]);
    await rebuildKnowledgeEmbeddings({ projectId: project.id, sourceId: source.id });
  }

  const result = await rebuildKnowledgeEmbeddings({ projectId: project.id, limit: 1 });

  assert.equal(result.rebuilt_chunks, 1);
  assert.ok(knowledgeRepo.getChunkEmbedding(staleChunk!.id));
});

test('rebuildKnowledgeEmbeddings ignores disabled chunks', async () => {
  resetKnowledgeEmbeddingSettings();
  const project = createProject('disabled-chunks');
  const source = createReadySource(project.id, 'manual:disabled-chunks', 'Disabled Chunks');
  const [disabledChunk, enabledChunk] = createChunks(source.id, [
    { heading: 'Disabled', content: 'disabled chunk', enabled: 0 },
    { heading: 'Enabled', content: 'enabled chunk' },
  ]);

  const result = await rebuildKnowledgeEmbeddings({ projectId: project.id });

  assert.equal(result.scanned_chunks, 1);
  assert.equal(result.rebuilt_chunks, 1);
  assert.equal(knowledgeRepo.getChunkEmbedding(disabledChunk!.id), undefined);
  assert.ok(knowledgeRepo.getChunkEmbedding(enabledChunk!.id));
});

test('rebuildKnowledgeEmbeddings rejects missing projects', async () => {
  await assert.rejects(
    () => rebuildKnowledgeEmbeddings({ projectId: 'missing-project' }),
    /project not found/,
  );
});

test('rebuildKnowledgeEmbeddings rebuilds when provider model changes with unchanged content hash', async () => {
  const envVarName = 'OPENDEEPSEA_REBUILD_MODEL_CHANGE_KEY';
  process.env[envVarName] = 'sk-model-change-secret';
  resetKnowledgeEmbeddingSettings();
  const project = createProject('model-change');
  const source = createReadySource(project.id, 'manual:model-change', 'Model Change');
  const [chunk] = createChunks(source.id, [
    { heading: 'Content', content: 'same content hash' },
  ]);

  const localResult = await rebuildKnowledgeEmbeddings({ projectId: project.id });
  const localEmbedding = knowledgeRepo.getChunkEmbedding(chunk!.id);

  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: 'https://embedding-model-change.example/v1',
    knowledge_embedding_api_key_env_var: envVarName,
  });
  const openAiResult = await rebuildKnowledgeEmbeddings({
    projectId: project.id,
    fetchImpl: async () => Response.json({ data: [{ embedding: [7, 8, 9] }] }),
  });
  const openAiEmbedding = knowledgeRepo.getChunkEmbedding(chunk!.id);

  assert.equal(localResult.rebuilt_chunks, 1);
  assert.equal(openAiResult.scanned_chunks, 1);
  assert.equal(openAiResult.rebuilt_chunks, 1);
  assert.equal(openAiResult.skipped_chunks, 0);
  assert.equal(localEmbedding?.content_hash, openAiEmbedding?.content_hash);
  assert.equal(openAiEmbedding?.provider, 'openai-compatible');
  assert.equal(openAiEmbedding?.model, 'text-embedding-3-small');
  assert.deepEqual(openAiEmbedding?.vector, [7, 8, 9]);
});

test('rebuildKnowledgeEmbeddings rebuilds known provider dimension mismatches', async () => {
  resetKnowledgeEmbeddingSettings();
  const project = createProject('dimension-mismatch');
  const source = createReadySource(project.id, 'manual:dimension-mismatch', 'Dimension Mismatch');
  const [chunk] = createChunks(source.id, [
    { heading: 'Heading', content: 'dimension mismatch chunk' },
  ]);

  await rebuildKnowledgeEmbeddings({ projectId: project.id });
  const existing = knowledgeRepo.getChunkEmbedding(chunk!.id);
  assert.ok(existing);
  knowledgeRepo.upsertChunkEmbedding({
    chunk_id: chunk!.id,
    source_id: source.id,
    project_id: project.id,
    provider: existing.provider,
    model: existing.model,
    dimensions: 8,
    vector: new Array(8).fill(0),
    content_hash: existing.content_hash,
  });

  const result = await rebuildKnowledgeEmbeddings({ projectId: project.id });
  const rebuilt = knowledgeRepo.getChunkEmbedding(chunk!.id);

  assert.equal(result.scanned_chunks, 1);
  assert.equal(result.rebuilt_chunks, 1);
  assert.equal(result.skipped_chunks, 0);
  assert.equal(rebuilt?.dimensions, 256);
});

test('rebuildKnowledgeEmbeddings rebuilds when embedding title text changes', async () => {
  resetKnowledgeEmbeddingSettings();
  const project = createProject('title-change');
  const source = createReadySource(project.id, 'manual:title-change', 'Original Title');
  const [chunk] = createChunks(source.id, [
    { heading: 'Stable Heading', content: 'stable chunk content' },
  ]);

  await rebuildKnowledgeEmbeddings({ projectId: project.id });
  const before = knowledgeRepo.getChunkEmbedding(chunk!.id);
  assert.ok(before);
  knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: source.source_id,
    title: 'Updated Title',
    status: 'ready',
    tags: source.tags,
    metadata: source.metadata,
  });

  const result = await rebuildKnowledgeEmbeddings({ projectId: project.id });
  const after = knowledgeRepo.getChunkEmbedding(chunk!.id);

  assert.equal(result.scanned_chunks, 1);
  assert.equal(result.rebuilt_chunks, 1);
  assert.equal(result.skipped_chunks, 0);
  assert.notEqual(after?.content_hash, before.content_hash);
});

test('rebuildKnowledgeEmbeddings supports async openai-compatible provider with fetchImpl', async () => {
  const envVarName = 'OPENDEEPSEA_REBUILD_EMBEDDING_KEY';
  process.env[envVarName] = 'sk-rebuild-secret';
  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: 1536,
    knowledge_embedding_base_url: 'https://embedding-rebuild.example/v1',
    knowledge_embedding_api_key_env_var: envVarName,
  });
  const project = createProject('openai-compatible');
  const source = createReadySource(project.id, 'manual:openai-compatible', 'Async Source');
  const [chunk] = createChunks(source.id, [
    { heading: 'Async Heading', content: 'Async chunk body.' },
  ]);
  const requests: Array<{ url: string; authorization: string | null; body: { model?: string; input?: string } }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body ?? '{}')) as { model?: string; input?: string },
    });
    return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] });
  };

  const result = await rebuildKnowledgeEmbeddings({ projectId: project.id, fetchImpl });
  const embedding = knowledgeRepo.getChunkEmbedding(chunk!.id);

  assert.equal(result.provider, 'openai-compatible');
  assert.equal(result.model, 'text-embedding-3-small');
  assert.equal(result.scanned_chunks, 1);
  assert.equal(result.rebuilt_chunks, 1);
  assert.equal(result.skipped_chunks, 0);
  assert.deepEqual(result.failed_chunks, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://embedding-rebuild.example/v1/embeddings');
  assert.equal(requests[0]?.authorization, 'Bearer sk-rebuild-secret');
  assert.deepEqual(requests[0]?.body, {
    model: 'text-embedding-3-small',
    input: 'Async Source\nAsync Heading\nAsync chunk body.',
  });
  assert.equal(embedding?.provider, 'openai-compatible');
  assert.equal(embedding?.model, 'text-embedding-3-small');
  assert.equal(embedding?.dimensions, 4);
  assert.deepEqual(embedding?.vector, [0.1, 0.2, 0.3, 0.4]);
});

test('rebuildKnowledgeEmbeddings isolates chunk failures and sanitizes failed_chunks errors', async () => {
  const envVarName = 'OPENDEEPSEA_REBUILD_FAILURE_KEY';
  process.env[envVarName] = 'sk-failure-secret';
  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: 'https://embedding-failure.example/v1',
    knowledge_embedding_api_key_env_var: envVarName,
  });
  const project = createProject('failure-isolation');
  const source = createReadySource(project.id, 'manual:failure-isolation', 'Failure Source');
  const [failedChunk, rebuiltChunk] = createChunks(source.id, [
    { heading: 'Bad', content: 'bad chunk leaks secret' },
    { heading: 'Good', content: 'good chunk still rebuilds' },
  ]);
  const fetchImpl: FetchLike = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string };
    if (body.input?.includes('bad chunk')) {
      throw new Error('upstream failed with Authorization: Bearer sk-failure-secret');
    }
    return Response.json({ data: [{ embedding: [9, 8] }] });
  };

  const result = await rebuildKnowledgeEmbeddings({ projectId: project.id, fetchImpl });

  assert.equal(result.scanned_chunks, 2);
  assert.equal(result.rebuilt_chunks, 1);
  assert.equal(result.skipped_chunks, 0);
  assert.equal(result.failed_chunks.length, 1);
  assert.equal(result.failed_chunks[0]?.chunk_id, failedChunk?.id);
  assert.equal(result.failed_chunks[0]?.source_id, source.id);
  assert.doesNotMatch(result.failed_chunks[0]?.error ?? '', /sk-failure-secret/);
  assert.doesNotMatch(result.failed_chunks[0]?.error ?? '', /Authorization:\s*Bearer\s+sk-failure-secret/);
  assert.match(result.failed_chunks[0]?.error ?? '', /\[REDACTED_CREDENTIAL\]/);
  assert.equal(knowledgeRepo.getChunkEmbedding(failedChunk!.id), undefined);
  assert.deepEqual(knowledgeRepo.getChunkEmbedding(rebuiltChunk!.id)?.vector, [9, 8]);
});

test('rebuildKnowledgeEmbeddings sanitizes non-sk api keys in failed_chunks errors', async () => {
  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: 'https://embedding-non-sk-failure.example/v1',
    knowledge_embedding_api_key_env_var: null,
  });
  settingsRepo.updateSystem({
    openai_api_key: 'provider-secret-token-5678',
    openai_base_url: 'https://embedding-non-sk-failure.example/v1',
  });
  const project = createProject('non-sk-failure');
  const source = createReadySource(project.id, 'manual:non-sk-failure', 'Non SK Failure');
  createChunks(source.id, [
    { heading: 'Failure', content: 'failure chunk' },
  ]);

  const result = await rebuildKnowledgeEmbeddings({
    projectId: project.id,
    fetchImpl: async () => {
      throw new Error('provider-secret-token-5678 failed');
    },
  });

  assert.equal(result.failed_chunks.length, 1);
  assert.doesNotMatch(result.failed_chunks[0]?.error ?? '', /provider-secret-token-5678/);
  assert.match(result.failed_chunks[0]?.error ?? '', /\[REDACTED_CREDENTIAL\]/);
});

test('rebuildKnowledgeEmbeddings returns zero scan for non-project or non-ready sourceId', async () => {
  resetKnowledgeEmbeddingSettings();
  const project = createProject('source-scope');
  const foreignProject = createProject('source-scope-foreign');
  const foreignSource = createReadySource(foreignProject.id, 'manual:foreign', 'Foreign Source');
  const staleSource = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: 'manual:stale',
    title: 'Stale Source',
    status: 'stale',
    tags: [],
    metadata: {},
  });
  createChunks(staleSource.id, [
    { heading: 'Stale', content: 'This stale chunk should not scan.' },
  ]);

  const foreignResult = await rebuildKnowledgeEmbeddings({ projectId: project.id, sourceId: foreignSource.id });
  const staleResult = await rebuildKnowledgeEmbeddings({ projectId: project.id, sourceId: staleSource.id });
  const missingResult = await rebuildKnowledgeEmbeddings({ projectId: project.id, sourceId: 'missing-source' });

  assert.equal(foreignResult.scanned_chunks, 0);
  assert.equal(foreignResult.rebuilt_chunks, 0);
  assert.equal(staleResult.scanned_chunks, 0);
  assert.equal(staleResult.rebuilt_chunks, 0);
  assert.equal(missingResult.scanned_chunks, 0);
  assert.equal(missingResult.rebuilt_chunks, 0);
});

function resetKnowledgeEmbeddingSettings(): void {
  settingsRepo.updateSystem({
    knowledge_embedding_provider: null,
    knowledge_embedding_model: null,
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: null,
    knowledge_embedding_api_key_env_var: null,
  });
}

function createProject(name: string) {
  return projectRepo.create({
    name: `Embedding Rebuild ${name}`,
    path: mkdtempSync(join(tmpdir(), `embedding-rebuild-${name}-`)),
  });
}

function createReadySource(projectId: string, sourceId: string, title: string) {
  return knowledgeRepo.ensureSource({
    project_id: projectId,
    source_type: 'manual',
    source_id: sourceId,
    title,
    status: 'ready',
    content_hash: `${sourceId}:hash`,
    tags: [],
    metadata: {},
  });
}

function createChunks(
  sourceId: string,
  chunks: Array<{ heading: string; content: string; enabled?: 0 | 1 }>,
) {
  const extraction = knowledgeRepo.saveExtraction({
    source_id: sourceId,
    plain_text: chunks.map((chunk) => chunk.content).join('\n'),
    markdown: null,
    metadata: {},
  });
  return knowledgeRepo.replaceChunks({
    source_id: sourceId,
    extraction_id: extraction.id,
    chunks: chunks.map((chunk) => ({
      chunk_type: 'body',
      heading: chunk.heading,
      content: chunk.content,
      enabled: chunk.enabled ?? 1,
      metadata: {},
    })),
  });
}
