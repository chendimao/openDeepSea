import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  SessionEvidenceEvent,
  SessionEvidenceSeverity,
  SessionEvidenceType,
} from '../types.js';
import { parseJsonObject } from './sessions.js';

type SessionEvidenceEventRow = Omit<SessionEvidenceEvent, 'payload'> & {
  payload: string | null;
};

export const sessionEvidenceRepo = {
  create(input: {
    session_id: string;
    event_type: SessionEvidenceType;
    severity?: SessionEvidenceSeverity;
    source_run_id?: string | null;
    source_message_id?: string | null;
    title: string;
    summary?: string | null;
    payload?: Record<string, unknown>;
  }): SessionEvidenceEvent {
    const insert = db.transaction(() => {
      const nextSeq = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_evidence_events WHERE session_id = ?',
      ).get(input.session_id) as { seq: number };
      const id = nanoid(16);
      db.prepare(`
        INSERT INTO session_evidence_events (
          id, session_id, seq, event_type, severity, source_run_id,
          source_message_id, title, summary, payload, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.session_id,
        nextSeq.seq,
        input.event_type,
        input.severity ?? 'info',
        input.source_run_id ?? null,
        input.source_message_id ?? null,
        input.title,
        input.summary ?? null,
        JSON.stringify(input.payload ?? {}),
        now(),
      );
      return id;
    });
    return this.get(insert())!;
  },

  get(id: string): SessionEvidenceEvent | undefined {
    const row = db.prepare('SELECT * FROM session_evidence_events WHERE id = ?').get(id) as
      | SessionEvidenceEventRow
      | undefined;
    return row ? parseSessionEvidenceEventRow(row) : undefined;
  },

  listBySession(sessionId: string, input: { limit?: number } = {}): SessionEvidenceEvent[] {
    const limit = input.limit ?? 500;
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT * FROM session_evidence_events
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?
      ) ORDER BY seq ASC
    `).all(sessionId, limit) as SessionEvidenceEventRow[];
    return rows.map(parseSessionEvidenceEventRow);
  },

  latestByType(sessionId: string, eventType: SessionEvidenceType): SessionEvidenceEvent | undefined {
    const row = db.prepare(`
      SELECT * FROM session_evidence_events
      WHERE session_id = ? AND event_type = ?
      ORDER BY seq DESC
      LIMIT 1
    `).get(sessionId, eventType) as SessionEvidenceEventRow | undefined;
    return row ? parseSessionEvidenceEventRow(row) : undefined;
  },
};

function parseSessionEvidenceEventRow(row: SessionEvidenceEventRow): SessionEvidenceEvent {
  return {
    ...row,
    payload: parseJsonObject(row.payload),
  };
}
