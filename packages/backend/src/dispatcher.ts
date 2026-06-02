import { resolve, sep } from 'node:path';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { nanoid } from 'nanoid';
import { getAdapter } from './acp/index.js';
import { isProtocolEvent, normalizeProtocolEvent } from './acp/protocol-events.js';
import { normalizeKnownProviderEvent, normalizeTimelineEventFromTrace } from './acp/timeline.js';
import type { AcpSessionHandoffMode, AcpStreamChunk, AcpStreamTrace } from './acp/types.js';
import { createAcpIntentStreamFilter, type AcpIntentStreamFilter } from './acp-intent-stream.js';
import { buildAgentRuntimeContextPrompt, resolveAgentRuntimeProfile } from './agent-runtime.js';
import { generateModelChatReply, invokeConfiguredModelText, isModelChatConfigured, type ModelChatInvoker } from './chat-model.js';
import { classifyAgentDocument } from './agent-document-classifier.js';
import { applyIntentToRouteResult } from './message-intent-router.js';
import { appendMemoryContextForPromptSafely } from './memory/context.js';
import { distillFromConversation, type MemoryDistillModelInvoker } from './memory/distill.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { fileRepo } from './repos/files.js';
import { memoryRepo } from './repos/memory.js';
import { messageRepo } from './repos/messages.js';
import { projectRepo } from './repos/projects.js';
import { agentRepo } from './repos/agents.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { settingsRepo } from './repos/settings.js';
import { taskEventRepo } from './repos/task-events.js';
import { taskExecutorRepo } from './repos/task-executors.js';
import { formatSkillPrompt } from './skills/prompt.js';
import { selectSkills } from './skills/selector.js';
import { buildSessionHandoffContext } from './session-handoff.js';
import { applySuperpowersBootstrap } from './superpowers-bootstrap.js';
import { createTaskWithConversation } from './task-conversation.js';
import { runRegistry } from './run-registry.js';
import { messageUploadDir, messageUploadRoute, projectFileUploadRoot, projectFileUploadRoute } from './uploads.js';
import { buildWorkspaceFileRefContext, type WorkspaceFileRefContext } from './workspace-file-refs.js';
import { wsHub } from './ws-hub.js';
import type {
  AgentRun,
  AgentRunStatus,
  AgentTimelineEvent,
  Agent,
  AcpSessionHandoffReason,
  Message,
  MessageAttachmentMetadata,
  MessageTrace,
  MessageReplyMetadata,
  MessageLayer,
  MessageMetadata,
  TaskExecutionDecision,
  RouteResult,
  Room,
  RoomAgent,
  TaskExecutionIntent,
  TaskEventType,
  WorkflowStage,
} from './types.js';

const AGENT_RUN_HEARTBEAT_MS = 30_000;
const ANSWER_STREAM_FLUSH_MS = 420;
const ANSWER_STREAM_FLUSH_CHARS = 120;
const ANSWER_STREAM_SENTENCE_END_PATTERN = /[。！？!?…]\s*$|\n$/;
const MAX_TASK_EXECUTION_AUTO_CONTINUE_DEPTH = 5;

interface TaskExecutionDispatchAddedAgent {
  agent_id: string;
  agent_name: string;
}

interface TaskExecutionDispatchResult {
  dispatched: number;
  added_agents: TaskExecutionDispatchAddedAgent[];
  deferred_steps: TaskExecutionDecision['next_steps'];
}

interface TaskExecutionDispatchedTarget {
  agent: RoomAgent;
  prompt: string;
  step: TaskExecutionDecision['next_steps'][number];
}

interface TargetRunResult {
  message: Message | undefined;
  run: AgentRun | undefined;
  status: AgentRunStatus | 'failed';
  error: string | null;
}

interface InitialRunTarget {
  agent: RoomAgent;
  prompt: string;
  internalMessage?: boolean;
  acpSessionIdOverride?: string | null;
}

interface ReplyDispatchTarget {
  agent: RoomAgent;
  acpSessionId: string | null;
}

interface TaskExecutionPlanDecision {
  mode: 'parallel' | 'serial';
  dispatch_step_indexes: number[];
  deferred_step_indexes: number[];
  rationale: string;
}

export interface TaskExecutionPlanInvoker {
  invoke(input: {
    room: Room;
    targets: TaskExecutionDispatchTarget[];
    sourceMessage: Message | undefined;
  }): Promise<TaskExecutionPlanDecision | null>;
}

interface TaskExecutionDispatchTarget {
  agent: RoomAgent;
  prompt: string;
  step: TaskExecutionDecision['next_steps'][number];
}

let plannerExecutionPlanInvoker: TaskExecutionPlanInvoker | undefined;

export function setTaskExecutionPlanInvokerForTest(invoker?: TaskExecutionPlanInvoker): void {
  plannerExecutionPlanInvoker = invoker;
}

function buildSessionHandoffForAgent(input: {
  roomId: string;
  agent: RoomAgent;
  taskExecutor?: ReturnType<typeof taskExecutorRepo.ensure> | null;
  currentPrompt: string;
}): { text: string; mode: AcpSessionHandoffMode } | null {
  const runs = agentRunRepo.listByRoom(input.roomId, 30);
  const sameAgentRuns = runs.filter((run) =>
    run.room_agent_id === input.agent.id &&
    (input.taskExecutor ? run.task_id === input.taskExecutor.task_id : !run.task_id)
  );
  const previousSessionId = input.taskExecutor
    ? input.taskExecutor.acp_session_id ?? sameAgentRuns.find((run) => run.acp_session_id)?.acp_session_id ?? null
    : input.agent.acp_session_id ?? sameAgentRuns.find((run) => run.acp_session_id)?.acp_session_id ?? null;
  const reason = input.taskExecutor
    ? resolveTaskExecutorSessionHandoffReason(input.taskExecutor, previousSessionId)
    : resolveSessionHandoffReason(input.agent, previousSessionId);
  if (!reason) return null;

  const recentUserMessages = messageRepo
    .listByRoom(input.roomId, 20)
    .filter((message) =>
      message.sender_type === 'user' &&
      (
        input.taskExecutor
          ? getMessageTaskId(message.metadata) === input.taskExecutor.task_id
          : !getMessageTaskId(message.metadata)
      )
    )
    .slice(-3)
    .map((message) => ({
      id: message.id,
      content: message.content,
    }));

  const context = buildSessionHandoffContext({
    agentName: input.agent.agent_name,
    agentId: input.agent.agent_id,
    roomId: input.roomId,
    reason,
    previousSessionId,
    currentUserPrompt: input.currentPrompt,
    sameAgentRuns: sameAgentRuns.slice(0, 5).map((run) => ({
      id: run.id,
      status: run.status,
      prompt: run.prompt,
      stdout: run.stdout,
      stderr: run.stderr,
      activityLog: run.activity_log,
    })),
    otherAgentRuns: runs
      .filter((run) =>
        run.room_agent_id !== input.agent.id &&
        (input.taskExecutor ? run.task_id === input.taskExecutor.task_id : !run.task_id)
      )
      .slice(0, 3)
      .map((run) => ({
        id: run.id,
        agentName: run.agent_id,
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
      })),
    recentUserMessages,
    maxChars: 8_000,
  });
  if (!context) return null;
  const forceHandoff = input.taskExecutor
    ? input.taskExecutor.acp_session_handoff_pending
    : input.agent.acp_session_handoff_pending;
  return {
    text: context,
    mode: forceHandoff ? 'force' : 'new_session',
  };
}

function resolveSessionHandoffReason(
  agent: RoomAgent,
  previousSessionId: string | null,
): AcpSessionHandoffReason | null {
  if (agent.acp_session_handoff_pending) {
    return agent.acp_session_handoff_reason ?? 'automatic_rotation';
  }
  if (!agent.acp_session_id) {
    return previousSessionId ? 'manual_new_session' : 'first_session';
  }
  return 'resume_unavailable';
}

function resolveTaskExecutorSessionHandoffReason(
  executor: ReturnType<typeof taskExecutorRepo.ensure>,
  previousSessionId: string | null,
): AcpSessionHandoffReason | null {
  if (executor.acp_session_handoff_pending) {
    return executor.acp_session_handoff_reason ?? 'automatic_rotation';
  }
  if (!executor.acp_session_id) {
    return previousSessionId ? 'manual_new_session' : 'first_session';
  }
  return 'resume_unavailable';
}

const AGENT_MATCH_SYNONYMS: Record<string, string[]> = {
  runtime: ['computer', 'cli', 'troubleshooting', 'automation', 'devops', 'ci-cd', 'deployment', 'observability'],
  inspector: ['computer', 'cli', 'review', 'quality', 'troubleshooting', 'qa', 'testing', 'acceptance'],
  inspect: ['computer', 'cli', 'review', 'quality', 'troubleshooting', 'qa', 'testing', 'acceptance'],
  context: ['computer', 'cli', 'troubleshooting', 'planning'],
  codex: ['computer', 'cli', 'automation'],
  cli: ['computer', 'cli', 'automation', 'troubleshooting'],
  frontend: ['frontend', 'ui', 'ux', 'browser'],
  backend: ['backend', 'api', 'database', 'testing'],
  ui: ['ui', 'ux', 'design', 'frontend'],
  ux: ['ui', 'ux', 'design', 'frontend'],
  design: ['design', 'ui', 'ux'],
  review: ['review', 'quality', 'security', 'qa'],
  reviewer: ['review', 'quality', 'security', 'qa'],
  test: ['testing', 'qa', 'regression', 'acceptance'],
  qa: ['testing', 'qa', 'regression', 'acceptance'],
  security: ['security', 'privacy', 'risk'],
  deploy: ['devops', 'deployment', 'ci-cd', 'observability'],
  devops: ['devops', 'deployment', 'ci-cd', 'observability'],
  docs: ['documentation', 'writing', 'handoff'],
  document: ['documentation', 'writing', 'handoff'],
};

/**
 * Dispatch an incoming user message to the agents selected by project routing.
 * - Mentioned agents are notified directly.
 * - Messages without mentions either stay silent or go to the configured fallback agent.
 * - ACP-enabled agents call their CLI; non-ACP agents are not executable.
 */
export async function dispatchUserMessage(args: {
  roomId: string;
  userMessage: Message;
  mentionedAgentRoomIds?: string[];
  modelChatInvoker?: ModelChatInvoker;
  distillModelInvoker?: MemoryDistillModelInvoker;
}): Promise<void> {
  const { roomId, userMessage } = args;
  const room = roomRepo.get(roomId);
  if (!room) return;
  const project = projectRepo.get(room.project_id);
  if (!project) return;
  const allAgents = roomAgentRepo.listByRoom(roomId);
  const mentionedIds = new Set(args.mentionedAgentRoomIds ?? []);
  const explicitlyMentionedAgents = allAgents.filter((agent) => mentionedIds.has(agent.id));
  const settings = settingsRepo.resolveForRoom(roomId)?.effective ?? {
    message_routing_mode: project.message_routing_mode,
    fallback_agent_id: project.fallback_agent_id,
  };
  const messageAttachments = getResolvedMessageAttachments(userMessage);
  const fileRefContext = await buildWorkspaceFileRefContext(project.path, getMessageFileRefs(userMessage.metadata));
  const roomChatSummary = getMessageTaskId(userMessage.metadata)
    ? null
    : buildRoomChatSummary(roomId, userMessage.id);
  const promptWithAttachments = buildPromptWithResolvedMessageContext(
    userMessage.content,
    messageAttachments,
    getResolvedMessageReply(userMessage),
    fileRefContext,
    roomChatSummary,
  );
  const replyDispatchTarget = resolveReplyDispatchTarget({
    roomId,
    userMessage,
    allAgents,
  });
  const imagePaths = [
    ...messageAttachments
      .filter((attachment) => attachment.metadata.isImage && attachment.localPath)
      .map((attachment) => attachment.localPath!),
    ...fileRefContext.imagePaths,
  ];
  const routing = resolveInitialTargets({
    allAgents,
    explicitlyMentionedAgents,
    fallbackAgentId: settings.fallback_agent_id,
    mode: settings.message_routing_mode,
    prompt: promptWithAttachments,
    imagePaths,
    replyDispatchTarget,
  });
  if (routing.targets.length === 0 && settings.message_routing_mode === 'fallback_reply') {
    await respondWithConfiguredModel({
      project,
      room,
      userMessage,
      invoker: args.modelChatInvoker,
    });
    return;
  }

  await runTargets({
    targets: routing.targets,
    projectPath: project.path,
    roomId,
    sourceMessageId: userMessage.id,
    taskId: getMessageTaskId(userMessage.metadata),
    imagePaths,
    distillModelInvoker: args.distillModelInvoker,
  });
}

