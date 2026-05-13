import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { Message, MessageType, SenderType } from '../types.js';

export const messageRepo = {
  listByRoom(roomId: string, limit = 200): Message[] {
    return db
      .prepare(
        'SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT ?',
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
};
