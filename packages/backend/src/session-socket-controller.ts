import type { WebSocket } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { now } from './db.js';
import { projectRepo } from './repos/projects.js';
import {
  DEFAULT_SESSION_AGENT_ID,
  sessionMessageRepo,
  sessionAgentEventRepo,
  sessionRepo,
  sessionRunRepo,
} from './repos/sessions.js';
import { sessionEvidenceRepo } from './repos/session-evidence.js';
import { sessionCompactionRepo } from './repos/session-compactions.js';
import { sessionContractRepo } from './repos/session-contracts.js';
import { sessionContextRepo } from './repos/session-context.js';
import { sessionCheckpointRepo } from './repos/session-checkpoints.js';
import { historyRecordRepo } from './repos/history-records.js';
import { runRegistry } from './run-registry.js';
import { dispatchSessionUserMessage } from './session-message-dispatch.js';
import { retrySessionAgentRun, runSessionAgent } from './session-runtime.js';
import { parseSessionCommand } from './session-command.js';
import { buildHistorySummary } from './session-summary.js';
import { buildSessionStatus, buildWorkspacePayload, createContextManifest } from './session.routes.js';
import { wsHub } from './ws-hub.js';
import type { HistoryRecord, Project, Session, SessionEvidenceEvent, SessionRun, WsClientEvent, WsServerEvent } from './types.js';

const execFileAsync = promisify(execFile);

const socketEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.workspace.request'),
    projectId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal('session.message.send'),
    sessionId: z.string().trim().min(1),
    content: z.string().trim().min(1),
    agentId: z.string().trim().min(1).optional(),
    mode: z.enum(['ask', 'plan', 'code', 'debug', 'review']).optional(),
  }),
  z.object({
    type: z.literal('agent.run.pause'),
    sessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('agent.run.resume'),
    sessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    content: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal('agent.run.cancel'),
    sessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('agent.run.retry'),
    sessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('session.command.run'),
    sessionId: z.string().trim().min(1),
    command: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('session.compact.apply'),
    sessionId: z.string().trim().min(1),
    compactionId: z.string().trim().min(1),
    appliedSummary: z.string().trim().min(1),
    userEdited: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('session.compact.discard'),
    sessionId: z.string().trim().min(1),
    compactionId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('session.contract.save'),
    sessionId: z.string().trim().min(1),
    scope: z.string().nullable().optional(),
    risks: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('history_records.filter'),
    projectId: z.string().trim().min(1),
    q: z.string().optional(),
    status: z.union([z.enum(['completed', 'blocked', 'failed', 'archived']), z.literal('all')]).optional(),
    mode: z.union([z.enum(['ask', 'plan', 'code', 'debug', 'review']), z.literal('all')]).optional(),
  }),
]);

export function handleSessionSocketEvent(socket: WebSocket, event: WsClientEvent): boolean {
  const parsed = socketEventSchema.safeParse(event);
  if (!parsed.success) return false;
  try {
    if (parsed.data.type === 'session.workspace.request') {
      sendSessionWorkspaceSnapshot(socket, parsed.data.projectId, parsed.data.sessionId);
      return true;
    }
    if (parsed.data.type === 'session.message.send') {
      dispatchSessionUserMessage({
        sessionId: parsed.data.sessionId,
        content: parsed.data.content,
        agentId: parsed.data.agentId,
        mode: parsed.data.mode,
      });
      return true;
    }
    if (parsed.data.type === 'agent.run.pause') return pauseRun(parsed.data);
    if (parsed.data.type === 'agent.run.resume') return resumeRun(parsed.data);
    if (parsed.data.type === 'agent.run.cancel') return cancelRun(parsed.data);
    if (parsed.data.type === 'agent.run.retry') return retryRun(parsed.data);
    if (parsed.data.type === 'session.command.run') return runSessionCommand(socket, parsed.data.sessionId, parsed.data.command);
    if (parsed.data.type === 'session.compact.apply') {
      return applyCompact(socket, parsed.data.sessionId, parsed.data.compactionId, {
        applied_summary: parsed.data.appliedSummary,
        user_edited: parsed.data.userEdited,
      });
    }
    if (parsed.data.type === 'session.compact.discard') return discardCompact(socket, parsed.data.sessionId, parsed.data.compactionId);
    if (parsed.data.type === 'session.contract.save') return saveContract(socket, parsed.data);
    if (parsed.data.type === 'history_records.filter') return filterHistory(socket, parsed.data);
    return false;
  } catch (error) {
    const sessionId = 'sessionId' in parsed.data && typeof parsed.data.sessionId === 'string' ? parsed.data.sessionId : '';
    send(socket, { type: 'session_error', sessionId, error: (error as Error).message });
    return true;
  }
}