async function respondWithConfiguredModel(args: {
  project: NonNullable<ReturnType<typeof projectRepo.get>>;
  room: NonNullable<ReturnType<typeof roomRepo.get>>;
  userMessage: Message;
  invoker?: ModelChatInvoker;
}): Promise<void> {
  if (!args.invoker && !isModelChatConfigured()) return;

  try {
    const skillContext = await buildModelChatSkillContext({
      projectId: args.project.id,
      roomId: args.room.id,
      message: args.userMessage.content,
    });
    const reply = await generateModelChatReply({
      project: args.project,
      room: args.room,
      userMessage: args.userMessage,
      recentMessages: messageRepo.listByRoom(args.room.id, 20),
    }, args.invoker, { skillContext });
    const message = messageRepo.create({
      room_id: args.room.id,
      sender_type: 'agent',
      sender_id: 'model-chat',
      sender_name: 'Model Chat',
      content: reply,
      message_type: 'text',
      metadata: {
        model_chat: true,
      },
    });
    wsHub.broadcast(args.room.id, { type: 'message:new', roomId: args.room.id, message });
  } catch (err) {
    const message = messageRepo.create({
      room_id: args.room.id,
      sender_type: 'system',
      sender_id: 'system',
      sender_name: 'System',
      content: `Model chat failed: ${(err as Error).message}`,
      message_type: 'system',
    });
    wsHub.broadcast(args.room.id, { type: 'message:new', roomId: args.room.id, message });
  }
}

async function buildModelChatSkillContext(input: {
  projectId: string;
  roomId: string;
  message: string;
}): Promise<string> {
  try {
    const skills = await selectSkills({
      runtimeScopes: ['model_chat'],
      projectId: input.projectId,
      roomId: input.roomId,
      message: input.message,
    });
    return formatSkillPrompt(skills);
  } catch (err) {
    console.warn(`[skills] failed to build model chat skill context: ${(err as Error).message}`);
    return '';
  }
}

export function buildPromptWithMessageAttachments(userPrompt: string, userMessage: Message): string {
  return buildPromptWithResolvedMessageContext(
    userPrompt,
    getResolvedMessageAttachments(userMessage),
    getResolvedMessageReply(userMessage),
  );
}

export interface RespondAsAgentInput {
  agent: RoomAgent;
  projectPath: string;
  roomId: string;
  prompt: string;
  internalMessage?: boolean;
  imagePaths?: string[];
  taskId?: string | null;
  workflowRunId?: string | null;
  workflowStepId?: string | null;
  workflowStage?: WorkflowStage | null;
  sourceMessageId?: string | null;
  acpSessionIdOverride?: string | null;
  collaborationRunId?: string | null;
  collaborationStage?: AgentRun['collaboration_stage'];
  distillModelInvoker?: MemoryDistillModelInvoker;
  onRunCreated?: (run: AgentRun) => Promise<void> | void;
  onFinished?: (result: { run: AgentRun; message: Message; status: AgentRunStatus }) => Promise<void> | void;
}

interface ResolvedMessageAttachment {
  metadata: MessageAttachmentMetadata;
  localPath: string | null;
}

interface ResolvedMessageReply {
  metadata: MessageReplyMetadata;
  body: string | null;
  bodyTruncated: boolean;
}

const maxReplyBodyChars = 6000;

function getResolvedMessageAttachments(userMessage: Message): ResolvedMessageAttachment[] {
  return parseMessageAttachments(userMessage.metadata).map((attachment) => ({
    metadata: attachment,
    localPath: resolveMessageAttachmentLocalPath(attachment),
  }));
}

function buildPromptWithResolvedMessageContext(
  userPrompt: string,
  attachments: ResolvedMessageAttachment[],
  replyTo: ResolvedMessageReply | null,
  fileRefContext?: WorkspaceFileRefContext,
  roomChatSummary?: string | null,
): string {
  const content = userPrompt.trim() || '用户发送了一条仅包含附件的消息。';
  const sections = [content];

  if (roomChatSummary) {
    sections.push(
      '',
      '---',
      '群聊摘要：',
      roomChatSummary,
    );
  }

  if (replyTo) {
    const senderName = replyTo.metadata.sender_name ?? replyTo.metadata.sender_id;
    sections.push(
      '',
      '---',
      '正在回复的消息：',
      `message_id: ${replyTo.metadata.message_id}`,
      `sender: ${senderName} (${replyTo.metadata.sender_type})`,
      `excerpt: ${replyTo.metadata.excerpt}`,
    );
    if (replyTo.body) {
      sections.push(
        replyTo.bodyTruncated ? '正文（已截断，保留开头和结尾）：' : '正文：',
        replyTo.body,
      );
    }
  }

  if (fileRefContext?.promptAddition) {
    sections.push(
      '',
      '---',
      '工作区引用文件：',
      fileRefContext.promptAddition,
    );
  }

  if (attachments.length === 0) return sections.join('\n');

  const attachmentLines = attachments.map(({ metadata: attachment, localPath }, index) => {
    const kind = attachment.isImage ? 'image' : 'file';
    const pathDetail = localPath ? `; localPath=${localPath}` : '; localPath=unavailable';
    const url = localPath ? attachment.url : 'unavailable';
    return [
      `${index + 1}. ${attachment.name}`,
      `mimeType=${attachment.mimeType}`,
      `size=${attachment.size}`,
      `kind=${kind}`,
      `url=${url}${pathDetail}`,
    ].join(' | ');
  });

  sections.push(
    '',
    '---',
    '消息附件：',
    '请结合以下附件回答。图片附件会优先通过 ACP adapter 传入；如果当前 ACP 不支持图片参数，或需要查看文件，请读取对应的 localPath。',
    ...attachmentLines,
  );
  return sections.join('\n');
}

function buildRoomChatSummary(roomId: string, currentMessageId: string): string | null {
  const lines = messageRepo
    .listByRoom(roomId, 20)
    .filter((message) =>
      message.id !== currentMessageId &&
      message.layer === 'chat' &&
      !getMessageTaskId(message.metadata) &&
      (message.sender_type === 'user' || message.sender_type === 'agent')
    )
    .slice(-8)
    .map((message) => `${formatSummarySender(message)}：${summarizeRoomChatContent(message.content)}`)
    .filter((line) => line.trim().length > 0);
  return lines.length > 0 ? lines.join('\n') : null;
}

function formatSummarySender(message: Message): string {
  return message.sender_name || message.sender_id || message.sender_type;
}

