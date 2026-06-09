import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-search-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const { rebuildSourceEmbeddings } = await import('./knowledge-embedding.js');
const { searchKnowledge } = await import('./knowledge-search.js');

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-knowledge-search-${name}-`)),
  });
}

function createSourceWithChunk(input: {
  projectId: string;
  title: string;
  summary?: string | null;
  tags?: string[];
  content: string;
}) {
  const source = knowledgeRepo.ensureSource({
    project_id: input.projectId,
    source_type: 'manual',
    source_id: `manual-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: input.title,
    status: 'ready',
    summary: input.summary ?? null,
    tags: input.tags ?? [],
  });
  const extraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: input.content,
    markdown: input.content,
  });
  const [chunk] = knowledgeRepo.replaceChunks({
    source_id: source.id,
    extraction_id: extraction.id,
    chunks: [{ chunk_type: 'body', content: input.content }],
  });
  return { source, chunk: chunk! };
}

test('searchKnowledge keeps keyword mode compatible and adds ranking metadata in hybrid mode', () => {
  const project = createProject('hybrid');
  const deployment = createSourceWithChunk({
    projectId: project.id,
    title: 'A12 Deployment Runbook',
    summary: 'deployment and backup',
    tags: ['部署'],
    content: 'A12 deployment requires backup and smoke verification.',
  });
  const unrelated = createSourceWithChunk({
    projectId: project.id,
    title: 'Design Note',
    summary: 'visual review',
    tags: ['设计'],
    content: 'Visual review checklist.',
  });
  rebuildSourceEmbeddings(deployment.source.id);
  rebuildSourceEmbeddings(unrelated.source.id);

  const keyword = searchKnowledge({ projectId: project.id, query: 'A12 deployment', mode: 'keyword' });
  assert.equal(keyword[0]?.source_id, deployment.source.id);
  assert.equal(keyword[0]?.ranking, undefined);
  assert.equal(keyword[0]?.retrieval_mode, undefined);

  const hybrid = searchKnowledge({ projectId: project.id, query: 'A12 deployment', mode: 'hybrid' });
  assert.equal(hybrid[0]?.source_id, deployment.source.id);
  assert.equal(hybrid[0]?.retrieval_mode, 'hybrid');
  assert.equal(hybrid[0]?.ranking?.titleMatch, true);
  assert.equal(hybrid[0]?.ranking?.summaryMatch, true);
  assert.ok((hybrid[0]?.ranking?.finalScore ?? 0) > 0);
});

test('searchKnowledge vector preview returns embedding results with citations', () => {
  const project = createProject('vector');
  const rollback = createSourceWithChunk({
    projectId: project.id,
    title: 'Rollback Procedure',
    summary: 'rollback steps',
    tags: ['运维'],
    content: 'Rollback package previous release smoke verification.',
  });
  createSourceWithChunk({
    projectId: project.id,
    title: 'Typography Note',
    summary: 'visual system',
    tags: ['设计'],
    content: 'Typography scale and color palette.',
  });
  rebuildSourceEmbeddings(rollback.source.id);

  const results = searchKnowledge({ projectId: project.id, query: 'rollback smoke', mode: 'vector_preview' });
  assert.equal(results[0]?.source_id, rollback.source.id);
  assert.equal(results[0]?.citation.source_id, rollback.source.id);
  assert.equal(results[0]?.retrieval_mode, 'vector_preview');
  assert.ok((results[0]?.ranking?.vectorScore ?? 0) > 0);
});

test('searchKnowledge hybrid respects status and disabled chunk filters', () => {
  const project = createProject('filters');
  const ready = createSourceWithChunk({
    projectId: project.id,
    title: 'Ready A12',
    content: 'A12 ready content.',
  });
  const disabled = createSourceWithChunk({
    projectId: project.id,
    title: 'Disabled A12',
    content: 'A12 disabled content.',
  });
  knowledgeRepo.updateSourceStatus(disabled.source.id, { status: 'disabled' });
  rebuildSourceEmbeddings(ready.source.id);
  rebuildSourceEmbeddings(disabled.source.id);

  const results = searchKnowledge({ projectId: project.id, query: 'A12', mode: 'hybrid' });
  assert.deepEqual(results.map((result) => result.source_id), [ready.source.id]);
});
