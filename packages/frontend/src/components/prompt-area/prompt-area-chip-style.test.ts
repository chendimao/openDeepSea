import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const css = readFileSync(resolve(import.meta.dirname, '../../index.css'), 'utf8');

test('prompt area chip ripple stays out of chip layout and cleans itself up', () => {
  assert.match(css, /\.prompt-area-chip\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.prompt-area-chip\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.prompt-area-chip-ripple\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.prompt-area-chip-ripple\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.prompt-area-chip-ripple\s*\{[^}]*animation:\s*prompt-area-chip-ripple\s+260ms\s+ease-out\s+forwards/s);
  assert.match(css, /@keyframes\s+prompt-area-chip-ripple\s*\{/s);
});
