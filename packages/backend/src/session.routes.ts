import { Router, type Response } from 'express';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
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
import { buildContextManifestDraft } from './session-context.js';
import { buildStatusSnapshot } from './session-status.js';
import {
  buildSessionBottomStatus,
  buildSessionDiffRows,
  buildSessionProjectSwitcher,
  buildSessionToolRows,
  resolveSessionWorkspacePath,
} from './session-workspace-view-model.js';
import type {
  HistoryRecord,
  Project,
  Session,
  SessionCompaction,
  SessionContextManifest,
  SessionDetail,
  SessionMode,
  SessionWorkspacePayload,
  StatusSnapshot,
} from './types.js';

export const sessionRouter = Router();

const sessionModeSchema = z.enum(['ask', 'plan', 'code', 'debug', 'review']);

sessionRouter.get('/projects/:projectId/sessions', listProjectSessions);
sessionRouter.post('/projects/:projectId/sessions', createProjectSession);
sessionRouter.get('/sessions/:sessionId', getSessionDetail);
sessionRouter.patch('/sessions/:sessionId', updateSession);
sessionRouter.get('/history-records/:historyRecordId', getHistoryRecord);
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

function getHistoryRecord(req: { params: { historyRecordId: string } }, res: Response): void {
  const record = historyRecordRepo.get(req.params.historyRecordId);
  if (!record) {
    res.status(404).json({ error: 'history record not found' });
    return;
  }
  res.json(record);
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

export function buildSessionStatus(session: Session): StatusSnapshot {
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