function summarizeRoomChatContent(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '空消息';
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217).trimEnd()}...`;
}

function getResolvedMessageReply(userMessage: Message): ResolvedMessageReply | null {
  const metadata = getMessageReplyMetadata(userMessage.metadata);
  if (!metadata) return null;
  const replyTarget = messageRepo.get(metadata.message_id);
  if (!replyTarget || replyTarget.room_id !== userMessage.room_id) {
    return { metadata, body: null, bodyTruncated: false };
  }
  const normalizedBody = normalizeReplyBody(replyTarget.content);
  if (!normalizedBody) return { metadata, body: null, bodyTruncated: false };
  const summarized = summarizeReplyBody(normalizedBody);
  return {
    metadata,
    body: summarized.body,
    bodyTruncated: summarized.truncated,
  };
}

function resolveReplyDispatchTarget(input: {
  roomId: string;
  userMessage: Message;
  allAgents: RoomAgent[];
}): ReplyDispatchTarget | null {
  const metadata = getMessageReplyMetadata(input.userMessage.metadata);
  if (!metadata || metadata.sender_type !== 'agent') return null;
  const replyTarget = messageRepo.get(metadata.message_id);
  if (!replyTarget || replyTarget.room_id !== input.roomId || replyTarget.sender_type !== 'agent') return null;
  const agent = input.allAgents.find((candidate) => candidate.agent_id === replyTarget.sender_id);
  if (!agent) return null;
  return {
    agent,
    acpSessionId: getMessageAcpSessionId(replyTarget.metadata),
  };
}

function getMessageFileRefs(rawMetadata: string | null): string[] {
  if (!rawMetadata) return [];
  try {
    const parsed = JSON.parse(rawMetadata) as MessageMetadata;
    return Array.isArray(parsed.file_refs)
      ? parsed.file_refs.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizeReplyBody(content: string): string {
  return content.replace(/\s+$/g, '').trimStart();
}

function summarizeReplyBody(content: string): { body: string; truncated: boolean } {
  if (content.length <= maxReplyBodyChars) {
    return { body: content, truncated: false };
  }
  const half = Math.floor((maxReplyBodyChars - 32) / 2);
  return {
    body: `${content.slice(0, half).trimEnd()}\n...\n${content.slice(-half).trimStart()}`,
    truncated: true,
  };
}

function getMessageReplyMetadata(metadata: string | null): MessageReplyMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return isMessageReplyMetadata((parsed as { reply_to?: unknown }).reply_to)
      ? (parsed as { reply_to: MessageReplyMetadata }).reply_to
      : null;
  } catch {
    return null;
  }
}

function isMessageReplyMetadata(value: unknown): value is MessageReplyMetadata {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Record<string, unknown>;
  return (
    typeof reply.message_id === 'string' &&
    (reply.sender_type === 'user' || reply.sender_type === 'agent' || reply.sender_type === 'system') &&
    typeof reply.sender_id === 'string' &&
    (typeof reply.sender_name === 'string' || reply.sender_name === null) &&
    typeof reply.excerpt === 'string'
  );
}

function parseMessageAttachments(metadata: string | null): MessageAttachmentMetadata[] {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { attachments?: unknown }).attachments)) {
      return [];
    }
    return (parsed as { attachments: unknown[] }).attachments.filter(isMessageAttachmentMetadata);
  } catch {
    return [];
  }
}

function isMessageAttachmentMetadata(value: unknown): value is MessageAttachmentMetadata {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Record<string, unknown>;
  return (
    typeof attachment.id === 'string' &&
    typeof attachment.name === 'string' &&
    typeof attachment.mimeType === 'string' &&
    typeof attachment.size === 'number' &&
    typeof attachment.url === 'string' &&
    typeof attachment.isImage === 'boolean'
  );
}

function resolveMessageAttachmentLocalPath(attachment: MessageAttachmentMetadata): string | null {
  if (attachment.url.startsWith(`${messageUploadRoute}/`)) {
    const relativePath = attachment.url.slice(messageUploadRoute.length + 1);
    if (!relativePath || relativePath.includes('/') || relativePath.includes('\\')) return null;
    return resolveUploadLocalPath(messageUploadDir, relativePath);
  }

  if (attachment.url.startsWith(`${projectFileUploadRoute}/`)) {
    const relativePath = attachment.url.slice(projectFileUploadRoute.length + 1);
    const parts = relativePath.split('/');
    if (
      parts.length !== 2 ||
      parts.some((part) => !part || part.includes('\\') || part === '.' || part === '..')
    ) {
      return null;
    }
    return resolveUploadLocalPath(projectFileUploadRoot, parts.map(decodeURIComponent).join('/'));
  }

  return null;
}

function resolveUploadLocalPath(rootDir: string, relativePath: string): string | null {
  const uploadRoot = resolve(rootDir);
  const filePath = resolve(uploadRoot, relativePath);
  if (filePath !== uploadRoot && filePath.startsWith(`${uploadRoot}${sep}`)) return filePath;
  return null;
}

async function runTargets(args: {
  targets: InitialRunTarget[];
  projectPath: string;
  roomId: string;
  sourceMessageId?: string | null;
  taskId?: string | null;
  imagePaths?: string[];
  distillModelInvoker?: MemoryDistillModelInvoker;
}): Promise<TargetRunResult[]> {
  return Promise.all(
    args.targets.map(async (target) => {
      let finalMessage: Message | undefined;
      let finalRun: AgentRun | undefined;
      let finalStatus: AgentRunStatus | 'failed' = 'failed';
      await respondAsAgent({
        agent: target.agent,
        projectPath: args.projectPath,
        roomId: args.roomId,
        prompt: target.prompt,
        internalMessage: target.internalMessage,
        imagePaths: args.imagePaths,
        taskId: args.taskId,
        sourceMessageId: args.sourceMessageId,
        acpSessionIdOverride: target.acpSessionIdOverride,
        distillModelInvoker: args.distillModelInvoker,
        onFinished: ({ run, message, status }) => {
          finalRun = run;
          finalMessage = message;
          finalStatus = status;
        },
      }).catch((err) => {
        const errMsg = messageRepo.create({
          room_id: args.roomId,
          sender_type: 'system',
          sender_id: 'system',
          sender_name: 'System',
          content: `Agent ${target.agent.agent_name} failed: ${(err as Error).message}`,
          message_type: 'system',
        });
        wsHub.broadcast(args.roomId, { type: 'message:new', roomId: args.roomId, message: errMsg });
        finalMessage = undefined;
        finalStatus = 'failed';
        finalRun = undefined;
      });
      return {
        message: finalMessage,
        run: finalRun,
        status: finalStatus,
        error: finalRun?.error ?? null,
      };
    }),
  );
}

function resolveInitialTargets(args: {
  allAgents: RoomAgent[];
  explicitlyMentionedAgents: RoomAgent[];
  fallbackAgentId: string | null;
  mode: 'mentions_only' | 'fallback_reply';
  prompt: string;
  imagePaths?: string[];
  replyDispatchTarget?: ReplyDispatchTarget | null;
}): { targets: InitialRunTarget[] } {
  if (args.replyDispatchTarget) {
    return {
      targets: [{
        agent: args.replyDispatchTarget.agent,
        prompt: args.prompt,
        acpSessionIdOverride: args.replyDispatchTarget.acpSessionId,
      }],
    };
  }
  const planner = args.allAgents.find((agent) => agent.agent_id === 'planner');
  if (planner) return { targets: [{ agent: planner, prompt: args.prompt }] };
  if (!args.fallbackAgentId) return { targets: [] };
  const fallbackAgent = args.allAgents.find((agent) => agent.agent_id === args.fallbackAgentId);
  if (!fallbackAgent) return { targets: [] };
  return {
    targets: [{ agent: fallbackAgent, prompt: args.prompt }],
  };
}

export function buildAgentIdentityPrompt(agent: RoomAgent, prompt: string): string {
  const identityLines = [
    `- 名称：${agent.agent_name}`,
    agent.preferred_user_name ? `- 用户称呼：${agent.preferred_user_name}` : null,
    agent.personality ? `- 性格：${agent.personality}` : null,
    agent.responsibilities ? `- 主要工作：${agent.responsibilities}` : null,
    agent.rules ? `- 必须遵守的规则：\n${agent.rules}` : null,
  ].filter((line): line is string => Boolean(line));

  const promptParts = [
    '你的智能体身份：',
    ...identityLines,
    ...buildMessageChoiceOptionsPrompt(),
    ...(agent.agent_id === 'planner' ? buildTaskExecutionDecisionPrompt() : []),
    '',
    '当前用户请求：',
    prompt,
  ];

  return promptParts.join('\n');
}

export async function respondAsAgent(args: RespondAsAgentInput): Promise<void> {
  const { agent, projectPath, roomId } = args;
  const room = roomRepo.get(roomId);
  const sourceMessage = args.sourceMessageId ? messageRepo.get(args.sourceMessageId) : undefined;
  const promptWithCasualContract = buildPlannerCasualChatPrompt(args.prompt, agent, sourceMessage);
  const promptWithIdentity = buildAgentIdentityPrompt(agent, promptWithCasualContract);
  const runtimeProfile = resolveAgentRuntimeProfile({
    agent,
    projectPath,
    imagePaths: args.imagePaths ?? [],
  });
  const promptWithRuntime = [
    promptWithIdentity,
    '',
    buildAgentRuntimeContextPrompt(runtimeProfile),
  ].join('\n');
  const promptWithMemory =
    room && !args.workflowRunId
      ? appendMemoryContextForPromptSafely({
          prompt: promptWithRuntime,
          loadContextEntries: () => memoryRepo.listForRoomContext({
            projectId: room.project_id,
            roomId,
            roomAgentId: agent.id,
            taskId: args.taskId,
          }),
          loadRelevantEntries: () => memoryRepo.listRelevantForPrompt({
            projectId: room.project_id,
            roomId,
            prompt: promptWithRuntime,
          }),
          maxChars: agent.memory_max_context_chars,
          warn: (message) => console.warn(message),
        })
      : promptWithRuntime;
  const effectiveSettings = room ? settingsRepo.resolveForRoom(roomId)?.effective : null;
  const superpowersBootstrap = applySuperpowersBootstrap({
    prompt: promptWithMemory,
    userPrompt: args.prompt,
    owner: effectiveSettings?.superpowers_bootstrap_owner ?? 'provider',
    workflowRunId: args.workflowRunId,
  });
  const intentAnalysisSource = isAcpIntentAnalysisRun({
    sourceMessage,
    taskId: args.taskId,
    workflowRunId: args.workflowRunId,
    collaborationRunId: args.collaborationRunId,
    internalMessage: args.internalMessage,
  });
  const intentStreamFilter = intentAnalysisSource ? createAcpIntentStreamFilter() : null;
  const prompt = intentAnalysisSource
    ? [superpowersBootstrap.prompt, buildAcpIntentControlBlockPrompt()].join('\n')
    : superpowersBootstrap.prompt;
  const superpowersBootstrapEnvOverrides: Record<string, string> = {
    OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER: superpowersBootstrap.source,
    OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER: superpowersBootstrap.source,
  };
  if (
    superpowersBootstrap.source === 'project' ||
    superpowersBootstrap.source === 'disabled' ||
    superpowersBootstrap.skipReason === 'workflow_run'
  ) {
    superpowersBootstrapEnvOverrides.SUPERPOWERS_BOOTSTRAP_DISABLED = '1';
  }
  const backend = agent.acp_enabled && agent.acp_backend ? agent.acp_backend : null;
  if (!backend) {
    throw new Error(`Agent ${agent.agent_name} has no ACP backend configured`);
  }
  const taskExecutor = args.taskId
    ? taskExecutorRepo.ensure({
        task_id: args.taskId,
        room_id: roomId,
        room_agent_id: agent.id,
        agent_id: agent.agent_id,
      })
    : null;
  const acpSessionId = taskExecutor?.acp_session_id ?? args.acpSessionIdOverride ?? agent.acp_session_id;
  const sessionHandoff = args.acpSessionIdOverride
    ? null
    : buildSessionHandoffForAgent({
        roomId,
        agent,
        taskExecutor,
        currentPrompt: args.prompt,
      });
  const run = agentRunRepo.create({
    room_id: roomId,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend,
    session_key: null,
    acp_session_id: acpSessionId,
    task_id: args.taskId,
    workflow_run_id: args.workflowRunId,
    workflow_step_id: args.workflowStepId,
    workflow_stage: args.workflowStage,
    collaboration_run_id: args.collaborationRunId,
    collaboration_stage: args.collaborationStage,
    superpowers_bootstrap_owner: superpowersBootstrap.source,
    superpowers_bootstrap_injected: superpowersBootstrap.injected,
    superpowers_bootstrap_skill: superpowersBootstrap.skill,
    superpowers_bootstrap_skip_reason: superpowersBootstrap.skipReason,
    prompt,
  });
  const controller = runRegistry.create(run.id);
  if (taskExecutor) {
    taskExecutorRepo.updateStatus(taskExecutor.id, 'running');
  }
  broadcastRun('agent_run:created', run);
  if (args.onRunCreated) {
    try {
      await args.onRunCreated(run);
    } catch (err) {
      console.warn(`[agent-runs] onRunCreated callback failed for ${run.id}: ${(err as Error).message}`);
    }
  }
  const suppressLiveAnswerStream = isPlannerCasualRun({
    agent,
    run,
    sourceMessageId: args.sourceMessageId,
  });

  // Create a placeholder agent message that will be filled by streaming chunks.
  const placeholder = messageRepo.create({
    room_id: roomId,
    sender_type: 'agent',
    sender_id: agent.agent_id,
    sender_name: agent.agent_name,
    content: '',
    message_type: 'agent_stream',
    metadata: {
      acp_enabled: !!agent.acp_enabled,
      acp_backend: agent.acp_backend,
      acp_session_id: acpSessionId,
      task_id: args.taskId ?? undefined,
      internal: args.internalMessage ? true : undefined,
    },
  });
  if (!args.internalMessage) {
    wsHub.broadcast(roomId, { type: 'message:new', roomId, message: placeholder });
  }
  let streamSeq = 0;
  let traceEventSeq = 0;
  let answerBuffer = '';
  let answerFlushTimer: ReturnType<typeof setTimeout> | undefined;

  const broadcastAnswerChunk = (rawChunk: string): void => {
    const chunk = intentStreamFilter ? intentStreamFilter.push(rawChunk) : rawChunk;
    if (!chunk) return;
    restoreRunStatusAfterRetry();
    messageRepo.appendChunk(placeholder.id, chunk);
    agentRunRepo.appendStdout(run.id, chunk);
    if (suppressLiveAnswerStream) return;
    if (!args.internalMessage) {
      wsHub.broadcast(roomId, {
        type: 'message:stream',
        roomId,
        messageId: placeholder.id,
        runId: run.id,
        channel: 'answer',
        chunk,
        done: false,
        seq: ++streamSeq,
        status: 'streaming',
      });
    }
  };

  const flushAnswerBuffer = (): void => {
    if (answerFlushTimer) {
      clearTimeout(answerFlushTimer);
      answerFlushTimer = undefined;
    }
    if (!answerBuffer) return;
    const chunk = answerBuffer;
    answerBuffer = '';
    broadcastAnswerChunk(chunk);
  };

  const onStdout = (chunk: string): void => {
    if (!chunk) return;
    answerBuffer += chunk;
    if (
      answerBuffer.length >= ANSWER_STREAM_FLUSH_CHARS ||
      ANSWER_STREAM_SENTENCE_END_PATTERN.test(answerBuffer)
    ) {
      flushAnswerBuffer();
      return;
    }
    if (!answerFlushTimer) {
      answerFlushTimer = setTimeout(flushAnswerBuffer, ANSWER_STREAM_FLUSH_MS);
    }
  };

  const onStderr = (chunk: string): void => {
    const updated = agentRunRepo.appendStderr(run.id, chunk);
    if (updated) broadcastRun('agent_run:updated', updated);
  };

  const onRetry = (chunk: string): void => {
    agentRunRepo.updateStatus(run.id, 'retrying');
    const text = formatActivityChunk(chunk);
    const updated = text ? agentRunRepo.appendActivity(run.id, text) : agentRunRepo.get(run.id);
    if (updated) broadcastRun('agent_run:updated', updated);
  };

  const onActivity = (chunk: string): void => {
    const text = formatActivityChunk(chunk);
    if (!text) return;
    const updated = agentRunRepo.appendActivity(run.id, text);
    if (updated) broadcastRun('agent_run:updated', updated);
  };

  const onTrace = (channel: 'thinking' | 'tool' | 'command', chunk: string, trace?: AcpStreamTrace): void => {
    restoreRunStatusAfterRetry();
    const text = chunk.trim();
    if (!text) return;
    const timelineEvent = normalizeTimelineEventFromTrace({
      messageId: placeholder.id,
      runId: run.id,
      agentId: agent.agent_id,
      seq: ++traceEventSeq,
      channel,
      text,
      trace,
    });
    const updatedMessage = messageRepo.mergeTrace(placeholder.id, toTracePatch(channel, text, trace, timelineEvent));
    projectTimelineEventToTaskEvent({ roomId, taskId: args.taskId, event: timelineEvent });
    if (!args.internalMessage) {
      wsHub.broadcast(roomId, {
        type: 'message:stream',
        roomId,
        messageId: placeholder.id,
        runId: run.id,
        channel,
        chunk: text,
        done: false,
        seq: ++streamSeq,
        status: 'streaming',
        message: updatedMessage,
      });
      broadcastTimelineEvent(timelineEvent, { stream: 'stdout', channel, text }, updatedMessage);
    }
  };

  const persistTimelineEvent = (event: AgentTimelineEvent, chunk: AcpStreamChunk): void => {
    restoreRunStatusAfterRetry();
    const updatedMessage = messageRepo.mergeTrace(placeholder.id, { events: [event] });
    projectTimelineEventToTaskEvent({ roomId, taskId: args.taskId, event });
    broadcastTimelineEvent(event, chunk, updatedMessage);
  };

  const broadcastTimelineEvent = (
    event: AgentTimelineEvent,
    chunk: AcpStreamChunk,
    updatedMessage: Message | undefined,
  ): void => {
    if (args.internalMessage) return;
    wsHub.broadcast(roomId, {
      type: 'message:stream',
      roomId,
      messageId: placeholder.id,
      runId: run.id,
      channel: 'event',
      chunk: chunk.text || event.title,
      done: false,
      seq: ++streamSeq,
      status: 'streaming',
      event,
      message: updatedMessage,
    });
  };

  const normalizeTimelineEventChunk = (chunk: AcpStreamChunk): AgentTimelineEvent | null => {
    if (chunk.event) {
      const event = chunk.event;
      const hasPendingContext =
        event.id === 'pending' ||
        event.id.startsWith('pending:') ||
        event.message_id === 'pending' ||
        event.run_id === 'pending' ||
        event.agent_id === 'pending';
      const hasMismatchedContext =
        event.message_id !== placeholder.id ||
        event.run_id !== run.id ||
        event.agent_id !== agent.agent_id;
      if (!hasPendingContext && !hasMismatchedContext) {
        traceEventSeq = Math.max(traceEventSeq, event.seq);
        return event;
      }
      const seq = Number.isFinite(event.seq) && event.seq > traceEventSeq ? event.seq : ++traceEventSeq;
      traceEventSeq = Math.max(traceEventSeq, seq);
      return {
        ...event,
        id: `${run.id}:${seq}`,
        message_id: placeholder.id,
        run_id: run.id,
        agent_id: agent.agent_id,
        seq,
        payload: {
          ...event.payload,
          provider_event_id: event.id,
        },
      };
    }

    if (chunk.rawEvent) {
      if (isProtocolEvent(chunk.rawEvent)) {
        return normalizeProtocolEvent({
          messageId: placeholder.id,
          runId: run.id,
          agentId: agent.agent_id,
          seq: ++traceEventSeq,
          provider: backend,
          raw: chunk.rawEvent,
        });
      }
      return normalizeKnownProviderEvent({
        messageId: placeholder.id,
        runId: run.id,
        agentId: agent.agent_id,
        seq: ++traceEventSeq,
        provider: backend,
        raw: chunk.rawEvent,
      });
    }

    return null;
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    heartbeat = setInterval(() => {
      const updated = agentRunRepo.touchActive(run.id);
      if (updated && (updated.status === 'running' || updated.status === 'queued')) {
        broadcastRun('agent_run:updated', updated);
      }
    }, AGENT_RUN_HEARTBEAT_MS);
    const adapter = getAdapter(backend);
    const result = await adapter.invoke({
      projectPath,
      sessionId: acpSessionId,
      prompt,
      sessionHandoff: sessionHandoff?.text ?? null,
      sessionHandoffMode: sessionHandoff?.mode,
      imagePaths: args.imagePaths,
      acpPermissionMode: intentAnalysisSource ? 'read-only' : runtimeProfile.acpPermissionMode,
      acpWritableDirs: intentAnalysisSource ? [] : runtimeProfile.writableDirs,
      envOverrides: superpowersBootstrapEnvOverrides,
      onChunk: (chunk) => {
        if (chunk.rawType === 'protocol.retry') onRetry(chunk.text);
        else if (chunk.stream === 'stdout' && chunk.channel === 'activity') onActivity(chunk.text);
        else if (chunk.stream === 'stdout' && chunk.channel === 'thinking') onTrace('thinking', chunk.text, chunk.trace);
        else if (chunk.stream === 'stdout' && chunk.channel === 'tool') onTrace('tool', chunk.text, chunk.trace);
        else if (chunk.stream === 'stdout' && chunk.channel === 'command') onTrace('command', chunk.text, chunk.trace);
        else if (chunk.stream === 'stdout' && chunk.channel === 'event') {
          const timelineEvent = normalizeTimelineEventChunk(chunk);
          if (timelineEvent) persistTimelineEvent(timelineEvent, chunk);
        }
        else if (chunk.stream === 'stdout') onStdout(chunk.text);
        else onStderr(chunk.text);
      },
      onSession: (sessionId) => {
        if (taskExecutor) {
          taskExecutorRepo.updateSession(taskExecutor.id, sessionId);
        }
        const updated = agentRunRepo.updateStatus(run.id, 'running', {
          acp_session_id: sessionId,
        });
        if (updated) broadcastRun('agent_run:updated', updated);
      },
      signal: controller.signal,
    });
    flushAnswerBuffer();
    if (result.sessionId) {
      if (taskExecutor) {
        taskExecutorRepo.updateSession(taskExecutor.id, result.sessionId);
      }
      const updated = agentRunRepo.updateStatus(run.id, 'running', {
        acp_session_id: result.sessionId,
      });
      if (updated) broadcastRun('agent_run:updated', updated);
    }
    if (!taskExecutor && result.sessionId && result.sessionId !== agent.acp_session_id) {
      roomAgentRepo.setAcp(agent.id, {
        acp_enabled: true,
        acp_backend: agent.acp_backend,
        acp_session_id: result.sessionId,
        acp_session_label: agent.acp_session_label,
        acp_permission_mode: agent.acp_permission_mode,
        acp_writable_dirs: agent.acp_writable_dirs,
      });
    }
    if (result.sessionHandoffPending) {
      if (taskExecutor) {
        taskExecutorRepo.setHandoffPending(
          taskExecutor.id,
          true,
          result.sessionHandoffReason ?? 'automatic_rotation_after_events',
        );
      } else {
        roomAgentRepo.setAcpSessionHandoffPending(
          agent.id,
          true,
          result.sessionHandoffReason ?? 'automatic_rotation_after_events',
        );
      }
    } else if (taskExecutor?.acp_session_handoff_pending) {
      taskExecutorRepo.setHandoffPending(taskExecutor.id, false, null);
    } else if (!taskExecutor && agent.acp_session_handoff_pending) {
      roomAgentRepo.setAcpSessionHandoffPending(agent.id, false, null);
    }
    if (controller.signal.aborted) {
      finishRun(run.id, 'cancelled');
    } else if (result.exitCode === 0) {
      const currentRun = agentRunRepo.get(run.id);
      if (!currentRun?.stdout) {
        const error = `${backend} completed without output`;
        onStdout(`\n[${backend} error] ${error}`);
        onStderr(error);
        finishRun(run.id, 'failed', error);
      } else {
        finishRun(run.id, 'completed');
      }
    } else {
      const error = result.stderr || `Process exited with code ${result.exitCode}`;
      finishRun(run.id, 'failed', error);
    }
  } catch (err) {
    flushAnswerBuffer();
    const status: AgentRunStatus = controller.signal.aborted ? 'cancelled' : 'failed';
    const message = (err as Error).message;
    onStderr(`\n[error] ${message}`);
    finishRun(run.id, status, status === 'failed' ? message : null);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    runRegistry.remove(run.id);
    const finalRun = agentRunRepo.get(run.id);
    let finalMessage = messageRepo.get(placeholder.id);
    let finalSnapshotBroadcasted = false;
    const broadcastFinalSnapshot = (): void => {
      if (finalSnapshotBroadcasted) return;
      flushAnswerBuffer();
      finalSnapshotBroadcasted = true;
      if (args.internalMessage) return;
      const completedMessage = messageRepo.get(placeholder.id) ?? finalMessage;
      wsHub.broadcast(roomId, {
        type: 'message:stream',
        roomId,
        messageId: placeholder.id,
        runId: finalRun?.id ?? run.id,
        channel: 'answer',
        chunk: '',
        done: true,
        seq: ++streamSeq,
        status: finalRun?.status ?? (controller.signal.aborted ? 'cancelled' : 'failed'),
        error: finalRun?.error ?? null,
        message: completedMessage,
      });
    };
    try {
      if (finalRun && finalMessage) {
        const trailingVisibleAnswer = intentStreamFilter?.finish() ?? '';
        if (trailingVisibleAnswer) {
          broadcastAnswerChunk(trailingVisibleAnswer);
          finalMessage = messageRepo.get(placeholder.id) ?? finalMessage;
        }
        if (intentStreamFilter && args.sourceMessageId && finalRun.status === 'completed') {
          applyAcpIntentResultToSourceMessage({
            roomId,
            sourceMessageId: args.sourceMessageId,
            filter: intentStreamFilter,
          });
        }
        try {
          finalMessage = sanitizePlannerCasualReply({
            message: finalMessage,
            run: finalRun,
            sourceMessageId: args.sourceMessageId,
            agent,
          }) ?? finalMessage;
          annotateTaskExecutionDecision({
            message: finalMessage,
            run: finalRun,
            sourceMessageId: args.sourceMessageId,
            agent,
          });
          annotateMessageChoiceOptions({
            message: finalMessage,
            run: finalRun,
            sourceMessageId: args.sourceMessageId,
          });
          annotateTaskReadiness({
            message: finalMessage,
            run: finalRun,
            sourceMessageId: args.sourceMessageId,
            agent,
          });
          maybeRegisterAgentDocument({
            run: finalRun,
            message: finalMessage,
            agent,
            sourceMessageId: args.sourceMessageId ?? null,
            prompt: args.prompt,
            taskId: args.taskId ?? null,
          });
        } catch (err) {
          console.warn(`[agent-runs] onFinished callback failed for ${finalRun.id}: ${(err as Error).message}`);
        }
        broadcastFinalSnapshot();
      }
      if (finalRun && finalMessage && args.onFinished) {
        await args.onFinished({ run: finalRun, message: finalMessage, status: finalRun.status });
      }
    } finally {
      broadcastFinalSnapshot();
      // Async memory distillation after reply completes (non-workflow only)
      const autoDistillEnabled = room
        ? settingsRepo.resolveForRoom(roomId)?.effective.auto_distill_enabled ?? true
        : false;
      if (room && !args.internalMessage && !args.workflowRunId && finalRun?.status === 'completed' && autoDistillEnabled) {
        buildMemorySkillContext({
          projectId: room.project_id,
          roomId,
          message: finalMessage?.content ?? finalRun.stdout ?? '',
        }).then((skillContext) => distillFromConversation({
          projectId: room.project_id,
          roomId,
          triggerMessageId: placeholder.id,
          modelInvoker: args.distillModelInvoker,
          skillContext,
        })).catch((err) => console.warn(`[distill] async distill error: ${(err as Error).message}`));
      }
    }
  }

  function broadcastRun(type: 'agent_run:created' | 'agent_run:updated', updatedRun: AgentRun): void {
    wsHub.broadcast(roomId, { type, roomId, run: updatedRun });
  }

  function finishRun(id: string, status: AgentRunStatus, error?: string | null): void {
    const updated = agentRunRepo.updateStatus(id, status, { error: error ?? null });
    if (taskExecutor) {
      taskExecutorRepo.updateStatus(taskExecutor.id, status === 'completed' ? 'idle' : 'failed');
    }
    if (updated) broadcastRun('agent_run:updated', updated);
  }

  function restoreRunStatusAfterRetry(): void {
    const current = agentRunRepo.get(run.id);
    if (current?.status !== 'retrying') return;
    const updated = agentRunRepo.updateStatus(run.id, 'running');
    if (updated) broadcastRun('agent_run:updated', updated);
  }
}

function annotateTaskExecutionDecision(input: {
  message: Message;
  run: AgentRun;
  sourceMessageId?: string | null;
  agent: RoomAgent;
}): void {
  if (input.run.workflow_run_id || input.run.task_id || input.run.collaboration_run_id) return;
  if (input.agent.agent_id !== 'planner') return;
  if (input.sourceMessageId) {
    const sourceMessage = messageRepo.get(input.sourceMessageId);
    if (sourceMessage && isCasualChatSourceMessage(sourceMessage)) return;
  }

  const decision = input.run.status === 'completed'
    ? parseTaskExecutionDecision(input.message.content)
    : parseExplicitTaskExecutionDecision(input.message.content);
  if (!decision) return;
  messageRepo.mergeMetadata(input.message.id, {
    task_execution: decision,
    source_message_id: input.sourceMessageId ?? undefined,
  });
}

function sanitizePlannerCasualReply(input: {
  message: Message;
  run: AgentRun;
  sourceMessageId?: string | null;
  agent: RoomAgent;
}): Message | undefined {
  if (!isPlannerCasualRun({
    agent: input.agent,
    run: input.run,
    sourceMessageId: input.sourceMessageId,
  })) return undefined;
  if (input.run.status !== 'completed') return undefined;
  if (!hasPlannerCasualReplyNoise(input.message.content)) return undefined;
  const cleaned = extractConciseCasualReply(input.message.content);
  if (!cleaned || cleaned === input.message.content) return undefined;
  agentRunRepo.updateStdout(input.run.id, cleaned);
  return messageRepo.updateContent(input.message.id, cleaned);
}

function isPlannerCasualRun(input: {
  agent: RoomAgent;
  run: AgentRun;
  sourceMessageId?: string | null;
}): boolean {
  if (input.run.workflow_run_id || input.run.task_id || input.run.collaboration_run_id) return false;
  if (input.agent.agent_id !== 'planner') return false;
  if (!input.sourceMessageId) return false;
  const sourceMessage = messageRepo.get(input.sourceMessageId);
  return Boolean(sourceMessage && isCasualChatSourceMessage(sourceMessage));
}

function isCasualChatSourceMessage(message: Message): boolean {
  const metadata = parseMessageMetadata(message.metadata);
  const intent = metadata.intent_result;
  const route = metadata.route_result;
  if (metadata.task_id || route?.taskId) return false;
  if (!intent && !route) return isShortGreeting(message.content);
  return (
    intent?.intent === 'chat' &&
    route?.action === 'ask_user' &&
    (intent.confidence ?? 1) <= 0.7 &&
    (route.confidence ?? 1) <= 0.2
  ) || isShortGreeting(message.content);
}

function hasPlannerCasualReplyNoise(content: string): boolean {
  return /using-superpowers|workflow 判断|入口 workflow|内部流程|技能使用|task_execution|task_readiness/u.test(content);
}

function extractConciseCasualReply(content: string): string | null {
  const withoutJson = content.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim();
  const sentences = withoutJson
    .split(/(?<=[。！？!?])\s+|\n+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = sentences.find((line) =>
    /^我在[。.!！]?$/u.test(line) ||
    /^我在[。.!！]?\s*/u.test(line) ||
    /^在[。.!！]?$/u.test(line)
  );
  if (!candidate) return '我在。';
  const concise = candidate.match(/^我在[。.!！]?/u)?.[0]
    ?? candidate.match(/^在[。.!！]?/u)?.[0]
    ?? '';
  if (/^我在/u.test(concise)) return '我在。';
  if (/^在/u.test(concise)) return '我在。';
  return '我在。';
}

function isShortGreeting(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return /^(hi|hello|hey|你好|您好|嗨|在吗|在不在)[。.!！?？\s]*$/u.test(normalized);
}

function isAcpIntentAnalysisRun(input: {
  sourceMessage?: Message;
  taskId?: string | null;
  workflowRunId?: string | null;
  collaborationRunId?: string | null;
  internalMessage?: boolean;
}): boolean {
  if (!input.sourceMessage || input.internalMessage) return false;
  if (input.taskId || input.workflowRunId || input.collaborationRunId) return false;
  const metadata = parseMessageMetadata(input.sourceMessage.metadata);
  return !metadata.route_result || metadata.route_result.action === 'reply_in_chat';
}

function buildAcpIntentControlBlockPrompt(): string {
  return [
    '',
    '本轮为群聊单次 ACP 分析回复。',
    '你只能分析和回复，不能修改文件、不能执行实现、不能运行会改变工作区的操作。',
    '正文按自然语言正常回复，并保持适合群聊直接阅读。',
    '在回复末尾追加隐藏控制块，格式必须完全如下，且不要用 Markdown 代码块包裹：',
    '<openclaw_intent_json>',
    '{"intent":"chat","suggestedAction":"reply_in_chat","reason":"简短中文原因","signals":["关键信号"]}',
    '</openclaw_intent_json>',
    'intent 只能是 chat、light_task、debugger、brainstorming、workflow。',
    'suggestedAction 只能是 reply_in_chat、create_light_task、start_debugger、start_brainstorming、start_workflow、ask_user。',
  ].join('\n');
}

function applyAcpIntentResultToSourceMessage(input: {
  roomId: string;
  sourceMessageId: string;
  filter: AcpIntentStreamFilter;
}): void {
  const intentResult = input.filter.intentResult();
  if (!intentResult) return;
  const sourceMessage = messageRepo.get(input.sourceMessageId);
  if (!sourceMessage || sourceMessage.room_id !== input.roomId) return;
  const metadata = parseMessageMetadata(sourceMessage.metadata);
  const currentRouteResult = metadata.route_result ?? buildDefaultChatRouteResult();
  let nextRouteResult = applyIntentToRouteResult(currentRouteResult, intentResult);
  let taskId: string | undefined;
  if (nextRouteResult.action === 'create_task') {
    const taskResult = createTaskWithConversation({
      roomId: input.roomId,
      taskInput: {
        title: inferAcpIntentTaskTitle(sourceMessage.content),
        description: buildAcpIntentTaskDescription(sourceMessage.content, intentResult),
        interaction_mode: 'ask_user',
      },
      origin: 'chat_plan',
      sourceMessageId: sourceMessage.id,
      createUserMessage: false,
    });
    taskId = taskResult.task.id;
    nextRouteResult = {
      ...nextRouteResult,
      taskId,
      reason: `${nextRouteResult.reason}，已根据 ACP 意图创建任务：${taskResult.task.title}`,
    };
  }
  const updatedMessage = messageRepo.mergeMetadata(sourceMessage.id, {
    intent_result: intentResult,
    route_result: nextRouteResult,
    task_id: taskId,
  });
  if (!updatedMessage) return;
  wsHub.broadcast(input.roomId, {
    type: 'message:stream',
    roomId: input.roomId,
    messageId: updatedMessage.id,
    channel: 'event',
    chunk: '',
    done: true,
    status: 'completed',
    message: updatedMessage,
  });
  if (taskId) {
    wsHub.broadcast(input.roomId, {
      type: 'task:activated',
      roomId: input.roomId,
      taskId,
    });
  }
}

function buildDefaultChatRouteResult(): RouteResult {
  return {
    taskId: null,
    action: 'reply_in_chat',
    confidence: 0,
    reason: '未显式引用任务，按全局聊天回复',
    reason_code: 'reply_in_chat',
  };
}

function inferAcpIntentTaskTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '待处理任务';
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77).trimEnd()}...`;
}

