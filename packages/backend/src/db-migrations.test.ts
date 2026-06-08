import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

test('db migration adds active workspace columns before creating dependent session index', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'openclaw-room-legacy-session-db-')), 'test.db');
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      current_goal TEXT,
      mode TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      workspace_path TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      forked_from_session_id TEXT,
      forked_from_history_record_id TEXT,
      latest_compaction_id TEXT,
      latest_context_manifest_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
  `);
  legacyDb.close();

  process.env.OPENCLAW_ROOM_DB = dbPath;
  const { db } = await import(`./db.js?legacy-session-migration=${Date.now()}`);

  const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const indexes = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index'
      AND name = 'idx_sessions_active_workspace'
  `).all() as Array<{ name: string }>;

  assert.ok(columns.some((column) => column.name === 'closed_at'));
  assert.ok(columns.some((column) => column.name === 'pinned_at'));
  assert.ok(columns.some((column) => column.name === 'last_viewed_at'));
  assert.deepEqual(indexes.map((index) => index.name), ['idx_sessions_active_workspace']);
});
