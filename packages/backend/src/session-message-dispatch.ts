import { lstat } from 'node:fs/promises';
import { sessionEvidenceRepo } from './repos/session-evidence.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { fileRepo } from './repos/files.js';
import { projectRepo } from './repos/projects.js';
import { roomRepo } from './repos/rooms.js';
import { settingsRepo } from './repos/settings.js';
import {
  DEFAULT_SESSION_AGENT_ID,
  sessionMessageRepo,
  sessionRepo,
} from './repos/sessions.js';
import { taskRepo } from './repos/tasks.js';
import { workflowArtifactVersionRepo, workflowRepo } from './repos/workflows.js';
import { createContextManifest } from './session.routes.js';
import { buildKnowledgeAgentToolPrompt } from './knowledge-rag.js';
import { broadcastActiveSessionUpsert } from './session-active-broadcast.js';
import { buildSessionFileReferenceContext } from './session-file-reference-context.js';
import { buildSessionPlannerRuntimeSnapshot, resolveSessionPlannerRuntime } from './session-planner-runtime.js';
import { runSessionAgent } from './session-runtime.js';
import { runRegistry } from './run-registry.js';
import { recordTaskCreatedEvent } from './task-conversation.js';
import { workflowOrchestrator } from './workflows/orchestrator.js';
import { createSessionWorkflowIntake } from './workflows/session-workflow-intake.js';
import { parseGraphState, serializeGraphState, type AgentWorkflowState } from './workflows/graph/state.js';
import { SUPERPOWERS_V2_GRAPH_VERSION } from './workflows/superpowers-stage-registry.js';
import { assessTaskRisk, type ApprovalCard, type TaskRiskAssessment } from './workflows/task-risk.js';
import { wsHub } from './ws-hub.js';
import { getPlatformSkill } from './platform-skills/service.js';
import { isIgnoredWorkspacePath, normalizeWorkspacePath, resolveWorkspacePath } from './workspace-files.js';
import type { ImageGenerationJob, ImageGenerationOutput } from './image-generation/types.js';
import type { GenerateImageToolOutput } from './image-generation/tool.js';
import type { PlatformSkill } from './platform-skills/types.js';
import type {
  MessageAttachmentMetadata,
  PlatformSkillRef,
  Project,
  ProjectFile,
  Room,
  Session,
  SessionMessage,
  SessionMode,
  Task,
  WorkflowRun,
  WorkflowArtifactVersion,
  WorkflowArtifactVersionType,
} from './types.js';

const DEFAULT_SESSION_TITLE = 'New Session';
const AUTO_SESSION_TITLE_LIMIT = 25;
const MAX_SESSION_FILE_REFS = 12;
const MAX_PLATFORM_SKILL_REFS = 8;
const SESSION_WORKFLOW_AUTO_APPROVAL_TIMEOUT_MS = 10_000;
const SESSION_WORKFLOW_AUTO_APPROVAL_POLL_MS = 25;

type ResolvedPlatformSkillRef = PlatformSkillRef & {
  description: string | null;
};

interface PendingSessionApproval {
  message: SessionMessage;
  metadata: SessionApprovalMetadata;
}

interface SessionApprovalMetadata {
  status: 'pending' | 'approved' | 'rejected';
  sourceMessageId: string;
  originalContent: string;
  contextContent?: string;
  riskAssessment: TaskRiskAssessment;
  approvalCard: ApprovalCard;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
  platformSkillRefs: ResolvedPlatformSkillRef[];
  createdAt: number;
  decidedAt?: number;
  decidedByMessageId?: string;
  executionPath?: 'session_planner' | 'workflow_graph';
  workflowRoomId?: string;
  workflowTaskId?: string;
  workflowRunId?: string;
}

interface SessionExecutionMetadata {
  executionPath: 'workflow_graph';
  trigger: 'workflow_intake';
  riskAssessment: TaskRiskAssessment;
  workflowRoomId?: string;
  workflowTaskId?: string;
  workflowRunId?: string;
  graphVersion?: string;
  activeSuperpowersStage?: string;
}

interface SessionWorkflowRequest {
  originalContent: string;
  contextContent?: string;
  riskAssessment: TaskRiskAssessment;
  agents: string[];
  executionMode: ApprovalCard['executionMode'];
  scopeRead: string[];
  scopeWrite: string[];
  verification: ApprovalCard['verification'];
  risks: string[];
  assumptions: string[];
  workspaceFileRefs: string[];
}

interface WorkflowArtifactChangeRequestPayload {
  workflowRunId: string;
  artifactVersionId: string;
  artifactType: WorkflowArtifactVersionType;
}

export async function dispatchSessionUserMessage(input: {
  sessionId: string;
  content: string;
  senderId?: string;
  senderName?: string | null;
  mode?: SessionMode;
  agentId?: string | null;
  workspaceFileRefs?: string[];
  libraryFileRefs?: string[];
  platformSkillRefs?: PlatformSkillRef[];
  workflowArtifactChangeRequest?: WorkflowArtifactChangeRequestPayload;
}): Promise<SessionMessage> {
  const session = sessionRepo.get(input.sessionId);
  if (!session) throw new Error('session not found');
  const project = projectRepo.get(session.project_id);
  if (!project) throw new Error('project not found');
  const workspacePath = session.worktree_path ?? session.workspace_path ?? project.path;
  const workspaceFileRefs = await normalizeWorkspaceFileRefs(workspacePath, input.workspaceFileRefs);
  const libraryFileRefs = normalizeLibraryFileRefs(project.id, input.libraryFileRefs);
  const plannerRuntime = resolveSessionPlannerRuntime(session.project_id);
  const platformSkillRefs = await normalizePlatformSkillRefs(input.platformSkillRefs, plannerRuntime.backend);
  if (!hasUserMessagePayload(input.content, workspaceFileRefs, libraryFileRefs, platformSkillRefs)) {
    throw new Error('session message content or references are required');
  }
  const updatedSession = input.mode && input.mode !== session.mode
    ? sessionRepo.update(session.id, { mode: input.mode }) ?? session
    : session;
  const agentId = input.agentId?.trim() || DEFAULT_SESSION_AGENT_ID;
  const shouldRenameSession = shouldRenameFromFirstUserMessage(updatedSession);
  const message = sessionMessageRepo.create({
    session_id: updatedSession.id,
    role: 'user',
    sender_id: input.senderId ?? 'user',
    sender_name: input.senderName ?? null,
    content: input.content,
    metadata: buildUserMessageMetadata({
      agentId,
      workspaceFileRefs,
      libraryFileRefs,
      platformSkillRefs,
      workflowArtifactChangeRequest: input.workflowArtifactChangeRequest,
    }),
  });
  const runtimeSession = shouldRenameSession
    ? sessionRepo.update(updatedSession.id, { title: buildSessionTitleFromMessage(input.content) }) ?? updatedSession
    : updatedSession;
  if (runtimeSession.title !== updatedSession.title) {
    wsHub.broadcastSession(runtimeSession.id, {
      type: 'session:updated',
      sessionId: runtimeSession.id,
      session: runtimeSession,
    });
  }
  sessionEvidenceRepo.create({
    session_id: runtimeSession.id,
    event_type: 'message',
    source_message_id: message.id,
    title: 'User message',
    payload: { message_id: message.id, target_agent_id: agentId },
  });
  wsHub.broadcastSession(runtimeSession.id, {
    type: 'session_message:new',
    sessionId: runtimeSession.id,
    message,
  });
  broadcastActiveSessionUpsert(runtimeSession.id);

  const approvalDecision = getSessionApprovalDecision(input.content);
  const pendingApproval = approvalDecision ? findLatestPendingSessionApproval(runtimeSession.id) : null;
  if (approvalDecision && pendingApproval) {
    await handleSessionApprovalDecision({
      project,
      session: runtimeSession,
      decisionMessage: message,
      pendingApproval,
      decision: approvalDecision,
      plannerRuntime,
      workspacePath,
      workspaceFileRefs,
      libraryFileRefs,
      platformSkillRefs,
    });
    return message;
  }

  if (input.workflowArtifactChangeRequest) {
    const handled = handleWorkflowArtifactChangeRequest({
      project,
      session: runtimeSession,
      sourceMessage: message,
      request: input.workflowArtifactChangeRequest,
    });
    if (!handled) {
      recordInvalidWorkflowArtifactChangeRequest({
        session: runtimeSession,
        sourceMessage: message,
        request: input.workflowArtifactChangeRequest,
      });
    }
    return message;
  }

  const riskGate = assessSessionMessageRisk({
    sessionId: runtimeSession.id,
    sourceMessageId: message.id,
    content: input.content,
    workspaceFileRefs,
    platformSkillRefs,
  });
  startSessionWorkflowIntake({
    project,
    session: runtimeSession,
    sourceMessage: message,
    assessment: riskGate.assessment,
    contextContent: riskGate.contextContent,
    workspaceFileRefs,
    libraryFileRefs,
    platformSkillRefs,
  });
  return message;
}

