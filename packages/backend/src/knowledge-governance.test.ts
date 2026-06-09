import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-governance-')), 'test.db');

const { knowledgeRepo } = await import('./repos/knowledge.js');
const { projectRepo } = await import('./repos/projects.js');
const {
  getKnowledgeInsights,
  patchKnowledgeSourceMetadata,
} = await import('./knowledge-governance.js');

test('getKnowledgeInsights groups duplicates, parser incomplete, empty index, and stale sources', () => {
  const project = createProject('insights');
  createReadySource(project.id, {
    sourceId: 'a',
    contentHash: 'same',
    metadata: { parser_status: 'complete' },
    chunks: ['A12 one'],
  });
  createReadySource(project.id, {
    sourceId: 'b',
    contentHash: 'same',
    metadata: { parser_status: 'complete' },
    chunks: ['A12 two'],
  });
  createReadySource(project.id, {
    sourceId: 'c',
    contentHash: 'c',
    metadata: { parser_status: 'requires_sidecar' },
    chunks: [],
  });
  createSource(project.id, { sourceId: 'd', status: 'stale', contentHash: 'd' });

  const insights = getKnowledgeInsights({ projectId: project.id });
  assert.equal(insights.duplicates.count, 2);
  assert.deepEqual(new Set(insights.duplicates.source_ids), new Set([
    knowledgeRepo.getSourceByExternalId({ projectId: project.id, sourceType: 'manual', sourceId: 'a' })?.id,
    knowledgeRepo.getSourceByExternalId({ projectId: project.id, sourceType: 'manual', sourceId: 'b' })?.id,
  ]));
  assert.equal(insights.parser_incomplete.count, 1);
  assert.equal(insights.empty_index.count, 1);
  assert.equal(insights.stale.count, 1);
});

test('patchKnowledgeSourceMetadata only allows governed fact fields', () => {
  const project = createProject('metadata-patch');
  const source = createSource(project.id, { sourceId: 'patch', status: 'ready' });
  const patched = patchKnowledgeSourceMetadata(source.id, {
    key_points: ['A12 需要验收'],
    decisions: ['采用 hybrid'],
    constraints: ['不抓取 URL'],
    risks: ['OCR 未配置'],
    learnings: ['citation 必须保留'],
  });

  assert.deepEqual(patched.metadata.key_points, ['A12 需要验收']);
  assert.deepEqual(patched.metadata.decisions, ['采用 hybrid']);
  assert.throws(
    () => patchKnowledgeSourceMetadata(source.id, { storage_path: ['/tmp/leak'] } as never),
    /unsupported metadata field/,
  );
});

test('patchKnowledgeSourceMetadata trims and caps governed arrays', () => {
  const project = createProject('metadata-normalize');
  const source = createSource(project.id, { sourceId: 'normalize', status: 'ready' });
  const patched = patchKnowledgeSourceMetadata(source.id, {
    risks: ['  ', 'A'.repeat(300), ...Array.from({ length: 20 }, (_, index) => `risk-${index}`)],
  });

  const risks = patched.metadata.risks as string[];
  assert.equal(risks.length, 12);
  assert.equal(risks[0]?.length, 240);
  assert.equal(risks.includes(''), false);
});

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-knowledge-governance-${name}-`)),
  });
}

function createSource(projectId: string, input: {
  sourceId: string;
  status: 'ready' | 'stale';
  contentHash?: string;
  metadata?: Record<string, unknown>;
}) {
  return knowledgeRepo.ensureSource({
    project_id: projectId,
    source_type: 'manual',
    source_id: input.sourceId,
    title: input.sourceId,
    status: input.status,
    content_hash: input.contentHash ?? input.sourceId,
    metadata: input.metadata,
  });
}

function createReadySource(projectId: string, input: {
  sourceId: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  chunks: string[];
}) {
  const source = createSource(projectId, {
    sourceId: input.sourceId,
    status: 'ready',
    contentHash: input.contentHash,
    metadata: input.metadata,
  });
  knowledgeRepo.replaceChunks(source.id, input.chunks.map((content) => ({
    chunk_type: 'body',
    content,
    project_id: projectId,
  })));
  return source;
}
