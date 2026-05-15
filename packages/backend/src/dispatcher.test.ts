import test from 'node:test';
import assert from 'node:assert/strict';
import { messageUploadDir } from './uploads.js';
import { buildPromptWithMessageAttachments, isOpenClawSessionAlreadyPresentError } from './dispatcher.js';
import type { Message, MessageMetadata } from './types.js';

test('detects OpenClaw session already exists errors as reusable', () => {
  assert.equal(isOpenClawSessionAlreadyPresentError(new Error('session already exists')), true);
});

test('detects OpenClaw label already in use errors as reusable', () => {
  assert.equal(
    isOpenClawSessionAlreadyPresentError(new Error('label already in use: OpenClaw Room pm')),
    true,
  );
});

test('does not treat unrelated gateway errors as reusable sessions', () => {
  assert.equal(isOpenClawSessionAlreadyPresentError(new Error('Gateway connect timeout')), false);
});

test('buildPromptWithMessageAttachments appends readable attachment context', () => {
  const message = createMessage({
    attachments: [
      {
        id: 'att-1',
        name: 'screen.png',
        mimeType: 'image/png',
        size: 576448,
        url: '/uploads/messages/stored.png',
        isImage: true,
      },
    ],
  });

  const prompt = buildPromptWithMessageAttachments('能识别当前对话的图片吗', message);

  assert.match(prompt, /能识别当前对话的图片吗/);
  assert.match(prompt, /消息附件：/);
  assert.match(prompt, /screen\.png/);
  assert.match(prompt, /mimeType=image\/png/);
  assert.match(prompt, /kind=image/);
  assert.match(prompt, new RegExp(`localPath=${escapeRegExp(messageUploadDir)}/stored\\.png`));
});

test('buildPromptWithMessageAttachments marks unsafe attachment paths unavailable', () => {
  const message = createMessage({
    attachments: [
      {
        id: 'att-1',
        name: 'secret.png',
        mimeType: 'image/png',
        size: 1,
        url: '/uploads/messages/../secret.png',
        isImage: true,
      },
    ],
  });

  const prompt = buildPromptWithMessageAttachments('', message);

  assert.match(prompt, /用户发送了一条仅包含附件的消息。/);
  assert.match(prompt, /localPath=unavailable/);
  assert.doesNotMatch(prompt, /\.\.\/secret/);
});

function createMessage(metadata: MessageMetadata): Message {
  return {
    id: 'msg-1',
    room_id: 'room-1',
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: 'hello',
    message_type: 'text',
    metadata: JSON.stringify(metadata),
    created_at: Date.now(),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
