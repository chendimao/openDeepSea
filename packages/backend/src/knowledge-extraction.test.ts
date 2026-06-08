import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractKnowledgeText,
  splitKnowledgeChunks,
  summarizeKnowledgeText,
} from './knowledge-extraction.js';

test('extractKnowledgeText parses markdown as builtin text', async () => {
  const extracted = await extractKnowledgeText({
    title: '深海任务说明.md',
    mimeType: 'text/markdown',
    content: '# 深海任务说明\n\n部署 A12 浮标。\n\n检查第 4 象限风险。',
  });

  assert.equal(extracted.parser, 'builtin-text');
  assert.equal(extracted.markdown, '# 深海任务说明\n\n部署 A12 浮标。\n\n检查第 4 象限风险。');
  assert.match(extracted.plainText, /部署 A12 浮标/);
  assert.match(extracted.plainText, /第 4 象限/);
});

test('summarizeKnowledgeText derives summary tags and key points', () => {
  const summary = summarizeKnowledgeText(
    '部署 A12 浮标。\n检查第 4 象限风险。\n记录物资投放。',
    '深海任务说明.md',
  );

  assert.match(summary.summary, /部署 A12 浮标/);
  assert.ok(summary.tags.length >= 1);
  assert.ok(summary.keyPoints.length >= 2);
  assert.equal(summary.keyPoints[0], '部署 A12 浮标。');
});

test('splitKnowledgeChunks splits by maxChars with body chunks from index zero', () => {
  const chunks = splitKnowledgeChunks({
    title: '深海任务说明.md',
    text: '部署 A12 浮标。检查第 4 象限风险。记录物资投放。',
    maxChars: 12,
  });

  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0]?.chunk_index, 0);
  assert.equal(chunks[1]?.chunk_index, 1);
  assert.equal(chunks[0]?.chunk_type, 'body');
  assert.equal(chunks[0]?.content.length <= 12, true);
});

test('extractKnowledgeText returns metadata-only result for images', async () => {
  const extracted = await extractKnowledgeText({
    title: 'screen.png',
    mimeType: 'image/png',
    content: null,
  });

  assert.equal(extracted.parser, 'image-metadata');
  assert.equal(extracted.plainText, '');
  assert.deepEqual(extracted.image, { kind: 'image', title: 'screen.png', mimeType: 'image/png' });
});
