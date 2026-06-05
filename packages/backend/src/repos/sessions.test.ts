import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-sessions-')), 'test.db');

const { db } = await import('../db.js');

test('session schema creates all new tables', () => {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'sessions',
        'session_messages',
        'session_runs',
        'session_plan_items',
        'session_context_manifests',
        'session_context_sources',
        'session_compactions',
        'session_evidence_events',
        'session_checkpoints',
        'history_records'
      )
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name), [
    'history_records',
    'session_checkpoints',
    'session_compactions',
    'session_context_manifests',
    'session_context_sources',
    'session_evidence_events',
    'session_messages',
    'session_plan_items',
    'session_runs',
    'sessions',
  ]);
});

test('session schema creates the primary lookup indexes', () => {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index'
      AND name IN (
        'idx_sessions_project_status_updated',
        'idx_session_messages_session',
        'idx_session_runs_session',
        'idx_session_evidence_session',
        'idx_history_project'
      )
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name), [
    'idx_history_project',
    'idx_session_evidence_session',
    'idx_session_messages_session',
    'idx_session_runs_session',
    'idx_sessions_project_status_updated',
  ]);
});
