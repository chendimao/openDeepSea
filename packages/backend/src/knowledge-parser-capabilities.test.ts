import assert from 'node:assert/strict';
import test from 'node:test';

const { extractKnowledgeText } = await import('./knowledge-extraction.js');

test('parser capabilities mark text, csv, json, images, pdf, and office files', async () => {
  const markdown = await extractKnowledgeText({ title: 'note.md', mimeType: 'text/markdown', content: '# Note' });
  assert.equal(markdown.metadata.parser_status, 'complete');
  assert.deepEqual(markdown.metadata.parser_capabilities, ['text', 'markdown', 'chunks']);

  const csv = await extractKnowledgeText({
    title: 'table.csv',
    mimeType: 'text/csv',
    content: 'name,value\nA12,ready',
  });
  assert.equal(csv.metadata.parser_status, 'complete');
  assert.equal(csv.table?.kind, 'csv');
  assert.deepEqual(csv.table?.columns, ['name', 'value']);
  assert.equal(csv.metadata.table_kind, 'csv');
  assert.deepEqual(csv.metadata.table_columns, ['name', 'value']);

  const json = await extractKnowledgeText({
    title: 'facts.json',
    mimeType: 'application/json',
    content: '{"name":"A12","status":"ready"}',
  });
  assert.equal(json.metadata.parser_status, 'complete');
  assert.deepEqual(json.metadata.structured_keys, ['name', 'status']);

  const image = await extractKnowledgeText({ title: 'screen.png', mimeType: 'image/png', content: null });
  assert.equal(image.metadata.parser_status, 'metadata_only');
  assert.equal(image.metadata.requires_sidecar, true);
  assert.match(String(image.metadata.parser_warnings), /OCR/);

  const pdf = await extractKnowledgeText({ title: 'brief.pdf', mimeType: 'application/pdf', content: null });
  assert.equal(pdf.metadata.parser_status, 'requires_sidecar');
  assert.equal(pdf.metadata.requires_sidecar, true);

  const office = await extractKnowledgeText({
    title: 'brief.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    content: null,
  });
  assert.equal(office.metadata.parser_status, 'requires_sidecar');
  assert.equal(office.metadata.requires_sidecar, true);
});
