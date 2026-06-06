import { execFileSync } from 'node:child_process';
import type {
  HistoryRecord,
  Project,
  Session,
  SessionAgentEvent,
  SessionBottomStatus,
  SessionDiffRow,
  SessionEvidenceEvent,
  SessionPlanItem,
  SessionPlanItemStatus,
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
      durationMs: firstNumber(event.payload.durationMs, acpEventPayload(event)?.durationMs),
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
  const trace = record(event.payload.trace);
  const toolName = evidenceToolName(event);
  if (trace?.kind === 'command') return 'exec';
  if (event.event_type === 'file_read') return 'read';
  if (event.event_type === 'file_diff') return 'edit';
  if (event.event_type === 'test' || event.event_type === 'build') return 'exec';
  if (event.event_type === 'browser_check') return 'browser';
  if (toolName && /^(read)$/i.test(toolName)) return 'read';
  if (toolName && /^(write)$/i.test(toolName)) return 'write';
  if (toolName && /^(edit|multiedit|patch|apply_patch)$/i.test(toolName)) return 'edit';
  return 'tool';
}

function evidenceLabel(event: SessionEvidenceEvent): string {
  const trace = record(event.payload.trace);
  const toolName = evidenceToolName(event);
  if (toolName) return toolName;
  if (trace?.kind === 'command') return 'exec_command';
  if (event.event_type === 'file_read') return '读取文件';
  if (event.event_type === 'file_diff') return '文件变更';
  if (event.event_type === 'test') return '测试';
  if (event.event_type === 'build') return '构建';
  if (event.event_type === 'browser_check') return '浏览器验证';
  return event.title;
}

function evidenceTarget(event: SessionEvidenceEvent): string {
  const trace = record(event.payload.trace);
  const eventPayload = acpEventPayload(event);
  const input = firstString(eventPayload?.input, eventPayload?.arguments, eventPayload?.rawInput, event.payload.input);
  const target = firstString(
    eventPayload?.path,
    eventPayload?.file,
    eventPayload?.file_path,
    eventPayload?.filePath,
    event.payload.path,
    event.payload.file,
    event.payload.file_path,
    event.payload.filePath,
    trace?.command,
    event.payload.command,
    input ? extractPatchPath(input) : null,
    event.summary,
    event.title,
  );
  return typeof target === 'string' && target.trim() ? target.trim() : event.title;
}

function evidenceStatus(event: SessionEvidenceEvent): SessionToolRow['status'] {
  if (event.severity === 'error' || event.severity === 'critical') return 'failed';
  const acpEvent = record(event.payload.event);
  const status = firstString(acpEvent?.status, event.payload.status);
  if (status === 'running' || status === 'delta' || status === 'started') return 'running';
  if (status === 'completed' || status === 'succeeded' || status === 'success') return 'completed';
  if (status === 'failed' || status === 'error') return 'failed';
  return 'completed';
}

export interface SessionInspectorSnapshot {
  planItems: SessionPlanItem[];
  toolRows: SessionToolRow[];
  diffRows: SessionDiffRow[];
}

export function buildSessionInspectorSnapshot(
  sessionId: string,
  evidence: SessionEvidenceEvent[],
  agentEvents: SessionAgentEvent[],
): SessionInspectorSnapshot {
  return {
    planItems: buildSessionPlanItemsFromAcp(sessionId, evidence, agentEvents),
    toolRows: buildSessionToolRows(evidence),
    diffRows: buildSessionDiffRowsFromAcp(evidence, agentEvents),
  };
}

export function buildSessionPlanItemsFromAcp(
  sessionId: string,
  evidence: SessionEvidenceEvent[],
  agentEvents: SessionAgentEvent[],
): SessionPlanItem[] {
  const latest = [
    ...evidence.flatMap((event) => extractPlanEntryBatchFromEvidence(event)),
    ...agentEvents.flatMap((event) => extractPlanEntryBatchFromAgentEvent(event)),
  ].at(-1);
  if (!latest) return [];
  return latest.entries.map((entry, index) => {
    const title = firstString(entry.title, entry.content, entry.text, entry.description) ?? `计划项 ${index + 1}`;
    const status = normalizePlanStatus(firstString(entry.status) ?? null);
    return {
      id: firstString(entry.id) ?? `${latest.sourceId}:${index}`,
      session_id: sessionId,
      parent_id: null,
      title,
      description: firstString(entry.description) ?? null,
      status,
      priority: index,
      source: 'acp_plan_update',
      evidence_event_id: latest.evidenceEventId,
      created_at: latest.createdAt,
      updated_at: latest.createdAt,
      completed_at: status === 'completed' ? latest.createdAt : null,
    };
  });
}

export function buildSessionDiffRowsFromAcp(
  evidence: SessionEvidenceEvent[],
  agentEvents: SessionAgentEvent[],
): SessionDiffRow[] {
  const rows = new Map<string, SessionDiffRow>();
  const changes = [
    ...evidence.flatMap(extractFileChangesFromEvidence),
    ...agentEvents.flatMap(extractFileChangesFromAgentEvent),
  ];

  for (const change of changes) {
    const existing = rows.get(change.path);
    rows.set(change.path, {
      path: change.path,
      status: change.status ?? existing?.status ?? 'modified',
      additions: addNullable(existing?.additions ?? null, change.additions),
      deletions: addNullable(existing?.deletions ?? null, change.deletions),
      summary: change.summary ?? existing?.summary ?? null,
    });
  }

  return [...rows.values()];
}

type PlanEntryBatch = {
  entries: Record<string, unknown>[];
  sourceId: string;
  evidenceEventId: string | null;
  createdAt: number;
};

type FileChange = {
  path: string;
  status: SessionDiffRow['status'] | null;
  additions: number | null;
  deletions: number | null;
  summary: string | null;
};

