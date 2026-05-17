import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { Message, MessageMetadata, MessageType, SenderType } from '../types.js';

export const messageRepo = {
  listByRoom(roomId: string, limit = 200): Message[] {
    return db
      .prepare(
        `SELECT * FROM messages
         WHERE room_id = ?
           AND COALESCE(json_extract(metadata, '$.internal'), 0) <> 1
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(roomId, limit) as Message[];
  },

  get(id: string): Message | undefined {
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | undefined;
  },

  create(input: {
    room_id: string;
    sender_type: SenderType;
    sender_id: string;
    sender_name?: string;
    content: string;
    message_type?: MessageType;
    metadata?: Record<string, unknown>;
  }): Message {
    const id = nanoid(16);
    db.prepare(
      `INSERT INTO messages (id, room_id, sender_type, sender_id, sender_name, content, message_type, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.room_id,
      input.sender_type,
      input.sender_id,
      input.sender_name ?? null,
      input.content,
      input.message_type ?? 'text',
      input.metadata ? JSON.stringify(input.metadata) : null,
      now(),
    );
    return this.get(id)!;
  },

  appendChunk(id: string, chunk: string): void {
    db.prepare('UPDATE messages SET content = content || ? WHERE id = ?').run(chunk, id);
  },

  markFileAttachmentDeleted(fileId: string): number {
    const messages = db.prepare(
      `SELECT DISTINCT messages.*
       FROM messages
       INNER JOIN message_file_refs ON message_file_refs.message_id = messages.id
       WHERE message_file_refs.file_id = ?`,
    ).all(fileId) as Message[];
    const update = db.prepare('UPDATE messages SET metadata = ? WHERE id = ?');
    let changed = 0;

    const transaction = db.transaction(() => {
      for (const message of messages) {
        const nextMetadata = markMetadataFileDeleted(message.metadata, fileId);
        if (!nextMetadata) continue;
        update.run(JSON.stringify(nextMetadata), message.id);
        changed += 1;
      }
    });
    transaction();
    return changed;
  },
};

function markMetadataFileDeleted(rawMetadata: string | null, fileId: string): MessageMetadata | null {
  if (!rawMetadata) return null;

  let metadata: MessageMetadata;
  try {
    metadata = JSON.parse(rawMetadata) as MessageMetadata;
  } catch {
    return null;
  }

  if (!Array.isArray(metadata.attachments)) return null;
  let changed = false;
  const attachments = metadata.attachments.map((attachment) => {
    if (attachment.fileId !== fileId || attachment.deleted) return attachment;
    changed = true;
    return { ...attachment, deleted: true };
  });

  return changed ? { ...metadata, attachments } : null;
}
