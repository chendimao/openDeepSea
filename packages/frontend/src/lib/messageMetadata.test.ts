import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMessageMetadata } from './messageMetadata';

test('parseMessageMetadata keeps legacy message upload attachments', () => {
  const metadata = JSON.stringify({
    attachments: [
      {
        id: 'message-attachment-1',
        name: 'legacy.png',
        mimeType: 'image/png',
        size: 1024,
        url: '/uploads/messages/stored.png',
        isImage: true,
      },
    ],
  });

  assert.deepEqual(parseMessageMetadata(metadata).attachments, [
    {
      id: 'message-attachment-1',
      fileId: undefined,
      name: 'legacy.png',
      mimeType: 'image/png',
      size: 1024,
      url: '/uploads/messages/stored.png',
      isImage: true,
      deleted: undefined,
    },
  ]);
});

test('parseMessageMetadata accepts project file upload attachments', () => {
  const metadata = JSON.stringify({
    attachments: [
      {
        id: 'file-1',
        fileId: 'file-1',
        name: 'screen.png',
        mimeType: 'image/png',
        size: 2048,
        url: '/uploads/files/project-1/stored.png',
        isImage: true,
        deleted: false,
      },
    ],
  });

  assert.deepEqual(parseMessageMetadata(metadata).attachments, [
    {
      id: 'file-1',
      fileId: 'file-1',
      name: 'screen.png',
      mimeType: 'image/png',
      size: 2048,
      url: '/uploads/files/project-1/stored.png',
      isImage: true,
      deleted: false,
    },
  ]);
});

test('parseMessageMetadata rejects unsafe attachment URLs', () => {
  const metadata = JSON.stringify({
    attachments: [
      {
        id: 'external',
        name: 'external.png',
        mimeType: 'image/png',
        size: 1,
        url: 'https://example.com/uploads/files/project-1/stored.png',
        isImage: true,
      },
      {
        id: 'traversal',
        name: 'traversal.png',
        mimeType: 'image/png',
        size: 1,
        url: '/uploads/files/project-1/%2e%2e/secret.png',
        isImage: true,
      },
      {
        id: 'script',
        name: 'script.png',
        mimeType: 'image/png',
        size: 1,
        url: 'javascript:alert(1)',
        isImage: true,
      },
    ],
  });

  assert.deepEqual(parseMessageMetadata(metadata).attachments, []);
});
