import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { SessionCheckpoint } from '../types.js';

export const sessionCheckpointRepo = {
  create(input: {
    session_id: string;
    title: string;
    description?: string | null;
    git_head?: string | null;
    branch_name?: string | null;
    diff_summary?: string | null;
    evidence_event_id?: string | null;
  }): SessionCheckpoint {
    const id = nanoid(16);
    db.prepare(`
      INSERT INTO session_checkpoints (
        id, session_id, title, description, git_head, branch_name,
        diff_summary, evidence_event_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.session_id,
      input.title,
      input.description ?? null,
      input.git_head ?? null,
      input.branch_name ?? null,
      input.diff_summary ?? null,
      input.evidence_event_id ?? null,
      now(),
    );
    return this.get(id)!;
  },

  get(id: string): SessionCheckpoint | undefined {
    return db.prepare('SELECT * FROM session_checkpoints WHERE id = ?').get(id) as SessionCheckpoint | undefined;
  },

  listBySession(sessionId: string): SessionCheckpoint[] {
    return db.prepare(`
      SELECT * FROM session_checkpoints
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as SessionCheckpoint[];
  },
};
