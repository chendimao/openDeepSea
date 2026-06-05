import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  SessionCompaction,
  SessionCompactionStrategy,
} from '../types.js';

export const sessionCompactionRepo = {
  createPreview(input: {
    session_id: string;
    strategy?: SessionCompactionStrategy;
    focus_prompt?: string | null;
    preview_summary: string;
    retained_refs?: string[];
    dropped_refs?: string[];
    risk_notes?: string | null;
  }): SessionCompaction {
    const id = nanoid(16);
    db.prepare(`
      INSERT INTO session_compactions (
        id, session_id, strategy, focus_prompt, preview_summary,
        retained_refs, dropped_refs, risk_notes, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'previewed', ?)
    `).run(
      id,
      input.session_id,
      input.strategy ?? 'manual',
      input.focus_prompt ?? null,
      input.preview_summary,
      JSON.stringify(input.retained_refs ?? []),
      JSON.stringify(input.dropped_refs ?? []),
      input.risk_notes ?? null,
      now(),
    );
    return this.get(id)!;
  },

  get(id: string): SessionCompaction | undefined {
    return db.prepare('SELECT * FROM session_compactions WHERE id = ?').get(id) as SessionCompaction | undefined;
  },

  listBySession(sessionId: string): SessionCompaction[] {
    return db.prepare(`
      SELECT * FROM session_compactions
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as SessionCompaction[];
  },

  apply(id: string, input: { applied_summary: string; user_edited?: boolean }): SessionCompaction | undefined {
    const timestamp = now();
    db.prepare(`
      UPDATE session_compactions
      SET applied_summary = ?,
          user_edited = ?,
          status = 'applied',
          applied_at = ?
      WHERE id = ?
    `).run(input.applied_summary, input.user_edited ? 1 : 0, timestamp, id);
    return this.get(id);
  },

  discard(id: string): SessionCompaction | undefined {
    db.prepare("UPDATE session_compactions SET status = 'discarded' WHERE id = ? AND status = 'previewed'").run(id);
    return this.get(id);
  },
};
