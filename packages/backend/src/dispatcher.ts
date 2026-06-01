import { resolve, sep } from 'node:path';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { nanoid } from 'nanoid';
import { getAdapter } from './acp/index.js';
import { isProtocolEvent, normalizeProtocolEvent } from './acp/protocol-events.js';
import { normalizeKnownProviderEvent, normalizeTimelineEventFromTrace } from './acp/timeline.js';
import type { AcpSessionHandoffMode, AcpStreamChunk, AcpStreamTrace } from './acp/types.js';
import { buildAgentRuntimeContextPrompt, resolveAgentRuntimeProfile } from './agent-runtime.js';
import { generateModelChatReply, invokeConfiguredModelText, isModelChatConfigured, type ModelChatInvoker } from './chat-model.js';
import { classifyAgentDocument } from './agent-document-classifier.js';
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
  PlannerDecision,
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
const MAX_PLANNER_AUTO_CONTINUE_DEPTH = 5;

interface PlannerDispatchAddedAgent {
  agent_id: string;
  agent_name: string;
}

interface PlannerDispatchResult {
  dispatched: number;
  added_agents: PlannerDispatchAddedAgent[];
  deferred_steps: PlannerDecision['next_steps'];
}

interface PlannerDispatchedTarget {
  agent: RoomAgent;
  prompt: string;
  step: PlannerDecision['next_steps'][number];
}

interface TargetRunResult {
  message: Message | undefined;
  run: AgentRun | undefined;
  status: AgentRunStatus | 'failed';
  error: string | null;
}

interface PlannerExecutionPlanDecision {
  mode: 'parallel' | 'serial';
  dispatch_step_indexes: number[];
  deferred_step_indexes: number[];
  rationale: string;
}

export interface PlannerExecutionPlanInvoker {
  invoke(input: {
    room: Room;
    targets: PlannerDispatchTarget[];
    sourceMessage: Message | undefined;
  }): Promise<PlannerExecutionPlanDecision | null>;
}

interface PlannerDispatchTarget {
  agent: RoomAgent;
  prompt: string;
  step: PlannerDecision['next_steps'][number];
}

let plannerExecutionPlanInvoker: PlannerExecutionPlanInvoker | undefined;

export function setPlannerExecutionPlanInvokerForTest(invoker?: PlannerExecutionPlanInvoker): void {
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
  targets: { agent: RoomAgent; prompt: string; internalMessage?: boolean }[];
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
}): { targets: { agent: RoomAgent; prompt: string; internalMessage?: boolean }[] } {
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

  if (identityLines.length <= 1) return prompt;

  const promptParts = [
    '你的智能体身份：',
    ...identityLines,
    ...(agent.agent_id === 'planner' ? buildPlannerDecisionPrompt() : []),
    '',
    '当前用户请求：',
    prompt,
  ];

  return promptParts.join('\n');
}

