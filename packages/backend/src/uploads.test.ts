import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  MAX_MESSAGE_FILES,
  MAX_MESSAGE_FILE_SIZE_BYTES,
  buildAttachmentMetadata,
  buildProjectFileRecordInput,
  buildProjectFileUploadDir,
  cleanupUploadedFilesInDir,
  isAllowedMessageUploadMimeType,
  projectFileUploadRoot,
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

test('message upload MIME allowlist rejects active content', () => {
  assert.equal(isAllowedMessageUploadMimeType('image/png'), true);
  assert.equal(isAllowedMessageUploadMimeType('image/jpeg'), true);
  assert.equal(isAllowedMessageUploadMimeType('image/avif'), true);
  assert.equal(isAllowedMessageUploadMimeType('image/heic'), true);
  assert.equal(isAllowedMessageUploadMimeType('image/heif'), true);
  assert.equal(isAllowedMessageUploadMimeType('application/pdf'), true);
  assert.equal(isAllowedMessageUploadMimeType('text/plain'), true);
  assert.equal(isAllowedMessageUploadMimeType('text/html'), false);
  assert.equal(isAllowedMessageUploadMimeType('image/svg+xml'), false);
  assert.equal(isAllowedMessageUploadMimeType('application/javascript'), false);
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

test('project file upload path is scoped by project id', () => {
  const uploadDir = buildProjectFileUploadDir('project-1');

  assert.equal(uploadDir.startsWith(projectFileUploadRoot), true);
  assert.equal(uploadDir.endsWith('project-1'), true);
});

test('buildProjectFileRecordInput maps multer file to project file input', () => {
  const input = buildProjectFileRecordInput('project-1', {
    originalname: 'screen.png',
    mimetype: 'image/png',
    size: 128,
    filename: 'stored.png',
    path: join(projectFileUploadRoot, 'project-1', 'stored.png'),
  } as Express.Multer.File, {
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  assert.equal(input.project_id, 'project-1');
  assert.equal(input.original_name, 'screen.png');
  assert.equal(input.stored_name, 'stored.png');
  assert.equal(input.mime_type, 'image/png');
  assert.equal(input.size, 128);
  assert.equal(input.url, '/uploads/files/project-1/stored.png');
  assert.equal(input.storage_path, join(projectFileUploadRoot, 'project-1', 'stored.png'));
  assert.equal(input.uploaded_by_id, 'user');
  assert.equal(input.uploaded_by_name, 'You');
});

test('cleanupUploadedFilesInDir only unlinks files under provided rootDir', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'openclaw-upload-test-'));
  const insidePath = join(tmpRoot, 'inside.txt');
  await writeFile(insidePath, 'inside');

  const outsideDir = await mkdtemp(join(tmpdir(), 'openclaw-upload-outside-'));
  const outsidePath = join(outsideDir, 'outside.txt');
  await writeFile(outsidePath, 'outside');

  try {
    await cleanupUploadedFilesInDir(
      [
      { path: insidePath } as Express.Multer.File,
      { path: outsidePath } as Express.Multer.File,
      ],
      tmpRoot
    );

    await assert.rejects(access(insidePath, constants.F_OK));
    await access(outsidePath, constants.F_OK);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
