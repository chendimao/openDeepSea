import { db } from './db.js';
import { projectRepo } from './repos/projects.js';
import { sessionRepo } from './repos/sessions.js';
import type { ActiveSessionSummary, Session } from './types.js';

const ACTIVE_RUN_STATUSES = ['queued', 'running', 'retrying', 'paused'] as const;

export function buildActiveSessionSummaries(): ActiveSessionSummary[] {
  return sessionRepo
    .listActiveWorkspaceSessions()
    .map(buildActiveSessionSummary)
    .filter((summary): summary is ActiveSessionSummary => summary !== null);
}

export function buildActiveSessionSummary(session: Session): ActiveSessionSummary | null {
  if (session.closed_at !== null || session.status === 'archived' || session.archived_at !== null) return null;
  const project = projectRepo.get(session.project_id);
  if (!project) return null;
  return {
    id: session.id,
    project_id: session.project_id,
    project_name: project.name,
    project_path: project.path,
    title: session.title,
    status: session.status,
    phase: session.phase,
    provider: session.provider,
    model: session.model,
    pinned_at: session.pinned_at,
    created_at: session.created_at,
    last_viewed_at: session.last_viewed_at,
    updated_at: session.updated_at,
    unread_count: readUnreadCount(session),
    active_run_count: readActiveRunCount(session.id),
    latest_event_summary: readFileChangeSummary(session.id) ?? readLatestEventSummary(session.id),
  };
}

function readActiveRunCount(sessionId: string): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count
    FROM session_runs
    WHERE session_id = ?
      AND status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(', ')})
  `).get(sessionId, ...ACTIVE_RUN_STATUSES) as { count: number }).count;
}

function readUnreadCount(session: Session): number {
  if (session.last_viewed_at === null) return 0;
  const messages = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM session_messages
    WHERE session_id = ?
      AND created_at > ?
  `).get(session.id, session.last_viewed_at) as { count: number }).count;
  const evidence = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM session_evidence_events
    WHERE session_id = ?
      AND created_at > ?
  `).get(session.id, session.last_viewed_at) as { count: number }).count;
  return messages + evidence;
}

function readFileChangeSummary(sessionId: string): string | null {
  const rows = db.prepare(`
    SELECT id, payload
    FROM session_evidence_events
    WHERE session_id = ?
      AND event_type = 'file_diff'
    ORDER BY seq ASC
  `).all(sessionId) as Array<{ id: string; payload: string | null }>;
  const changedFiles = new Set<string>();
  let anonymousDiffCount = 0;
  for (const row of rows) {
    const path = readFileDiffPath(row.payload);
    if (path) changedFiles.add(path);
    else anonymousDiffCount++;
  }
  const changeCount = changedFiles.size + anonymousDiffCount;
  return changeCount > 0 ? `本会话 ${changeCount} 个文件变更` : null;
}

function readFileDiffPath(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return findFirstDiffPath(parsed);
  } catch {
    return null;
  }
}

function findFirstDiffPath(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const directPath = firstNonEmptyString(record.path, record.file, record.filePath, record.file_path);
  if (directPath) return directPath;
  for (const key of ['event', 'data', 'payload', 'content', 'rawInput', 'raw_output'] as const) {
    const nested = findFirstDiffPath(record[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readLatestEventSummary(sessionId: string): string | null {
  const row = db.prepare(`
    SELECT summary, title
    FROM session_evidence_events
    WHERE session_id = ?
    ORDER BY seq DESC
    LIMIT 1
  `).get(sessionId) as { summary: string | null; title: string } | undefined;
  return row?.summary?.trim() || row?.title?.trim() || null;
}