function buildAcpIntentTaskDescription(
  content: string,
  intentResult: MessageMetadata['intent_result'],
): string {
  return [
    `消息模式：${intentResult?.intent ?? 'light_task'}`,
    `建议动作：${intentResult?.suggestedAction ?? 'create_light_task'}`,
    intentResult?.reason ? `判断原因：${intentResult.reason}` : null,
    '',
    content,
  ].filter((line): line is string => line !== null).join('\n');
}

function buildPlannerCasualChatPrompt(prompt: string, agent: RoomAgent, sourceMessage?: Message): string {
  if (agent.agent_id !== 'planner') return prompt;
  if (!sourceMessage || !isCasualChatSourceMessage(sourceMessage)) return prompt;
  return [
    '本轮消息类型：普通闲聊/问候。',
    '回复契约：只输出一句简短自然回复，例如“我在。”；不要解释 workflow、任务规划、内部流程或技能加载；不要输出 task_execution、task_readiness 或任何 JSON。',
    '',
    prompt,
  ].join('\n');
}

function parseMessageMetadata(raw: string | null): MessageMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed as MessageMetadata : {};
  } catch {
    return {};
  }
}

function annotateTaskReadiness(input: {
  message: Message;
  run: AgentRun;
  sourceMessageId?: string | null;
  agent: RoomAgent;
}): void {
  if (input.run.workflow_run_id || input.run.task_id || input.run.collaboration_run_id) return;
  if (input.run.status !== 'completed') return;
  if (input.message.sender_type !== 'agent') return;
  if (input.agent.agent_id !== 'planner') return;

  const readiness = parseTaskReadiness(input.message.content);
  if (!readiness) return;
  messageRepo.mergeMetadata(input.message.id, {
    task_readiness: {
      ...readiness,
      source_message_id: input.sourceMessageId ?? readiness.source_message_id,
    },
  });
}

