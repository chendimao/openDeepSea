import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-embedding-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const {
  cosineSimilarity,
  createLocalHashEmbeddingProvider,
  rebuildSourceEmbeddings,
} = await import('./knowledge-embedding.js');

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-embedding-${name}-`)),
  });
}

test('local hash embedding is deterministic and normalized', () => {
  const provider = createLocalHashEmbeddingProvider({ dimensions: 16 });
  const first = provider.embed('A12 hybrid search');
  const second = provider.embed('A12 hybrid search');

  assert.deepEqual(first, second);
  assert.equal(first.length, 16);
  assert.ok(Math.abs(cosineSimilarity(first, first) - 1) < 0.000001);
});

test('local hash embedding gives related text a stronger score than unrelated text', () => {
  const provider = createLocalHashEmbeddingProvider({ dimensions: 64 });
  const query = provider.embed('A12 deployment smoke');
  const related = provider.embed('A12 deployment smoke verification');
  const unrelated = provider.embed('visual typography color palette');

  assert.ok(cosineSimilarity(query, related) > cosineSimilarity(query, unrelated));
});

test('rebuildSourceEmbeddings stores one embedding per enabled chunk', () => {
  const project = createProject('rebuild');
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: 'manual-embed-rebuild',
    title: 'Embedding rebuild',
    status: 'ready',
  });
  knowledgeRepo.replaceChunks(source.id, [
    { chunk_type: 'body', content: 'A12 deployment notes', enabled: 1 },
    { chunk_type: 'body', content: 'Disabled hidden notes', enabled: 0 },
  ]);

  const count = rebuildSourceEmbeddings(source.id);
  const rows = knowledgeRepo.listChunkEmbeddings({ projectId: project.id });

  assert.equal(count, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.provider, 'local-hash');
  assert.equal(rows[0]?.model, 'local-hash-v1');
  assert.equal(rows[0]?.dimensions, 256);
});