function runSessionCommand(socket: WebSocket, sessionId: string, commandText: string): boolean {
  const session = requireSession(sessionId);
  const command = parseSessionCommand(commandText);
  if (command.kind === 'new') {
    const project = requireProject(session.project_id);
    const record = createHistoryRecordForSession(session, command.args.title);
    const next = sessionRepo.create({
      project_id: project.id,
      title: command.args.blank ? 'New Session' : `继续：${record.title}`,
      current_goal: command.args.blank ? null : session.current_goal,
      mode: session.mode,
      provider: session.provider ?? 'codex',
      model: session.model,
      workspace_path: session.workspace_path ?? project.path,
    });
    sessionRepo.archive(session.id);
    sendWorkspaceSnapshot(socket, project, next);
    return true;
  }
  if (command.kind === 'compact') {
    const compaction = createCompactPreview(session, typeof command.args.focus === 'string' ? command.args.focus : null);
    send(socket, { type: 'session_compact:preview', sessionId: session.id, compaction });
    return true;
  }
  if (command.kind === 'status') {
    send(socket, { type: 'session_status:snapshot', sessionId: session.id, status: buildSessionStatus(session) });
    return true;
  }
  if (command.kind === 'context') {
    send(socket, { type: 'session_context:snapshot', sessionId: session.id, context: createContextManifest(session) });
    return true;
  }
  if (command.kind === 'resume') {
    const historyRecordId = command.body.trim();
    if (!historyRecordId) return true;
    const record = historyRecordRepo.get(historyRecordId);
    if (!record) throw new Error('history record not found');
    const project = requireProject(record.project_id);
    const next = sessionRepo.create({
      project_id: record.project_id,
      title: `Resume: ${record.title}`,
      current_goal: readGoalFromResumeBrief(record.resume_brief) ?? record.title,
      mode: record.mode,
      provider: 'codex',
      workspace_path: project.path,
      forked_from_history_record_id: record.id,
    });
    sessionMessageRepo.create({
      session_id: next.id,
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
      session_id: next.id,
      event_type: 'resume',
      title: 'History resumed',
      payload: { history_record_id: record.id },
    });
    sendWorkspaceSnapshot(socket, project, next);
    return true;
  }
  if (command.kind === 'fork') {
    const project = requireProject(session.project_id);
    const historyRecordId = command.body.startsWith('history:') ? command.body.replace(/^history:\s*/, '').trim() : '';
    if (historyRecordId) {
      const record = historyRecordRepo.get(historyRecordId);
      if (!record) throw new Error('history record not found');
      const recordProject = requireProject(record.project_id);
      const fork = sessionRepo.create({
        project_id: record.project_id,
        title: `Fork: ${record.title}`,
        current_goal: readGoalFromResumeBrief(record.resume_brief) ?? record.title,
        mode: record.mode,
        provider: 'codex',
        workspace_path: recordProject.path,
        forked_from_history_record_id: record.id,
      });
      inheritHistoryBrief(record, fork);
      historyRecordRepo.incrementForkCount(record.id);
      sessionEvidenceRepo.create({
        session_id: fork.id,
        event_type: 'fork',
        title: 'History fork created',
        payload: { history_record_id: record.id },
      });
      sendWorkspaceSnapshot(socket, recordProject, fork);
      return true;
    }
    const fork = sessionRepo.create({
      project_id: session.project_id,
      title: `Fork: ${session.title}`,
      current_goal: session.current_goal,
      mode: session.mode,
      provider: session.provider,
      model: session.model,
      workspace_path: session.workspace_path,
      worktree_path: session.worktree_path,
      branch_name: session.branch_name,
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
    sendWorkspaceSnapshot(socket, project, fork);
    return true;
  }
  if (command.kind === 'checkpoint') {
    void createCheckpoint(socket, session, command.body).catch((error) => {
      send(socket, { type: 'session_error', sessionId: session.id, error: (error as Error).message });
    });
    return true;
  }
  dispatchSessionUserMessage({ sessionId: session.id, content: commandText, agentId: DEFAULT_SESSION_AGENT_ID });
  return true;
}

function applyCompact(
  socket: WebSocket,
  sessionId: string,
  compactionId: string,
  input: { applied_summary: string; user_edited?: boolean },
): boolean {
  const session = requireSession(sessionId);
  const compaction = sessionCompactionRepo.get(compactionId);
  if (!compaction || compaction.session_id !== session.id) throw new Error('compaction not found');
  sessionCompactionRepo.apply(compaction.id, input);
  sessionRepo.update(session.id, { latest_compaction_id: compaction.id });
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'compact',
    title: 'Compact applied',
    summary: input.applied_summary,
    payload: { compaction_id: compaction.id },
  });
  wsHub.broadcastSession(session.id, { type: 'session_evidence:new', sessionId: session.id, event });
  sendWorkspaceSnapshot(socket, requireProject(session.project_id), sessionRepo.get(session.id) ?? session);
  return true;
}