async function startSessionPlannerRun(input: {
  project: Project;
  session: Session;
  content: string;
  workspacePath: string;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
  platformSkillRefs: ResolvedPlatformSkillRef[];
  plannerRuntime: ReturnType<typeof resolveSessionPlannerRuntime>;
}): Promise<void> {
  const fileReferenceContext = await buildSessionFileReferenceContext({
    project: input.project,
    workspacePath: input.workspacePath,
    workspaceFileRefs: input.workspaceFileRefs,
    libraryFileRefs: input.libraryFileRefs,
  });
  void runSessionAgent({
    sessionId: input.session.id,
    agentId: input.plannerRuntime.agentId,
    prompt: buildRuntimePrompt(
      input.session,
      input.content,
      fileReferenceContext.promptAddition,
      buildPlatformSkillsPrompt(input.platformSkillRefs),
      settingsRepo.getSystem().global_session_prompt,
    ),
    provider: input.plannerRuntime.backend,
    model: input.session.model,
    permissionMode: input.plannerRuntime.permissionMode,
    runtimeProfileSnapshot: buildSessionPlannerRuntimeSnapshot(input.plannerRuntime),
    imagePaths: fileReferenceContext.imagePaths,
  }).catch((error) => {
    const event = sessionEvidenceRepo.create({
      session_id: input.session.id,
      event_type: 'blocker',
      severity: 'error',
      title: 'Session runtime failed',
      summary: (error as Error).message,
    });
    wsHub.broadcastSession(input.session.id, { type: 'session_evidence:new', sessionId: input.session.id, event });
    broadcastActiveSessionUpsert(input.session.id);
  });
}

function startSessionWorkflowIntake(input: {
  project: Project;
  session: Session;
  sourceMessage: SessionMessage;
  assessment: TaskRiskAssessment;
  contextContent: string | null;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
  platformSkillRefs: ResolvedPlatformSkillRef[];
}): void {
  const room = roomRepo.create({
    project_id: input.project.id,
    name: buildSessionWorkflowRoomName(input.session),
    description: `SessionOS workflow intake for session ${input.session.id}`,
  });
  const { task, workflow } = createSessionWorkflowIntake({
    project: input.project,
    session: input.session,
    sourceMessage: input.sourceMessage,
    room,
    contextContent: input.contextContent,
    workspaceFileRefs: input.workspaceFileRefs,
    libraryFileRefs: input.libraryFileRefs,
    platformSkillRefs: input.platformSkillRefs,
  });
  mergeSessionExecutionMetadata({
    sessionId: input.session.id,
    sourceMessageId: input.sourceMessage.id,
    patch: {
      executionPath: 'workflow_graph',
      trigger: 'workflow_intake',
      riskAssessment: input.assessment,
      workflowRoomId: room.id,
      workflowTaskId: task.id,
      workflowRunId: workflow.id,
      graphVersion: workflow.graph_version ?? SUPERPOWERS_V2_GRAPH_VERSION,
      activeSuperpowersStage: 'intake',
    },
  });
  const event = sessionEvidenceRepo.create({
    session_id: input.session.id,
    event_type: 'status',
    source_message_id: input.sourceMessage.id,
    title: 'Workflow intake started',
    summary: `已进入 Superpowers workflow intake：${task.title}`,
    payload: {
      execution_path: 'workflow_graph',
      trigger: 'workflow_intake',
      room_id: room.id,
      task_id: task.id,
      workflow_run_id: workflow.id,
      workflow_status: workflow.status,
      workflow_stage: workflow.current_stage,
      graph_version: workflow.graph_version ?? SUPERPOWERS_V2_GRAPH_VERSION,
      active_superpowers_stage: 'intake',
    },
  });
  recordWorkflowIntakeStartedMessage({
    session: input.session,
    sourceMessage: input.sourceMessage,
    assessment: input.assessment,
    room,
    task,
    run: workflow,
  });
  enqueueSessionWorkflowIntake({
    session: input.session,
    sourceMessage: input.sourceMessage,
    workflow,
  });
  wsHub.broadcastSession(input.session.id, { type: 'session_evidence:new', sessionId: input.session.id, event });
  broadcastActiveSessionUpsert(input.session.id);
}

function enqueueSessionWorkflowIntake(input: {
  session: Session;
  sourceMessage: SessionMessage;
  workflow: WorkflowRun;
}): void {
  try {
    workflowOrchestrator.enqueueExistingGraphRun(input.workflow.id);
  } catch (error) {
    const event = sessionEvidenceRepo.create({
      session_id: input.session.id,
      event_type: 'blocker',
      severity: 'error',
      source_message_id: input.sourceMessage.id,
      title: 'Workflow intake enqueue failed',
      summary: (error as Error).message,
      payload: {
        execution_path: 'workflow_graph',
        trigger: 'workflow_intake',
        workflow_run_id: input.workflow.id,
      },
    });
    wsHub.broadcastSession(input.session.id, { type: 'session_evidence:new', sessionId: input.session.id, event });
  }
}