function annotateMessageChoiceOptions(input: {
  message: Message;
  run: AgentRun;
  sourceMessageId?: string | null;
}): void {
  if (input.run.workflow_run_id || input.run.task_id || input.run.collaboration_run_id) return;
  if (input.message.sender_type !== 'agent') return;
  const options = parseExplicitMessageChoiceOptions(input.message.content);
  if (options.length === 0) return;
  messageRepo.mergeMetadata(input.message.id, {
    choice_options: options,
    source_message_id: input.sourceMessageId ?? undefined,
  });
}

function parseExplicitMessageChoiceOptions(content: string): NonNullable<MessageMetadata['choice_options']> {
  for (const candidate of extractJsonObjectCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const options = readMessageChoiceOptionsObject(parsed);
      if (options.length > 0) return options;
    } catch {
      // Ignore malformed JSON blocks.
    }
  }
  return [];
}

function readMessageChoiceOptionsObject(value: unknown): NonNullable<MessageMetadata['choice_options']> {
  if (!isRecord(value)) return [];
  const rawOptions = Array.isArray(value.choice_options)
    ? value.choice_options
    : Array.isArray(value.message_options)
      ? value.message_options
      : [];
  return rawOptions
    .map(readMessageChoiceOption)
    .filter((option): option is NonNullable<MessageMetadata['choice_options']>[number] => option !== null)
    .slice(0, 6);
}

function readMessageChoiceOption(value: unknown): NonNullable<MessageMetadata['choice_options']>[number] | null {
  if (!isRecord(value)) return null;
  const id = readNonEmptyString(value.id);
  const title = readNonEmptyString(value.title);
  const summary = readNonEmptyString(value.summary);
  const maturity = readMessageChoiceOptionMaturity(value.maturity);
  if (!id || !title || !summary || !maturity) return null;
  return {
    id: id.slice(0, 120),
    title: title.slice(0, 120),
    summary: summary.slice(0, 360),
    benefits: readStringList(value.benefits, 3, 180),
    risks: readStringList(value.risks, 3, 180),
    maturity,
    ...(typeof value.recommended === 'boolean' ? { recommended: value.recommended } : {}),
  };
}

function readMessageChoiceOptionMaturity(value: unknown): NonNullable<MessageMetadata['choice_options']>[number]['maturity'] | null {
  return value === 'exploratory' || value === 'boundary_needed' || value === 'actionable' ? value : null;
}

function readStringList(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, limit);
}

function parseTaskReadiness(content: string): MessageMetadata['task_readiness'] | null {
  const explicit = parseExplicitTaskReadiness(content);
  if (explicit) return explicit;
  return inferTaskReadinessFromPlannerReply(content);
}

function parseExplicitTaskReadiness(content: string): MessageMetadata['task_readiness'] | null {
  for (const candidate of extractJsonObjectCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const readiness = readTaskReadinessObject(parsed);
      if (readiness) return readiness;
    } catch {
      // Ignore malformed JSON blocks.
    }
  }
  return null;
}

