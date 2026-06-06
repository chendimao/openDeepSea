import { Router, type Response } from 'express';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { now } from './db.js';
import { projectRepo } from './repos/projects.js';
import {
  sessionMessageRepo,
  sessionPlanItemRepo,
  sessionRepo,
  sessionRunRepo,
} from './repos/sessions.js';
import { historyRecordRepo } from './repos/history-records.js';
import { sessionCompactionRepo } from './repos/session-compactions.js';
import { sessionContractRepo } from './repos/session-contracts.js';
import { sessionContextRepo } from './repos/session-context.js';
import { sessionEvidenceRepo } from './repos/session-evidence.js';
import { sessionCheckpointRepo } from './repos/session-checkpoints.js';
import type { ParsedSessionCommand } from './session-command.js';
import { buildContextManifestDraft } from './session-context.js';
import { buildHistorySummary } from './session-summary.js';
import { buildStatusSnapshot } from './session-status.js';
import {
  buildSessionBottomStatus,
  buildSessionDiffRows,
  buildSessionProjectSwitcher,
  buildSessionToolRows,
  resolveSessionWorkspacePath,
} from './session-workspace-view-model.js';
import { wsHub } from './ws-hub.js';
import type {
  HistoryRecord,
  Project,
  Session,
  SessionCompaction,
  SessionContextManifest,
  SessionDetail,
  SessionEvidenceEvent,
  SessionMode,
  SessionWorkspacePayload,
  StatusSnapshot,
} from './types.js';

export const sessionRouter = Router();

const sessionModeSchema = z.enum(['ask', 'plan', 'code', 'debug', 'review']);
const historyRecordStatusSchema = z.enum(['completed', 'blocked', 'failed', 'archived']);
const execFileAsync = promisify(execFile);

sessionRouter.get('/projects/:projectId/sessions', listProjectSessions);
sessionRouter.post('/projects/:projectId/sessions', createProjectSession);
sessionRouter.get('/sessions/:sessionId', getSessionDetail);
sessionRouter.patch('/sessions/:sessionId', updateSession);
sessionRouter.post('/sessions/:sessionId/new', runNewCommand);
sessionRouter.post('/sessions/:sessionId/compact/preview', previewSessionCompact);
sessionRouter.post('/sessions/:sessionId/compact/apply', applySessionCompact);
sessionRouter.post('/sessions/:sessionId/compact/discard', discardSessionCompact);
sessionRouter.patch('/sessions/:sessionId/contract', updateSessionContract);
sessionRouter.get('/sessions/:sessionId/status', getSessionStatus);
sessionRouter.get('/sessions/:sessionId/context', getSessionContext);
sessionRouter.get('/sessions/:sessionId/evidence', listSessionEvidence);
sessionRouter.post('/sessions/:sessionId/checkpoints', createSessionCheckpoint);
sessionRouter.post('/sessions/:sessionId/fork', forkSession);
sessionRouter.get('/projects/:projectId/history-records', listProjectHistoryRecords);
sessionRouter.get('/history-records/:historyRecordId', getHistoryRecord);
sessionRouter.post('/history-records/:historyRecordId/resume', resumeHistoryRecord);
sessionRouter.post('/history-records/:historyRecordId/fork', forkHistoryRecord);
sessionRouter.post('/history-records/:historyRecordId/resume-brief/regenerate', regenerateResumeBrief);
sessionRouter.get('/history-records/:historyRecordId/export', exportHistoryRecord);

