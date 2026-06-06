import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const css = readFileSync(resolve(import.meta.dirname, 'session-os.css'), 'utf8');

test('session markdown preview keeps headings compact inside message bubbles', () => {
  assert.match(css, /\.deepsea-message-body \.markdown-preview h1[\s\S]*?font-size:\s*16px/s);
  assert.match(css, /\.deepsea-message-body \.markdown-preview h2[\s\S]*?font-size:\s*15px/s);
  assert.match(css, /\.deepsea-message-body \.markdown-preview h3[\s\S]*?font-size:\s*14px/s);
});

test('session markdown preview keeps run-log paragraphs aligned with list text', () => {
  assert.match(css, /\.deepsea-run-log-body \.markdown-preview p[\s\S]*?font-size:\s*14px/s);
  assert.match(css, /\.deepsea-run-log-body \.markdown-preview p[\s\S]*?line-height:\s*20px/s);
  assert.match(css, /\.deepsea-run-log-body \.markdown-preview li[\s\S]*?font-size:\s*14px/s);
});

test('session markdown preview styles GFM tables within transcript width', () => {
  assert.match(css, /\.deepsea-message-body \.markdown-preview table[\s\S]*?overflow-x:\s*auto/s);
  assert.match(css, /\.deepsea-message-body \.markdown-preview th,[\s\S]*?\.deepsea-message-body \.markdown-preview td[\s\S]*?border:\s*1px solid var\(--deepsea-border\)/s);
});