function readTaskReadinessObject(value: unknown): MessageMetadata['task_readiness'] | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.task_readiness) ? value.task_readiness : value;
  const ready = typeof candidate.ready === 'boolean' ? candidate.ready : false;
  if (!ready) return null;
  const title = readNonEmptyString(candidate.title) ?? '待生成任务';
  const description = readNonEmptyString(candidate.description) ?? title;
  const missingQuestions = Array.isArray(candidate.missing_questions)
    ? candidate.missing_questions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const executionIntent = readTaskExecutionIntent(candidate.execution_intent) ?? 'implementation';
  const recommendedMode = candidate.recommended_mode === 'chat_collaboration' || isAnalysisIntent(executionIntent)
    ? 'chat_collaboration'
    : 'formal_workflow';
  const confidence = typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
    ? Math.max(0, Math.min(1, candidate.confidence))
    : 0.8;
  return {
    ready,
    confidence,
    title,
    description,
    missing_questions: missingQuestions,
    recommended_mode: recommendedMode,
    execution_intent: executionIntent,
    source_message_id: readNonEmptyString(candidate.source_message_id) ?? undefined,
  };
}

function inferTaskReadinessFromPlannerReply(content: string): MessageMetadata['task_readiness'] | null {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (!hasTaskReadinessSignals(content)) return null;
  const executionIntent = inferTaskExecutionIntent(normalized);
  const title = inferTaskReadinessTitle(content);
  return {
    ready: true,
    confidence: executionIntent === 'analysis_only' ? 0.72 : 0.76,
    title,
    description: normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`,
    missing_questions: [],
    recommended_mode: isAnalysisIntent(executionIntent) ? 'chat_collaboration' : 'formal_workflow',
    execution_intent: executionIntent,
  };
}

function hasTaskReadinessSignals(content: string): boolean {
  const signals = [
    /实施目标[:：]/u,
    /实施范围[:：]/u,
    /验收标准[:：]/u,
    /下一步.*(工程排期|实现|执行|workflow|工作流)/u,
    /可进入.*(工程排期|实现|执行|workflow|工作流)/u,
  ];
  return signals.filter((pattern) => pattern.test(content)).length >= 2;
}

function inferTaskExecutionIntent(content: string): TaskExecutionIntent {
  if (/不进入实现|不要实现|只做方案|只做分析|先生成.*方案|只读分析/u.test(content)) {
    return 'analysis_only';
  }
  if (/修复|bug|报错|失败|回归|恢复/u.test(content)) return 'debug_fix';
  return 'implementation';
}

function inferTaskReadinessTitle(content: string): string {
  const lines = content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const objective = lines.find((line) => /^实施目标[:：]/u.test(line));
  if (objective) return truncateReadinessTitle(objective.replace(/^实施目标[:：]\s*/u, ''));
  const taskTitleIndex = lines.findIndex((line) => /^(\*\*)?任务标题(\*\*)?$/u.test(line));
  if (taskTitleIndex >= 0 && lines[taskTitleIndex + 1]) {
    return truncateReadinessTitle(lines[taskTitleIndex + 1]!);
  }
  return truncateReadinessTitle(lines[0] ?? '待生成任务');
}

function truncateReadinessTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '待生成任务';
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117).trimEnd()}...`;
}

function readTaskExecutionIntent(value: unknown): TaskExecutionIntent | null {
  if (
    value === 'analysis_only' ||
    value === 'planning_only' ||
    value === 'documentation_only' ||
    value === 'implementation' ||
    value === 'debug_fix' ||
    value === 'review_only'
  ) {
    return value;
  }
  return null;
}

function isAnalysisIntent(intent: TaskExecutionIntent): boolean {
  return intent === 'analysis_only' || intent === 'planning_only' || intent === 'documentation_only' || intent === 'review_only';
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function maybeRegisterAgentDocument(input: {
  run: AgentRun;
  message: Message;
  agent: RoomAgent;
  sourceMessageId: string | null;
  prompt: string;
  taskId: string | null | undefined;
}): void {
  if (input.run.status !== 'completed') return;
  if (input.message.sender_type !== 'agent') return;
  if (!input.message.content.trim()) return;

  const room = roomRepo.get(input.run.room_id);
  if (!room) return;

  const classification = classifyAgentDocument({
    content: input.message.content,
    senderType: 'agent',
    messageComplete: true,
    projectId: room.project_id,
    roomId: input.run.room_id,
    messageId: input.message.id,
    agentId: input.agent.agent_id,
    agentName: input.agent.agent_name,
    userRequest: input.prompt,
    alreadyArchived: false,
  });
  if (classification.decision === 'do_not_archive') {
    return;
  }

  const title = classification.title ?? `${input.agent.agent_name} 生成文档`;
  try {
    const file = fileRepo.createAgentDocument({
      project_id: room.project_id,
      title,
      content: input.message.content,
      source_message_id: input.message.id,
      source_room_id: input.run.room_id,
      source_agent_id: input.agent.agent_id,
      source_task_id: input.taskId ?? null,
    });
    if (!file) {
      console.warn(`[agent-document] failed to register resource for message ${input.message.id}`);
    }
  } catch (err) {
    console.warn(`[agent-document] failed to register resource for message ${input.message.id}: ${(err as Error).message}`);
  }
}

function parseTaskExecutionDecision(content: string): TaskExecutionDecision | null {
  return parseExplicitTaskExecutionDecision(content);
}

function parseExplicitTaskExecutionDecision(content: string): TaskExecutionDecision | null {
  for (const candidate of extractJsonObjectCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const decision = readTaskExecutionDecisionObject(parsed);
      if (decision) return decision;
    } catch {
      // Ignore malformed JSON blocks.
    }
  }
  return null;
}

function readTaskExecutionDecisionObject(value: unknown): TaskExecutionDecision | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.task_execution) ? value.task_execution : value;
  if (
    typeof candidate.summary !== 'string' ||
    !candidate.summary.trim() ||
    !isTaskExecutionState(candidate.state) ||
    !Array.isArray(candidate.next_steps)
  ) {
    return null;
  }

  const status: TaskExecutionDecision['status'] = isTaskExecutionDecisionStatus(candidate.status)
    ? candidate.status
    : 'suggested';

  if (!isTaskExecutionDecisionStatus(candidate.status) && candidate.status !== undefined) {
    console.warn(`[task_execution] unknown status "${candidate.status}", falling back to "${status}"`);
  }

  const next_steps = candidate.next_steps
    .map((step) => {
      if (!isRecord(step)) return null;
      if (
        typeof step.agent_id !== 'string' ||
        !step.agent_id.trim() ||
        typeof step.goal !== 'string' ||
        !step.goal.trim()
      ) {
        return null;
      }
      return {
        agent_id: step.agent_id.trim(),
        goal: step.goal.trim(),
      };
    })
    .filter((step): step is TaskExecutionDecision['next_steps'][number] => Boolean(step));

  return {
    state: candidate.state,
    status,
    summary: candidate.summary.trim(),
    ...(typeof candidate.reason === 'string' && candidate.reason.trim() ? { reason: candidate.reason.trim() } : {}),
    next_steps,
  };
}

function extractJsonObjectCandidates(content: string): string[] {
  const fencedBlocks = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item && item.startsWith('{') && item.endsWith('}')));
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return [...fencedBlocks, trimmed];
  }
  return fencedBlocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isTaskExecutionState(value: unknown): value is TaskExecutionDecision['state'] {
  return value === 'ready_to_execute' ||
    value === 'needs_choice' ||
    value === 'needs_boundary_confirmation' ||
    value === 'analysis_only' ||
    value === 'blocked';
}

function isTaskExecutionDecisionStatus(value: unknown): value is TaskExecutionDecision['status'] {
  return value === 'suggested' || value === 'dispatching' || value === 'completed' || value === 'blocked' || value === 'needs_fix';
}

function buildTaskExecutionDecisionPrompt(): string[] {
  return [
    '',
    'Planner 普通消息回复规则：',
    '- 普通问候、闲聊或信息不足时，只输出简短自然回复，例如“我在”。',
    '- 不要解释内部流程、workflow 判断、技能使用或 using-superpowers。',
    '- 不要追加 task_execution 或 task_readiness JSON。',
    '- 只有用户提出明确规划、实现、修复、任务拆解或调度需求时，才进入下面的结构化输出规则。',
    '',
    '任务执行结构化输出规则：',
    '- 当用户请求是单一完整可执行任务时，必须返回 state 为 "ready_to_execute"，系统会在用户点击开始任务后直接派发执行智能体。',
    '- 只有存在多个方案、重大分析结论需要用户决策、或执行边界不清时，才返回 "needs_choice" 或 "needs_boundary_confirmation"。',
    '- 只读分析不执行时返回 "analysis_only"；无法继续时返回 "blocked"。',
    '- 字段名必须固定为 task_execution。',
    '- 固定 JSON 结构如下：',
    '```json',
    '{',
    '  "task_execution": {',
    '    "state": "ready_to_execute",',
    '    "status": "suggested",',
    '    "summary": "一句话总结下一步",',
    '    "reason": "为什么可以直接执行，或为什么需要选择/确认",',
    '    "next_steps": [',
    '      { "agent_id": "frontend-executor", "goal": "检查设置页测试入口" }',
    '    ]',
    '  }',
    '}',
    '```',
    '',
    '任务生成结构化输出规则：',
    '- 当用户请求已具备生成正式任务或 workflow 的条件时，请在自然语言回复后追加 task_readiness JSON。',
    '- 如果用户要求实现、修复、开发、细化功能或优化功能，recommended_mode 使用 "formal_workflow"，execution_intent 使用 "implementation" 或 "debug_fix"。',
    '- 如果用户明确只要方案/分析且不要实现，recommended_mode 使用 "chat_collaboration"，execution_intent 使用 "analysis_only"。',
    '- 固定 JSON 结构如下：',
    '```json',
    '{',
    '  "task_readiness": {',
    '    "ready": true,',
    '    "confidence": 0.9,',
    '    "title": "一句话任务标题",',
    '    "description": "任务目标、边界和验收方式",',
    '    "missing_questions": [],',
    '    "recommended_mode": "formal_workflow",',
    '    "execution_intent": "implementation"',
    '  }',
    '}',
    '```',
  ];
}

function buildMessageChoiceOptionsPrompt(): string[] {
  return [
    '',
    '群聊可选方案结构化输出规则：',
    '- 当回复中给出多个可供用户选择的方案、路径、处理方式或执行策略时，必须在自然语言回复后追加一个单独的 ```json 代码块。',
    '- 字段名固定为 choice_options；不要依赖标题文案让前端猜测方案。',
    '- 不提供多个可选方案时，不要输出 choice_options。',
    '- 固定 JSON 结构如下：',
    '```json',
    '{',
    '  "choice_options": [',
    '    {',
    '      "id": "parallel_execution",',
    '      "title": "并行执行",',
    '      "summary": "拆成互不冲突的子任务并行处理。",',
    '      "benefits": ["更快拿到结果"],',
    '      "risks": ["需要统一收尾"],',
    '      "maturity": "actionable",',
    '      "recommended": true',
    '    }',
    '  ]',
    '}',
    '```',
    '- maturity 只能是 exploratory、boundary_needed、actionable。',
    '- id 使用稳定英文 snake_case，同一条消息内唯一。',
  ];
}

function toTracePatch(
  channel: 'thinking' | 'tool' | 'command',
  text: string,
  trace?: AcpStreamTrace,
  event?: AgentTimelineEvent,
): MessageTrace {
  const next: MessageTrace = event ? { events: [event] } : {};
  if (trace?.kind === 'thinking') return { ...next, thinking: [{ text: trace.text }] };
  if (trace?.kind === 'tool') return { ...next, tool_calls: [{ name: trace.name, input: trace.input, output: trace.output }] };
  if (trace?.kind === 'command') return { ...next, commands: [{ command: trace.command, output: trace.output }] };
  if (channel === 'thinking') return { ...next, thinking: [{ text }] };
  if (channel === 'tool') return { ...next, tool_calls: [{ name: 'trace', input: text }] };
  return { ...next, commands: [{ command: text }] };
}

