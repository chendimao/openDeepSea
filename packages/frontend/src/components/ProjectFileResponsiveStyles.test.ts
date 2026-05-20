import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const css = readFileSync(resolve(import.meta.dirname, '../index.css'), 'utf8');

test('file management styles keep source controls usable on desktop and mobile', () => {
  assert.match(css, /\.files-filter-select:focus-visible\s*\{[^}]*box-shadow:/s);
  assert.match(css, /\.project-file-source-badge,\s*\n\s*\.project-file-origin-badge\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.project-file-origin-badge\s*\{[^}]*font-weight:\s*600/s);
  assert.match(css, /\.project-file-origin-badge\.is-unknown-origin\s*\{[^}]*color:\s*var\(--color-fg-muted\)/s);
  assert.match(css, /\.project-file-action-button\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.project-file-action-button\s*\{[^}]*max-width:\s*150px/s);
  assert.match(css, /\.file-preview-source-trace\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.file-preview-source-items\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /@media \(max-width: 767px\)\s*\{[\s\S]*?\.files-filters\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /@media \(max-width: 767px\)\s*\{[\s\S]*?\.files-filter-select\s*\{[^}]*flex:\s*1 1 128px/s);
  assert.match(css, /@media \(max-width: 767px\)\s*\{[\s\S]*?\.project-file-action-button\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /@media \(max-width: 767px\)\s*\{[\s\S]*?\.project-file-view\.is-card,[\s\S]*?grid-template-columns:\s*1fr/s);
  assert.match(css, /\.file-preview-dialog\s*\{[^}]*width:\s*min\(94vw, 1040px\)/s);
  assert.match(css, /\.file-preview-markdown\s*\{[^}]*max-height:\s*min\(72dvh, 720px\)/s);
});
