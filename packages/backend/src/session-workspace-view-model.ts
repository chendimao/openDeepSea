import { execFileSync } from 'node:child_process';
import type {
  HistoryRecord,
  Project,
  Session,
  SessionAgentEvent,
  SessionBottomStatus,
  SessionDiffRow,
  SessionEvidenceEvent,
  SessionEvidenceSeverity,
  SessionEvidenceType,
  SessionPlanItem,
  SessionPlanItemStatus,
  SessionProjectSwitcher,
  SessionRun,
  SessionToolRow,
} from './types.js';
import { historyRecordRepo } from './repos/history-records.js';
import { projectRepo } from './repos/projects.js';
import { sessionRepo } from './repos/sessions.js';

const TOOL_EVIDENCE_TYPES = new Set<SessionEvidenceType>([
  'tool_call',
  'tool_result',
  'file_read',
  'file_diff',
  'test',
  'build',
  'browser_check',
]);
const MAX_TOOL_DETAIL_CHARS = 12_000;

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
  const rows: SessionToolRow[] = [];
  const rowIndexesByCallId = new Map<string, number>();
  for (const event of evidence.filter(isToolEvidence)) {
    const row = buildToolRow(event);
    const callId = evidenceToolCallId(event);
    const existingIndex = callId ? rowIndexesByCallId.get(callId) : undefined;
    if (existingIndex !== undefined) {
      rows[existingIndex] = mergeToolRows(rows[existingIndex]!, row);
      continue;
    }
    if (callId) rowIndexesByCallId.set(callId, rows.length);
    rows.push(row);
  }
  return rows.slice(-20);
}

function isToolEvidence(event: SessionEvidenceEvent): boolean {
  return effectiveToolEvidenceType(event) !== null;
}

function buildToolRow(event: SessionEvidenceEvent): SessionToolRow {
  const command = evidenceCommand(event);
  const output = evidenceOutput(event);
  const startedAt = evidenceStartedAt(event);
  const completedAt = evidenceCompletedAt(event);
  return {
    id: event.id,
    action: evidenceAction(event),
    label: evidenceLabel(event),
    target: evidenceTarget(event),
    status: evidenceStatus(event),
    durationMs: evidenceDurationMs(event, startedAt, completedAt),
    command,
    output,
    detail: buildToolDetail(command, output, event),
    startedAt,
    completedAt,
    severity: event.severity,
    eventId: event.id,
    created_at: event.created_at,
  };
}

function mergeToolRows(left: SessionToolRow, right: SessionToolRow): SessionToolRow {
  const command = right.command ?? left.command ?? null;
  const output = right.output ?? left.output ?? null;
  const detail = right.detail ?? left.detail ?? null;
  const startedAt = firstNumber(left.startedAt, right.startedAt);
  const completedAt = firstNumber(right.completedAt, left.completedAt);
  return {
    ...left,
    action: right.action === 'tool' ? left.action : right.action,
    label: isGenericToolLabel(right.label) ? left.label : right.label,
    target: isGenericToolTarget(right.target) ? left.target : right.target,
    status: mergeToolStatus(left.status, right.status),
    durationMs: right.durationMs ?? left.durationMs ?? (
      startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null
    ),
    command,
    output,
    detail,
    startedAt,
    completedAt,
    severity: mergeSeverity(left.severity, right.severity),
    eventId: right.eventId,
  };
}

function evidenceToolCallId(event: SessionEvidenceEvent): string | null {
  const rawUpdate = acpRawUpdate(event);
  const rawInput = record(rawUpdate?.rawInput);
  const rawOutput = acpRawOutput(event);
  const eventPayload = acpEventPayload(event);
  return firstString(
    rawUpdate?.toolCallId,
    rawUpdate?.tool_call_id,
    rawInput?.call_id,
    rawInput?.toolCallId,
    rawOutput?.call_id,
    rawOutput?.toolCallId,
    eventPayload?.tool_call_id,
    eventPayload?.toolCallId,
    event.payload.tool_call_id,
    event.payload.toolCallId,
  );
}

function evidenceCommand(event: SessionEvidenceEvent): string | null {
  const trace = record(event.payload.trace);
  const rawUpdate = acpRawUpdate(event);
  const rawInput = record(rawUpdate?.rawInput);
  const rawOutput = acpRawOutput(event);
  return firstString(
    rawInputCommand(rawOutput),
    rawInputCommand(rawInput),
    trace?.command,
    event.payload.command,
  );
}

