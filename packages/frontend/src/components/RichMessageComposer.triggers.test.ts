import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFileSuggestions, encodeFileChipValue, parseFileChipValue } from './RichMessageComposer.triggers';
import type { ProjectFile } from '../lib/types';

const projectFile = {
  id: 'f1',
  original_name: 'report.md',
  mime_type: 'text/markdown',
} as ProjectFile;

test('buildFileSuggestions merges project and workspace, dedups, limits', () => {
  const suggestions = buildFileSuggestions(
    [projectFile],
    [{ path: 'src/report.md', name: 'report.md', type: 'file' }],
    'report',
  );
  assert.equal(suggestions[0].value, 'project:f1');
  assert.ok(suggestions.some((s) => s.value === 'workspace:src/report.md'));
  assert.ok(suggestions.length <= 8);
});

test('buildFileSuggestions filters project files by query', () => {
  const suggestions = buildFileSuggestions([projectFile], [], 'nomatch');
  assert.equal(suggestions.length, 0);
});

test('encode/parse file chip value round-trips', () => {
  assert.equal(encodeFileChipValue('project', 'f1'), 'project:f1');
  assert.deepEqual(parseFileChipValue('project:f1'), { kind: 'project', ref: 'f1' });
  assert.deepEqual(parseFileChipValue('workspace:src/a.ts'), { kind: 'workspace', ref: 'src/a.ts' });
  assert.equal(parseFileChipValue('garbage'), null);
});
