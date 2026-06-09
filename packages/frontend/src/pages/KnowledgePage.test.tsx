import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('KnowledgePage wires Phase 4A search mode, imports, insights, and metadata editing', () => {
  const source = readFileSync(new URL('./KnowledgePage.tsx', import.meta.url), 'utf8');
  assert.match(source, /KnowledgeRetrievalMode/);
  assert.match(source, /getKnowledgeRetrievalModeDisplay/);
  assert.match(source, /api\.getKnowledgeInsights/);
  assert.match(source, /api\.createManualKnowledge/);
  assert.match(source, /api\.createUrlKnowledge/);
  assert.match(source, /api\.importWorkspaceKnowledgeDocs/);
  assert.match(source, /metadataPatch/);
  assert.match(source, /ranking/);
  assert.match(source, /parser_status/);
  assert.match(source, /关键词/);
  assert.match(source, /向量预览/);
  assert.match(source, /混合/);
});
