import { db, now } from '../db.js';
import type { Session, SessionContract } from '../types.js';
import { parseJsonArray } from './sessions.js';

type SessionContractRow = {
  session_id: string;
  scope: string | null;
  risks: string;
  acceptance_criteria: string;
  created_at: number;
  updated_at: number;
};

export const sessionContractRepo = {
  get(session: Session): SessionContract | undefined {
    const row = db.prepare('SELECT * FROM session_contracts WHERE session_id = ?').get(session.id) as
      | SessionContractRow
      | undefined;
    return row ? parseContractRow(session, row) : undefined;
  },

  getOrCreate(session: Session): SessionContract {
    const existing = this.get(session);
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO session_contracts (session_id, scope, risks, acceptance_criteria, created_at, updated_at)
      VALUES (?, NULL, '[]', '[]', ?, ?)
    `).run(session.id, timestamp, timestamp);
    return this.get(session)!;
  },

  upsert(
    session: Session,
    input: {
      scope?: string | null;
      risks?: string[];
      acceptanceCriteria?: string[];
    },
  ): SessionContract {
    const existing = this.getOrCreate(session);
    const timestamp = now();
    db.prepare(`
      UPDATE session_contracts
      SET scope = ?,
          risks = ?,
          acceptance_criteria = ?,
          updated_at = ?
      WHERE session_id = ?
    `).run(
      input.scope === undefined ? existing.scope : normalizeNullableText(input.scope),
      JSON.stringify(input.risks ?? existing.risks),
      JSON.stringify(input.acceptanceCriteria ?? existing.acceptanceCriteria),
      timestamp,
      session.id,
    );
    return this.get(session)!;
  },
};

function parseContractRow(session: Session, row: SessionContractRow): SessionContract {
  return {
    sessionId: session.id,
    objective: session.current_goal ?? session.title,
    scope: row.scope,
    risks: parseJsonArray<string>(row.risks),
    acceptanceCriteria: parseJsonArray<string>(row.acceptance_criteria),
    updated_at: row.updated_at,
  };
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}