function discardCompact(socket: WebSocket, sessionId: string, compactionId: string): boolean {
  const session = requireSession(sessionId);
  const compaction = sessionCompactionRepo.get(compactionId);
  if (!compaction || compaction.session_id !== session.id) throw new Error('compaction not found');
  const discarded = sessionCompactionRepo.discard(compaction.id);
  if (!discarded || discarded.session_id !== session.id) throw new Error('compaction is not previewed');
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'compact',
    title: 'Compact discarded',
    payload: { compaction_id: compaction.id },
  });
  wsHub.broadcastSession(session.id, { type: 'session_evidence:new', sessionId: session.id, event });
  sendWorkspaceSnapshot(socket, requireProject(session.project_id), session);
  return true;
}

function saveContract(
  socket: WebSocket,
  input: { sessionId: string; scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] },
): boolean {
  const session = requireSession(input.sessionId);
  sessionContractRepo.upsert(session, {
    scope: input.scope,
    risks: input.risks,
    acceptanceCriteria: input.acceptanceCriteria,
  });
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: 'Contract updated',
    payload: { contract_updated: true },
  });
  wsHub.broadcastSession(session.id, { type: 'session_evidence:new', sessionId: session.id, event });
  sendWorkspaceSnapshot(socket, requireProject(session.project_id), session);
  return true;
}

function filterHistory(
  socket: WebSocket,
  input: { projectId: string; q?: string; status?: 'completed' | 'blocked' | 'failed' | 'archived' | 'all'; mode?: Session['mode'] | 'all' },
): boolean {
  const project = requireProject(input.projectId);
  const records = historyRecordRepo.listByProject(project.id, {
    q: input.q,
    status: input.status === 'all' ? undefined : input.status,
    mode: input.mode === 'all' ? undefined : input.mode,
  });
  send(socket, { type: 'history_records:snapshot', projectId: project.id, records });
  return true;
}

function requireSession(sessionId: string): Session {
  const session = sessionRepo.get(sessionId);
  if (!session) throw new Error('session not found');
  return session;
}

function requireProject(projectId: string): Project {
  const project = projectRepo.get(projectId);
  if (!project) throw new Error('project not found');
  return project;
}