function extractPlanEntryBatchFromEvidence(event: SessionEvidenceEvent): PlanEntryBatch[] {
  const entries = extractPlanEntries(event.payload);
  if (entries.length === 0) return [];
  return [{
    entries,
    sourceId: event.id,
    evidenceEventId: event.id,
    createdAt: event.created_at,
  }];
}

function extractPlanEntryBatchFromAgentEvent(event: SessionAgentEvent): PlanEntryBatch[] {
  const payload = parsePayloadJson(event.payload_json);
  const entries = extractPlanEntries(payload);
  if (entries.length === 0) return [];
  return [{
    entries,
    sourceId: event.id,
    evidenceEventId: null,
    createdAt: event.created_at,
  }];
}

function extractPlanEntries(source: Record<string, unknown> | null): Record<string, unknown>[] {
  const candidates = expandPayloadCandidates(source);
  for (const candidate of candidates) {
    const eventType = firstString(candidate.type, candidate.event_type, candidate.rawType);
    const entries = firstArray(candidate.entries, candidate.plan, candidate.next_steps);
    if (!entries || entries.length === 0) continue;
    if (eventType && !/plan|next_steps/i.test(eventType)) continue;
    return entries.filter(isRecord);
  }
  return [];
}

function extractFileChangesFromEvidence(event: SessionEvidenceEvent): FileChange[] {
  const changes: FileChange[] = [];
  const eventPayload = acpEventPayload(event);
  const patchInput = firstString(eventPayload?.input, eventPayload?.arguments, eventPayload?.rawInput, event.payload.input);
  const path = firstString(
    eventPayload?.path,
    eventPayload?.file,
    eventPayload?.file_path,
    eventPayload?.filePath,
    event.payload.path,
    event.payload.file,
    event.payload.file_path,
    event.payload.filePath,
  );
  if (event.event_type === 'file_diff' && path) {
    changes.push({
      path,
      status: 'modified',
      additions: firstNumber(eventPayload?.additions, event.payload.additions),
      deletions: firstNumber(eventPayload?.deletions, event.payload.deletions),
      summary: evidenceToolName(event) ?? firstString(event.summary, event.title),
    });
  }

  const toolName = evidenceToolName(event);
  const patchPath = patchInput ? extractPatchPath(patchInput) : null;
  if (toolName && /^(edit|multiedit|patch|apply_patch)$/i.test(toolName) && patchInput && patchPath) {
    changes.push({
      path: patchPath,
      status: patchStatus(patchInput),
      additions: null,
      deletions: null,
      summary: toolName,
    });
  }
  return changes;
}

function extractFileChangesFromAgentEvent(event: SessionAgentEvent): FileChange[] {
  const payload = parsePayloadJson(event.payload_json);
  const changes: FileChange[] = [];
  for (const candidate of expandPayloadCandidates(payload)) {
    const eventType = firstString(candidate.type, candidate.event_type, candidate.rawType);
    const path = firstString(candidate.path, candidate.file, candidate.file_path, candidate.filePath);
    if (path && eventType && /file_diff|patch|diff/i.test(eventType)) {
      changes.push({
        path,
        status: 'modified',
        additions: firstNumber(candidate.additions),
        deletions: firstNumber(candidate.deletions),
        summary: firstString(candidate.name, candidate.title, event.event_type),
      });
    }
    const toolName = firstString(candidate.name, candidate.toolName, candidate.tool_name);
    const input = firstString(candidate.input, candidate.arguments, candidate.rawInput);
    const patchPath = input ? extractPatchPath(input) : null;
    if (toolName && /^(edit|multiedit|patch|apply_patch)$/i.test(toolName) && input && patchPath) {
      changes.push({
        path: patchPath,
        status: patchStatus(input),
        additions: null,
        deletions: null,
        summary: toolName,
      });
    }
  }
  return changes;
}

function evidenceToolName(event: SessionEvidenceEvent): string | null {
  const trace = record(event.payload.trace);
  const eventPayload = acpEventPayload(event);
  return firstString(
    eventPayload?.name,
    eventPayload?.toolName,
    eventPayload?.tool_name,
    event.payload.name,
    event.payload.toolName,
    event.payload.tool_name,
    trace?.name,
  );
}

function acpEventPayload(event: SessionEvidenceEvent): Record<string, unknown> | null {
  const acpEvent = record(event.payload.event);
  return record(acpEvent?.payload) ?? record(event.payload.payload);
}

function expandPayloadCandidates(source: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!source) return [];
  const event = record(source.event);
  const eventPayload = record(event?.payload);
  const payload = record(source.payload);
  const rawEvent = record(source.rawEvent);
  const rawEventPayload = record(rawEvent?.payload);
  return [source, event, eventPayload, payload, rawEvent, rawEventPayload].filter(isRecord);
}

function normalizePlanStatus(value: string | null): SessionPlanItemStatus {
  if (value === 'in_progress' || value === 'running' || value === 'started') return 'in_progress';
  if (value === 'completed' || value === 'done' || value === 'success' || value === 'succeeded') return 'completed';
  if (value === 'blocked') return 'blocked';
  if (value === 'failed' || value === 'error') return 'failed';
  if (value === 'skipped') return 'skipped';
  return 'pending';
}

function extractPatchPath(input: string): string | null {
  const match = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(input);
  return match?.[1]?.trim() || null;
}

function patchStatus(input: string): SessionDiffRow['status'] {
  if (/^\*\*\* Add File:/m.test(input)) return 'added';
  if (/^\*\*\* Delete File:/m.test(input)) return 'deleted';
  return 'modified';
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function parsePayloadJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return record(parsed);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(record(value));
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function firstArray(...values: unknown[]): unknown[] | null {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return null;
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
