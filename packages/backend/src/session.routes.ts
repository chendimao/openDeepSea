import { Router, type Response } from 'express';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { fileRepo } from './repos/files.js';
import { projectRepo } from './repos/projects.js';
import { roomAgentRepo } from './repos/rooms.js';
import { taskRepo } from './repos/tasks.js';
import { workflowArtifactVersionRepo, workflowRepo } from './repos/workflows.js';
import {
  sessionAgentEventRepo,
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
import { sessionTokenUsageRepo } from './repos/session-token-usage.js';
import { buildContextManifestDraft } from './session-context.js';
import { buildStatusSnapshot } from './session-status.js';
import { broadcastActiveSessionRemove, broadcastActiveSessionUpsert } from './session-active-broadcast.js';
import { buildActiveSessionSummaries } from './session-active-view-model.js';
import {
  buildSessionBottomStatus,
  buildSessionInspectorSnapshot,
  buildSessionProjectSwitcher,
} from './session-workspace-view-model.js';
import { wsHub } from './ws-hub.js';
import type {
  HistoryRecord,
  Project,
  ProjectFile,
  Session,
  SessionCompaction,
  SessionContextManifest,
  SessionContract,
  SessionDetail,
  SessionMessage,
  SessionMode,
  SessionPlanItem,
  SessionTodoStats,
  SessionWorkspacePayload,
  StatusSnapshot,
  WorkflowArtifactVersion,
  WorkflowArtifactVersionType,
  WorkflowArtifactVersionView,
  WorkflowAgentAssignmentView,
  WorkflowControllerView,
  WorkflowGateView,
  WorkflowRun,
} from './types.js';
import { parseGraphState, serializeGraphState, type AgentWorkflowState } from './workflows/graph/state.js';
import { workflowOrchestrator } from './workflows/orchestrator.js';

export const sessionRouter = Router();

const sessionModeSchema = z.enum(['ask', 'plan', 'code', 'debug', 'review']);
const finishBranchDecisionSchema = z.enum(['merge_local', 'create_pr', 'keep_branch', 'discard_work']);

sessionRouter.get('/active-sessions', listActiveSessions);
sessionRouter.get('/projects/:projectId/sessions', listProjectSessions);
sessionRouter.post('/projects/:projectId/sessions', createProjectSession);
sessionRouter.get('/sessions/:sessionId', getSessionDetail);
sessionRouter.patch('/sessions/:sessionId', updateSession);
sessionRouter.get('/sessions/:sessionId/todo-stats', getSessionTodoStats);
sessionRouter.post('/sessions/:sessionId/workflow-artifacts/:artifactVersionId/approve', approveSessionWorkflowArtifact);
sessionRouter.post('/sessions/:sessionId/workflows/:workflowRunId/finish-branch-decision', submitSessionFinishBranchDecision);
sessionRouter.get('/history-records/:historyRecordId', getHistoryRecord);
sessionRouter.post('/history-records/:historyRecordId/resume-brief/regenerate', regenerateResumeBrief);
sessionRouter.get('/history-records/:historyRecordId/export', exportHistoryRecord);

function listActiveSessions(_req: unknown, res: Response): void {
  res.json(buildActiveSessionSummaries());
}

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
    provider: parsed.data.provider ?? null,
    model: parsed.data.model,
    workspace_path: project.path,
  });
  broadcastActiveSessionUpsert(session);
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
    pinned_at: z.number().int().nullable().optional(),
  }).strict().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const updated = sessionRepo.update(session.id, parsed.data);
  if (updated) {
    if (updated.closed_at !== null) broadcastActiveSessionRemove(updated.id);
    else broadcastActiveSessionUpsert(updated);
  }
  res.json(updated);
}

function getSessionTodoStats(req: { params: { sessionId: string } }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const runs = sessionRunRepo.listBySession(session.id);
  const evidence = sessionEvidenceRepo.listBySession(session.id);
  const agentEvents = runs.flatMap((run) => sessionAgentEventRepo.listByRun(run.id));
  const inspector = buildSessionInspectorSnapshot(session.id, evidence, agentEvents);
  res.json(buildSessionTodoStats(session.id, inspector.planItems));
}