function evidenceOutput(event: SessionEvidenceEvent): string | null {
  const rawOutput = acpRawOutput(event);
  const stdout = firstString(rawOutput?.stdout, rawOutput?.output, rawOutput?.aggregated_output, rawOutput?.formatted_output);
  const stderr = firstString(rawOutput?.stderr);
  const content = extractToolContentText(rawOutput?.content);
  const parts = [
    stdout,
    stderr ? `[stderr]\n${stderr}` : null,
    content,
  ].filter((part): part is string => Boolean(part));
  return trimToolDetail(parts.join('\n\n')) || null;
}

function evidenceStartedAt(event: SessionEvidenceEvent): number | null {
  const rawUpdate = acpRawUpdate(event);
  const rawInput = record(rawUpdate?.rawInput);
  const rawOutput = acpRawOutput(event);
  return firstNumber(
    event.payload.startedAt,
    event.payload.started_at,
    rawOutput?.started_at_ms,
    rawOutput?.startedAt,
    rawInput?.started_at_ms,
    rawInput?.startedAt,
  );
}

function evidenceCompletedAt(event: SessionEvidenceEvent): number | null {
  const rawUpdate = acpRawUpdate(event);
  const rawOutput = acpRawOutput(event);
  return firstNumber(
    event.payload.completedAt,
    event.payload.completed_at,
    rawOutput?.completed_at_ms,
    rawOutput?.completedAt,
    rawUpdate?.completed_at_ms,
    rawUpdate?.completedAt,
  );
}

function evidenceDurationMs(
  event: SessionEvidenceEvent,
  startedAt: number | null,
  completedAt: number | null,
): number | null {
  const eventPayload = acpEventPayload(event);
  const rawUpdate = acpRawUpdate(event);
  const rawOutput = acpRawOutput(event);
  const explicit = firstNumber(
    event.payload.durationMs,
    eventPayload?.durationMs,
    rawUpdate?.durationMs,
    rawOutput?.durationMs,
  );
  if (explicit !== null) return explicit;
  return startedAt !== null && completedAt !== null
    ? Math.max(0, completedAt - startedAt)
    : null;
}

function buildToolDetail(command: string | null, output: string | null, event: SessionEvidenceEvent): string | null {
  const rawOutput = acpRawOutput(event);
  const exitCode = firstNumber(rawOutput?.exit_code, rawOutput?.exitCode);
  const parts = [
    command ? `$ ${command}` : null,
    output,
    exitCode !== null ? `退出码 ${exitCode}` : null,
  ].filter((part): part is string => Boolean(part));
  return trimToolDetail(parts.join('\n\n')) || null;
}

function acpRawOutput(event: SessionEvidenceEvent): Record<string, unknown> | null {
  const rawUpdate = acpRawUpdate(event);
  return record(rawUpdate?.rawOutput) ?? record(rawUpdate?.output);
}

function extractToolContentText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((item) => {
    const itemRecord = record(item);
    const content = record(itemRecord?.content);
    return firstString(content?.text, itemRecord?.text) ?? [];
  });
  return parts.join('\n').trim() || null;
}