export async function respondAsAgent(args: RespondAsAgentInput): Promise<void> {
  const { agent, projectPath, roomId } = args;
  const room = roomRepo.get(roomId);
  const promptWithIdentity = buildAgentIdentityPrompt(agent, args.prompt);
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
  const prompt = superpowersBootstrap.prompt;
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
  const acpSessionId = taskExecutor?.acp_session_id ?? agent.acp_session_id;
  const sessionHandoff = buildSessionHandoffForAgent({
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

  const broadcastAnswerChunk = (chunk: string): void => {
    restoreRunStatusAfterRetry();
    messageRepo.appendChunk(placeholder.id, chunk);
    agentRunRepo.appendStdout(run.id, chunk);
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
      acpPermissionMode: runtimeProfile.acpPermissionMode,
      acpWritableDirs: runtimeProfile.writableDirs,
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
        try {
          finalMessage = sanitizePlannerCasualReply({
            message: finalMessage,
            run: finalRun,
            sourceMessageId: args.sourceMessageId,
            agent,
          }) ?? finalMessage;
          annotatePlannerDecision({
            message: finalMessage,
            run: finalRun,
            sourceMessageId: args.sourceMessageId,
            agent,
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

function annotatePlannerDecision(input: {
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
    ? parsePlannerDecision(input.message.content)
    : parseExplicitPlannerDecision(input.message.content);
  if (!decision) return;
  messageRepo.mergeMetadata(input.message.id, {
    planner_decision: decision,
    source_message_id: input.sourceMessageId ?? undefined,
  });
}

function sanitizePlannerCasualReply(input: {
  message: Message;
  run: AgentRun;
  sourceMessageId?: string | null;
  agent: RoomAgent;
}): Message | undefined {
  if (input.run.workflow_run_id || input.run.task_id || input.run.collaboration_run_id) return undefined;
  if (input.run.status !== 'completed') return undefined;
  if (input.agent.agent_id !== 'planner') return undefined;
  if (!input.sourceMessageId) return undefined;
  const sourceMessage = messageRepo.get(input.sourceMessageId);
  if (!sourceMessage || !isCasualChatSourceMessage(sourceMessage)) return undefined;
  if (!hasPlannerCasualReplyNoise(input.message.content)) return undefined;
  const cleaned = extractConciseCasualReply(input.message.content);
  return cleaned && cleaned !== input.message.content
    ? messageRepo.updateContent(input.message.id, cleaned)
    : undefined;
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
  return /using-superpowers|workflow 判断|入口 workflow|内部流程|技能使用|planner_decision|task_readiness/u.test(content);
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
  const concise = candidate
    .replace(/已按.*$/u, '')
    .replace(/当前.*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^我在/u.test(concise)) return concise.endsWith('。') ? concise : `${concise.replace(/[.!！]+$/u, '')}。`;
  if (/^在/u.test(concise)) return '我在。';
  return '我在。';
}

function isShortGreeting(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return /^(hi|hello|hey|你好|您好|嗨|在吗|在不在)[。.!！?？\s]*$/u.test(normalized);
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

function parsePlannerDecision(content: string): PlannerDecision | null {
  const explicitDecision = parseExplicitPlannerDecision(content);
  if (explicitDecision) return explicitDecision;

  const summary = content
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!summary) return null;
  return {
    mode: 'pause_after_suggestion',
    status: 'suggested',
    summary,
    next_steps: [],
    awaiting_user_confirmation: true,
  };
}

function parseExplicitPlannerDecision(content: string): PlannerDecision | null {
  for (const candidate of extractJsonObjectCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const decision = readPlannerDecisionObject(parsed);
      if (decision) return decision;
    } catch {
      // Ignore malformed JSON blocks.
    }
  }
  return null;
}

function readPlannerDecisionObject(value: unknown): PlannerDecision | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.planner_decision) ? value.planner_decision : value;
  if (
    typeof candidate.summary !== 'string' ||
    !candidate.summary.trim() ||
    typeof candidate.awaiting_user_confirmation !== 'boolean' ||
    !Array.isArray(candidate.next_steps)
  ) {
    return null;
  }

  const hasValidNextSteps = Array.isArray(candidate.next_steps) && candidate.next_steps.length > 0;
  const mode: PlannerDecision['mode'] = isPlannerExecutionMode(candidate.mode)
    ? candidate.mode
    : hasValidNextSteps ? 'pause_after_suggestion' : 'pause_after_suggestion';
  const status: PlannerDecision['status'] = isPlannerDecisionStatus(candidate.status)
    ? candidate.status
    : hasValidNextSteps ? 'suggested' : 'suggested';

  if (!isPlannerExecutionMode(candidate.mode) && candidate.mode !== undefined) {
    console.warn(`[planner_decision] unknown mode "${candidate.mode}", falling back to "${mode}"`);
  }
  if (!isPlannerDecisionStatus(candidate.status) && candidate.status !== undefined) {
    console.warn(`[planner_decision] unknown status "${candidate.status}", falling back to "${status}"`);
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
    .filter((step): step is PlannerDecision['next_steps'][number] => Boolean(step));

  return {
    mode,
    status,
    summary: candidate.summary.trim(),
    next_steps,
    awaiting_user_confirmation: candidate.awaiting_user_confirmation,
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

function isPlannerExecutionMode(value: unknown): value is PlannerDecision['mode'] {
  return value === 'pause_after_suggestion' || value === 'auto_continue' || value === 'dispatch_next';
}

function isPlannerDecisionStatus(value: unknown): value is PlannerDecision['status'] {
  return value === 'suggested' || value === 'dispatching' || value === 'completed' || value === 'blocked' || value === 'needs_fix';
}

function buildPlannerDecisionPrompt(): string[] {
  return [
    '',
    'Planner 普通消息回复规则：',
    '- 普通问候、闲聊或信息不足时，只输出简短自然回复，例如“我在”。',
    '- 不要解释内部流程、workflow 判断、技能使用或 using-superpowers。',
    '- 不要追加 planner_decision 或 task_readiness JSON。',
    '- 只有用户提出明确规划、实现、修复、任务拆解或调度需求时，才进入下面的结构化输出规则。',
    '',
    'Planner 决策结构化输出规则：',
    '- 当你需要建议下一步或调度其他智能体时，请在自然语言回复后追加一个单独的 ```json 代码块。',
    '- 字段名必须固定为 planner_decision。',
    '- 若需要等待用户确认，mode 使用 "pause_after_suggestion"，awaiting_user_confirmation 为 true。',
    '- 固定 JSON 结构如下：',
    '```json',
    '{',
    '  "planner_decision": {',
    '    "mode": "pause_after_suggestion",',
    '    "status": "suggested",',
    '    "summary": "一句话总结下一步",',
    '    "next_steps": [',
    '      { "agent_id": "frontend-executor", "goal": "检查设置页测试入口" }',
    '    ],',
    '    "awaiting_user_confirmation": true',
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

async function dispatchPlannerDecision(args: {
  roomId: string;
  sourceMessageId: string;
  decision: PlannerDecision;
  autoContinueDepth?: number;
}): Promise<PlannerDispatchResult> {
  const room = roomRepo.get(args.roomId);
  if (!room) throw new Error('room not found');
  const project = projectRepo.get(room.project_id);
  if (!project) throw new Error('project not found');
  const { targets, addedAgents, missingAgentIds } = resolvePlannerDispatchTargets(args.roomId, args.decision);
  const sourceMessage = messageRepo.get(args.sourceMessageId);
  const taskId = getMessageTaskId(sourceMessage?.metadata ?? null);
  const executionPlan = await resolvePlannerStepExecutionPlan({
    room,
    sourceMessage,
    targets,
  });
  if (executionPlan.dispatchTargets.length === 0 || missingAgentIds.length > 0) {
    const requestedAgentIds = args.decision.next_steps.map((step) => step.agent_id).filter(Boolean);
    throw new Error(
      missingAgentIds.length > 0
        ? `planner decision has no matching room or global agents: ${missingAgentIds.join(', ')}`
        : requestedAgentIds.length > 0
          ? `planner decision has no matching room or global agents: ${requestedAgentIds.join(', ')}`
        : 'planner decision has no next steps to dispatch',
    );
  }
  const results = await runTargets({
    targets: executionPlan.dispatchTargets,
    projectPath: project.path,
    roomId: args.roomId,
    sourceMessageId: args.sourceMessageId,
    taskId,
  });
  await reportPlannerDispatchResults({
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

async function resolvePlannerStepExecutionPlan(input: {
  room: Room;
  sourceMessage: Message | undefined;
  targets: PlannerDispatchTarget[];
}): Promise<{
  dispatchTargets: PlannerDispatchedTarget[];
  deferredSteps: PlannerDecision['next_steps'];
}> {
  const llmDecision = await resolvePlannerExecutionPlanWithModel(input);
  const selectedIndexes = sanitizePlannerExecutionIndexes(
    llmDecision?.dispatch_step_indexes,
    input.targets.length,
  );
  const fallbackIndexes = input.targets.length > 0 ? [0] : [];
  const dispatchIndexes = selectedIndexes.length > 0 ? selectedIndexes : fallbackIndexes;
  const dispatchIndexSet = new Set(dispatchIndexes);
  const deferredIndexes = sanitizePlannerExecutionIndexes(
    llmDecision?.deferred_step_indexes,
    input.targets.length,
  ).filter((index) => !dispatchIndexSet.has(index));
  const coveredIndexSet = new Set([...dispatchIndexes, ...deferredIndexes]);
  for (let index = 0; index < input.targets.length; index += 1) {
    if (!coveredIndexSet.has(index)) deferredIndexes.push(index);
  }

  return {
    dispatchTargets: dispatchIndexes.map((index) => input.targets[index]).filter(isPlannerDispatchTarget)
      .map((target) => ({ agent: target.agent, prompt: target.prompt, step: target.step })),
    deferredSteps: deferredIndexes.map((index) => input.targets[index]).filter(isPlannerDispatchTarget)
      .map((target) => target.step),
  };
}

function isPlannerDispatchTarget(value: PlannerDispatchTarget | undefined): value is PlannerDispatchTarget {
  return Boolean(value);
}

async function resolvePlannerExecutionPlanWithModel(input: {
  room: Room;
  sourceMessage: Message | undefined;
  targets: PlannerDispatchTarget[];
}): Promise<PlannerExecutionPlanDecision | null> {
  const invoker = plannerExecutionPlanInvoker ?? defaultPlannerExecutionPlanInvoker;
  try {
    return await invoker.invoke(input);
  } catch (err) {
    console.warn(`[planner-dispatch] LLM execution plan failed, falling back to serial: ${(err as Error).message}`);
    return null;
  }
}

const defaultPlannerExecutionPlanInvoker: PlannerExecutionPlanInvoker = {
  async invoke(input) {
    if (!isModelChatConfigured()) return null;
    const text = await invokeConfiguredModelText(buildPlannerExecutionPlanMessages(input));
    return parsePlannerExecutionPlanDecision(text);
  },
};

function buildPlannerExecutionPlanMessages(input: {
  room: Room;
  sourceMessage: Message | undefined;
  targets: PlannerDispatchTarget[];
}): Array<SystemMessage | HumanMessage> {
  return [
    new SystemMessage([
      '你是 OpenDeepSea 的调度策略模型。',
      '任务：判断 planner_decision.next_steps 应该第一批并行执行哪些步骤，哪些步骤必须等第一批结果返回 planner 后再执行。',
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

function parsePlannerExecutionPlanDecision(text: string): PlannerExecutionPlanDecision | null {
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

function sanitizePlannerExecutionIndexes(value: unknown, length: number): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  for (const item of value) {
    if (!Number.isInteger(item) || item < 0 || item >= length || seen.has(item)) continue;
    seen.add(item);
  }
  return Array.from(seen);
}

function resolvePlannerDispatchTargets(
  roomId: string,
  decision: PlannerDecision,
): {
  targets: PlannerDispatchTarget[];
  addedAgents: PlannerDispatchAddedAgent[];
  missingAgentIds: string[];
} {
  const agentsById = new Map(roomAgentRepo.listByRoom(roomId).map((agent) => [agent.agent_id, agent]));
  const globalAgentsByRequestedId = new Map<string, Agent>();
  const addedAgentsById = new Map<string, PlannerDispatchAddedAgent>();
  const missingAgentIds: string[] = [];

  for (const step of decision.next_steps) {
    if (agentsById.has(step.agent_id)) {
      continue;
    }
    const globalAgent = resolveGlobalAgentForPlannerStep(step);
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
    .filter((target): target is PlannerDispatchTarget =>
      Boolean(target),
    );

  return {
    targets,
    addedAgents: Array.from(addedAgentsById.values()),
    missingAgentIds,
  };
}

async function reportPlannerDispatchResults(args: {
  roomId: string;
  projectPath: string;
  sourceMessageId: string;
  taskId?: string | null;
  decision: PlannerDecision;
  dispatchedTargets: PlannerDispatchedTarget[];
  dispatchedResults: TargetRunResult[];
  deferredSteps: PlannerDecision['next_steps'];
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
      `  返回摘要：${summarizePlannerDispatchResult(content)}`,
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
    '- 如果任务已完成，输出 status 为 "completed" 且 next_steps 为空的 planner_decision。',
    '- 如果还需要修复、审查、测试或验收，输出新的 planner_decision，只包含下一轮要派发的智能体。',
    '- 如果无法继续，输出 status 为 "blocked" 并说明原因。',
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
      const decision = metadata.planner_decision;
      if (!shouldAutoContinuePlannerDecision(decision)) return;
      if (args.autoContinueDepth >= MAX_PLANNER_AUTO_CONTINUE_DEPTH) {
        const blockedDecision = normalizeBlockedAutoContinuePlannerDecision(
          decision,
          `自动续派发已达到上限 ${MAX_PLANNER_AUTO_CONTINUE_DEPTH}，已暂停后续派发。`,
        );
        const updatedMessage = messageRepo.mergeMetadata(latestMessage.id, {
          planner_decision: blockedDecision,
          source_message_id: args.sourceMessageId,
        });
        if (updatedMessage) broadcastAgentMessageSnapshot({
          roomId: args.roomId,
          message: updatedMessage,
          run,
        });
        console.warn(`[planner-dispatch] auto-continue depth limit reached for source message ${args.sourceMessageId}`);
        return;
      }
      const autoDecision = normalizeAutoContinuePlannerDecision(decision);
      const updatedMessage = messageRepo.mergeMetadata(latestMessage.id, {
        planner_decision: autoDecision,
        source_message_id: args.sourceMessageId,
      });
      if (updatedMessage) broadcastAgentMessageSnapshot({
        roomId: args.roomId,
        message: updatedMessage,
        run,
      });
      try {
        await dispatchPlannerDecision({
          roomId: args.roomId,
          sourceMessageId: args.sourceMessageId,
          decision: autoDecision,
          autoContinueDepth: args.autoContinueDepth + 1,
        });
      } catch (err) {
        const error = (err as Error).message;
        const blockedDecision = normalizeBlockedAutoContinuePlannerDecision(autoDecision, `自动续派发失败：${error}`);
        const blockedMessage = messageRepo.mergeMetadata(latestMessage.id, {
          planner_decision: blockedDecision,
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

function summarizePlannerDispatchResult(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 800) return normalized;
  return `${normalized.slice(0, 520)} ... ${normalized.slice(-220)}`;
}

function shouldAutoContinuePlannerDecision(decision: PlannerDecision | undefined): decision is PlannerDecision {
  return Boolean(decision && decision.status === 'suggested' && decision.next_steps.length > 0);
}

function normalizeAutoContinuePlannerDecision(decision: PlannerDecision): PlannerDecision {
  return {
    ...decision,
    mode: 'auto_continue',
    awaiting_user_confirmation: false,
  };
}

function normalizeBlockedAutoContinuePlannerDecision(decision: PlannerDecision, summary: string): PlannerDecision {
  return {
    ...decision,
    mode: 'auto_continue',
    status: 'blocked',
    summary,
    next_steps: [],
    awaiting_user_confirmation: false,
  };
}

function resolveGlobalAgentForPlannerStep(step: PlannerDecision['next_steps'][number]): Agent | undefined {
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

function findBestGlobalAgentMatch(step: PlannerDecision['next_steps'][number]): Agent | undefined {
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

export async function continueLatestPlannerDecision(args: { roomId: string }): Promise<{ accepted: boolean } & PlannerDispatchResult> {
  const plannerMessage = messageRepo
    .listByRoom(args.roomId, 200)
    .slice()
    .reverse()
    .find((message) => {
      if (message.sender_type !== 'agent' || message.sender_id !== 'planner') return false;
      const metadata = parsePlannerMessageMetadata(message.metadata);
      return Boolean(metadata.planner_decision);
    });
  if (!plannerMessage) return { accepted: false, dispatched: 0, added_agents: [], deferred_steps: [] };
  const metadata = parsePlannerMessageMetadata(plannerMessage.metadata);
  if (!metadata.planner_decision || !metadata.planner_decision.awaiting_user_confirmation) {
    return { accepted: false, dispatched: 0, added_agents: [], deferred_steps: [] };
  }
  const result = await dispatchPlannerDecision({
    roomId: args.roomId,
    sourceMessageId: metadata.source_message_id ?? plannerMessage.id,
    decision: metadata.planner_decision,
  });
  return {
    accepted: true,
    dispatched: result.dispatched,
    added_agents: result.added_agents,
    deferred_steps: result.deferred_steps,
  };
}

export async function dispatchPlannerDecisionForRoom(args: {
  roomId: string;
  sourceMessageId: string;
  decision: PlannerDecision;
}): Promise<PlannerDispatchResult> {
  return dispatchPlannerDecision(args);
}

function parsePlannerMessageMetadata(raw: string | null): {
  planner_decision?: PlannerDecision;
  source_message_id?: string;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      planner_decision: readPlannerDecisionObject(parsed) ?? undefined,
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
