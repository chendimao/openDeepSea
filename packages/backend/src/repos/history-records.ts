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

  listByProject(
    projectId: string,
    input: {
      limit?: number;
      q?: string;
      status?: HistoryRecordStatus | HistoryRecordStatus[];
      mode?: SessionMode | SessionMode[];
    } = {},
  ): HistoryRecord[] {
    const limit = input.limit ?? 100;
    const where = ['project_id = ?'];
    const values: Array<string | number> = [projectId];
    const q = input.q?.trim();
    if (q) {
      where.push('(title LIKE ? OR summary LIKE ? OR resume_brief LIKE ?)');
      values.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const statuses = normalizeArray(input.status);
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      values.push(...statuses);
    }
    const modes = normalizeArray(input.mode);
    if (modes.length > 0) {
      where.push(`mode IN (${modes.map(() => '?').join(', ')})`);
      values.push(...modes);
    }
    values.push(limit);
    const rows = db.prepare(`
      SELECT * FROM history_records
      WHERE ${where.join(' AND ')}
      ORDER BY ended_at DESC
      LIMIT ?
    `).all(...values) as HistoryRecordRow[];
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

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function parseHistoryRecordRow(row: HistoryRecordRow): HistoryRecord {
  return {
    ...row,
    key_decisions: parseJsonArray<string>(row.key_decisions),
    changed_files: parseJsonArray<string>(row.changed_files),
    commit_refs: parseJsonArray<string>(row.commit_refs),
  };
}