function approveSessionWorkflowArtifact(req: { params: { sessionId: string; artifactVersionId: string } }, res: Response): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const artifact = workflowArtifactVersionRepo.get(req.params.artifactVersionId);
  if (!artifact) {
    res.status(404).json({ error: 'workflow artifact version not found' });
    return;
  }
  const linked = findSessionWorkflowRunForArtifact(session, artifact);
  if (!linked) {
    res.status(404).json({ error: 'workflow artifact version not found for session' });
    return;
  }
  const approved = workflowArtifactVersionRepo.approve(artifact.id, {
    approved_by: 'user',
    approval_message_id: null,
  });
  if (!approved) {
    res.status(409).json({ error: 'workflow artifact version cannot be approved' });
    return;
  }
  const shouldResume = shouldResumeAfterArtifactApproval(linked.run, artifact.artifact_type);
  const updatedRun = updateApprovedArtifactGraphState(linked.run, approved, shouldResume);
  resumeWorkflowAfterArtifactApproval(updatedRun ?? linked.run, shouldResume);
  broadcastSessionWorkspaceSnapshot(session);
  const view = toWorkflowArtifactVersionView(approved);
  res.json(view);
}

function submitSessionFinishBranchDecision(
  req: { params: { sessionId: string; workflowRunId: string }; body: unknown },
  res: Response,
): void {
  const session = sessionRepo.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const run = workflowRepo.getRun(req.params.workflowRunId);
  if (!run || !sessionOwnsWorkflowRun(session, run)) {
    res.status(404).json({ error: 'workflow run not found for session' });
    return;
  }
  const parsed = z.object({
    decision: finishBranchDecisionSchema,
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const state = parseGraphState(run.graph_state);
  if (!state || state.superpowersPhase !== 'finish_branch' || run.status !== 'awaiting_decision') {
    res.status(409).json({ error: 'workflow is not awaiting finish branch decision' });
    return;
  }
  const nextState: AgentWorkflowState = {
    ...state,
    status: 'running',
    error: null,
    finishBranchDecision: {
      decision: parsed.data.decision,
      options: state.finishBranchDecision?.options?.length
        ? state.finishBranchDecision.options
        : ['merge_local', 'create_pr', 'keep_branch', 'discard_work'],
      reason: state.finishBranchDecision?.reason ?? '用户已选择分支收尾方式',
      decidedAt: new Date().toISOString(),
    },
  };
  const graphStateUpdated = workflowRepo.updateGraphState(run.id, serializeGraphState(nextState));
  const updated = workflowRepo.updateRun(run.id, {
    status: 'running',
    error: null,
  }) ?? graphStateUpdated;
  if (!updated) {
    res.status(404).json({ error: 'workflow run not found' });
    return;
  }
  workflowOrchestrator.enqueueExistingGraphRun(updated.id);
  broadcastSessionWorkspaceSnapshot(session);
  res.json(updated);
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
  const inspector = buildSessionInspectorSnapshot(activeSession.id, detail.evidence, detail.agentEvents);
  return {
    project,
    activeSession: {
      ...detail,
      planItems: inspector.planItems,
    },
    activeSessions: buildActiveSessionSummaries(),
    historyRecords: historyRecordRepo.listByProject(project.id),
    status: buildSessionStatus(activeSession),
    context: sessionContextRepo.getLatestBySession(activeSession.id) ?? null,
    evidence,
    projectSwitcher: buildSessionProjectSwitcher(project.id),
    bottomStatus: buildSessionBottomStatus(
      detail.runs,
      detail.evidence,
      sessionTokenUsageRepo.summarizeBySession(activeSession.id),
    ),
    contract: buildWorkspaceContract(activeSession, detail.messages),
    toolRows: inspector.toolRows,
    diffRows: inspector.diffRows,
    historyFilters: { q: '', status: 'all', mode: 'all' },
  };
}

function buildWorkspaceContract(session: Session, messages: SessionMessage[]): SessionContract {
  return {
    ...sessionContractRepo.getOrCreate(session),
    reason: deriveSessionContractReason(messages),
  };
}

function deriveSessionContractReason(messages: SessionMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const metadataReason = readReasonFromMetadata(message.metadata);
    if (metadataReason) return metadataReason;
    const contentReason = readReasonFromContent(message.content);
    if (contentReason) return contentReason;
  }
  return null;
}

function readReasonFromMetadata(metadata: string | null): string | null {
  const parsed = parseJsonRecord(metadata);
  if (!parsed) return null;
  return firstNonEmptyText([
    readNestedReason(parsed, 'task_readiness'),
    readNestedReason(parsed, 'task_execution'),
    readNestedReason(parsed, 'intent_result'),
    readNestedReason(parsed, 'session_execution'),
    parsed.reason,
  ]);
}

function readReasonFromContent(content: string): string | null {
  for (const candidate of extractJsonObjectCandidates(content)) {
    const parsed = parseJsonRecord(candidate);
    if (!parsed) continue;
    const reason = firstNonEmptyText([
      readNestedReason(parsed, 'task_readiness'),
      readNestedReason(parsed, 'task_execution'),
      readNestedReason(parsed, 'intent_result'),
      parsed.reason,
    ]);
    if (reason) return reason;
  }
  return null;
}

function readNestedReason(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return firstNonEmptyText([(value as Record<string, unknown>).reason]);
}

function extractJsonObjectCandidates(content: string): string[] {
  const fencedBlocks = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item && item.startsWith('{') && item.endsWith('}')));
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return [...fencedBlocks, trimmed];
  return fencedBlocks;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function firstNonEmptyText(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function buildSessionDetail(session: Session): SessionDetail {
  const runs = sessionRunRepo.listBySession(session.id);
  const workflowRuns = listSessionWorkflowRuns(session);
  const workflowArtifacts = workflowRuns.flatMap((run) =>
    workflowArtifactVersionRepo.listByRun(run.id).map(toWorkflowArtifactVersionView)
  );
  return {
    session,
    messages: sessionMessageRepo.listBySession(session.id).map((message) =>
      backfillSessionMessageAttachments(session.project_id, message)
    ),
    runs,
    agentEvents: runs.flatMap((run) => sessionAgentEventRepo.listByRun(run.id)),
    planItems: sessionPlanItemRepo.listBySession(session.id),
    compactions: sessionCompactionRepo.listBySession(session.id),
    checkpoints: sessionCheckpointRepo.listBySession(session.id),
    evidence: sessionEvidenceRepo.listBySession(session.id),
    workflowArtifacts,
    workflowGates: buildWorkflowGates(workflowRuns, workflowArtifacts),
    workflowController: buildWorkflowControllerView(workflowRuns),
    workflowAgentAssignments: buildWorkflowAgentAssignmentViews(workflowRuns),
  };
}

function broadcastSessionWorkspaceSnapshot(session: Session): void {
  const project = projectRepo.get(session.project_id);
  if (!project) return;
  wsHub.broadcastSession(session.id, {
    type: 'session_workspace:snapshot',
    projectId: project.id,
    sessionId: session.id,
    payload: buildWorkspacePayload(project, session),
  });
}

function listSessionWorkflowRuns(session: Session): WorkflowRun[] {
  const messageIds = new Set(sessionMessageRepo.listBySession(session.id).map((message) => message.id));
  if (messageIds.size === 0) return [];
  const tasks = taskRepo
    .listByProject(session.project_id)
    .filter((task) => task.source_message_id !== null && messageIds.has(task.source_message_id));
  return tasks.flatMap((task) => workflowRepo.listByTask(task.id));
}

function findSessionWorkflowRunForArtifact(
  session: Session,
  artifact: WorkflowArtifactVersion,
): { run: WorkflowRun } | null {
  const run = listSessionWorkflowRuns(session).find((item) => item.id === artifact.workflow_run_id);
  return run ? { run } : null;
}

function toWorkflowArtifactVersionView(artifact: WorkflowArtifactVersion): WorkflowArtifactVersionView {
  return {
    id: artifact.id,
    workflow_run_id: artifact.workflow_run_id,
    artifact_type: artifact.artifact_type,
    version: artifact.version,
    status: artifact.status,
    title: artifact.title,
    content: artifact.content,
    structured_data: parseStructuredData(artifact.structured_data),
    created_by_agent_id: artifact.created_by_agent_id,
    change_request_message_id: artifact.change_request_message_id,
    approved_by: artifact.approved_by,
    approved_at: artifact.approved_at,
    created_at: artifact.created_at,
  };
}

function buildWorkflowControllerView(runs: WorkflowRun[]): WorkflowControllerView | null {
  const run = latestWorkflowRun(runs);
  if (!run) return null;
  const state = parseGraphState(run.graph_state);
  const activeStage = state?.superpowersPhase === 'finish_branch'
    ? 'finish_branch'
    : state?.activeSuperpowersStage ?? run.current_stage ?? null;
  const blocker = state?.error ?? run.error ?? null;
  return {
    workflow_run_id: run.id,
    status: run.status,
    selected_intent: state?.selectedIntent ?? null,
    active_stage: activeStage,
    controller: inferWorkflowController(state?.currentNode ?? null, activeStage, run.status),
    blocker,
    next_action: inferWorkflowNextAction(state, run, blocker),
    finishBranchDecision: state?.finishBranchDecision ?? null,
  };
}

function buildWorkflowAgentAssignmentViews(runs: WorkflowRun[]): WorkflowAgentAssignmentView[] {
  return runs.flatMap((run) => {
    const state = parseGraphState(run.graph_state);
    const assignments = state?.agentAssignments ?? [];
    if (assignments.length === 0) return [];
    const roomAgents = roomAgentRepo.listByRoom(run.room_id, { includeRemoved: true });
    return assignments.map((assignment) => {
      const taskIndex = parsePlanTaskIndex(assignment.taskId);
      const planTask = taskIndex === null ? null : state?.plan?.tasks[taskIndex] ?? null;
      const assignedAgent = assignment.assignedAgentId
        ? roomAgents.find((agent) =>
          agent.id === assignment.assignedAgentId ||
          agent.agent_id === assignment.assignedAgentId
        ) ?? null
        : null;
      return {
        task_id: assignment.taskId,
        task_title: planTask?.title ?? assignment.taskId,
        role: normalizeWorkflowAssignmentRole(planTask?.suggestedRole ?? 'executor'),
        assigned_agent_id: assignment.assignedAgentId,
        assigned_agent_name: assignedAgent?.agent_name ?? assignment.assignedAgentId,
        backend: assignedAgent?.acp_backend ?? null,
        fallback_reason: assignment.fallbackReason,
        execution_mode: assignment.executionMode,
        scope_write: assignment.scopeWrite.length > 0 ? assignment.scopeWrite : planTask?.scopeWrite ?? [],
      };
    });
  });
}

function buildWorkflowGates(
  runs: WorkflowRun[],
  artifacts: WorkflowArtifactVersionView[],
): WorkflowGateView[] {
  const gates: WorkflowGateView[] = [];
  for (const run of runs) {
    const runArtifacts = artifacts.filter((artifact) => artifact.workflow_run_id === run.id);
    for (const artifactType of ['spec', 'plan', 'lightweight_plan'] as const) {
      const latestDraft = latestArtifactByStatus(runArtifacts, artifactType, ['draft', 'reviewing']);
      const approved = latestArtifactByStatus(runArtifacts, artifactType, ['approved']);
      const artifact = latestDraft ?? approved;
      if (!artifact) continue;
      gates.push({
        kind: artifactType === 'spec' ? 'spec_confirm' : 'plan_confirm',
        workflow_run_id: run.id,
        artifact_version_id: artifact.id,
        status: artifact.status === 'approved' ? 'approved' : 'pending',
        reason: buildWorkflowGateReason(artifactType, artifact.status === 'approved' ? 'approved' : 'pending'),
      });
    }
  }
  return gates;
}

function buildWorkflowGateReason(
  artifactType: Extract<WorkflowArtifactVersionType, 'spec' | 'plan' | 'lightweight_plan'>,
  status: 'pending' | 'approved',
): string {
  if (status === 'approved') {
    if (artifactType === 'spec') return '已确认的需求/设计规格；如需调整，请请求 planner 修改。';
    if (artifactType === 'lightweight_plan') return '已确认的轻量执行计划；如需调整，请请求 planner 修改。';
    return '已确认的执行计划；如需调整，请请求 planner 修改。';
  }
  if (artifactType === 'spec') return '等待用户确认 planner 生成的需求/设计规格。';
  if (artifactType === 'lightweight_plan') return '等待用户确认 planner 生成的轻量执行计划。';
  return '等待用户确认 planner 生成的执行计划。';
}

function latestWorkflowRun(runs: WorkflowRun[]): WorkflowRun | null {
  return runs.reduce<WorkflowRun | null>((latest, run) => {
    if (!latest) return run;
    const latestTime = latest.updated_at || latest.created_at;
    const runTime = run.updated_at || run.created_at;
    return runTime > latestTime ? run : latest;
  }, null);
}

function sessionOwnsWorkflowRun(session: Session, run: WorkflowRun): boolean {
  const task = taskRepo.get(run.task_id);
  if (!task || task.project_id !== session.project_id || !task.source_message_id) return false;
  return sessionMessageRepo.listBySession(session.id).some((message) => message.id === task.source_message_id);
}

function inferWorkflowController(
  node: AgentWorkflowState['currentNode'] | null,
  activeStage: string | null,
  status: WorkflowRun['status'],
): WorkflowControllerView['controller'] {
  if (status === 'awaiting_approval') return 'user';
  if (node === 'approval' || node === 'debug_plan_confirm') return 'user';
  if (node === 'execute' || node === 'tdd_execute' || node === 'systematic_debugging') return 'worker';
  if (node === 'review' || node === 'spec_compliance_review' || node === 'code_quality_review') return 'reviewer';
  if (node === 'verify') return 'verifier';
  if (activeStage === 'implementation') return 'worker';
  if (activeStage === 'code_review') return 'reviewer';
  if (activeStage === 'acceptance') return 'user';
  if (!node && !activeStage) return null;
  return 'planner';
}

function inferWorkflowNextAction(
  state: AgentWorkflowState | null,
  run: WorkflowRun,
  blocker: string | null,
): string | null {
  if (blocker === 'needs_agent_assignment') return '需要 planner 重新分配可用执行智能体。';
  if (run.status === 'awaiting_approval') return '等待用户确认当前 workflow artifact。';
  if (run.status === 'blocked') return blocker ?? '等待处理阻塞。';
  if (state?.currentNode === 'agent_assignment') return '生成并冻结子任务执行智能体分配。';
  if (state?.currentNode === 'dispatch') return '按已确认分配创建子任务并进入执行。';
  return null;
}

function parsePlanTaskIndex(taskId: string): number | null {
  const match = /^task-(\d+)$/u.exec(taskId);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index - 1 : null;
}

function normalizeWorkflowAssignmentRole(role: string): WorkflowAgentAssignmentView['role'] {
  if (role === 'reviewer' || role === 'acceptor') return role;
  return 'executor';
}

function latestArtifactByStatus(
  artifacts: WorkflowArtifactVersionView[],
  artifactType: WorkflowArtifactVersionType,
  statuses: WorkflowArtifactVersionView['status'][],
): WorkflowArtifactVersionView | null {
  return artifacts
    .filter((artifact) => artifact.artifact_type === artifactType && statuses.includes(artifact.status))
    .sort((a, b) => b.version - a.version)[0] ?? null;
}

function updateApprovedArtifactGraphState(
  run: WorkflowRun,
  artifact: WorkflowArtifactVersion,
  shouldResume = shouldResumeAfterArtifactApproval(run, artifact.artifact_type),
): WorkflowRun | null {
  const state = parseGraphState(run.graph_state);
  if (!state) return null;
  const nextState: AgentWorkflowState = {
    ...state,
    ...(artifact.artifact_type === 'spec'
      ? {
        approvedSpecArtifactVersionId: artifact.id,
        draftSpecArtifactVersionId: state.draftSpecArtifactVersionId === artifact.id
          ? null
          : state.draftSpecArtifactVersionId,
      }
      : {}),
    ...(artifact.artifact_type === 'plan'
      ? {
        approvedPlanArtifactVersionId: artifact.id,
        draftPlanArtifactVersionId: state.draftPlanArtifactVersionId === artifact.id
          ? null
          : state.draftPlanArtifactVersionId,
      }
      : {}),
    ...(artifact.artifact_type === 'lightweight_plan'
      ? {
        lightweightPlanArtifactVersionId: artifact.id,
      }
      : {}),
    ...(shouldResume
      ? {
        status: 'running',
        error: null,
      }
      : {}),
  };
  const graphStateUpdated = workflowRepo.updateGraphState(run.id, serializeGraphState(nextState));
  if (!shouldResume) return graphStateUpdated ?? null;
  return workflowRepo.updateRun(run.id, { status: 'running', error: null }) ?? graphStateUpdated ?? null;
}

function shouldResumeAfterArtifactApproval(run: WorkflowRun, artifactType: WorkflowArtifactVersionType): boolean {
  if (artifactType !== 'spec' && artifactType !== 'plan' && artifactType !== 'lightweight_plan') return false;
  if (run.status !== 'blocked' && run.status !== 'awaiting_approval') return false;
  const state = parseGraphState(run.graph_state);
  if (run.status === 'awaiting_approval') return true;
  const error = [run.error, state?.error].filter(Boolean).join('\n');
  if (artifactType === 'spec') return /approved spec artifact/i.test(error);
  return /approved plan artifact/i.test(error);
}

function resumeWorkflowAfterArtifactApproval(run: WorkflowRun, shouldResume: boolean): void {
  if (!shouldResume) return;
  workflowOrchestrator.enqueueExistingGraphRun(run.id);
}

function parseStructuredData(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function backfillSessionMessageAttachments(projectId: string, message: SessionMessage): SessionMessage {
  const metadata = parseMessageMetadataRecord(message.metadata);
  const libraryFileRefs = Array.isArray(metadata.library_file_refs)
    ? metadata.library_file_refs.filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
    : [];
  if (libraryFileRefs.length === 0) return message;

  const existingAttachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  const existingFileIds = new Set(existingAttachments
    .map((attachment) => isRecord(attachment) && typeof attachment.fileId === 'string' ? attachment.fileId : null)
    .filter((fileId): fileId is string => fileId !== null));
  const backfilledAttachments = libraryFileRefs
    .filter((ref) => !existingFileIds.has(ref))
    .map((ref) => fileRepo.get(ref))
    .filter((file): file is ProjectFile => isBackfillableUploadedFile(projectId, file))
    .map((file) => ({
      id: file.id,
      fileId: file.id,
      name: file.original_name,
      mimeType: file.mime_type,
      size: file.size,
      url: file.url,
      isImage: file.mime_type.startsWith('image/'),
      deleted: file.deleted_at !== null,
    }));
  if (backfilledAttachments.length === 0) return message;
  const nextMetadata = JSON.stringify({
    ...metadata,
    attachments: [...existingAttachments, ...backfilledAttachments],
  });
  const updated = sessionMessageRepo.updateMetadata(message.id, nextMetadata);
  return updated ?? {
    ...message,
    metadata: nextMetadata,
  };
}

function isBackfillableUploadedFile(projectId: string, file: ProjectFile | undefined): file is ProjectFile {
  return Boolean(file && file.project_id === projectId && file.source_type === 'uploaded_file');
}

function parseMessageMetadataRecord(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

export function buildSessionTodoStats(sessionId: string, planItems: SessionPlanItem[]): SessionTodoStats {
  const stats: SessionTodoStats = {
    sessionId,
    total: planItems.length,
    open: 0,
    pending: 0,
    inProgress: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
    skipped: 0,
  };

  for (const item of planItems) {
    if (item.status === 'pending') stats.pending += 1;
    else if (item.status === 'in_progress') stats.inProgress += 1;
    else if (item.status === 'blocked') stats.blocked += 1;
    else if (item.status === 'failed') stats.failed += 1;
    else if (item.status === 'completed') stats.completed += 1;
    else if (item.status === 'skipped') stats.skipped += 1;
  }
  stats.open = stats.pending + stats.inProgress + stats.blocked + stats.failed;
  return stats;
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
