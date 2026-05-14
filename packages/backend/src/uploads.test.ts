import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MESSAGE_FILES,
  MAX_MESSAGE_FILE_SIZE_BYTES,
  buildAttachmentMetadata,
  safeUploadFileName,
} from './uploads.js';

test('upload limits use expected defaults', () => {
  assert.equal(MAX_MESSAGE_FILES, 5);
  assert.equal(MAX_MESSAGE_FILE_SIZE_BYTES, 10 * 1024 * 1024);
});

test('safeUploadFileName sanitizes traversal-like names', () => {
  const generated = safeUploadFileName('../../secret.png');
  assert.match(generated, /^\d+-[A-Za-z0-9_-]{12}\.png$/);
  assert.equal(generated.includes('/'), false);
  assert.equal(generated.includes('..'), false);
});

test('safeUploadFileName falls back to bin extension for unsupported extension', () => {
  const generated = safeUploadFileName('payload.verylongextension');
  assert.match(generated, /^\d+-[A-Za-z0-9_-]{12}\.bin$/);
});

test('buildAttachmentMetadata maps multer file to message attachment metadata', () => {
  const metadata = buildAttachmentMetadata({
    originalname: 'screen.png',
    mimetype: 'image/png',
    size: 128,
    filename: 'stored.png',
  } as Express.Multer.File);

  assert.equal(typeof metadata.id, 'string');
  assert.equal(metadata.id.length, 16);
  assert.equal(metadata.name, 'screen.png');
  assert.equal(metadata.mimeType, 'image/png');
  assert.equal(metadata.size, 128);
  assert.equal(metadata.url, '/uploads/messages/stored.png');
  assert.equal(metadata.isImage, true);
});
