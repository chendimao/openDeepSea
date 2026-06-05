import { execFileSync } from 'node:child_process';
import type {
  HistoryRecord,
  Project,
  Session,
  SessionBottomStatus,
  SessionDiffRow,
  SessionEvidenceEvent,
  SessionProjectSwitcher,
  SessionRun,
  SessionToolRow,
} from './types.js';
import { historyRecordRepo } from './repos/history-records.js';
import { projectRepo } from './repos/projects.js';
import { sessionRepo } from './repos/sessions.js';

export function buildSessionProjectSwitcher(activeProjectId: string): SessionProjectSwitcher {
  const projects = projectRepo.list().map((project) => ({
    id: project.id,
    name: project.name,
    path: project.path,
    active: project.id === activeProjectId,
    recentSessions: buildRecentProjectSessions(project),
  }));

  return { activeProjectId, projects };
}

function buildRecentProjectSessions(project: Project): SessionProjectSwitcher['projects'][number]['recentSessions'] {
  const sessions = sessionRepo.listByProject(project.id, { includeArchived: true }).slice(0, 3).map((session) => ({
    id: session.id,
    title: session.title,
    status: session.status,
    updated_at: session.updated_at,
    href: `/projects/${project.id}/sessions/${session.id}`,
    source: 'session' as const,
  }));
  const histories = historyRecordRepo.listByProject(project.id, { limit: 3 }).map((record: HistoryRecord) => ({
    id: record.id,
    title: record.title,
    status: record.status,
    updated_at: record.ended_at,
    href: `/projects/${project.id}/sessions/${record.session_id}`,
    source: 'history' as const,
  }));

  return [...sessions, ...histories]
    .sort((a, b) => {
      const activeDelta = Number(b.status === 'active') - Number(a.status === 'active');
      return activeDelta || b.updated_at - a.updated_at;
    })
    .slice(0, 3);
}

export function buildSessionBottomStatus(runs: SessionRun[], evidence: SessionEvidenceEvent[]): SessionBottomStatus {
  const recentRuns = runs.slice(-20);
  const lastCompleted = [...recentRuns].reverse().find((run) => run.completed_at !== null && run.started_at);
  const failedCount = recentRuns.filter((run) => run.status === 'failed').length;

  return {
    health: failedCount > 0 ? 'warning' : 'ok',
    healthLabel: failedCount > 0 ? '存在失败运行' : '良好',
    indexStatus: 'unknown',
    indexLabel: '未接入索引',
    lastResponseMs: lastCompleted?.completed_at
      ? Math.max(0, lastCompleted.completed_at - lastCompleted.started_at)
      : null,
    errorRate: recentRuns.length > 0 ? failedCount / recentRuns.length : 0,
    networkLatencyMs: null,
    tokenUsage: collectTokenUsage(evidence),
  };
}

function collectTokenUsage(evidence: SessionEvidenceEvent[]): SessionBottomStatus['tokenUsage'] {
  const totals = evidence.reduce(
    (acc, event) => {
      const usage = event.payload.usage;
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return acc;
      const input = Number(readUsageValue(usage, ['input', 'input_tokens', 'prompt_tokens']));
      const output = Number(readUsageValue(usage, ['output', 'output_tokens', 'completion_tokens']));
      return {
        input: acc.input + (Number.isFinite(input) ? input : 0),
        output: acc.output + (Number.isFinite(output) ? output : 0),
      };
    },
    { input: 0, output: 0 },
  );
  const total = totals.input + totals.output;
  return total > 0 ? { ...totals, total } : null;
}

function readUsageValue(usage: object, keys: string[]): number {
  const record = usage as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === 'number') return record[key];
  }
  return 0;
}

export function buildSessionToolRows(evidence: SessionEvidenceEvent[]): SessionToolRow[] {
  return evidence
    .filter(isToolEvidence)
    .slice(-20)
    .map((event) => ({
      id: event.id,
      action: evidenceAction(event),
      label: evidenceLabel(event),
      target: evidenceTarget(event),
      status: evidenceStatus(event),
      durationMs: typeof event.payload.durationMs === 'number' ? event.payload.durationMs : null,
      severity: event.severity,
      eventId: event.id,
      created_at: event.created_at,
    }));
}

function isToolEvidence(event: SessionEvidenceEvent): boolean {
  return (
    event.event_type === 'tool_call' ||
    event.event_type === 'tool_result' ||
    event.event_type === 'file_read' ||
    event.event_type === 'file_diff' ||
    event.event_type === 'test' ||
    event.event_type === 'build' ||
    event.event_type === 'browser_check'
  );
}

function evidenceAction(event: SessionEvidenceEvent): SessionToolRow['action'] {
  if (event.event_type === 'file_read') return 'read';
  if (event.event_type === 'file_diff') return 'edit';
  if (event.event_type === 'test' || event.event_type === 'build') return 'exec';
  if (event.event_type === 'browser_check') return 'browser';
  return 'tool';
}

function evidenceLabel(event: SessionEvidenceEvent): string {
  if (event.event_type === 'file_read') return '读取文件';
  if (event.event_type === 'file_diff') return '文件变更';
  if (event.event_type === 'test') return '测试';
  if (event.event_type === 'build') return '构建';
  if (event.event_type === 'browser_check') return '浏览器验证';
  return event.title;
}

function evidenceTarget(event: SessionEvidenceEvent): string {
  const target = event.payload.path ?? event.payload.file ?? event.payload.command ?? event.summary ?? event.title;
  return typeof target === 'string' && target.trim() ? target.trim() : event.title;
}

function evidenceStatus(event: SessionEvidenceEvent): SessionToolRow['status'] {
  if (event.severity === 'error' || event.severity === 'critical') return 'failed';
  const status = event.payload.status;
  if (status === 'running' || status === 'completed' || status === 'failed') return status;
  return 'completed';
}

export function buildSessionDiffRows(workspacePath: string | null | undefined): SessionDiffRow[] {
  if (!workspacePath) return [];
  const statusLines = readGit(workspacePath, ['status', '--porcelain']).split('\n').filter(Boolean);
  const stats = readDiffStats(workspacePath);

  return statusLines.map((line) => {
    const code = line.slice(0, 2);
    const path = normalizeGitStatusPath(line.slice(3).trim());
    const stat = stats.get(path);
    return {
      path,
      status: mapGitStatus(code),
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      summary: code.trim() || null,
    };
  });
}

function readDiffStats(workspacePath: string): Map<string, { additions: number | null; deletions: number | null }> {
  const rows = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of readGit(workspacePath, ['diff', '--numstat']).split('\n').filter(Boolean)) {
    const parts = line.split(/\s+/);
    const additions = parts[0];
    const deletions = parts[1];
    const path = parts.slice(2).join(' ');
    if (!path) continue;
    rows.set(normalizeGitStatusPath(path), {
      additions: additions === '-' ? null : Number(additions),
      deletions: deletions === '-' ? null : Number(deletions),
    });
  }
  return rows;
}

function normalizeGitStatusPath(path: string): string {
  const renameArrow = ' -> ';
  return path.includes(renameArrow) ? path.slice(path.indexOf(renameArrow) + renameArrow.length) : path;
}

function mapGitStatus(code: string): SessionDiffRow['status'] {
  if (code.includes('U')) return 'conflicted';
  if (code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  if (code === '??') return 'untracked';
  return 'modified';
}

function readGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch {
    return '';
  }
}

export function resolveSessionWorkspacePath(session: Session, project: Project): string | null {
  return session.worktree_path ?? session.workspace_path ?? project.path ?? null;
}