function sendWorkspaceSnapshot(socket: WebSocket, project: Project, session: Session): void {
  send(socket, {
    type: 'session_workspace:snapshot',
    projectId: project.id,
    sessionId: session.id,
    payload: buildWorkspacePayload(project, session),
  });
}

function createHistoryRecordForSession(session: Session, title?: string | true): HistoryRecord {
  const messages = sessionMessageRepo.listBySession(session.id);
  const evidence = sessionEvidenceRepo.listBySession(session.id);
  const changedFiles = collectChangedFiles(evidence);
  const verificationSummary = collectLatestVerification(evidence);
  const summary = buildHistorySummary({
    goal: session.current_goal,
    messages,
    changedFiles,
    verificationSummary,
  });
  const record = historyRecordRepo.create({
    project_id: session.project_id,
    session_id: session.id,
    title: typeof title === 'string' ? title : summary.title,
    summary: summary.summary,
    status: session.status === 'failed' ? 'failed' : session.status === 'blocked' ? 'blocked' : 'archived',
    mode: session.mode,
    started_at: session.created_at,
    ended_at: now(),
    key_decisions: summary.keyDecisions,
    changed_files: changedFiles,
    verification_summary: verificationSummary,
    commit_refs: collectCommitRefs(evidence),
    resume_brief: summary.resumeBrief,
    compact_count: sessionCompactionRepo.listBySession(session.id).length,
  });
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'new',
    title: 'Session archived',
    payload: { history_record_id: record.id },
  });
  return record;
}

function createCompactPreview(session: Session, focus: string | null) {
  const messages = sessionMessageRepo.listBySession(session.id, { limit: 20 });
  const previewSummary = [
    focus ? `Focus：${focus}` : null,
    `目标：${session.current_goal ?? session.title}`,
    `最近消息数：${messages.length}`,
    messages.slice(-5).map((message) => `${message.role}: ${message.content}`).join('\n'),
  ].filter(Boolean).join('\n');
  return sessionCompactionRepo.createPreview({
    session_id: session.id,
    strategy: focus ? 'focus' : 'manual',
    focus_prompt: focus,
    preview_summary: previewSummary,
    retained_refs: messages.slice(-10).map((message) => `message:${message.id}`),
    dropped_refs: messages.slice(0, -10).map((message) => `message:${message.id}`),
    risk_notes: messages.length > 10 ? '较早消息将只通过摘要保留。' : null,
  });
}

async function createCheckpoint(socket: WebSocket, session: Session, title: string): Promise<void> {
  const project = requireProject(session.project_id);
  const workspacePath = session.worktree_path ?? session.workspace_path ?? project.path;
  const [gitHead, branchName, diffSummary] = await Promise.all([
    readGitValue(workspacePath, ['rev-parse', 'HEAD']),
    readGitValue(workspacePath, ['branch', '--show-current']),
    readGitValue(workspacePath, ['diff', '--stat']),
  ]);
  const checkpoint = sessionCheckpointRepo.create({
    session_id: session.id,
    title: title.trim() || `Checkpoint: ${session.title}`,
    description: null,
    git_head: gitHead,
    branch_name: branchName,
    diff_summary: diffSummary,
  });
  const event = sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'checkpoint',
    title: checkpoint.title,
    summary: checkpoint.diff_summary,
    payload: { checkpoint_id: checkpoint.id },
  });
  sessionCheckpointRepo.updateEvidenceEvent(checkpoint.id, event.id);
  wsHub.broadcastSession(session.id, { type: 'session_evidence:new', sessionId: session.id, event });
  sendWorkspaceSnapshot(socket, project, session);
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