function handleWorkflowArtifactChangeRequest(input: {
  project: Project;
  session: Session;
  sourceMessage: SessionMessage;
  request: WorkflowArtifactChangeRequestPayload;
}): boolean {
  const artifact = workflowArtifactVersionRepo.get(input.request.artifactVersionId);
  if (!artifact || !workflowArtifactChangeRequestMatchesArtifact(input.request, artifact)) return false;
  if (artifact.status !== 'draft' && artifact.status !== 'reviewing' && artifact.status !== 'approved') return false;
  if (artifact.artifact_type !== 'spec' && artifact.artifact_type !== 'plan' && artifact.artifact_type !== 'lightweight_plan') return false;

  const run = workflowRepo.getRun(input.request.workflowRunId);
  if (!run || run.project_id !== input.project.id || run.graph_version !== SUPERPOWERS_V2_GRAPH_VERSION) return false;
  if (!sessionOwnsWorkflowRun(input.session, run)) return false;

  if (artifact.artifact_type === 'lightweight_plan') {
    recordUnsupportedWorkflowArtifactChangeRequest({
      session: input.session,
      sourceMessage: input.sourceMessage,
      run,
      artifact,
    });
    return true;
  }

  const state = parseGraphState(run.graph_state);
  if (!state) return false;
  invalidateSupersededWorkflowExecution(run, state);
  const nextState = buildWorkflowArtifactChangeRequestState({
    state,
    artifact,
    sourceMessageId: input.sourceMessage.id,
  });
  const updatedRun = workflowRepo.updateRun(run.id, {
    status: 'running',
    current_stage: 'planning',
    error: null,
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState(nextState));
  workflowOrchestrator.enqueueExistingGraphRun(run.id);
  const event = sessionEvidenceRepo.create({
    session_id: input.session.id,
    event_type: 'status',
    source_message_id: input.sourceMessage.id,
    title: 'Workflow artifact change requested',
    summary: `已请求 planner 修改 ${artifact.artifact_type} v${artifact.version}。`,
    payload: {
      workflow_run_id: run.id,
      artifact_version_id: artifact.id,
      artifact_type: artifact.artifact_type,
      previous_status: artifact.status,
    },
  });
  wsHub.broadcastSession(input.session.id, { type: 'session_evidence:new', sessionId: input.session.id, event });
  if (updatedRun) wsHub.broadcast(run.room_id, { type: 'workflow:updated', roomId: run.room_id, workflow: updatedRun });
  broadcastActiveSessionUpsert(input.session.id);
  return true;
}

function recordInvalidWorkflowArtifactChangeRequest(input: {
  session: Session;
  sourceMessage: SessionMessage;
  request: WorkflowArtifactChangeRequestPayload;
}): void {
  const event = sessionEvidenceRepo.create({
    session_id: input.session.id,
    event_type: 'blocker',
    severity: 'warning',
    source_message_id: input.sourceMessage.id,
    title: 'Workflow artifact change request rejected',
    summary: '无法匹配当前会话中的 workflow artifact，本次消息不会启动新的 planner 或 workflow。',
    payload: {
      workflow_artifact_change_request: input.request,
      reason: 'invalid_or_foreign_artifact',
    },
  });
  wsHub.broadcastSession(input.session.id, { type: 'session_evidence:new', sessionId: input.session.id, event });
  broadcastActiveSessionUpsert(input.session.id);
}

function recordUnsupportedWorkflowArtifactChangeRequest(input: {
  session: Session;
  sourceMessage: SessionMessage;
  run: WorkflowRun;
  artifact: WorkflowArtifactVersion;
}): void {
  const event = sessionEvidenceRepo.create({
    session_id: input.session.id,
    event_type: 'blocker',
    severity: 'warning',
    source_message_id: input.sourceMessage.id,
    title: 'Workflow artifact change request blocked',
    summary: 'lightweight_plan 修订暂未接入可执行 graph 节点，本次请求未转换为普通 plan。',
    payload: {
      workflow_run_id: input.run.id,
      artifact_version_id: input.artifact.id,
      artifact_type: input.artifact.artifact_type,
      reason: 'lightweight_plan_revision_not_implemented',
    },
  });
  wsHub.broadcastSession(input.session.id, { type: 'session_evidence:new', sessionId: input.session.id, event });
  broadcastActiveSessionUpsert(input.session.id);
}

function invalidateSupersededWorkflowExecution(run: WorkflowRun, state: AgentWorkflowState): void {
  const supersededReason = 'Superseded by artifact change request';
  const executionNodeNames = new Set([
    'dispatch',
    'tdd_execute',
    'execute',
    'spec_compliance_review',
    'code_quality_review',
    'verify',
    'finish_branch',
    'acceptance',
    'memory',
  ]);
  const childTaskIds = new Set([
    ...state.childTaskIds,
    ...taskRepo.listChildren(run.task_id).map((task) => task.id),
  ]);
  for (const activeRun of agentRunRepo.listActiveByWorkflow(run.id)) {
    runRegistry.cancel(activeRun.id);
    agentRunRepo.interruptRun(activeRun.id, supersededReason);
  }
  for (const childTaskId of childTaskIds) {
    taskRepo.delete(childTaskId);
  }
  for (const step of workflowRepo.listSteps(run.id)) {
    if (!step.node_name || !executionNodeNames.has(step.node_name)) continue;
    workflowRepo.updateStep(step.id, {
      status: 'skipped',
      error: step.error ?? supersededReason,
    });
  }
}

function workflowArtifactChangeRequestMatchesArtifact(
  request: WorkflowArtifactChangeRequestPayload,
  artifact: WorkflowArtifactVersion,
): boolean {
  return artifact.workflow_run_id === request.workflowRunId &&
    artifact.id === request.artifactVersionId &&
    artifact.artifact_type === request.artifactType;
}

function sessionOwnsWorkflowRun(session: Session, run: WorkflowRun): boolean {
  const task = taskRepo.get(run.task_id);
  if (!task || task.project_id !== session.project_id || !task.source_message_id) return false;
  return sessionMessageRepo.listBySession(session.id).some((message) => message.id === task.source_message_id);
}

function buildWorkflowArtifactChangeRequestState(input: {
  state: AgentWorkflowState;
  artifact: WorkflowArtifactVersion;
  sourceMessageId: string;
}): AgentWorkflowState {
  const common = {
    artifactChangeRequestMessageId: input.sourceMessageId,
    artifactChangeRequestArtifactVersionId: input.artifact.id,
    status: 'running' as const,
    error: null,
    recoveryState: null,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    childTaskPlanIndexes: {},
    agentAssignments: [],
    tddEvidence: [],
    tddExemption: null,
    specComplianceReview: null,
    codeQualityReview: null,
    verificationEvidence: [],
    finishBranchDecision: null,
    riskAssessment: null,
    approvalCard: null,
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
  };
  if (input.artifact.artifact_type === 'spec') {
    return {
      ...input.state,
      ...common,
      currentNode: 'context',
      superpowersPhase: null,
      activeSuperpowersStage: 'brainstorming',
      approvedSpecArtifactVersionId: null,
      draftSpecArtifactVersionId: input.artifact.status === 'approved'
        ? input.state.draftSpecArtifactVersionId
        : input.artifact.id,
      designReviewVerdict: null,
      draftPlanArtifactVersionId: null,
      approvedPlanArtifactVersionId: null,
      lightweightPlanArtifactVersionId: null,
      implementationPlanPath: null,
      planReviewVerdict: null,
      plan: null,
      workflowPlan: null,
      approval: 'pending',
    };
  }
  return {
    ...input.state,
    ...common,
    currentNode: 'planning',
    superpowersPhase: 'worktree',
    activeSuperpowersStage: input.artifact.artifact_type === 'lightweight_plan' ? 'lightweight_plan' : 'writing_plans',
    draftPlanArtifactVersionId: input.artifact.artifact_type === 'plan' && input.artifact.status !== 'approved'
      ? input.artifact.id
      : input.state.draftPlanArtifactVersionId,
    approvedPlanArtifactVersionId: null,
    lightweightPlanArtifactVersionId: input.artifact.artifact_type === 'lightweight_plan' ? null : input.state.lightweightPlanArtifactVersionId,
    implementationPlanPath: null,
    planReviewVerdict: null,
    plan: null,
    workflowPlan: null,
    approval: 'pending',
  };
}

function recordWorkflowIntakeStartedMessage(input: {
  session: Session;
  sourceMessage: SessionMessage;
  assessment: TaskRiskAssessment;
  room: Room;
  task: Task;
  run: WorkflowRun;
}): void {
  const sessionWorkflow = {
    executionPath: 'workflow_graph',
    trigger: 'workflow_intake',
    riskAssessment: input.assessment,
    workflowRoomId: input.room.id,
    workflowTaskId: input.task.id,
    workflowRunId: input.run.id,
    workflowStatus: input.run.status,
    workflowStage: input.run.current_stage,
    graphVersion: input.run.graph_version ?? SUPERPOWERS_V2_GRAPH_VERSION,
    activeSuperpowersStage: 'intake',
    sourceMessageId: input.sourceMessage.id,
    createdAt: Date.now(),
  };
  const message = sessionMessageRepo.create({
    session_id: input.session.id,
    role: 'system',
    sender_id: 'workflow',
    sender_name: '工作流',
    content: [
      `已进入 Superpowers 工作流：${input.task.title}`,
      `当前阶段：${input.run.current_stage ?? '启动中'}`,
      '执行方式：workflow_graph',
    ].join('\n'),
    message_type: 'system',
    metadata: {
      risk_assessment: input.assessment,
      session_workflow: sessionWorkflow,
      source_message_id: input.sourceMessage.id,
    },
  });
  wsHub.broadcastSession(input.session.id, {
    type: 'session_message:new',
    sessionId: input.session.id,
    message,
  });
}

export function assertSessionCanReceiveImageGenerationJob(
  projectId: string,
  sessionId: string | null | undefined,
): void {
  if (!sessionId) return;
  const session = sessionRepo.get(sessionId);
  if (!session) throw new Error('session not found');
  if (session.project_id !== projectId) throw new Error('session project mismatch');
}

export function recordSessionImageGenerationJobMessage(input: {
  sessionId: string;
  job: ImageGenerationJob;
  outputs?: ImageGenerationOutput[];
}): SessionMessage {
  assertSessionCanReceiveImageGenerationJob(input.job.project_id, input.sessionId);
  if (input.job.session_id !== input.sessionId) {
    throw new Error('image generation job session mismatch');
  }
  const message = sessionMessageRepo.create({
    session_id: input.sessionId,
    role: 'system',
    sender_id: 'image-generation',
    sender_name: 'Image Generation',
    content: `图片生成任务已创建：${truncateImageGenerationPrompt(input.job.prompt)}`,
    message_type: 'system',
    metadata: buildImageGenerationJobMessageMetadata(input.job, input.outputs ?? []),
  });
  wsHub.broadcastSession(input.sessionId, {
    type: 'session_message:new',
    sessionId: input.sessionId,
    message,
  });
  broadcastActiveSessionUpsert(input.sessionId);
  return message;
}

export function recordSessionImageGenerationToolResultEvidence(input: {
  sessionId: string;
  sourceRunId?: string | null;
  result: GenerateImageToolOutput;
}) {
  const event = sessionEvidenceRepo.create({
    session_id: input.sessionId,
    event_type: 'tool_result',
    severity: imageToolEvidenceSeverity(input.result),
    source_run_id: input.sourceRunId ?? null,
    title: '图片生成结果',
    summary: imageToolEvidenceSummary(input.result),
    payload: {
      tool_name: 'generate_image',
      job_id: input.result.job_id,
      status: input.result.status,
      error: input.result.error,
      outputs: input.result.outputs,
    },
  });
  wsHub.broadcastSession(input.sessionId, {
    type: 'session_evidence:new',
    sessionId: input.sessionId,
    event,
  });
  broadcastActiveSessionUpsert(input.sessionId);
  return event;
}

function assessSessionMessageRisk(input: {
  sessionId: string;
  sourceMessageId: string;
  content: string;
  workspaceFileRefs: string[];
  platformSkillRefs: ResolvedPlatformSkillRef[];
}): {
  assessment: TaskRiskAssessment;
  contextContent: string | null;
  applies: boolean;
} {
  const applies = shouldApplySessionRiskGate(input.content, input.platformSkillRefs);
  const scopeWrite = applies
    ? dedupeStringList([...extractPathLikeScopes(input.content), ...input.workspaceFileRefs])
    : extractPathLikeScopes(input.content);
  let assessment = assessTaskRisk({
    title: input.content,
    description: input.content,
    scopeRead: input.workspaceFileRefs,
    scopeWrite,
    verificationCommands: [],
  });
  let contextContent: string | null = null;
  if (shouldEnhanceRiskWithSessionContext({ content: input.content, assessment })) {
    contextContent = buildRecentSessionTaskContext(input.sessionId, input.sourceMessageId);
    if (!contextContent) {
      return {
        assessment,
        contextContent,
        applies: false,
      };
    }
    const enhancedDescription = [input.content, '', '最近会话上下文：', contextContent].join('\n');
    const enhancedScopeWrite = applies
      ? dedupeStringList([...extractPathLikeScopes(enhancedDescription), ...input.workspaceFileRefs])
      : extractPathLikeScopes(enhancedDescription);
    assessment = assessTaskRisk({
      title: input.content,
      description: enhancedDescription,
      scopeRead: input.workspaceFileRefs,
      scopeWrite: enhancedScopeWrite,
      verificationCommands: [],
    });
  }
  return { assessment, contextContent, applies };
}

async function handleSessionApprovalDecision(input: {
  project: Project;
  session: Session;
  decisionMessage: SessionMessage;
  pendingApproval: PendingSessionApproval;
  decision: 'approved' | 'rejected';
  plannerRuntime: ReturnType<typeof resolveSessionPlannerRuntime>;
  workspacePath: string;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
  platformSkillRefs: ResolvedPlatformSkillRef[];
}): Promise<void> {
  const existingMetadata = parseSessionMessageMetadata(input.pendingApproval.message.metadata);
  const nextApproval: SessionApprovalMetadata = {
    ...input.pendingApproval.metadata,
    status: input.decision,
    decidedAt: Date.now(),
    decidedByMessageId: input.decisionMessage.id,
  };
  const updatedSourceMessage = sessionMessageRepo.updateMetadata(input.pendingApproval.message.id, {
    ...existingMetadata,
    risk_assessment: nextApproval.riskAssessment,
    approval_card: nextApproval.approvalCard,
    session_approval: nextApproval,
  }) ?? input.pendingApproval.message;
  wsHub.broadcastSession(input.session.id, {
    type: 'session_message:new',
    sessionId: input.session.id,
    message: updatedSourceMessage,
  });

  const approved = input.decision === 'approved';
  const shouldStartWorkflow = approved && shouldStartWorkflowForApproval(nextApproval);
  const gateMessage = sessionMessageRepo.create({
    session_id: input.session.id,
    role: 'system',
    sender_id: 'risk-gate',
    sender_name: '风险门禁',
    content: approved
      ? shouldStartWorkflow
        ? '风险确认已确认，正在启动 workflow 执行原任务。'
        : '风险确认已确认，正在启动 planner 执行原任务。'
      : '风险确认已取消，本次任务不会启动执行流程。',
    message_type: 'system',
    metadata: {
      session_approval: nextApproval,
      source_message_id: input.pendingApproval.message.id,
      decision_message_id: input.decisionMessage.id,
    },
  });
  const event = sessionEvidenceRepo.create({
    session_id: input.session.id,
    event_type: 'status',
    source_message_id: input.decisionMessage.id,
    title: approved ? '风险确认已确认' : '风险确认已取消',
    summary: approved ? '用户确认执行中高风险任务。' : '用户取消执行中高风险任务。',
    payload: {
      session_approval: nextApproval,
      gate_message_id: gateMessage.id,
      source_message_id: input.pendingApproval.message.id,
      decision_message_id: input.decisionMessage.id,
    },
  });
  wsHub.broadcastSession(input.session.id, {
    type: 'session_message:new',
    sessionId: input.session.id,
    message: gateMessage,
  });
  wsHub.broadcastSession(input.session.id, {
    type: 'session_evidence:new',
    sessionId: input.session.id,
    event,
  });
  broadcastActiveSessionUpsert(input.session.id);

  if (!approved) return;
  if (shouldStartWorkflow) {
    startApprovedSessionWorkflow({
      project: input.project,
      session: input.session,
      approval: nextApproval,
      sourceMessageId: input.pendingApproval.message.id,
    });
    return;
  }
  await startSessionPlannerRun({
    project: input.project,
    session: input.session,
    content: buildSessionApprovalExecutionContent(nextApproval),
    workspacePath: input.workspacePath,
    workspaceFileRefs: nextApproval.workspaceFileRefs ?? input.workspaceFileRefs,
    libraryFileRefs: nextApproval.libraryFileRefs ?? input.libraryFileRefs,
    platformSkillRefs: nextApproval.platformSkillRefs ?? input.platformSkillRefs,
    plannerRuntime: input.plannerRuntime,
  });
}

function startApprovedSessionWorkflow(input: {
  project: Project;
  session: Session;
  approval: SessionApprovalMetadata;
  sourceMessageId: string;
}): void {
  void runApprovedSessionWorkflow(input).catch((error) => {
    const event = sessionEvidenceRepo.create({
      session_id: input.session.id,
      event_type: 'blocker',
      severity: 'error',
      source_message_id: input.sourceMessageId,
      title: 'Session workflow failed',
      summary: (error as Error).message,
      payload: {
        session_approval: input.approval,
        source_message_id: input.sourceMessageId,
      },
    });
    wsHub.broadcastSession(input.session.id, { type: 'session_evidence:new', sessionId: input.session.id, event });
    broadcastActiveSessionUpsert(input.session.id);
  });
}

async function runApprovedSessionWorkflow(input: {
  project: Project;
  session: Session;
  approval: SessionApprovalMetadata;
  sourceMessageId: string;
}): Promise<void> {
  const request = buildApprovedSessionWorkflowRequest(input.approval);
  const { room, task } = createSessionWorkflowBridgeTask({
    project: input.project,
    session: input.session,
    sourceMessageId: input.sourceMessageId,
    request,
    trigger: 'approved',
    approvalDecisionMessageId: input.approval.decidedByMessageId,
  });

  mergeSessionApprovalMetadata({
    sessionId: input.session.id,
    sourceMessageId: input.sourceMessageId,
    patch: {
      executionPath: 'workflow_graph',
      workflowRoomId: room.id,
      workflowTaskId: task.id,
    },
  });

  const started = await workflowOrchestrator.startInBackground(task.id);
  mergeSessionApprovalMetadata({
    sessionId: input.session.id,
    sourceMessageId: input.sourceMessageId,
    patch: {
      executionPath: 'workflow_graph',
      workflowRoomId: room.id,
      workflowTaskId: task.id,
      workflowRunId: started.id,
    },
  });
  scheduleSessionWorkflowAutoApproval({
    session: input.session,
    sourceMessageId: input.sourceMessageId,
    approval: input.approval,
    workflowRunId: started.id,
  });
  const event = sessionEvidenceRepo.create({
    session_id: input.session.id,
    event_type: 'status',
    source_message_id: input.sourceMessageId,
    title: 'Workflow started',
    summary: `已启动 workflow：${task.title}`,
    payload: {
      execution_path: 'workflow_graph',
      room_id: room.id,
      task_id: task.id,
      workflow_run_id: started.id,
      workflow_status: started.status,
      workflow_stage: started.current_stage,
    },
  });
  wsHub.broadcastSession(input.session.id, { type: 'session_evidence:new', sessionId: input.session.id, event });
  broadcastActiveSessionUpsert(input.session.id);
}

function scheduleSessionWorkflowAutoApproval(input: {
  session: Session;
  sourceMessageId: string;
  approval: SessionApprovalMetadata;
  workflowRunId: string;
}): void {
  void autoApproveSessionWorkflowWhenReady(input).catch((error) => {
    const event = sessionEvidenceRepo.create({
      session_id: input.session.id,
      event_type: 'blocker',
      severity: 'error',
      source_message_id: input.sourceMessageId,
      title: 'Session workflow approval failed',
      summary: (error as Error).message,
      payload: {
        source_message_id: input.sourceMessageId,
        workflow_run_id: input.workflowRunId,
      },
    });
    wsHub.broadcastSession(input.session.id, { type: 'session_evidence:new', sessionId: input.session.id, event });
    broadcastActiveSessionUpsert(input.session.id);
  });
}

async function autoApproveSessionWorkflowWhenReady(input: {
  session: Session;
  sourceMessageId: string;
  approval: SessionApprovalMetadata;
  workflowRunId: string;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= SESSION_WORKFLOW_AUTO_APPROVAL_TIMEOUT_MS) {
    const run = workflowRepo.getRun(input.workflowRunId);
    if (!run) return;
    if (shouldAutoApproveWorkflowRun(run, input.approval)) {
      const approved = await workflowOrchestrator.approvePlan(run.id, 'session-risk-gate');
      mergeSessionApprovalMetadata({
        sessionId: input.session.id,
        sourceMessageId: input.sourceMessageId,
        patch: {
          executionPath: 'workflow_graph',
          workflowRunId: approved.id,
        },
      });
      if (approved.status !== 'awaiting_approval') return;
      await delay(SESSION_WORKFLOW_AUTO_APPROVAL_POLL_MS);
      continue;
    }
    if (
      run.status === 'awaiting_approval' ||
      run.status === 'awaiting_decision' ||
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled'
    ) {
      return;
    }
    await delay(SESSION_WORKFLOW_AUTO_APPROVAL_POLL_MS);
  }
}

function buildApprovedSessionWorkflowRequest(approval: SessionApprovalMetadata): SessionWorkflowRequest {
  return {
    originalContent: approval.originalContent,
    ...(approval.contextContent ? { contextContent: approval.contextContent } : {}),
    riskAssessment: approval.riskAssessment,
    agents: approval.approvalCard.agents,
    executionMode: approval.approvalCard.executionMode,
    scopeRead: approval.approvalCard.scopeRead,
    scopeWrite: approval.approvalCard.scopeWrite,
    verification: approval.approvalCard.verification,
    risks: approval.approvalCard.risks,
    assumptions: approval.approvalCard.assumptions,
    workspaceFileRefs: approval.workspaceFileRefs,
  };
}

function buildSessionApprovalExecutionContent(approval: SessionApprovalMetadata): string {
  if (!approval.contextContent) return approval.originalContent;
  return [approval.originalContent, '', '最近会话上下文：', approval.contextContent].join('\n');
}

function createSessionWorkflowBridgeTask(input: {
  project: Project;
  session: Session;
  sourceMessageId: string;
  request: SessionWorkflowRequest;
  trigger: 'approved';
  approvalDecisionMessageId?: string;
}) {
  const room = roomRepo.create({
    project_id: input.project.id,
    name: buildSessionWorkflowRoomName(input.session),
    description: `SessionOS workflow bridge for session ${input.session.id}`,
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: input.project.id,
    title: buildSessionWorkflowTaskTitle(input.request.originalContent),
    description: buildSessionWorkflowTaskDescription({
      session: input.session,
      request: input.request,
      sourceMessageId: input.sourceMessageId,
    }),
    interaction_mode: 'auto_recommended',
    source_message_id: input.sourceMessageId,
    created_from: 'chat_plan',
  });
  recordTaskCreatedEvent({
    roomId: room.id,
    task,
    origin: 'chat_plan',
    content: `SessionOS 已创建开发任务「${task.title}」。`,
    metadata: {
      session_id: input.session.id,
      source_message_id: input.sourceMessageId,
      execution_trigger: input.trigger,
      approval_decision_message_id: input.approvalDecisionMessageId,
      approval_risk_level: input.request.riskAssessment.riskLevel,
      approval_task_kind: input.request.riskAssessment.taskKind,
    },
  });
  return { room, task };
}

function mergeSessionExecutionMetadata(input: {
  sessionId: string;
  sourceMessageId: string;
  patch: SessionExecutionMetadata;
}): void {
  const message = sessionMessageRepo.get(input.sourceMessageId);
  if (!message) return;
  const metadata = parseSessionMessageMetadata(message.metadata);
  const existing = isRecord(metadata.session_execution) ? metadata.session_execution : {};
  const updated = sessionMessageRepo.updateMetadata(message.id, {
    ...metadata,
    risk_assessment: input.patch.riskAssessment,
    session_execution: {
      ...existing,
      ...input.patch,
    },
  });
  if (updated) {
    wsHub.broadcastSession(input.sessionId, {
      type: 'session_message:new',
      sessionId: input.sessionId,
      message: updated,
    });
  }
}

function mergeSessionApprovalMetadata(input: {
  sessionId: string;
  sourceMessageId: string;
  patch: Partial<SessionApprovalMetadata>;
}): void {
  const message = sessionMessageRepo.get(input.sourceMessageId);
  if (!message) return;
  const approval = parseSessionApprovalMetadata(message);
  if (!approval) return;
  const metadata = parseSessionMessageMetadata(message.metadata);
  const nextApproval: SessionApprovalMetadata = {
    ...approval,
    ...input.patch,
  };
  const updated = sessionMessageRepo.updateMetadata(message.id, {
    ...metadata,
    risk_assessment: nextApproval.riskAssessment,
    approval_card: nextApproval.approvalCard,
    session_approval: nextApproval,
  });
  if (updated) {
    wsHub.broadcastSession(input.sessionId, {
      type: 'session_message:new',
      sessionId: input.sessionId,
      message: updated,
    });
  }
}

function shouldStartWorkflowForApproval(approval: SessionApprovalMetadata): boolean {
  if (approval.status !== 'approved') return false;
  return [
    'fullstack_change',
    'frontend_change',
    'backend_change',
    'bug_fix',
    'test_only',
    'ops_or_config',
  ].includes(approval.riskAssessment.taskKind);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldAutoApproveWorkflowRun(run: WorkflowRun, approval: SessionApprovalMetadata): boolean {
  if (run.status !== 'awaiting_approval') return false;
  const workflowRiskLevel = getWorkflowRunHighestRiskLevel(run);
  if (!workflowRiskLevel) return approval.riskAssessment.riskLevel !== 'high';
  if (workflowRiskLevel === 'high') return false;
  return compareRiskLevel(workflowRiskLevel, approval.riskAssessment.riskLevel) <= 0;
}

function getWorkflowRunHighestRiskLevel(run: WorkflowRun): TaskRiskAssessment['riskLevel'] | null {
  const levels: TaskRiskAssessment['riskLevel'][] = [];
  collectRiskLevelsFromUnknown(parseUnknownJson(run.graph_state), levels);
  const detail = workflowOrchestrator.detail(run.id);
  for (const artifact of detail?.artifacts ?? []) {
    collectRiskLevelsFromUnknown(parseUnknownJson(artifact.metadata), levels);
  }
  if (levels.length === 0) return null;
  return levels.sort((left, right) => compareRiskLevel(right, left))[0] ?? null;
}

function collectRiskLevelsFromUnknown(value: unknown, levels: TaskRiskAssessment['riskLevel'][]): void {
  if (!isRecord(value)) return;
  if (isTaskRiskLevel(value.riskLevel)) levels.push(value.riskLevel);
  collectRiskLevelsFromUnknown(value.riskAssessment, levels);
  collectRiskLevelsFromUnknown(value.risk_assessment, levels);
  collectRiskLevelsFromUnknown(value.approvalCard, levels);
  collectRiskLevelsFromUnknown(value.approval_card, levels);
  collectRiskLevelsFromUnknown(value.plan, levels);
}

function parseUnknownJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isTaskRiskLevel(value: unknown): value is TaskRiskAssessment['riskLevel'] {
  return value === 'low' || value === 'medium' || value === 'high';
}

function compareRiskLevel(left: TaskRiskAssessment['riskLevel'], right: TaskRiskAssessment['riskLevel']): number {
  const order: Record<TaskRiskAssessment['riskLevel'], number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  return order[left] - order[right];
}

function buildSessionWorkflowRoomName(session: Session): string {
  const title = session.title?.trim() || DEFAULT_SESSION_TITLE;
  return truncateText(`Session Workflow: ${title}`, 80);
}

function buildSessionWorkflowTaskTitle(content: string): string {
  return truncateText(content.trim() || 'Session development task', 180);
}

function buildSessionWorkflowTaskDescription(input: {
  session: Session;
  request: SessionWorkflowRequest;
  sourceMessageId: string;
}): string {
  const scopeRead = input.request.scopeRead.length > 0
    ? input.request.scopeRead.join(', ')
    : '无';
  const scopeWrite = input.request.scopeWrite.length > 0
    ? input.request.scopeWrite.join(', ')
    : '由 planner 分析后确定';
  const handoffTasks = buildSessionWorkflowHandoffTasks(input.request);
  const verification = buildSessionWorkflowVerification(input.request);
  const assumptions = input.request.assumptions.length > 0
    ? input.request.assumptions.join('；')
    : '保持风险确认范围内的最小充分改动。';
  const risks = input.request.risks.length > 0
    ? input.request.risks.join('；')
    : input.request.riskAssessment.reasons.join('；');
  return [
    input.request.originalContent,
    '',
    '产品经理方案背景：',
    `用户原始需求：${input.request.originalContent}`,
    input.request.contextContent ? `最近会话上下文：${input.request.contextContent}` : null,
    `来源会话：${input.session.id}`,
    `来源消息：${input.sourceMessageId}`,
    `风险等级：${input.request.riskAssessment.riskLevel}`,
    `工作分类：${input.request.riskAssessment.taskKind}`,
    input.request.riskAssessment.approvalReason
      ? `审批原因：${input.request.riskAssessment.approvalReason}`
      : '审批原因：低风险自动执行，无需用户确认',
    `执行方式：${input.request.executionMode}`,
    `读取范围：${scopeRead}`,
    `写入范围：${scopeWrite}`,
    '',
    ...handoffTasks.flatMap((task, index) => [
      `任务 ${index + 1}：${task.title}`,
      task.description,
      ...(task.scopeRead.length > 0 ? [`读范围：${task.scopeRead.join(', ')}`] : []),
      ...(task.scopeWrite.length > 0 ? [`写范围：${task.scopeWrite.join(', ')}`] : []),
      `验收：${task.acceptance}`,
      ...(task.dependsOn.length > 0 ? [`依赖：${task.dependsOn.join(', ')}`] : []),
      '',
    ]),
    `验证方式：${verification}`,
    `假设：${assumptions}`,
    risks ? `风险：${risks}` : null,
    '',
    '任务意图：implementation',
    '',
    'SessionOS 已完成执行门禁：先规划，再按实施、审查和验收阶段分派子智能体。',
    '',
  ].filter((line): line is string => line !== null).join('\n');
}

interface SessionWorkflowHandoffTask {
  title: string;
  description: string;
  scopeRead: string[];
  scopeWrite: string[];
  acceptance: string;
  dependsOn: string[];
}

function buildSessionWorkflowHandoffTasks(request: SessionWorkflowRequest): SessionWorkflowHandoffTask[] {
  const taskKind = request.riskAssessment.taskKind;
  const agents = new Set(request.agents);
  const allReadScopes = dedupeStringList([
    ...request.scopeRead,
    ...request.riskAssessment.scopeRead,
    ...request.workspaceFileRefs,
  ]);
  const allWriteScopes = dedupeStringList([
    ...request.scopeWrite,
    ...request.riskAssessment.scopeWrite,
    ...request.workspaceFileRefs,
  ]);
  const tasks: SessionWorkflowHandoffTask[] = [];
  const includeBackend = taskKind === 'fullstack_change' ||
    taskKind === 'backend_change' ||
    taskKind === 'bug_fix' ||
    agents.has('backend-executor');
  const includeFrontend = taskKind === 'fullstack_change' ||
    taskKind === 'frontend_change' ||
    agents.has('frontend-executor');

  if (includeBackend) {
    tasks.push({
      title: '实现后端能力和接口支撑',
      description: '按用户需求补充后端读取、处理或 API 能力，并保持接口边界清晰。',
      scopeRead: domainScopes(allReadScopes, 'backend'),
      scopeWrite: domainScopes(allWriteScopes, 'backend'),
      acceptance: '后端能力满足用户原始需求，并通过验证流程。',
      dependsOn: [],
    });
  }
  if (includeFrontend) {
    tasks.push({
      title: '实现前端界面和状态刷新',
      description: '按用户需求更新会话页面交互与展示，并接入必要的数据刷新流程。',
      scopeRead: domainScopes(allReadScopes, 'frontend'),
      scopeWrite: domainScopes(allWriteScopes, 'frontend'),
      acceptance: '前端界面能展示目标状态，关键交互和刷新路径可用。',
      dependsOn: [],
    });
  }
  if (tasks.length === 0 && taskKind === 'test_only') {
    tasks.push({
      title: '补充测试覆盖',
      description: '围绕用户需求补充定向测试，并确保测试能验证目标行为。',
      scopeRead: allReadScopes,
      scopeWrite: allWriteScopes,
      acceptance: '新增或调整的测试覆盖关键路径，并能稳定运行。',
      dependsOn: [],
    });
  }
  if (tasks.length === 0) {
    tasks.push({
      title: '实现已确认的开发改动',
      description: '在风险确认范围内完成用户原始需求，避免扩大改动面。',
      scopeRead: allReadScopes,
      scopeWrite: allWriteScopes,
      acceptance: '实现结果满足用户原始需求和风险确认范围。',
      dependsOn: [],
    });
  }
  return tasks;
}

function domainScopes(
  scopes: string[],
  domain: 'backend' | 'frontend',
  fallback: string[] = [],
): string[] {
  const matched = scopes.filter((scope) => {
    const normalized = scope.toLowerCase();
    if (domain === 'backend') {
      return normalized.includes('backend') || normalized.includes('server') || normalized.includes('api');
    }
    return normalized.includes('frontend') || normalized.includes('client') || normalized.includes('ui') ||
      /\.(?:tsx|jsx|css|scss)$/i.test(scope);
  });
  return matched.length > 0 ? dedupeStringList(matched) : fallback;
}

function buildSessionWorkflowVerification(request: SessionWorkflowRequest): string {
  const commands = request.verification.map((item) => item.command).filter(Boolean);
  return commands.length > 0 ? commands.join('；') : 'npm run build';
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function findLatestPendingSessionApproval(sessionId: string): PendingSessionApproval | null {
  const messages = sessionMessageRepo.listBySession(sessionId, { limit: 100 });
  for (const message of [...messages].reverse()) {
    const metadata = parseSessionApprovalMetadata(message);
    if (metadata?.status === 'pending' && metadata.sourceMessageId === message.id) return { message, metadata };
  }
  return null;
}

function parseSessionApprovalMetadata(message: SessionMessage): SessionApprovalMetadata | null {
  const metadata = parseSessionMessageMetadata(message.metadata);
  const approval = metadata.session_approval;
  if (!isRecord(approval)) return null;
  if (approval.status !== 'pending' && approval.status !== 'approved' && approval.status !== 'rejected') return null;
  if (typeof approval.originalContent !== 'string') return null;
  if (!isRecord(approval.riskAssessment) || !isRecord(approval.approvalCard)) return null;
  return {
    status: approval.status,
    sourceMessageId: typeof approval.sourceMessageId === 'string' ? approval.sourceMessageId : message.id,
    originalContent: approval.originalContent,
    contextContent: typeof approval.contextContent === 'string' && approval.contextContent.trim()
      ? approval.contextContent
      : undefined,
    riskAssessment: approval.riskAssessment as unknown as TaskRiskAssessment,
    approvalCard: approval.approvalCard as unknown as ApprovalCard,
    workspaceFileRefs: Array.isArray(approval.workspaceFileRefs) ? approval.workspaceFileRefs.filter(isString) : [],
    libraryFileRefs: Array.isArray(approval.libraryFileRefs) ? approval.libraryFileRefs.filter(isString) : [],
    platformSkillRefs: Array.isArray(approval.platformSkillRefs)
      ? approval.platformSkillRefs.filter(isResolvedPlatformSkillRef)
      : [],
    createdAt: typeof approval.createdAt === 'number' ? approval.createdAt : message.created_at,
    decidedAt: typeof approval.decidedAt === 'number' ? approval.decidedAt : undefined,
    decidedByMessageId: typeof approval.decidedByMessageId === 'string' ? approval.decidedByMessageId : undefined,
    executionPath: approval.executionPath === 'workflow_graph' || approval.executionPath === 'session_planner'
      ? approval.executionPath
      : undefined,
    workflowRoomId: typeof approval.workflowRoomId === 'string' ? approval.workflowRoomId : undefined,
    workflowTaskId: typeof approval.workflowTaskId === 'string' ? approval.workflowTaskId : undefined,
    workflowRunId: typeof approval.workflowRunId === 'string' ? approval.workflowRunId : undefined,
  };
}

function getSessionApprovalDecision(content: string): 'approved' | 'rejected' | null {
  const normalized = normalizeSessionApprovalDecisionText(content);
  if (!normalized) return null;
  if (/^(确认|同意|批准|yes|y|approve|approved|ok|okay)$/i.test(normalized)) {
    return 'approved';
  }
  if (/^(取消|拒绝|不要执行|停止|终止|否|不|no|n|reject|rejected|cancel|cancelled)$/i.test(normalized)) {
    return 'rejected';
  }
  return null;
}

function normalizeSessionApprovalDecisionText(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/^[`"'“”‘’\s]+|[`"'“”‘’。，、；;：:！？!,?\s]+$/g, '');
}

function shouldApplySessionRiskGate(content: string, platformSkillRefs: ResolvedPlatformSkillRef[]): boolean {
  if (platformSkillRefs.length > 0) return true;
  if (isAnalysisOnlySessionRequest(content)) return false;
  const normalized = content.toLowerCase();
  return SESSION_DEVELOPMENT_SIGNALS.some((signal) => normalized.includes(signal.toLowerCase()));
}

function shouldEnhanceRiskWithSessionContext(input: {
  content: string;
  assessment: TaskRiskAssessment;
}): boolean {
  return input.assessment.riskLevel === 'low' &&
    isContextualFixRequest(input.content) &&
    (input.assessment.taskKind === 'unknown' || input.assessment.taskKind === 'bug_fix');
}

function buildRecentSessionTaskContext(sessionId: string, sourceMessageId: string): string | null {
  const messages = sessionMessageRepo.listBySession(sessionId, { limit: 12 });
  const contextLines: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.id === sourceMessageId) continue;
    if (message.role !== 'user') continue;
    const content = message.content.trim();
    if (!content || isContextualFixRequest(content)) continue;
    contextLines.push(content);
    if (contextLines.length >= 3) break;
  }
  const context = contextLines.reverse().join('\n');
  return context ? truncateText(context, 1000) : null;
}

function isAnalysisOnlySessionRequest(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!containsAny(normalized, SESSION_ANALYSIS_SIGNALS)) return false;
  const actionText = stripAnalysisFramedImplementationPhrases(normalized);
  return !containsAny(actionText, SESSION_IMPLEMENTATION_ACTION_SIGNALS);
}

function isContextualFixRequest(content: string): boolean {
  const normalized = normalizeSessionApprovalDecisionText(content);
  if (!normalized) return false;
  return /^(帮我)?修复(一下)?(这个|该|上面|刚才)?(问题|bug|缺陷)?$/.test(normalized) ||
    /^继续(修复|处理|实现|开发)$/.test(normalized) ||
    /^按(上面|刚才|前面).*(修复|处理|实现|开发)$/.test(normalized) ||
    /^(fix|fix it|fix this|fix this issue|continue fixing|continue implementation)$/i.test(normalized);
}

function stripAnalysisFramedImplementationPhrases(content: string): string {
  return content
    .replace(/(?:怎么|如何|怎样)[^。！？!?，,；;\n]*(?:实现|开发|修改|更新|接入|刷新|工作)/g, '')
    .replace(/how\s+(?:is|are|does|do|to)[^.!?;\n]*(?:implement|implemented|work|works|built|build)/g, '');
}

function containsAny(text: string, signals: string[]): boolean {
  return signals.some((signal) => text.includes(signal.toLowerCase()));
}

function extractPathLikeScopes(content: string): string[] {
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const rawToken of content.split(/\s+/)) {
    const token = rawToken
      .trim()
      .replace(/^[`"'([{（【]+|[`"')\]}。，、；;：:！？!,?]+$/g, '');
    if (!isPathLikeScope(token) || seen.has(token)) continue;
    scopes.push(token);
    seen.add(token);
  }
  return scopes;
}

function parseSessionMessageMetadata(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function dedupeStringList(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    result.push(value);
    seen.add(value);
  }
  return result;
}

function isPathLikeScope(value: string): boolean {
  if (!value || value.length > 180) return false;
  if (/^https?:\/\//i.test(value)) return false;
  return value.includes('/') ||
    /\.(?:[cm]?[jt]sx?|json|mdx?|css|scss|html|vue|sql|ya?ml|sh|env|lock|txt)$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isResolvedPlatformSkillRef(value: unknown): value is ResolvedPlatformSkillRef {
  return isRecord(value) &&
    (value.provider === 'codex' || value.provider === 'claudecode' || value.provider === 'opencode') &&
    typeof value.name === 'string' &&
    (typeof value.description === 'string' || value.description === null);
}

function buildUserMessageMetadata(input: {
  agentId: string;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
  platformSkillRefs: ResolvedPlatformSkillRef[];
  workflowArtifactChangeRequest?: WorkflowArtifactChangeRequestPayload;
}): Record<string, unknown> {
  const attachments = buildLibraryAttachmentMetadata(input.libraryFileRefs);
  return {
    target_agent_id: input.agentId,
    ...(input.workspaceFileRefs.length > 0 ? { workspace_file_refs: input.workspaceFileRefs } : {}),
    ...(input.libraryFileRefs.length > 0 ? { library_file_refs: input.libraryFileRefs } : {}),
    ...(input.platformSkillRefs.length > 0
      ? {
          platform_skill_refs: input.platformSkillRefs.map(({ provider, name }) => ({ provider, name })),
        }
      : {}),
    ...(input.workflowArtifactChangeRequest
      ? { workflow_artifact_change_request: input.workflowArtifactChangeRequest }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function buildImageGenerationJobMessageMetadata(
  job: ImageGenerationJob,
  outputs: ImageGenerationOutput[],
): Record<string, unknown> {
  const attachments = outputs.map((output) => ({
    id: output.file_id,
    fileId: output.file_id,
    name: output.name,
    mimeType: output.mime_type,
    size: output.size,
    url: output.url,
    isImage: output.mime_type.startsWith('image/'),
  }));
  return {
    image_generation_job_id: job.id,
    image_generation_status: job.status,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function truncateImageGenerationPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= 80) return normalized;
  return `${chars.slice(0, 80).join('').trimEnd()}...`;
}

function imageToolEvidenceSeverity(result: GenerateImageToolOutput): 'info' | 'warning' | 'error' {
  if (result.status === 'failed') return 'error';
  if (result.status === 'canceled') return 'warning';
  return 'info';
}

function imageToolEvidenceSummary(result: GenerateImageToolOutput): string {
  if (result.outputs.length > 0) return `已生成 ${result.outputs.length} 张图片。`;
  if (result.error) return result.error;
  if (result.status === 'canceled') return '图片生成任务已取消。';
  return '图片生成未返回图片。';
}

function buildLibraryAttachmentMetadata(libraryFileRefs: string[]): MessageAttachmentMetadata[] {
  return libraryFileRefs
    .map((ref) => fileRepo.get(ref))
    .filter((file): file is ProjectFile => file?.source_type === 'uploaded_file')
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
}

function hasUserMessagePayload(
  content: string,
  workspaceFileRefs: string[],
  libraryFileRefs: string[],
  platformSkillRefs: ResolvedPlatformSkillRef[],
): boolean {
  return content.trim().length > 0 ||
    workspaceFileRefs.length > 0 ||
    libraryFileRefs.length > 0 ||
    platformSkillRefs.length > 0;
}

async function normalizeWorkspaceFileRefs(workspacePath: string, refs: string[] | undefined): Promise<string[]> {
  const normalizedRefs = dedupeRefs(refs);
  const validRefs: string[] = [];
  const seenPaths = new Set<string>();
  for (const ref of normalizedRefs) {
    let safePath: string;
    try {
      safePath = normalizeWorkspacePath(ref);
    } catch {
      throw new Error('workspace file reference is not available');
    }
    if (!safePath || isIgnoredWorkspacePath(safePath)) {
      throw new Error('workspace file reference is not available');
    }
    try {
      const resolved = await resolveWorkspacePath(workspacePath, safePath);
      const stats = await lstat(resolved.absolutePath);
      if (!stats.isFile()) {
        throw new Error('workspace file reference is not a file');
      }
      if (!seenPaths.has(resolved.relativePath)) {
        seenPaths.add(resolved.relativePath);
        validRefs.push(resolved.relativePath);
      }
    } catch {
      throw new Error('workspace file reference is not available');
    }
  }
  return validRefs;
}

function normalizeLibraryFileRefs(projectId: string, refs: string[] | undefined): string[] {
  return dedupeRefs(refs).map((ref) => {
    const file = fileRepo.get(ref);
    if (!file || file.project_id !== projectId || file.deleted_at !== null) {
      throw new Error('library file reference is not available');
    }
    return file.id;
  });
}

async function normalizePlatformSkillRefs(
  refs: PlatformSkillRef[] | undefined,
  plannerBackend: PlatformSkillRef['provider'],
): Promise<ResolvedPlatformSkillRef[]> {
  const normalized: ResolvedPlatformSkillRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    const provider = ref.provider;
    const name = ref.name.trim();
    if (!name) continue;
    if (provider !== plannerBackend) {
      throw new Error('platform skill provider must match planner backend');
    }
    const key = `${provider}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    const skill = await getAvailablePlatformSkill(provider, name);
    normalized.push({
      provider,
      name: skill.name,
      description: skill.description,
    });
    seen.add(key);
    if (normalized.length >= MAX_PLATFORM_SKILL_REFS) break;
  }
  return normalized;
}

async function getAvailablePlatformSkill(
  provider: PlatformSkillRef['provider'],
  name: string,
): Promise<PlatformSkill> {
  const skill = await getPlatformSkill(provider, name).catch(() => null);
  if (!skill || !skill.valid) {
    throw new Error('platform skill is not available');
  }
  return skill;
}

function dedupeRefs(refs: string[] | undefined): string[] {
  const uniqueRefs: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    uniqueRefs.push(trimmed);
    if (uniqueRefs.length >= MAX_SESSION_FILE_REFS) break;
  }
  return uniqueRefs;
}

function shouldRenameFromFirstUserMessage(session: Session): boolean {
  if (session.title.trim() !== DEFAULT_SESSION_TITLE) return false;
  return sessionMessageRepo.listBySession(session.id, { limit: 1 }).length === 0;
}

export function buildSessionTitleFromMessage(content: string): string {
  const normalized = normalizeSessionTitleContent(content, { keepCodeBlocks: false }) ||
    normalizeSessionTitleContent(content, { keepCodeBlocks: true });
  const fallback = normalized || DEFAULT_SESSION_TITLE;
  return truncateTitle(fallback, AUTO_SESSION_TITLE_LIMIT);
}

function normalizeSessionTitleContent(content: string, options: { keepCodeBlocks: boolean }): string {
  return content
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, options.keepCodeBlocks ? '$1' : ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}(?:[#>*-]+\s*|\d+[.)]\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,，。.!！?？:：;；\s]+|[,，。.!！?？:：;；\s]+$/g, '');
}

function truncateTitle(title: string, limit: number): string {
  const chars = Array.from(title);
  if (chars.length <= limit) return title;
  return `${chars.slice(0, limit).join('').trimEnd()}...`;
}

export function buildRuntimePrompt(
  session: Session,
  content: string,
  referencedFilesBlock = '',
  platformSkillsBlock = '',
  globalSessionPrompt: string | null = null,
): string {
  const manifest = createContextManifest(session);
  const sourceBlocks = manifest.sources
    .filter((source) => source.included === 1 && source.excerpt?.trim())
    .map((source) => [
      `### ${source.title} (${source.source_type})`,
      `Reason: ${source.reason ?? 'session context'}`,
      source.excerpt!.trim(),
    ].join('\n'));
  const goal = session.current_goal?.trim();
  return [
    buildGlobalSessionInstructionBlock(globalSessionPrompt) || null,
    '本轮 prompt 来源由 SessionOS Context Inspector 记录。',
    goal ? `当前目标：${goal}` : null,
    sourceBlocks.length > 0 ? ['## Context Sources', ...sourceBlocks].join('\n\n') : null,
    referencedFilesBlock.trim() || null,
    platformSkillsBlock.trim() || null,
    buildKnowledgeAgentToolPrompt({ projectId: session.project_id }),
    '## User Request',
    content,
  ].filter(Boolean).join('\n\n');
}

export function buildGlobalSessionInstructionBlock(prompt: string | null | undefined): string {
  const trimmed = prompt?.trim();
  return trimmed ? `## Global Session Instruction\n${trimmed}` : '';
}

function buildPlatformSkillsPrompt(skills: ResolvedPlatformSkillRef[]): string {
  if (skills.length === 0) return '';
  return [
    '## Explicit Platform Skills',
    '用户通过 `$` 显式选择了 planner 当前 ACP backend 的 provider-native skills。请在本轮调用中按 provider 原生语义使用这些 skills。',
    ...skills.map((skill) => [
      `- $${skill.name}`,
      `  provider: ${skill.provider}`,
      skill.description ? `  description: ${skill.description}` : null,
    ].filter(Boolean).join('\n')),
  ].join('\n');
}

const SESSION_DEVELOPMENT_SIGNALS = [
  'implement',
  'develop',
  'modify',
  'change',
  'edit',
  'editing',
  'edited',
  'fix',
  'add',
  'update',
  'refactor',
  'migration',
  'database',
  'frontend',
  'backend',
  'api',
  'route',
  'component',
  '实现',
  '开发',
  '修改',
  '编辑',
  '修复',
  '新增',
  '添加',
  '调整',
  '去掉',
  '移除',
  '隐藏',
  '接入',
  '重构',
  '迁移',
  '升级',
  '删除',
  '前端',
  '后端',
  '接口',
  '数据库',
  '路由',
  '组件',
  '页面',
  '状态栏',
  '代码',
  'git',
];

const SESSION_ANALYSIS_SIGNALS = [
  'analyze',
  'analysis',
  'explain',
  'why',
  'investigate',
  'diagnose',
  '分析',
  '解释',
  '说明',
  '为什么',
  '为何',
  '排查',
  '诊断',
  '看一下',
];

const SESSION_IMPLEMENTATION_ACTION_SIGNALS = [
  'implement',
  'develop',
  'modify',
  'change',
  'edit',
  'fix',
  'add',
  'update',
  'refactor',
  'migration',
  'delete',
  'remove',
  '实现',
  '开发',
  '修改',
  '编辑',
  '修复',
  '新增',
  '添加',
  '调整',
  '去掉',
  '移除',
  '隐藏',
  '接入',
  '重构',
  '迁移',
  '升级',
  '删除',
];
