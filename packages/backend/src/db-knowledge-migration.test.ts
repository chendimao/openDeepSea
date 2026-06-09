import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';

test('db startup resets incompatible legacy knowledge schema before creating current schema', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-migration-')), 'test.db');
  const setup = new Database(dbPath);
  setup.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      description TEXT,
      pinned_at INTEGER,
      sort_order INTEGER,
      message_routing_mode TEXT NOT NULL DEFAULT 'fallback_reply',
      fallback_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE knowledge_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (
        source_type IN ('resource_asset', 'uploaded_file', 'agent_document', 'message', 'task', 'workspace_file', 'url', 'manual')
      ),
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      mime_type TEXT,
      uri TEXT,
      content_hash TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'stale')),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      indexed_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      UNIQUE (project_id, source_type, source_id)
    );

    INSERT INTO projects (
      id, name, path, description, pinned_at, sort_order, message_routing_mode, fallback_agent_id, created_at, updated_at
    )
    VALUES ('project-legacy', 'Legacy Project', '/tmp/opendeepsea-legacy-project', NULL, NULL, NULL, 'fallback_reply', NULL, 1, 1);

    INSERT INTO knowledge_sources (
      id, project_id, source_type, source_id, title, description, mime_type, uri, content_hash,
      tags_json, metadata_json, status, error, created_at, updated_at, indexed_at
    )
    VALUES (
      'legacy-source', 'project-legacy', 'uploaded_file', 'legacy-file', 'Legacy File', NULL, 'text/plain',
      NULL, NULL, '[]', '{}', 'ready', NULL, 1, 1, NULL
    );
  `);
  setup.close();

  process.env.OPENCLAW_ROOM_DB = dbPath;
  const { db } = await import(`./db.js?knowledge-migration-${Date.now()}`);
  const columns = db.prepare('PRAGMA table_info(knowledge_sources)').all() as { name: string }[];
  const indexes = db.prepare('PRAGMA index_list(knowledge_sources)').all() as { name: string }[];
  const embeddingColumns = db.prepare('PRAGMA table_info(knowledge_chunk_embeddings)').all() as { name: string }[];
  const embeddingIndexes = db.prepare('PRAGMA index_list(knowledge_chunk_embeddings)').all() as { name: string }[];
  const legacyCount = db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources WHERE id = ?')
    .get('legacy-source') as { count: number };

  assert.ok(columns.some((column) => column.name === 'room_id'));
  assert.ok(columns.some((column) => column.name === 'last_processed_at'));
  assert.ok(indexes.some((index) => index.name === 'idx_knowledge_sources_room'));
  assert.ok(embeddingColumns.some((column) => column.name === 'chunk_id'));
  assert.ok(embeddingColumns.some((column) => column.name === 'vector_json'));
  assert.ok(embeddingColumns.some((column) => column.name === 'content_hash'));
  assert.ok(embeddingIndexes.some((index) => index.name === 'idx_knowledge_chunk_embeddings_project'));
  assert.equal(legacyCount.count, 0);

  db.prepare(
    `INSERT INTO knowledge_sources (
      id, project_id, source_type, source_id, title, tags_json, metadata_json, status, created_at, updated_at
    )
     VALUES (?, ?, ?, ?, ?, '[]', '{}', ?, ?, ?)`,
  ).run('current-source', 'project-legacy', 'workspace_doc', 'workspace-doc-1', 'Workspace Doc', 'disabled', 2, 2);

  const inserted = db.prepare('SELECT source_type, status FROM knowledge_sources WHERE id = ?')
    .get('current-source') as { source_type: string; status: string } | undefined;
  assert.deepEqual(inserted, { source_type: 'workspace_doc', status: 'disabled' });
});
