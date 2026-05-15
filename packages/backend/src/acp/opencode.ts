import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliSessionSummary } from '../types.js';
import type { SessionAdapter } from './types.js';
import { runStreaming } from './claudecode.js';

const DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
const DEFAULT_OPENCODE_MODEL = 'gwenapi/gpt-5.5';

interface OpenCodeRow {
  id: string;
  title: string | null;
  cwd: string | null;
  created_at: number | null;
  updated_at: number | null;
  message_count: number | null;
  first_user: string | null;
}

export const openCodeAdapter: SessionAdapter = {
  backend: 'opencode',

  async listSessions(projectPath: string): Promise<CliSessionSummary[]> {
    if (!existsSync(DB_PATH)) return [];
    let db: Database.Database;
    try {
      db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    } catch {
      return [];
    }
    try {
      // OpenCode schema varies by version. Try a few likely table/column shapes.
      const candidateQueries = [
        `SELECT id, title, cwd, created_at, updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
                (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY created_at ASC LIMIT 1) AS first_user
         FROM sessions s WHERE cwd = ? ORDER BY updated_at DESC LIMIT 200`,
        `SELECT id, title, directory AS cwd, created_at, updated_at,
                NULL AS message_count, NULL AS first_user
         FROM session WHERE directory = ? ORDER BY updated_at DESC LIMIT 200`,
        `SELECT id, title, cwd, time_created AS created_at, time_updated AS updated_at,
                NULL AS message_count, NULL AS first_user
         FROM session WHERE cwd = ? ORDER BY time_updated DESC LIMIT 200`,
      ];
      let rows: OpenCodeRow[] = [];
      for (const q of candidateQueries) {
        try {
          rows = db.prepare(q).all(projectPath) as OpenCodeRow[];
          if (rows.length >= 0) break;
        } catch {
          // try next
        }
      }
      return rows.map((r) => ({
        backend: 'opencode' as const,
        sessionId: r.id,
        title: r.title?.trim() || (r.first_user ?? '').slice(0, 80) || r.id.slice(0, 8),
        cwd: r.cwd ?? projectPath,
        messageCount: r.message_count ?? 0,
        lastActivity: r.updated_at ?? r.created_at ?? Date.now(),
        firstUserMessage: r.first_user?.slice(0, 200),
      }));
    } finally {
      db.close();
    }
  },

  async invoke({ projectPath, sessionId, prompt, onChunk, onSession, signal }) {
    const args: string[] = ['run'];
    if (sessionId) args.push('--session', sessionId);
    args.push('--model', process.env.OPENCLAW_OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL);
    args.push(prompt);
    return runStreaming('opencode', args, projectPath, onChunk, signal, onSession);
  },
};
