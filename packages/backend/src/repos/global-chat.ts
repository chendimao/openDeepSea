import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  GlobalChatMessage,
  GlobalChatMessageMetadata,
  GlobalChatMessageStatus,
  GlobalChatRole,
  GlobalChatSession,
} from '../types.js';

interface GlobalChatMessageRow {
  id: string;
  session_id: string;
  role: GlobalChatRole;
  content: string;
  status: GlobalChatMessageStatus;
  metadata: string | null;
  created_at: number;
}

export const globalChatRepo = {
  createSession(input: { title?: string | null } = {}): GlobalChatSession {
    const id = nanoid(14);
    const ts = now();
    db.prepare(
      `INSERT INTO global_chat_sessions (id, title, archived, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(id, normalizeSessionTitle(input.title), ts, ts);
    return this.getSession(id)!;
  },

  listSessions(input: { includeArchived?: boolean; limit?: number } = {}): GlobalChatSession[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const archivedClause = input.includeArchived ? '' : 'WHERE archived = 0';
    return db.prepare(
      `SELECT * FROM global_chat_sessions
       ${archivedClause}
       ORDER BY updated_at DESC
       LIMIT ?`,
    ).all(limit) as GlobalChatSession[];
  },

  getSession(id: string): GlobalChatSession | undefined {
    return db.prepare('SELECT * FROM global_chat_sessions WHERE id = ?').get(id) as GlobalChatSession | undefined;
  },

  updateSession(id: string, patch: { title?: string | null; archived?: boolean }): GlobalChatSession | undefined {
    const existing = this.getSession(id);
    if (!existing) return undefined;
    const nextTitle = patch.title === undefined ? existing.title : normalizeSessionTitle(patch.title);
    const nextArchived = patch.archived === undefined ? existing.archived : patch.archived ? 1 : 0;
    db.prepare(
      `UPDATE global_chat_sessions
       SET title = ?, archived = ?, updated_at = ?
       WHERE id = ?`,
    ).run(nextTitle, nextArchived, now(), id);
    return this.getSession(id);
  },

  archiveSession(id: string, archived = true): GlobalChatSession | undefined {
    return this.updateSession(id, { archived });
  },

  deleteSession(id: string): boolean {
    return db.prepare('DELETE FROM global_chat_sessions WHERE id = ?').run(id).changes > 0;
  },

  createMessage(input: {
    session_id: string;
    role: GlobalChatRole;
    content: string;
    status?: GlobalChatMessageStatus;
    metadata?: GlobalChatMessageMetadata | null;
  }): GlobalChatMessage {
    if (!this.getSession(input.session_id)) throw new Error('global chat session not found');
    const id = nanoid(16);
    const ts = now();
    db.prepare(
      `INSERT INTO global_chat_messages (id, session_id, role, content, status, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.session_id,
      input.role,
      input.content,
      input.status ?? 'completed',
      serializeMetadata(input.metadata),
      ts,
    );
    db.prepare('UPDATE global_chat_sessions SET updated_at = ? WHERE id = ?').run(ts, input.session_id);
    return this.getMessage(id)!;
  },

  getMessage(id: string): GlobalChatMessage | undefined {
    const row = db.prepare('SELECT * FROM global_chat_messages WHERE id = ?').get(id) as
      | GlobalChatMessageRow
      | undefined;
    return row ? normalizeMessage(row) : undefined;
  },

  listMessages(sessionId: string, input: { limit?: number } = {}): GlobalChatMessage[] {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    return (db.prepare(
      `SELECT * FROM global_chat_messages
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(sessionId, limit) as GlobalChatMessageRow[]).map(normalizeMessage);
  },
};

function normalizeSessionTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed || '新的全局聊天';
}

function serializeMetadata(metadata: GlobalChatMessageMetadata | null | undefined): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  return JSON.stringify(metadata);
}

function normalizeMessage(row: GlobalChatMessageRow): GlobalChatMessage {
  return {
    ...row,
    metadata: parseMetadata(row.metadata),
  };
}

function parseMetadata(raw: string | null): GlobalChatMessageMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as GlobalChatMessageMetadata : {};
  } catch {
    return {};
  }
}
