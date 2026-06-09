import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sessionOsCss = readFileSync(new URL('./session-os.css', import.meta.url), 'utf8');

test('message copy knowledge and markdown actions share one compact toolbar style', () => {
  assert.match(sessionOsCss, /\.deepsea-message-tools\s*\{[^}]*gap:\s*1px/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools\s*\{[^}]*border:\s*1px solid rgba\(226, 232, 240, 0\.76\)/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools\s*\{[^}]*padding:\s*1px/s);
  assert.match(sessionOsCss, /\.deepsea-shell button,[\s\S]*font:\s*inherit/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools \.deepsea-message__action\s*\{[^}]*min-height:\s*20px/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools \.deepsea-message__action\s*\{[^}]*gap:\s*3px/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools \.deepsea-message__action\s*\{[^}]*border:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools \.deepsea-message__action\s*\{[^}]*background:\s*transparent/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools \.deepsea-message__action\s*\{[^}]*padding:\s*1px 6px/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools \.deepsea-message__action\s*\{[^}]*font-size:\s*10px/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools \.deepsea-message__action\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(sessionOsCss, /\.deepsea-message-tools \.deepsea-message__action svg\s*\{[^}]*width:\s*12px/s);
  assert.match(sessionOsCss, /\.deepsea-markdown-switch\s*\{[^}]*gap:\s*1px/s);
  assert.match(sessionOsCss, /\.deepsea-markdown-switch\s*\{[^}]*border:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-markdown-switch\s*\{[^}]*background:\s*transparent/s);
  assert.match(sessionOsCss, /\.deepsea-markdown-switch\s*\{[^}]*padding:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-markdown-switch button\s*\{[^}]*min-height:\s*20px/s);
  assert.match(sessionOsCss, /\.deepsea-markdown-switch button\s*\{[^}]*gap:\s*3px/s);
  assert.match(sessionOsCss, /\.deepsea-markdown-switch button\s*\{[^}]*padding:\s*1px 6px/s);
  assert.match(sessionOsCss, /\.deepsea-markdown-switch button\s*\{[^}]*font-size:\s*10px/s);
  assert.match(sessionOsCss, /\.deepsea-markdown-switch svg\s*\{[^}]*width:\s*12px/s);
});
