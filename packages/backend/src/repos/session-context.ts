import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  SessionContextManifest,
  SessionContextSource,
  SessionContextSourceType,
} from '../types.js';

export const sessionContextRepo = {
  createManifest(input: {
    session_id: string;
    run_id?: string | null;
    total_token_estimate?: number;
    prompt_hash?: string | null;
    sources?: Array<{
      source_type: SessionContextSourceType;
      source_ref?: string | null;
      title: string;
      included?: 0 | 1;
      priority?: number;
      token_estimate?: number;
      reason?: string | null;
      content_hash?: string | null;
      excerpt?: string | null;
      metadata?: Record<string, unknown> | string | null;
    }>;
  }): SessionContextManifest {
    const id = nanoid(16);
    const timestamp = now();
    const create = db.transaction(() => {
      db.prepare(`
        INSERT INTO session_context_manifests (
          id, session_id, run_id, total_token_estimate, prompt_hash, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.session_id,
        input.run_id ?? null,
        input.total_token_estimate ?? 0,
        input.prompt_hash ?? null,
        timestamp,
      );
      for (const source of input.sources ?? []) {
        db.prepare(`
          INSERT INTO session_context_sources (
            id, manifest_id, session_id, source_type, source_ref, title,
            included, priority, token_estimate, reason, content_hash,
            excerpt, metadata, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nanoid(16),
          id,
          input.session_id,
          source.source_type,
          source.source_ref ?? null,
          source.title,
          source.included ?? 1,
          source.priority ?? 0,
          source.token_estimate ?? 0,
          source.reason ?? null,
          source.content_hash ?? null,
          source.excerpt ?? null,
          stringifyMetadata(source.metadata),
          timestamp,
        );
      }
    });
    create();
    return this.get(id)!;
  },

  get(id: string): SessionContextManifest | undefined {
    const row = db.prepare('SELECT * FROM session_context_manifests WHERE id = ?').get(id) as
      | Omit<SessionContextManifest, 'sources'>
      | undefined;
    return row ? { ...row, sources: this.listSources(id) } : undefined;
  },

  getLatestBySession(sessionId: string): SessionContextManifest | undefined {
    const row = db.prepare(`
      SELECT * FROM session_context_manifests
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId) as Omit<SessionContextManifest, 'sources'> | undefined;
    return row ? { ...row, sources: this.listSources(row.id) } : undefined;
  },

  listSources(manifestId: string): SessionContextSource[] {
    return db.prepare(`
      SELECT * FROM session_context_sources
      WHERE manifest_id = ?
      ORDER BY priority ASC, created_at ASC
    `).all(manifestId) as SessionContextSource[];
  },
};

function stringifyMetadata(value: Record<string, unknown> | string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}
