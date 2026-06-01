import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkspaceFileRefContext } from './workspace-file-refs';

test('buildWorkspaceFileRefContext injects text content and resolves image paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-room-fileref-'));
  writeFileSync(join(root, 'note.txt'), 'hello world');
  writeFileSync(join(root, 'pic.png'), 'image-bytes');

  const result = await buildWorkspaceFileRefContext(root, ['note.txt', 'pic.png']);

  assert.ok(result.promptAddition.includes('note.txt'));
  assert.ok(result.promptAddition.includes('hello world'));
  assert.deepEqual(result.imagePaths, [realpathSync(join(root, 'pic.png'))]);
});

test('buildWorkspaceFileRefContext ignores traversal paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-room-fileref-safe-'));
  const result = await buildWorkspaceFileRefContext(root, ['../secret.txt']);
  assert.equal(result.promptAddition, '');
  assert.deepEqual(result.imagePaths, []);
});

test('buildWorkspaceFileRefContext validates image refs before passing paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-room-fileref-image-safe-'));
  const outside = mkdtempSync(join(tmpdir(), 'openclaw-room-fileref-outside-'));
  writeFileSync(join(root, 'pic.png'), 'image-bytes');
  writeFileSync(join(outside, 'secret.png'), 'secret');
  symlinkSync(join(outside, 'secret.png'), join(root, 'leak.png'));

  const result = await buildWorkspaceFileRefContext(root, ['pic.png', 'missing.png', 'leak.png']);

  assert.deepEqual(result.imagePaths, [realpathSync(join(root, 'pic.png'))]);
});