function getMessageTaskId(rawMetadata: string | null): string | null {
  if (!rawMetadata) return null;
  try {
    const parsed = JSON.parse(rawMetadata) as unknown;
    if (!isRecord(parsed)) return null;
    return typeof parsed.task_id === 'string' && parsed.task_id.trim() ? parsed.task_id.trim() : null;
  } catch {
    return null;
  }
}

function getMessageAcpSessionId(rawMetadata: string | null): string | null {
  if (!rawMetadata) return null;
  try {
    const parsed = JSON.parse(rawMetadata) as unknown;
    if (!isRecord(parsed)) return null;
    return typeof parsed.acp_session_id === 'string' && parsed.acp_session_id.trim()
      ? parsed.acp_session_id.trim()
      : null;
  } catch {
    return null;
  }
}

function projectTimelineEventToTaskEvent(input: {
  roomId: string;
  taskId?: string | null;
  event: AgentTimelineEvent;
}): void {
  if (!input.taskId) return;
  const projection = mapTimelineEventToTaskEvent(input.event);
  if (!projection) return;
  const providerEventId = typeof input.event.payload.provider_event_id === 'string'
    ? input.event.payload.provider_event_id
    : null;
  const idempotencyPayloadKey = providerEventId ? 'projection_key' : 'timeline_event_id';
  const taskEvent = taskEventRepo.createOnceByPayloadString(idempotencyPayloadKey, {
    task_id: input.taskId,
    room_id: input.roomId,
    type: projection.type,
    layer: projection.layer,
    source_run_id: input.event.run_id,
    payload: {
      timeline_event_id: input.event.id,
      timeline_type: input.event.type,
      timeline_status: input.event.status,
      message_id: input.event.message_id,
      agent_id: input.event.agent_id,
      title: input.event.title,
      ...input.event.payload,
      projection_key: providerEventId
        ? `${input.event.run_id}:${providerEventId}`
        : input.event.id,
    },
  });
  wsHub.broadcast(input.roomId, { type: 'task_event:new', roomId: input.roomId, event: taskEvent });
}

function mapTimelineEventToTaskEvent(event: AgentTimelineEvent): { type: TaskEventType; layer: MessageLayer } | null {
  if (event.type === 'thinking' || event.type === 'assistant_message' || event.type === 'raw') return null;
  if (event.type === 'file_diff') return { type: 'diff_detected', layer: 'diff' };
  if (event.type === 'plan_update') return { type: 'plan_proposed', layer: 'timeline' };
  if (
    event.type === 'tool_call' ||
    event.type === 'tool_result' ||
    event.type === 'command' ||
    event.type === 'command_output' ||
    event.type === 'web_search' ||
    event.type === 'permission_request' ||
    event.type === 'error'
  ) {
    return { type: 'runtime_event', layer: 'runtime' };
  }
  return null;
}

async function dispatchTaskExecutionDecision(args: {
  roomId: string;
  sourceMessageId: string;
  decision: TaskExecutionDecision;
  autoContinueDepth?: number;
}): Promise<TaskExecutionDispatchResult> {
  const room = roomRepo.get(args.roomId);
  if (!room) throw new Error('room not found');
  const project = projectRepo.get(room.project_id);
  if (!project) throw new Error('project not found');
  const { targets, addedAgents, missingAgentIds } = resolveTaskExecutionDispatchTargets(args.roomId, args.decision);
  const sourceMessage = messageRepo.get(args.sourceMessageId);
  const taskId = getMessageTaskId(sourceMessage?.metadata ?? null);
  const executionPlan = await resolveTaskExecutionStepExecutionPlan({
    room,
    sourceMessage,
    targets,
  });
  if (executionPlan.dispatchTargets.length === 0 || missingAgentIds.length > 0) {
    const requestedAgentIds = args.decision.next_steps.map((step) => step.agent_id).filter(Boolean);
    throw new Error(
      missingAgentIds.length > 0
        ? `task execution has no matching room or global agents: ${missingAgentIds.join(', ')}`
        : requestedAgentIds.length > 0
          ? `task execution has no matching room or global agents: ${requestedAgentIds.join(', ')}`
        : 'task execution has no next steps to dispatch',
    );
  }
  const results = await runTargets({
    targets: executionPlan.dispatchTargets,
    projectPath: project.path,
    roomId: args.roomId,
    sourceMessageId: args.sourceMessageId,
    taskId,
  });
  await reportTaskExecutionDispatchResults({
    roomId: args.roomId,
    projectPath: project.path,
    sourceMessageId: args.sourceMessageId,
    taskId,
    decision: args.decision,
    dispatchedTargets: executionPlan.dispatchTargets,
    dispatchedResults: results,
    deferredSteps: executionPlan.deferredSteps,
    autoContinueDepth: args.autoContinueDepth ?? 0,
  });
  return {
    dispatched: executionPlan.dispatchTargets.length,
    added_agents: addedAgents,
    deferred_steps: executionPlan.deferredSteps,
  };
}

async function resolveTaskExecutionStepExecutionPlan(input: {
  room: Room;
  sourceMessage: Message | undefined;
  targets: TaskExecutionDispatchTarget[];
}): Promise<{
  dispatchTargets: TaskExecutionDispatchedTarget[];
  deferredSteps: TaskExecutionDecision['next_steps'];
}> {
  const llmDecision = await resolveTaskExecutionPlanWithModel(input);
  const selectedIndexes = sanitizeTaskExecutionPlanIndexes(
    llmDecision?.dispatch_step_indexes,
    input.targets.length,
  );
  const fallbackIndexes = input.targets.length > 0 ? [0] : [];
  const dispatchIndexes = selectedIndexes.length > 0 ? selectedIndexes : fallbackIndexes;
  const dispatchIndexSet = new Set(dispatchIndexes);
  const deferredIndexes = sanitizeTaskExecutionPlanIndexes(
    llmDecision?.deferred_step_indexes,
    input.targets.length,
  ).filter((index) => !dispatchIndexSet.has(index));
  const coveredIndexSet = new Set([...dispatchIndexes, ...deferredIndexes]);
  for (let index = 0; index < input.targets.length; index += 1) {
    if (!coveredIndexSet.has(index)) deferredIndexes.push(index);
  }

  return {
    dispatchTargets: dispatchIndexes.map((index) => input.targets[index]).filter(isTaskExecutionDispatchTarget)
      .map((target) => ({ agent: target.agent, prompt: target.prompt, step: target.step })),
    deferredSteps: deferredIndexes.map((index) => input.targets[index]).filter(isTaskExecutionDispatchTarget)
      .map((target) => target.step),
  };
}

function isTaskExecutionDispatchTarget(value: TaskExecutionDispatchTarget | undefined): value is TaskExecutionDispatchTarget {
  return Boolean(value);
}

async function resolveTaskExecutionPlanWithModel(input: {
  room: Room;
  sourceMessage: Message | undefined;
  targets: TaskExecutionDispatchTarget[];
}): Promise<TaskExecutionPlanDecision | null> {
  const invoker = plannerExecutionPlanInvoker ?? defaultTaskExecutionPlanInvoker;
  try {
    return await invoker.invoke(input);
  } catch (err) {
    console.warn(`[task-execution-dispatch] LLM execution plan failed, falling back to serial: ${(err as Error).message}`);
    return null;
  }
}

const defaultTaskExecutionPlanInvoker: TaskExecutionPlanInvoker = {
  async invoke(input) {
    if (!isModelChatConfigured()) return null;
    const text = await invokeConfiguredModelText(buildTaskExecutionPlanMessages(input));
    return parseTaskExecutionPlanDecision(text);
  },
};

function buildTaskExecutionPlanMessages(input: {
  room: Room;
  sourceMessage: Message | undefined;
  targets: TaskExecutionDispatchTarget[];
}): Array<SystemMessage | HumanMessage> {
  return [
    new SystemMessage([
      '你是 OpenDeepSea 的调度策略模型。',
      '任务：判断 task_execution.next_steps 应该第一批并行执行哪些步骤，哪些步骤必须等第一批结果返回 planner 后再执行。',
      '必须基于任务语义、智能体角色、目标依赖来判断串行或并行，不要用固定关键词规则。',
      '如果某个步骤是在验证、测试、审查、验收另一个步骤的产物，必须暂缓到后续阶段。',
      '如果多个步骤互不依赖、可以同时产生独立结果，可以并行执行。',
      '只输出 JSON，不要输出 Markdown。',
      'JSON 结构：{"mode":"parallel|serial","dispatch_step_indexes":[0],"deferred_step_indexes":[1],"rationale":"简短原因"}',
    ].join('\n')),
    new HumanMessage(JSON.stringify({
      room: {
        id: input.room.id,
        name: input.room.name,
        description: input.room.description,
      },
      source_message: input.sourceMessage
        ? {
          id: input.sourceMessage.id,
          content: input.sourceMessage.content,
        }
        : null,
      next_steps: input.targets.map((target, index) => ({
        index,
        agent_id: target.step.agent_id,
        goal: target.step.goal,
        resolved_agent: {
          agent_id: target.agent.agent_id,
          name: target.agent.agent_name,
          role: target.agent.workflow_role,
          description: target.agent.agent_role,
          capabilities: target.agent.capabilities,
          runtime_backend: target.agent.runtime_backend,
          memory_scope: target.agent.memory_scope,
        },
      })),
    }, null, 2)),
  ];
}

function parseTaskExecutionPlanDecision(text: string): TaskExecutionPlanDecision | null {
  const json = extractJsonObjectCandidates(text)[0];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isRecord(parsed)) return null;
    const mode = parsed.mode === 'parallel' || parsed.mode === 'serial' ? parsed.mode : 'serial';
    const dispatch = Array.isArray(parsed.dispatch_step_indexes) ? parsed.dispatch_step_indexes : [];
    const deferred = Array.isArray(parsed.deferred_step_indexes) ? parsed.deferred_step_indexes : [];
    return {
      mode,
      dispatch_step_indexes: dispatch.filter((item): item is number => Number.isInteger(item)),
      deferred_step_indexes: deferred.filter((item): item is number => Number.isInteger(item)),
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  } catch {
    return null;
  }
}

function sanitizeTaskExecutionPlanIndexes(value: unknown, length: number): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  for (const item of value) {
    if (!Number.isInteger(item) || item < 0 || item >= length || seen.has(item)) continue;
    seen.add(item);
  }
  return Array.from(seen);
}

function resolveTaskExecutionDispatchTargets(
  roomId: string,
  decision: TaskExecutionDecision,
): {
  targets: TaskExecutionDispatchTarget[];
  addedAgents: TaskExecutionDispatchAddedAgent[];
  missingAgentIds: string[];
} {
  const agentsById = new Map(roomAgentRepo.listByRoom(roomId).map((agent) => [agent.agent_id, agent]));
  const globalAgentsByRequestedId = new Map<string, Agent>();
  const addedAgentsById = new Map<string, TaskExecutionDispatchAddedAgent>();
  const missingAgentIds: string[] = [];

  for (const step of decision.next_steps) {
    if (agentsById.has(step.agent_id)) {
      continue;
    }
    const globalAgent = resolveGlobalAgentForTaskExecutionStep(step);
    if (globalAgent) {
      globalAgentsByRequestedId.set(step.agent_id, globalAgent);
      continue;
    }
    if (!missingAgentIds.includes(step.agent_id)) {
      missingAgentIds.push(step.agent_id);
    }
  }

  if (missingAgentIds.length > 0) {
    return { targets: [], addedAgents: [], missingAgentIds };
  }

  for (const [requestedAgentId, globalAgent] of globalAgentsByRequestedId.entries()) {
    const agent = roomAgentRepo.addFromGlobalAgent({ room_id: roomId, global_agent_id: globalAgent.id });
    agentsById.set(requestedAgentId, agent);
    agentsById.set(agent.agent_id, agent);
    if (globalAgent.builtin_key) agentsById.set(globalAgent.builtin_key, agent);
    addedAgentsById.set(agent.agent_id, {
      agent_id: agent.agent_id,
      agent_name: agent.agent_name,
    });
  }

  const targets = decision.next_steps
    .map((step) => {
      const agent = agentsById.get(step.agent_id);
      return agent ? { agent, prompt: step.goal, step } : null;
    })
    .filter((target): target is TaskExecutionDispatchTarget =>
      Boolean(target),
    );

  return {
    targets,
    addedAgents: Array.from(addedAgentsById.values()),
    missingAgentIds,
  };
}