function trimToolDetail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_TOOL_DETAIL_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TOOL_DETAIL_CHARS).trimEnd()}\n\n[已截断]`;
}

function isGenericToolLabel(value: string): boolean {
  return value === 'tool_call' || value === 'tool_call_update' || value === 'exec_command';
}

function isGenericToolTarget(value: string): boolean {
  return value === 'tool_call' || value === 'tool_call_update';
}

function mergeToolStatus(
  left: SessionToolRow['status'],
  right: SessionToolRow['status'],
): SessionToolRow['status'] {
  if (right === 'failed' || left === 'failed') return 'failed';
  if (right === 'completed') return 'completed';
  if (left === 'completed') return 'completed';
  if (right === 'running' || left === 'running') return 'running';
  return right === 'unknown' ? left : right;
}

function mergeSeverity(
  left: SessionEvidenceSeverity,
  right: SessionEvidenceSeverity,
): SessionEvidenceSeverity {
  const rank: Record<SessionEvidenceSeverity, number> = {
    info: 0,
    warning: 1,
    error: 2,
    critical: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

function evidenceAction(event: SessionEvidenceEvent): SessionToolRow['action'] {
  const trace = record(event.payload.trace);
  const eventType = effectiveToolEvidenceType(event) ?? event.event_type;
  const toolName = evidenceToolName(event);
  const rawUpdate = acpRawUpdate(event);
  if (trace?.kind === 'command' || rawUpdate?.kind === 'execute') return 'exec';
  if (eventType === 'file_read') return 'read';
  if (eventType === 'file_diff') return 'edit';
  if (eventType === 'test' || eventType === 'build') return 'exec';
  if (eventType === 'browser_check') return 'browser';
  if (toolName && /^(read)$/i.test(toolName)) return 'read';
  if (toolName && /^(write)$/i.test(toolName)) return 'write';
  if (toolName && /^(edit|multiedit|patch|apply_patch)$/i.test(toolName)) return 'edit';
  return 'tool';
}

function evidenceLabel(event: SessionEvidenceEvent): string {
  const trace = record(event.payload.trace);
  const eventType = effectiveToolEvidenceType(event) ?? event.event_type;
  const toolName = evidenceToolName(event);
  const rawUpdate = acpRawUpdate(event);
  if (toolName) return toolName;
  if (trace?.kind === 'command') return 'exec_command';
  if (rawUpdate?.kind === 'execute') return 'exec_command';
  if (eventType === 'file_read') return '读取文件';
  if (eventType === 'file_diff') return '文件变更';
  if (eventType === 'test') return '测试';
  if (eventType === 'build') return '构建';
  if (eventType === 'browser_check') return '浏览器验证';
  const rawTitle = firstString(rawUpdate?.title);
  if (rawTitle) return rawTitle;
  return event.title;
}

function evidenceTarget(event: SessionEvidenceEvent): string {
  const trace = record(event.payload.trace);
  const eventPayload = acpEventPayload(event);
  const rawUpdate = acpRawUpdate(event);
  const input = firstString(
    eventPayload?.input,
    eventPayload?.arguments,
    eventPayload?.rawInput,
    event.payload.input,
    rawInputCommand(rawUpdate?.rawInput),
  );
  const rawTitle = firstString(rawUpdate?.title);
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
    rawInputCommand(rawUpdate?.rawInput),
    event.payload.command,
    input ? extractPatchPath(input) : null,
    input,
    rawTitle,
    event.summary,
    event.title,
  );
  return typeof target === 'string' && target.trim() ? target.trim() : event.title;
}

function evidenceStatus(event: SessionEvidenceEvent): SessionToolRow['status'] {
  if (event.severity === 'error' || event.severity === 'critical') return 'failed';
  const acpEvent = record(event.payload.event);
  const rawUpdate = acpRawUpdate(event);
  const status = firstString(acpEvent?.status, rawUpdate?.status, event.payload.status);
  if (status === 'running' || status === 'delta' || status === 'started' || status === 'in_progress') return 'running';
  if (status === 'completed' || status === 'succeeded' || status === 'success') return 'completed';
  if (status === 'failed' || status === 'error') return 'failed';
  return 'completed';
}

function effectiveToolEvidenceType(event: SessionEvidenceEvent): SessionEvidenceType | null {
  if (TOOL_EVIDENCE_TYPES.has(event.event_type)) return event.event_type;
  const rawType = evidenceRawType(event);
  if (rawType === 'tool_call_update') return 'tool_call';
  return TOOL_EVIDENCE_TYPES.has(rawType as SessionEvidenceType)
    ? rawType as SessionEvidenceType
    : null;
}

function evidenceRawType(event: SessionEvidenceEvent): string | null {
  const acpEvent = record(event.payload.event);
  const rawEvent = record(event.payload.rawEvent);
  const rawUpdate = acpRawUpdate(event);
  return firstString(
    event.payload.rawType,
    acpEvent?.type,
    rawEvent?.type,
    rawUpdate?.sessionUpdate,
  );
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
    ...agentEvents.flatMap((event) => extractPlanEntryBatchFromAgentEvent(event)),
    ...evidence.flatMap((event) => extractPlanEntryBatchFromEvidence(event)),
  ].sort((a, b) => a.createdAt - b.createdAt || a.sourceOrder - b.sourceOrder).at(-1);
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
  const seenSourceKeys = new Set<string>();

  for (const change of changes) {
    if (change.sourceKey) {
      if (seenSourceKeys.has(change.sourceKey)) continue;
      seenSourceKeys.add(change.sourceKey);
    }
    const existing = rows.get(change.path);
    rows.set(change.path, {
      path: change.path,
      status: mergeDiffStatus(existing?.status ?? null, change.status),
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
  sourceOrder: number;
};

type FileChange = {
  path: string;
  status: SessionDiffRow['status'] | null;
  additions: number | null;
  deletions: number | null;
  summary: string | null;
  sourceKey: string | null;
};

function extractPlanEntryBatchFromEvidence(event: SessionEvidenceEvent): PlanEntryBatch[] {
  const entries = extractPlanEntries(event.payload);
  if (entries.length === 0) return [];
  return [{
    entries,
    sourceId: event.id,
    evidenceEventId: event.id,
    createdAt: event.created_at,
    sourceOrder: 1,
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
    sourceOrder: 0,
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
      sourceKey: fileChangeSourceKey('file_diff', path, eventPayload, event.payload),
    });
  }

  const toolName = evidenceToolName(event);
  if (toolName && /^(edit|multiedit|patch|apply_patch)$/i.test(toolName) && patchInput) {
    changes.push(...extractPatchFileChanges(patchInput, toolName, fileChangeSourceKey('patch', null, eventPayload, event.payload)));
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
        sourceKey: fileChangeSourceKey('file_diff', path, candidate),
      });
    }
    const toolName = firstString(candidate.name, candidate.toolName, candidate.tool_name);
    const input = firstString(candidate.input, candidate.arguments, candidate.rawInput);
    if (toolName && /^(edit|multiedit|patch|apply_patch)$/i.test(toolName) && input) {
      changes.push(...extractPatchFileChanges(input, toolName, fileChangeSourceKey('patch', null, candidate)));
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

function acpRawUpdate(event: SessionEvidenceEvent): Record<string, unknown> | null {
  const rawEvent = record(event.payload.rawEvent);
  const params = record(rawEvent?.params);
  return record(params?.update) ?? record(rawEvent?.update);
}

function rawInputCommand(value: unknown): string | null {
  const rawInput = record(value);
  const command = rawInput?.command;
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.trim());
    if (parts.length >= 3 && parts[1] === '-lc') return parts.slice(2).join(' ');
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return firstString(command, rawInput?.cmd);
}

function expandPayloadCandidates(source: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!source) return [];
  const event = record(source.event);
  const eventPayload = record(event?.payload);
  const payload = record(source.payload);
  const rawEvent = record(source.rawEvent);
  const rawEventPayload = record(rawEvent?.payload);
  return [
    source,
    event,
    withInheritedEventType(eventPayload, event),
    payload,
    rawEvent,
    withInheritedEventType(rawEventPayload, rawEvent),
  ].filter(isRecord);
}

function withInheritedEventType(
  payload: Record<string, unknown> | null,
  event: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null;
  const eventType = firstString(event?.type, event?.event_type, event?.rawType);
  return eventType && !firstString(payload.type, payload.event_type, payload.rawType)
    ? { ...payload, type: eventType }
    : payload;
}

function normalizePlanStatus(value: string | null): SessionPlanItemStatus {
  if (value === 'in_progress' || value === 'running' || value === 'started') return 'in_progress';
  if (value === 'completed' || value === 'done' || value === 'success' || value === 'succeeded') return 'completed';
  if (value === 'blocked') return 'blocked';
  if (value === 'failed' || value === 'error') return 'failed';
  if (value === 'skipped') return 'skipped';
  return 'pending';
}

function fileChangeSourceKey(
  kind: 'file_diff' | 'patch',
  path: string | null,
  ...sources: Array<Record<string, unknown> | null>
): string | null {
  for (const source of sources) {
    const event = record(source?.event);
    const rawEvent = record(source?.rawEvent);
    const key = firstString(
      source?.tool_call_id,
      source?.toolCallId,
      source?.id,
      source?.event_id,
      source?.eventId,
      event?.tool_call_id,
      event?.toolCallId,
      event?.id,
      rawEvent?.tool_call_id,
      rawEvent?.toolCallId,
      rawEvent?.id,
    );
    if (key) return path ? `${kind}:${key}:${path}` : `${kind}:${key}`;
  }
  return null;
}

function extractPatchPath(input: string): string | null {
  return extractPatchFileChanges(input, null, null)[0]?.path ?? null;
}

function extractPatchFileChanges(input: string, summary: string | null, sourceKey: string | null): FileChange[] {
  const changes: FileChange[] = [];
  const headerPattern = /^\*\*\* (Update|Add|Delete) File: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(input)) !== null) {
    const action = match[1];
    const path = match[2]?.trim();
    if (!action || !path) continue;
    changes.push({
      path,
      status: patchHeaderStatus(action),
      additions: null,
      deletions: null,
      summary,
      sourceKey: sourceKey ? `${sourceKey}:${path}` : null,
    });
  }
  return changes;
}

function patchHeaderStatus(action: string): SessionDiffRow['status'] {
  if (action === 'Add') return 'added';
  if (action === 'Delete') return 'deleted';
  return 'modified';
}

function mergeDiffStatus(
  existing: SessionDiffRow['status'] | null,
  next: SessionDiffRow['status'] | null,
): SessionDiffRow['status'] {
  if (!existing) return next ?? 'modified';
  if (!next || next === 'modified') return existing;
  if (existing === 'modified') return next;
  return existing;
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
