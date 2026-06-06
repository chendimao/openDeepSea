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
  if (session.closed_at !== null) return null;
  const project = projectRepo.get(session.project_id);
  if (!project) return null;
  const latestEvent = readLatestEventSummary(session.id);
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
    updated_at: session.updated_at,
    unread_count: readUnreadCount(session),
    active_run_count: readActiveRunCount(session.id),
    latest_event_summary: latestEvent,
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