function listProjectSessions(req: { params: { projectId: string }; query: Record<string, unknown> }, res: Response): void {
  const project = projectRepo.get(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  res.json(sessionRepo.listByProject(project.id, { includeArchived: req.query.includeArchived === '1' }));
}

function createProjectSession(req: { params: { projectId: string }; body: unknown }, res: Response): void {
  const project = projectRepo.get(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const parsed = z.object({
    title: z.string().trim().min(1).optional(),
    current_goal: z.string().trim().min(1).nullable().optional(),
    mode: sessionModeSchema.optional(),
    provider: z.enum(['claudecode', 'opencode', 'codex']).nullable().optional(),
    model: z.string().trim().min(1).nullable().optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const session = sessionRepo.create({
    project_id: project.id,
    title: parsed.data.title,
    current_goal: parsed.data.current_goal,
    mode: parsed.data.mode,
    provider: parsed.data.provider ?? 'codex',
    model: parsed.data.model,
    workspace_path: project.path,
  });
  res.status(201).json(session);
}

function getSessionDetail(req: { params: { sessionId: string } }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  res.json(buildSessionDetail(session));
}

function updateSession(req: { params: { sessionId: string }; body: unknown }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const parsed = z.object({
    title: z.string().trim().min(1).optional(),
    current_goal: z.string().trim().min(1).nullable().optional(),
    mode: sessionModeSchema.optional(),
    phase: z.enum([
      'idle',
      'brainstorming',
      'planning',
      'implementing',
      'debugging',
      'reviewing',
      'verifying',
      'blocked',
      'completed',
      'archived',
    ]).optional(),
    status: z.enum(['active', 'blocked', 'completed', 'archived', 'failed']).optional(),
    provider: z.enum(['claudecode', 'opencode', 'codex']).nullable().optional(),
    model: z.string().trim().min(1).nullable().optional(),
  }).strict().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(sessionRepo.update(session.id, parsed.data));
}

function updateSessionContract(req: { params: { sessionId: string }; body?: unknown }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const parsed = z.object({
    scope: z.string().nullable().optional(),
    risks: z.array(z.string().trim().min(1)).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
  }).strict().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const contract = sessionContractRepo.upsert(session, parsed.data);
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: 'Contract updated',
    payload: { contract_updated: true },
  });
  wsHub.broadcastSession(session.id, { type: 'session_evidence:new', sessionId: session.id, event });
  res.json(contract);
}

function runNewCommand(req: { params: { sessionId: string }; body?: unknown }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const parsed = z.object({
    title: z.string().trim().min(1).optional(),
    blank: z.boolean().optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const command: ParsedSessionCommand = {
    kind: 'new',
    raw: '/new',
    body: '',
    args: {
      ...(parsed.data.title ? { title: parsed.data.title } : {}),
      ...(parsed.data.blank ? { blank: true } : {}),
    },
  };
  handleNewCommand(res, session, command);
}

function previewSessionCompact(req: { params: { sessionId: string }; body?: unknown }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const parsed = z.object({
    focus: z.string().trim().min(1).optional(),
    strategy: z.enum(['manual', 'focus', 'aggressive', 'conservative', 'auto_suggested']).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const command: ParsedSessionCommand = {
    kind: 'compact',
    raw: '/compact',
    body: '',
    args: parsed.data.focus ? { focus: parsed.data.focus } : {},
  };
  const compaction = createCompactPreview(session, command, parsed.data.strategy);
  res.status(201).json(compaction);
}

function applySessionCompact(req: { params: { sessionId: string }; body?: unknown }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const parsed = z.object({
    compaction_id: z.string().min(1),
    applied_summary: z.string().trim().min(1),
    user_edited: z.boolean().optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const compaction = sessionCompactionRepo.get(parsed.data.compaction_id);
  if (!compaction || compaction.session_id !== session.id) {
    res.status(404).json({ error: 'compaction not found' });
    return;
  }
  const applied = sessionCompactionRepo.apply(compaction.id, {
    applied_summary: parsed.data.applied_summary,
    user_edited: parsed.data.user_edited,
  });
  sessionRepo.update(session.id, { latest_compaction_id: compaction.id });
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'compact',
    title: 'Compact applied',
    summary: parsed.data.applied_summary,
    payload: { compaction_id: compaction.id },
  });
  res.json(applied);
}

function discardSessionCompact(req: { params: { sessionId: string }; body?: unknown }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const parsed = z.object({ compaction_id: z.string().min(1) }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const compaction = sessionCompactionRepo.get(parsed.data.compaction_id);
  if (!compaction || compaction.session_id !== session.id) {
    res.status(404).json({ error: 'compaction not found' });
    return;
  }
  const discarded = sessionCompactionRepo.discard(compaction.id);
  if (!discarded || discarded.status !== 'discarded') {
    res.status(409).json({ error: 'compaction is not previewed' });
    return;
  }
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'compact',
    title: 'Compact discarded',
    payload: { compaction_id: compaction.id },
  });
  wsHub.broadcastSession(session.id, { type: 'session_evidence:new', sessionId: session.id, event });
  res.json(discarded);
}

function getSessionStatus(req: { params: { sessionId: string } }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  res.json(buildSessionStatus(session));
}

function getSessionContext(req: { params: { sessionId: string } }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  res.json(ensureContextManifest(session));
}

function listSessionEvidence(req: { params: { sessionId: string } }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  res.json(sessionEvidenceRepo.listBySession(session.id));
}

async function createSessionCheckpoint(req: { params: { sessionId: string }; body?: unknown }, res: Response): Promise<void> {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const project = projectRepo.get(session.project_id);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const parsed = z.object({
    title: z.string().trim().min(1),
    description: z.string().nullable().optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const git = await readGitSnapshot(project.path);
  const checkpoint = sessionCheckpointRepo.create({
    session_id: session.id,
    ...parsed.data,
    git_head: git.git_head,
    branch_name: git.branch_name,
    diff_summary: git.diff_summary,
  });
  const evidence = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'checkpoint',
    title: checkpoint.title,
    summary: checkpoint.diff_summary,
    payload: { checkpoint_id: checkpoint.id },
  });
  res.status(201).json(sessionCheckpointRepo.updateEvidenceEvent(checkpoint.id, evidence.id));
}

function forkSession(req: { params: { sessionId: string }; body?: unknown }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const parsed = forkInputSchema().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const fork = sessionRepo.create({
    project_id: session.project_id,
    title: parsed.data.title ?? `Fork: ${session.title}`,
    current_goal: session.current_goal,
    mode: parsed.data.mode ?? session.mode,
    provider: parsed.data.provider ?? session.provider,
    model: parsed.data.model ?? session.model,
    workspace_path: session.workspace_path,
    worktree_path: parsed.data.worktree_path ?? null,
    branch_name: parsed.data.branch_name ?? session.branch_name,
    forked_from_session_id: session.id,
  });
  inheritLatestAppliedCompact(session, fork);
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'fork',
    title: 'Session forked',
    payload: { fork_session_id: fork.id },
  });
  sessionEvidenceRepo.create({
    session_id: fork.id,
    event_type: 'fork',
    title: 'Fork created',
    payload: { source_session_id: session.id },
  });
  const project = projectRepo.get(session.project_id)!;
  res.status(201).json(buildWorkspacePayload(project, fork));
}

function listProjectHistoryRecords(req: { params: { projectId: string }; query: Record<string, unknown> }, res: Response): void {
  const project = projectRepo.get(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const parsed = z.object({
    q: z.string().trim().optional(),
    status: historyRecordStatusSchema.optional(),
    mode: sessionModeSchema.optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(historyRecordRepo.listByProject(project.id, parsed.data));
}

function getHistoryRecord(req: { params: { historyRecordId: string } }, res: Response): void {
  const record = historyRecordRepo.get(req.params.historyRecordId);
  if (!record) {
    res.status(404).json({ error: 'history record not found' });
    return;
  }
  res.json(record);
}

function resumeHistoryRecord(req: { params: { historyRecordId: string } }, res: Response): void {
  const record = historyRecordRepo.get(req.params.historyRecordId);
  if (!record) {
    res.status(404).json({ error: 'history record not found' });
    return;
  }
  const project = projectRepo.get(record.project_id);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const session = sessionRepo.create({
    project_id: record.project_id,
    title: `Resume: ${record.title}`,
    current_goal: readGoalFromResumeBrief(record),
    mode: record.mode,
    provider: 'codex',
    workspace_path: project.path,
    forked_from_history_record_id: record.id,
  });
  sessionMessageRepo.create({
    session_id: session.id,
    role: 'system',
    sender_id: 'system',
    sender_name: 'OpenClaw',
    message_type: 'system',
    content: [
      '这是从历史记录恢复的新会话。请先对齐目标、未完成项、关键文件和最近验证，再继续执行。',
      '',
      record.resume_brief,
    ].join('\n'),
  });
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'resume',
    title: 'History resumed',
    payload: { history_record_id: record.id },
  });
  res.status(201).json(buildWorkspacePayload(project, session));
}

function forkHistoryRecord(req: { params: { historyRecordId: string }; body?: unknown }, res: Response): void {
  const record = historyRecordRepo.get(req.params.historyRecordId);
  if (!record) {
    res.status(404).json({ error: 'history record not found' });
    return;
  }
  const project = projectRepo.get(record.project_id);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const parsed = forkInputSchema().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const fork = sessionRepo.create({
    project_id: record.project_id,
    title: parsed.data.title ?? `Fork: ${record.title}`,
    current_goal: readGoalFromResumeBrief(record),
    mode: parsed.data.mode ?? record.mode,
    provider: parsed.data.provider ?? 'codex',
    model: parsed.data.model,
    workspace_path: project.path,
    worktree_path: parsed.data.worktree_path ?? null,
    branch_name: parsed.data.branch_name ?? null,
    forked_from_history_record_id: record.id,
  });
  sessionContextRepo.createManifest({
    session_id: fork.id,
    total_token_estimate: Math.ceil(record.resume_brief.length / 4),
    sources: [{
      source_type: 'history',
      source_ref: record.id,
      title: `History: ${record.title}`,
      reason: '从历史记录分叉时继承 resume brief',
      excerpt: record.resume_brief,
      metadata: { inherited: true },
    }],
  });
  historyRecordRepo.incrementForkCount(record.id);
  sessionEvidenceRepo.create({
    session_id: fork.id,
    event_type: 'fork',
    title: 'History fork created',
    payload: { history_record_id: record.id },
  });
  res.status(201).json(buildWorkspacePayload(project, fork));
}

function regenerateResumeBrief(req: { params: { historyRecordId: string } }, res: Response): void {
  const record = historyRecordRepo.get(req.params.historyRecordId);
  if (!record) {
    res.status(404).json({ error: 'history record not found' });
    return;
  }
  const resumeBrief = [
    `目标：${record.title}`,
    `已完成：${record.summary}`,
    `最近验证：${record.verification_summary ?? '未知'}`,
    `优先读取文件：${record.changed_files.slice(0, 8).join(', ') || '无'}`,
  ].join('\n');
  res.json(historyRecordRepo.updateResumeBrief(record.id, resumeBrief));
}

function exportHistoryRecord(req: { params: { historyRecordId: string } }, res: Response): void {
  const record = historyRecordRepo.get(req.params.historyRecordId);
  if (!record) {
    res.status(404).json({ error: 'history record not found' });
    return;
  }
  const sourceSession = sessionRepo.get(record.session_id);
  res.json({
    record,
    sourceSession: sourceSession ? buildSessionDetail(sourceSession) : null,
  });
}

function handleNewCommand(res: Response, session: Session, command: ParsedSessionCommand): void {
  const project = projectRepo.get(session.project_id);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const detail = buildSessionDetail(session);
  const changedFiles = collectChangedFiles(detail.evidence);
  const verificationSummary = collectLatestVerification(detail.evidence);
  const summary = buildHistorySummary({
    goal: session.current_goal,
    messages: detail.messages,
    changedFiles,
    verificationSummary,
  });
  const record = historyRecordRepo.create({
    project_id: session.project_id,
    session_id: session.id,
    title: typeof command.args.title === 'string' ? command.args.title : summary.title,
    summary: summary.summary,
    status: session.status === 'failed' ? 'failed' : session.status === 'blocked' ? 'blocked' : 'archived',
    mode: session.mode,
    started_at: session.created_at,
    ended_at: now(),
    key_decisions: summary.keyDecisions,
    changed_files: changedFiles,
    verification_summary: verificationSummary,
    commit_refs: collectCommitRefs(detail.evidence),
    resume_brief: summary.resumeBrief,
    compact_count: detail.compactions.length,
  });
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'new',
    title: 'Session archived',
    payload: { history_record_id: record.id },
  });
  sessionRepo.archive(session.id);
  const next = sessionRepo.create({
    project_id: session.project_id,
    title: command.args.blank ? 'New Session' : `继续：${record.title}`,
    current_goal: command.args.blank ? null : session.current_goal,
    mode: session.mode,
    provider: session.provider ?? 'codex',
    model: session.model,
    workspace_path: session.workspace_path ?? project.path,
  });
  res.status(201).json(buildWorkspacePayload(project, next));
}

function createCompactPreview(
  session: Session,
  command: ParsedSessionCommand,
  strategy?: 'manual' | 'focus' | 'aggressive' | 'conservative' | 'auto_suggested',
) {
  const messages = sessionMessageRepo.listBySession(session.id, { limit: 20 });
  const focus = typeof command.args.focus === 'string' ? command.args.focus : null;
  const previewSummary = [
    focus ? `Focus：${focus}` : null,
    `目标：${session.current_goal ?? session.title}`,
    `最近消息数：${messages.length}`,
    messages.slice(-5).map((message) => `${message.role}: ${message.content}`).join('\n'),
  ].filter(Boolean).join('\n');
  return sessionCompactionRepo.createPreview({
    session_id: session.id,
    strategy: strategy ?? (focus ? 'focus' : 'manual'),
    focus_prompt: focus,
    preview_summary: previewSummary,
    retained_refs: messages.slice(-10).map((message) => `message:${message.id}`),
    dropped_refs: messages.slice(0, -10).map((message) => `message:${message.id}`),
    risk_notes: messages.length > 10 ? '较早消息将只通过摘要保留。' : null,
  });
}

export function buildWorkspacePayload(project: Project, activeSession: Session): SessionWorkspacePayload {
  const detail = buildSessionDetail(activeSession);
  const evidence = detail.evidence.slice(-100);
  return {
    project,
    activeSession: detail,
    historyRecords: historyRecordRepo.listByProject(project.id),
    status: buildSessionStatus(activeSession),
    context: sessionContextRepo.getLatestBySession(activeSession.id) ?? null,
    evidence,
    projectSwitcher: buildSessionProjectSwitcher(project.id),
    bottomStatus: buildSessionBottomStatus(detail.runs, detail.evidence),
    contract: sessionContractRepo.getOrCreate(activeSession),
    toolRows: buildSessionToolRows(evidence),
    diffRows: buildSessionDiffRows(resolveSessionWorkspacePath(activeSession, project)),
    historyFilters: { q: '', status: 'all', mode: 'all' },
  };
}

function buildSessionDetail(session: Session): SessionDetail {
  return {
    session,
    messages: sessionMessageRepo.listBySession(session.id),
    runs: sessionRunRepo.listBySession(session.id),
    planItems: sessionPlanItemRepo.listBySession(session.id),
    compactions: sessionCompactionRepo.listBySession(session.id),
    checkpoints: sessionCheckpointRepo.listBySession(session.id),
    evidence: sessionEvidenceRepo.listBySession(session.id),
  };
}

function buildSessionStatus(session: Session): StatusSnapshot {
  const evidence = sessionEvidenceRepo.listBySession(session.id);
  const git = readStatusGitSnapshot(session);
  const latestVerification = [...evidence].reverse().find((event) =>
    event.event_type === 'test' ||
    event.event_type === 'build' ||
    event.event_type === 'browser_check' ||
    event.event_type === 'review'
  ) ?? null;
  const latestBlocker = [...evidence].reverse().find((event) => event.event_type === 'blocker') ?? null;
  return buildStatusSnapshot({
    session,
    context: sessionContextRepo.getLatestBySession(session.id) ?? null,
    latestVerification,
    latestBlocker,
    changedFileCount: git.changedFileCount,
    branchName: git.branchName ?? session.branch_name,
    hasUncommittedDiff: git.hasUncommittedDiff,
    conflictRisk: git.conflictRisk,
    permissionMode: null,
  });
}

function ensureContextManifest(session: Session): SessionContextManifest {
  const existing = sessionContextRepo.getLatestBySession(session.id);
  if (existing && isContextManifestFreshForSession(session, existing)) return existing;
  return createContextManifest(session);
}

export function createContextManifest(session: Session): SessionContextManifest {
  const project = projectRepo.get(session.project_id);
  const workspacePath = session.worktree_path ?? session.workspace_path ?? project?.path ?? process.cwd();
  const compact = getLatestAppliedCompact(session);
  const historyBriefs = session.forked_from_history_record_id
    ? [historyRecordRepo.get(session.forked_from_history_record_id)].filter((record): record is HistoryRecord => Boolean(record))
    : [];
  const draft = buildContextManifestDraft({
    session,
    agentsText: readFirstExistingFile([
      join(workspacePath, 'AGENTS.md'),
      join(process.cwd(), 'AGENTS.md'),
      join(homedir(), '.codex', 'AGENTS.md'),
    ]),
    rtkText: readFirstExistingFile([
      join(workspacePath, 'RTK.md'),
      join(process.cwd(), 'RTK.md'),
      join(homedir(), '.codex', 'RTK.md'),
    ]),
    compactSummary: compact?.applied_summary?.trim() || null,
    historyBriefs,
    recentMessages: sessionMessageRepo.listBySession(session.id, { limit: 20 }),
    explicitFiles: [],
    gitDiff: readGitValueSync(workspacePath, ['diff', '--stat']),
  });
  const manifest = sessionContextRepo.createManifest({
    session_id: session.id,
    total_token_estimate: draft.totalTokenEstimate,
    prompt_hash: hashPromptSources(draft.sources.map((source) => source.excerpt).join('\n')),
    sources: draft.sources.map((source) => ({
      source_type: source.source_type,
      source_ref: source.source_type === 'compact' ? compact?.id ?? source.source_ref : source.source_ref,
      title: source.title,
      included: source.included,
      priority: source.priority,
      token_estimate: source.token_estimate,
      reason: source.reason,
      content_hash: source.content_hash,
      excerpt: source.excerpt,
      metadata: source.metadata,
    })),
  });
  sessionRepo.update(session.id, { latest_context_manifest_id: manifest.id });
  return manifest;
}

function isContextManifestFreshForSession(session: Session, manifest: SessionContextManifest): boolean {
  if (!session.latest_compaction_id) return true;
  return manifest.sources.some((source) =>
    source.source_type === 'compact' &&
    source.source_ref === session.latest_compaction_id &&
    source.excerpt?.trim()
  );
}

function collectChangedFiles(evidence: SessionEvidenceEvent[]): string[] {
  const files = new Set<string>();
  for (const event of evidence) {
    const path = event.payload.path ?? event.payload.file ?? event.payload.file_path;
    if (event.event_type === 'file_diff' && typeof path === 'string' && path.trim()) {
      files.add(path.trim());
    }
    if (Array.isArray(event.payload.files)) {
      for (const file of event.payload.files) {
        if (typeof file === 'string' && file.trim()) files.add(file.trim());
      }
    }
  }
  return [...files];
}

function collectCommitRefs(evidence: SessionEvidenceEvent[]): string[] {
  return evidence.flatMap((event) => {
    if (event.event_type !== 'commit') return [];
    const ref = event.payload.commit ?? event.payload.hash ?? event.payload.ref;
    return typeof ref === 'string' && ref.trim() ? [ref.trim()] : [];
  });
}

function collectLatestVerification(evidence: SessionEvidenceEvent[]): string | null {
  const event = [...evidence].reverse().find((item) =>
    item.event_type === 'test' ||
    item.event_type === 'build' ||
    item.event_type === 'browser_check' ||
    item.event_type === 'review'
  );
  return event ? event.summary ?? event.title : null;
}

function readGoalFromResumeBrief(record: HistoryRecord): string | null {
  const firstLine = record.resume_brief.split('\n').find((line) => line.trim().startsWith('目标：'));
  return firstLine ? firstLine.replace(/^目标：/, '').trim() || null : record.title;
}

function inheritLatestAppliedCompact(source: Session, target: Session): void {
  const compact = sessionCompactionRepo
    .listBySession(source.id)
    .filter((item) => item.status === 'applied' && item.applied_summary?.trim())
    .at(-1);
  if (!compact?.applied_summary) return;
  sessionContextRepo.createManifest({
    session_id: target.id,
    total_token_estimate: Math.ceil(compact.applied_summary.length / 4),
    sources: [{
      source_type: 'compact',
      source_ref: compact.id,
      title: `Inherited compact: ${source.title}`,
      reason: '从源 session 分叉时继承最新已应用 compact',
      excerpt: compact.applied_summary,
      metadata: {
        inherited: true,
        source_session_id: source.id,
      },
    }],
  });
}

async function readGitSnapshot(projectPath: string): Promise<{
  git_head: string | null;
  branch_name: string | null;
  diff_summary: string | null;
}> {
  const [gitHead, branchName, diffSummary] = await Promise.all([
    readGitValue(projectPath, ['rev-parse', 'HEAD']),
    readGitValue(projectPath, ['branch', '--show-current']),
    readGitValue(projectPath, ['diff', '--stat']),
  ]);
  return {
    git_head: gitHead,
    branch_name: branchName,
    diff_summary: diffSummary,
  };
}

function readStatusGitSnapshot(session: Session): {
  branchName: string | null;
  changedFileCount: number;
  hasUncommittedDiff: boolean;
  conflictRisk: 'none' | 'low' | 'high';
} {
  const project = projectRepo.get(session.project_id);
  const projectPath = session.worktree_path ?? session.workspace_path ?? project?.path;
  if (!projectPath) {
    return { branchName: session.branch_name, changedFileCount: 0, hasUncommittedDiff: false, conflictRisk: 'none' };
  }
  const status = readGitValueSync(projectPath, ['status', '--short']) ?? '';
  const changedLines = status.split('\n').map((line) => line.trim()).filter(Boolean);
  const hasConflict = changedLines.some((line) => /^(UU|AA|DD|AU|UA|DU|UD)\b/.test(line));
  return {
    branchName: readGitValueSync(projectPath, ['branch', '--show-current']),
    changedFileCount: changedLines.length,
    hasUncommittedDiff: changedLines.length > 0,
    conflictRisk: hasConflict ? 'high' : changedLines.length > 0 ? 'low' : 'none',
  };
}

async function readGitValue(projectPath: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync('git', args, { cwd: projectPath, timeout: 5000 });
    const value = result.stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

function readGitValueSync(projectPath: string, args: string[]): string | null {
  try {
    const value = execFileSync('git', args, {
      cwd: projectPath,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function readFirstExistingFile(paths: string[]): string | null {
  for (const path of paths) {
    try {
      if (existsSync(path)) return readFileSync(path, 'utf-8');
    } catch {
      // Ignore unreadable context files; the manifest records only readable sources.
    }
  }
  return null;
}

function getLatestAppliedCompact(session: Session): SessionCompaction | null {
  const compactions = sessionCompactionRepo
    .listBySession(session.id)
    .filter((item) => item.status === 'applied' && item.applied_summary?.trim());
  const latest = session.latest_compaction_id
    ? compactions.find((item) => item.id === session.latest_compaction_id) ?? compactions.at(-1)
    : compactions.at(-1);
  return latest ?? null;
}

function hashPromptSources(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function forkInputSchema() {
  return z.object({
    title: z.string().trim().min(1).optional(),
    mode: sessionModeSchema.optional(),
    provider: z.enum(['claudecode', 'opencode', 'codex']).nullable().optional(),
    model: z.string().trim().min(1).nullable().optional(),
    worktree_path: z.string().trim().min(1).nullable().optional(),
    branch_name: z.string().trim().min(1).nullable().optional(),
  });
}
