import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { AcpBackend } from '../types.js';
import type { SessionTokenUsageRecord, SessionTokenUsageSummary } from '../session-types.js';
import { parseJsonObject } from './sessions.js';

type SessionTokenUsageRow = Omit<SessionTokenUsageRecord, 'raw_payload'> & {
  raw_payload: string | null;
};

type SessionTokenUsageSummaryRow = SessionTokenUsageRow & {
  acp_session_id: string | null;
  usage_rowid: number;
};

export const sessionTokenUsageRepo = {
  create(input: {
    session_id: string;
    run_id?: string | null;
    agent_id?: string | null;
    provider?: AcpBackend | null;
    model?: string | null;
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number | null;
    cached_input_tokens?: number | null;
    reasoning_tokens?: number | null;
    source: string;
    is_final?: boolean;
    raw_payload?: Record<string, unknown>;
  }): SessionTokenUsageRecord {
    const id = nanoid(16);
    const inputTokens = normalizeTokenCount(input.input_tokens);
    const outputTokens = normalizeTokenCount(input.output_tokens);
    const totalTokens = normalizeTokenCount(input.total_tokens ?? inputTokens + outputTokens);
    db.prepare(`
      INSERT INTO session_token_usage (
        id, session_id, run_id, agent_id, provider, model,
        input_tokens, output_tokens, total_tokens,
        cached_input_tokens, reasoning_tokens, source, is_final,
        raw_payload, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.session_id,
      input.run_id ?? null,
      input.agent_id ?? null,
      input.provider ?? null,
      input.model ?? null,
      inputTokens,
      outputTokens,
      totalTokens,
      nullableTokenCount(input.cached_input_tokens),
      nullableTokenCount(input.reasoning_tokens),
      input.source,
      input.is_final ? 1 : 0,
      JSON.stringify(input.raw_payload ?? {}),
      now(),
    );
    return this.get(id)!;
  },

  get(id: string): SessionTokenUsageRecord | undefined {
    const row = db.prepare('SELECT * FROM session_token_usage WHERE id = ?').get(id) as
      | SessionTokenUsageRow
      | undefined;
    return row ? parseSessionTokenUsageRow(row) : undefined;
  },

  listBySession(sessionId: string, input: { limit?: number } = {}): SessionTokenUsageRecord[] {
    const limit = input.limit ?? 500;
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT * FROM session_token_usage
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) ORDER BY created_at ASC, id ASC
    `).all(sessionId, limit) as SessionTokenUsageRow[];
    return rows.map(parseSessionTokenUsageRow);
  },

  summarizeBySession(sessionId: string): SessionTokenUsageSummary | null {
    const rows = db.prepare(`
      SELECT
        session_token_usage.*,
        session_token_usage.rowid AS usage_rowid,
        session_runs.acp_session_id
      FROM session_token_usage
      LEFT JOIN session_runs ON session_runs.id = session_token_usage.run_id
      WHERE session_token_usage.session_id = ?
      ORDER BY session_token_usage.created_at ASC, session_token_usage.rowid ASC
    `).all(sessionId) as SessionTokenUsageSummaryRow[];
    const latestRowsByScope = new Map<string, SessionTokenUsageSummaryRow>();
    for (const row of rows) {
      const key = usageSummaryScopeKey(row);
      const existing = latestRowsByScope.get(key);
      if (!existing || shouldReplaceSummaryRow(existing, row)) {
        latestRowsByScope.set(key, row);
      }
    }
    const totals = Array.from(latestRowsByScope.values()).reduce(
      (acc, row) => ({
        input: acc.input + row.input_tokens,
        output: acc.output + row.output_tokens,
        total: acc.total + row.total_tokens,
      }),
      { input: 0, output: 0, total: 0 },
    );
    return totals.total > 0 ? totals : null;
  },
};

function usageSummaryScopeKey(row: SessionTokenUsageSummaryRow): string {
  if (row.source === 'provider_context_usage') {
    return `context:${row.provider ?? 'unknown'}:${row.acp_session_id ?? row.run_id ?? row.id}`;
  }
  return `run:${row.run_id ?? row.id}`;
}

function shouldReplaceSummaryRow(left: SessionTokenUsageSummaryRow, right: SessionTokenUsageSummaryRow): boolean {
  if (left.is_final !== right.is_final) return right.is_final > left.is_final;
  if (left.created_at !== right.created_at) return right.created_at > left.created_at;
  return right.usage_rowid > left.usage_rowid;
}

function parseSessionTokenUsageRow(row: SessionTokenUsageRow): SessionTokenUsageRecord {
  return {
    ...row,
    provider: row.provider as AcpBackend | null,
    is_final: row.is_final ? 1 : 0,
    raw_payload: parseJsonObject(row.raw_payload),
  };
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function nullableTokenCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return normalizeTokenCount(value);
}
