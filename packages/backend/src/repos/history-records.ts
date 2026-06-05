import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  HistoryRecord,
  HistoryRecordStatus,
  SessionMode,
} from '../types.js';
import { parseJsonArray } from './sessions.js';

type HistoryRecordRow = Omit<HistoryRecord, 'key_decisions' | 'changed_files' | 'commit_refs'> & {
  key_decisions: string | null;
  changed_files: string | null;
  commit_refs: string | null;
};

export const historyRecordRepo = {
  create(input: {
    project_id: string;
    session_id: string;
    title: string;
    summary: string;
    status: HistoryRecordStatus;
    mode: SessionMode;
    started_at: number;
    ended_at: number;
    key_decisions: string[];
    changed_files: string[];
    verification_summary?: string | null;
    commit_refs: string[];
    resume_brief: string;
    compact_count: number;
    fork_count?: number;
  }): HistoryRecord {
    const timestamp = now();
    const id = nanoid(16);
    db.prepare(`
      INSERT INTO history_records (
        id, project_id, session_id, title, summary, status, mode,
        started_at, ended_at, key_decisions, changed_files,
        verification_summary, commit_refs, resume_brief,
        compact_count, fork_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.project_id,
      input.session_id,
      input.title,
      input.summary,
      input.status,
      input.mode,
      input.started_at,
      input.ended_at,
      JSON.stringify(input.key_decisions),
      JSON.stringify(input.changed_files),
      input.verification_summary ?? null,
      JSON.stringify(input.commit_refs),
      input.resume_brief,
      input.compact_count,
      input.fork_count ?? 0,
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  },

  get(id: string): HistoryRecord | undefined {
    const row = db.prepare('SELECT * FROM history_records WHERE id = ?').get(id) as HistoryRecordRow | undefined;
    return row ? parseHistoryRecordRow(row) : undefined;
  },

  getBySession(sessionId: string): HistoryRecord | undefined {
    const row = db.prepare('SELECT * FROM history_records WHERE session_id = ?').get(sessionId) as
      | HistoryRecordRow
      | undefined;
    return row ? parseHistoryRecordRow(row) : undefined;
  },

  listByProject(projectId: string, input: { limit?: number } = {}): HistoryRecord[] {
    const limit = input.limit ?? 100;
    const rows = db.prepare(`
      SELECT * FROM history_records
      WHERE project_id = ?
      ORDER BY ended_at DESC
      LIMIT ?
    `).all(projectId, limit) as HistoryRecordRow[];
    return rows.map(parseHistoryRecordRow);
  },

  incrementForkCount(id: string): HistoryRecord | undefined {
    db.prepare('UPDATE history_records SET fork_count = fork_count + 1, updated_at = ? WHERE id = ?').run(now(), id);
    return this.get(id);
  },

  updateResumeBrief(id: string, resumeBrief: string): HistoryRecord | undefined {
    db.prepare('UPDATE history_records SET resume_brief = ?, updated_at = ? WHERE id = ?').run(
      resumeBrief,
      now(),
      id,
    );
    return this.get(id);
  },
};

function parseHistoryRecordRow(row: HistoryRecordRow): HistoryRecord {
  return {
    ...row,
    key_decisions: parseJsonArray<string>(row.key_decisions),
    changed_files: parseJsonArray<string>(row.changed_files),
    commit_refs: parseJsonArray<string>(row.commit_refs),
  };
}