async function reportTaskExecutionDispatchResults(args: {
  roomId: string;
  projectPath: string;
  sourceMessageId: string;
  taskId?: string | null;
  decision: TaskExecutionDecision;
  dispatchedTargets: TaskExecutionDispatchedTarget[];
  dispatchedResults: TargetRunResult[];
  deferredSteps: TaskExecutionDecision['next_steps'];
  autoContinueDepth: number;
}): Promise<void> {
  if (args.dispatchedTargets.length === 0) return;
  const planner = roomAgentRepo.listByRoom(args.roomId).find((agent) => agent.agent_id === 'planner');
  if (!planner) return;
  const completedSummaries = args.dispatchedTargets.map((target, index) => {
    const result = args.dispatchedResults[index];
    const content = result?.message?.content?.trim() || '该智能体没有返回可用内容。';
    return [
      `- 已执行智能体：${target.agent.agent_name} (${target.agent.agent_id})`,
      `  原目标：${target.prompt}`,
      `  状态：${result?.status ?? 'unknown'}`,
      result?.error ? `  错误：${result.error}` : null,
      `  返回摘要：${summarizeTaskExecutionDispatchResult(content)}`,
    ].filter((line): line is string => Boolean(line)).join('\n');
  });
  const deferredLines = args.deferredSteps.map((step, index) =>
    `${index + 1}. ${step.agent_id}: ${step.goal}`,
  );
  const originalMessage = messageRepo.get(args.sourceMessageId);
  const prompt = [
    '本轮派发的智能体已经完成，请你作为规划师分析执行结果，并决定是否需要后续处理。',
    '',
    '原始用户请求：',
    originalMessage?.content?.trim() || '未找到原始用户请求。',
    '',
    '上一轮规划师决策：',
    args.decision.summary,
    '',
    '本轮已完成智能体：',
    ...completedSummaries,
    '',
    '暂缓的后续步骤：',
    ...(deferredLines.length > 0 ? deferredLines : ['- 无']),
    '',
    '请判断：',
    '- 如果任务已完成，输出 state 为 "analysis_only"、status 为 "completed" 且 next_steps 为空的 task_execution。',
    '- 如果还需要修复、审查、测试或验收，输出 state 为 "ready_to_execute" 的 task_execution，只包含下一轮要派发的智能体。',
    '- 如果存在多个方案或边界不清，输出 state 为 "needs_choice" 或 "needs_boundary_confirmation"，不要派发。',
    '- 如果无法继续，输出 state 为 "blocked"、status 为 "blocked" 并说明原因。',
    '- 不要重复派发已经完成且不需要返工的同一目标。',
  ].join('\n');
  await respondAsAgent({
    agent: planner,
    projectPath: args.projectPath,
    roomId: args.roomId,
    prompt,
    taskId: args.taskId,
    sourceMessageId: args.sourceMessageId,
    onFinished: async ({ run, message }) => {
      if (run.status !== 'completed') return;
      const latestMessage = messageRepo.get(message.id) ?? message;
      const metadata = parsePlannerMessageMetadata(latestMessage.metadata);
      const decision = metadata.task_execution;
      if (!shouldAutoContinueTaskExecutionDecision(decision)) return;
      if (args.autoContinueDepth >= MAX_TASK_EXECUTION_AUTO_CONTINUE_DEPTH) {
        const blockedDecision = normalizeBlockedAutoContinueTaskExecutionDecision(
          decision,
          `自动续派发已达到上限 ${MAX_TASK_EXECUTION_AUTO_CONTINUE_DEPTH}，已暂停后续派发。`,
        );
        const updatedMessage = messageRepo.mergeMetadata(latestMessage.id, {
          task_execution: blockedDecision,
          source_message_id: args.sourceMessageId,
        });
        if (updatedMessage) broadcastAgentMessageSnapshot({
          roomId: args.roomId,
          message: updatedMessage,
          run,
        });
        console.warn(`[task-execution-dispatch] auto-continue depth limit reached for source message ${args.sourceMessageId}`);
        return;
      }
      const autoDecision = normalizeAutoContinueTaskExecutionDecision(decision);
      const updatedMessage = messageRepo.mergeMetadata(latestMessage.id, {
        task_execution: autoDecision,
        source_message_id: args.sourceMessageId,
      });
      if (updatedMessage) broadcastAgentMessageSnapshot({
        roomId: args.roomId,
        message: updatedMessage,
        run,
      });
      try {
        await dispatchTaskExecutionDecision({
          roomId: args.roomId,
          sourceMessageId: args.sourceMessageId,
          decision: autoDecision,
          autoContinueDepth: args.autoContinueDepth + 1,
        });
      } catch (err) {
        const error = (err as Error).message;
        const blockedDecision = normalizeBlockedAutoContinueTaskExecutionDecision(autoDecision, `自动续派发失败：${error}`);
        const blockedMessage = messageRepo.mergeMetadata(latestMessage.id, {
          task_execution: blockedDecision,
          source_message_id: args.sourceMessageId,
        });
        if (blockedMessage) broadcastAgentMessageSnapshot({
          roomId: args.roomId,
          message: blockedMessage,
          run,
        });
        const systemMessage = messageRepo.create({
          room_id: args.roomId,
          sender_type: 'system',
          sender_id: 'system',
          sender_name: 'System',
          content: `Planner auto-continue failed: ${error}`,
          message_type: 'system',
        });
        wsHub.broadcast(args.roomId, { type: 'message:new', roomId: args.roomId, message: systemMessage });
      }
    },
  });
}

function broadcastAgentMessageSnapshot(input: {
  roomId: string;
  message: Message;
  run: AgentRun;
}): void {
  wsHub.broadcast(input.roomId, {
    type: 'message:stream',
    roomId: input.roomId,
    messageId: input.message.id,
    runId: input.run.id,
    channel: 'answer',
    chunk: '',
    done: true,
    status: input.run.status,
    error: input.run.error ?? null,
    message: input.message,
  });
}

function summarizeTaskExecutionDispatchResult(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 800) return normalized;
  return `${normalized.slice(0, 520)} ... ${normalized.slice(-220)}`;
}

function shouldAutoContinueTaskExecutionDecision(decision: TaskExecutionDecision | undefined): decision is TaskExecutionDecision {
  return Boolean(
    decision &&
    decision.state === 'ready_to_execute' &&
    (decision.status === 'suggested' || decision.status === 'needs_fix') &&
    decision.next_steps.length > 0,
  );
}

function normalizeAutoContinueTaskExecutionDecision(decision: TaskExecutionDecision): TaskExecutionDecision {
  return {
    ...decision,
    state: 'ready_to_execute',
    status: 'dispatching',
  };
}

function normalizeBlockedAutoContinueTaskExecutionDecision(decision: TaskExecutionDecision, summary: string): TaskExecutionDecision {
  return {
    ...decision,
    state: 'blocked',
    status: 'blocked',
    summary,
    next_steps: [],
  };
}

function resolveGlobalAgentForTaskExecutionStep(step: TaskExecutionDecision['next_steps'][number]): Agent | undefined {
  return agentRepo.getByAgentId(step.agent_id)
    ?? agentRepo.getByBuiltinKey(step.agent_id)
    ?? resolveGlobalAgentAlias(step.agent_id)
    ?? findBestGlobalAgentMatch(step);
}

function resolveGlobalAgentAlias(agentId: string): Agent | undefined {
  const normalized = agentId.toLowerCase();
  if (matchesAgentRoleAlias(normalized, ['reviewer', 'review', '审查', '评审', '复核'])) {
    return agentRepo.getByAgentId('reviewer') ?? agentRepo.getByBuiltinKey('reviewer');
  }
  if (matchesAgentRoleAlias(normalized, ['tester', 'test', 'qa', '测试', '验证'])) {
    return agentRepo.getByAgentId('qa-tester') ?? agentRepo.getByBuiltinKey('qa-tester');
  }
  if (matchesAgentRoleAlias(normalized, ['acceptor', 'acceptance', '验收'])) {
    return agentRepo.getByAgentId('acceptor') ?? agentRepo.getByBuiltinKey('acceptor');
  }
  if (
    normalized.includes('runtime') ||
    normalized.includes('inspector') ||
    normalized.includes('context') ||
    normalized.includes('cli')
  ) {
    return agentRepo.getByAgentId('computer-assistant') ?? agentRepo.getByBuiltinKey('computer-assistant');
  }
  return undefined;
}

function matchesAgentRoleAlias(value: string, aliases: string[]): boolean {
  return aliases.some((alias) => value.includes(alias));
}

function findBestGlobalAgentMatch(step: TaskExecutionDecision['next_steps'][number]): Agent | undefined {
  const queryTokens = tokenizeAgentMatchText(`${step.agent_id} ${step.goal}`);
  if (queryTokens.length === 0) return undefined;

  let best: { agent: Agent; score: number } | undefined;
  for (const agent of agentRepo.list()) {
    if (!agent.default_acp_backend) continue;
    if (agent.agent_id === 'planner' || agent.builtin_key === 'planner') continue;
    const score = scoreGlobalAgentMatch(agent, queryTokens);
    if (!best || score > best.score) {
      best = { agent, score };
    }
  }

  return best && best.score >= 4 ? best.agent : undefined;
}

function scoreGlobalAgentMatch(agent: Agent, queryTokens: string[]): number {
  const agentTokens = new Set(tokenizeAgentMatchText([
    agent.agent_id,
    agent.builtin_key,
    agent.name,
    agent.description,
    agent.responsibilities,
    agent.personality,
    agent.default_tool_policy.allowed.join(' '),
    agent.default_workspace_policy.write.join(' '),
  ].filter(Boolean).join(' ')));
  let score = 0;
  for (const token of queryTokens) {
    if (agentTokens.has(token)) score += 3;
    for (const synonym of AGENT_MATCH_SYNONYMS[token] ?? []) {
      if (agentTokens.has(synonym)) score += 2;
    }
  }
  return score;
}

function tokenizeAgentMatchText(text: string): string[] {
  return Array.from(new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  ));
}

export async function dispatchTaskExecutionDecisionForRoom(args: {
  roomId: string;
  sourceMessageId: string;
  decision: TaskExecutionDecision;
}): Promise<TaskExecutionDispatchResult> {
  return dispatchTaskExecutionDecision(args);
}

function parsePlannerMessageMetadata(raw: string | null): {
  task_execution?: TaskExecutionDecision;
  source_message_id?: string;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      task_execution: readTaskExecutionDecisionObject(parsed) ?? undefined,
      source_message_id: typeof parsed.source_message_id === 'string' ? parsed.source_message_id : undefined,
    };
  } catch {
    return {};
  }
}

async function buildMemorySkillContext(input: {
  projectId: string;
  roomId: string;
  message: string;
}): Promise<string> {
  try {
    const skills = await selectSkills({
      runtimeScopes: ['memory'],
      projectId: input.projectId,
      roomId: input.roomId,
      message: input.message,
    });
    return formatSkillPrompt(skills);
  } catch (err) {
    console.warn(`[skills] failed to build memory skill context: ${(err as Error).message}`);
    return '';
  }
}

export async function runAgentOnce(input: RespondAsAgentInput): Promise<{
  run: AgentRun;
  message: Message;
  status: AgentRunStatus;
}> {
  return new Promise((resolve, reject) => {
    void respondAsAgent({
      ...input,
      onFinished: async (result) => {
        resolve(result);
        if (input.onFinished) await input.onFinished(result);
      },
    }).catch(reject);
  });
}


function formatActivityChunk(chunk: string): string {
  const text = chunk.trim();
  if (!text) return '';
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function newRequestId(): string {
  return nanoid(12);
}
