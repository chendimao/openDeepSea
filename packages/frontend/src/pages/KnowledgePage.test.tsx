import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('KnowledgePage wires Phase 4A search mode, imports, insights, and metadata editing', () => {
  const source = readFileSync(new URL('./KnowledgePage.tsx', import.meta.url), 'utf8');
  assert.match(source, /KnowledgeRetrievalMode/);
  assert.match(source, /getKnowledgeRetrievalModeDisplay/);
  assert.match(source, /api\.getKnowledgeInsights/);
  assert.match(source, /api\.getKnowledgeEmbeddingStatus/);
  assert.match(source, /api\.testKnowledgeEmbeddingProvider/);
  assert.match(source, /api\.rebuildKnowledgeEmbeddings/);
  assert.match(source, /KnowledgeEmbeddingStatusStrip/);
  assert.match(source, /failed_chunks\.length > 0/);
  assert.match(source, /embeddingStatus\?\.runtime\.available/);
  assert.match(source, /api\.createManualKnowledge/);
  assert.match(source, /api\.createUrlKnowledge/);
  assert.match(source, /api\.importWorkspaceKnowledgeDocs/);
  assert.match(source, /metadataPatch/);
  assert.match(source, /ranking/);
  assert.match(source, /parser_status/);
  assert.match(source, /关键词/);
  assert.match(source, /向量预览/);
  assert.match(source, /混合/);
  assert.match(source, /测试 provider/);
  assert.match(source, /重建索引/);
});