function inheritHistoryBrief(record: HistoryRecord, target: Session): void {
  sessionContextRepo.createManifest({
    session_id: target.id,
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

function readGoalFromResumeBrief(resumeBrief: string): string | null {
  const firstLine = resumeBrief.split('\n').find((line) => line.trim().startsWith('目标：'));
  return firstLine ? firstLine.replace(/^目标：/, '').trim() || null : null;
}

function sendSessionWorkspaceSnapshot(socket: WebSocket, projectId: string, sessionId?: string): void {
  const project = projectRepo.get(projectId);
  if (!project) throw new Error('project not found');
  const requested = sessionId ? sessionRepo.get(sessionId) : undefined;
  if (sessionId && (!requested || requested.project_id !== project.id)) throw new Error('session not found');
  const activeSession = requested ??
    sessionRepo.listByProject(project.id).find((session) => session.status === 'active') ??
    sessionRepo.create({
      project_id: project.id,
      title: 'New Session',
      mode: 'ask',
      provider: 'codex',
      workspace_path: project.path,
    });
  send(socket, {
    type: 'session_workspace:snapshot',
    projectId: project.id,
    sessionId: activeSession.id,
    payload: buildWorkspacePayload(project, activeSession),
  });
}

type RunControlInput = {
  sessionId: string;
  agentId: string;
  runId: string;
};

function pauseRun(input: RunControlInput): boolean {
  const run = requireOwnedRun(input, ['queued', 'running', 'retrying']);
  runRegistry.pause(run.id);
  const updated = sessionRunRepo.updateStatus(run.id, 'paused', { error: 'Session run paused' });
  if (!updated) throw new Error('run not found');
  broadcastRunStopped(updated, 'paused');
  return true;
}

function cancelRun(input: RunControlInput): boolean {
  const run = requireOwnedRun(input, ['queued', 'running', 'retrying', 'paused']);
  runRegistry.cancel(run.id);
  const updated = sessionRunRepo.updateStatus(run.id, 'cancelled', { error: 'Session run cancelled' });
  if (!updated) throw new Error('run not found');
  broadcastRunStopped(updated, 'cancelled');
  return true;
}

function retryRun(input: RunControlInput): boolean {
  const run = requireOwnedRun(input);
  retrySessionAgentRun(run.id);
  const event = sessionEvidenceRepo.create({
    session_id: run.session_id,
    event_type: 'status',
    title: 'Run retry requested',
    payload: { source_run_id: run.id, agent_id: run.agent_id },
  });
  wsHub.broadcastSession(run.session_id, { type: 'session_evidence:new', sessionId: run.session_id, event });
  return true;
}

function resumeRun(input: RunControlInput & { content?: string }): boolean {
  const run = requireOwnedRun(input);
  if (run.status !== 'paused') throw new Error('run is not paused');
  void runSessionAgent({
    sessionId: run.session_id,
    agentId: run.agent_id || DEFAULT_SESSION_AGENT_ID,
    prompt: input.content ?? '继续刚才暂停的任务。',
    provider: run.provider,
    model: run.model,
  });
  return true;
}

function requireOwnedRun(input: RunControlInput, statuses?: SessionRun['status'][]): SessionRun {
  const run = sessionRunRepo.get(input.runId);
  if (!run) throw new Error('run not found');
  if (run.session_id !== input.sessionId || run.agent_id !== input.agentId) {
    throw new Error('run does not belong to session agent');
  }
  if (statuses && !statuses.includes(run.status)) throw new Error('run is not active');
  return run;
}

function broadcastRunStopped(run: SessionRun, status: 'paused' | 'cancelled'): void {
  wsHub.broadcastSession(run.session_id, {
    type: 'session_run:updated',
    sessionId: run.session_id,
    run,
  });
  const finalEvent = sessionAgentEventRepo.create({
    session_id: run.session_id,
    agent_id: run.agent_id,
    run_id: run.id,
    channel: 'event',
    event_type: `run_${status}`,
    content: '',
    payload: { status },
  });
  wsHub.broadcastSession(run.session_id, {
    type: 'session_run:stream',
    sessionId: run.session_id,
    agentId: run.agent_id,
    runId: run.id,
    seq: finalEvent.seq,
    chunk: '',
    channel: 'event',
    done: true,
  });
}

function send(socket: WebSocket, event: WsServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}
