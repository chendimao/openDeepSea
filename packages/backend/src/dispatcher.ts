import { resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import { getAdapter } from './acp/index.js';
import { buildAgentRuntimeContextPrompt, resolveAgentRuntimeProfile } from './agent-runtime.js';
import { generateModelChatReply, isModelChatConfigured, type ModelChatInvoker } from './chat-model.js';
import { buildCollaborationDecisionPrompt, parseCollaborationDecision } from './collaboration-decision.js';
import { classifyAgentDocument } from './agent-document-classifier.js';
import { appendMemoryContextForPromptSafely } from './memory/context.js';
import { distillFromConversation, type MemoryDistillModelInvoker } from './memory/distill.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { fileRepo } from './repos/files.js';
import { memoryRepo } from './repos/memory.js';
import { messageRepo } from './repos/messages.js';
import { projectRepo } from './repos/projects.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { settingsRepo } from './repos/settings.js';
import { formatSkillPrompt } from './skills/prompt.js';
import { selectSkills } from './skills/selector.js';
import { runRegistry } from './run-registry.js';
import { messageUploadDir, messageUploadRoute, projectFileUploadRoot, projectFileUploadRoute } from './uploads.js';
import { wsHub } from './ws-hub.js';
import type {
  AgentRun,
  AgentRunStatus,
  Message,
  MessageAttachmentMetadata,
  MessageReplyMetadata,
  RoomAgent,
  WorkflowStage,
} from './types.js';

const AGENT_RUN_HEARTBEAT_MS = 30_000;

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
  const promptWithAttachments = buildPromptWithResolvedMessageContext(
    userMessage.content,
    messageAttachments,
    getResolvedMessageReply(userMessage),
  );
  const imagePaths = messageAttachments
    .filter((attachment) => attachment.metadata.isImage && attachment.localPath)
    .map((attachment) => attachment.localPath!);
  const routing = resolveInitialTargets({
    allAgents,
    explicitlyMentionedAgents,
    fallbackAgentId: settings.fallback_agent_id,
    mode: settings.message_routing_mode,
    prompt: promptWithAttachments,
    imagePaths,
  });
  if (routing.targets.length === 0) {
    await respondWithConfiguredModel({
      project,
      room,
      userMessage,
      invoker: args.modelChatInvoker,
    });
    return;
  }

  const responses = await runTargets({
    targets: routing.targets,
    projectPath: project.path,
    roomId,
    sourceMessageId: userMessage.id,
    imagePaths,
    distillModelInvoker: args.distillModelInvoker,
  });

  const fallbackTarget = routing.targets[0];
  const fallbackResponse = responses[0]?.content;
  if (routing.after === 'decision_from_planner_fallback' && fallbackTarget && fallbackResponse) {
    try {
      const decision = parseCollaborationDecision(fallbackResponse);
      const decisionMessage = messageRepo.create({
        room_id: roomId,
        sender_type: 'system',
        sender_id: 'system',
        sender_name: 'System',
        content: '已生成协作模式选择',
        message_type: 'system',
        metadata: {
          event_type: 'collaboration_decision',
          collaboration_decision: decision,
          source_message_id: userMessage.id,
          fallback_agent_id: fallbackTarget.agent.agent_id,
        },
      });
      wsHub.broadcast(roomId, { type: 'message:new', roomId, message: decisionMessage });
    } catch (error) {
      console.warn(
        `[dispatcher] planner fallback decision parse failed: roomId=${roomId} sourceMessageId=${userMessage.id} fallbackAgentId=${fallbackTarget.agent.agent_id} error=${(error as Error).message}`,
      );
      const errorMessage = messageRepo.create({
        room_id: roomId,
        sender_type: 'system',
        sender_id: 'system',
        sender_name: 'System',
        content: `Planner 协作决策解析失败：${(error as Error).message}`,
        message_type: 'system',
        metadata: {
          event_type: 'collaboration_decision_failed',
          source_message_id: userMessage.id,
          fallback_agent_id: fallbackTarget.agent.agent_id,
        },
      });
      wsHub.broadcast(roomId, { type: 'message:new', roomId, message: errorMessage });
    }
  }
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
): string {
  const content = userPrompt.trim() || '用户发送了一条仅包含附件的消息。';
  const sections = [content];

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
  imagePaths?: string[];
  distillModelInvoker?: MemoryDistillModelInvoker;
}): Promise<Array<Message | undefined>> {
  return Promise.all(
    args.targets.map(async (target) => {
      let finalMessage: Message | undefined;
      await respondAsAgent({
        agent: target.agent,
        projectPath: args.projectPath,
        roomId: args.roomId,
        prompt: target.prompt,
        internalMessage: target.internalMessage,
        imagePaths: args.imagePaths,
        sourceMessageId: args.sourceMessageId,
        distillModelInvoker: args.distillModelInvoker,
        onFinished: ({ message }) => {
          finalMessage = message;
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
      });
      return finalMessage;
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
}): { targets: { agent: RoomAgent; prompt: string; internalMessage?: boolean }[]; after?: 'decision_from_planner_fallback' } {
  if (args.explicitlyMentionedAgents.length > 0) {
    return {
      targets: args.explicitlyMentionedAgents.map((agent) => ({ agent, prompt: args.prompt })),
    };
  }
  if (args.mode === 'mentions_only' || !args.fallbackAgentId) return { targets: [] };
  const fallbackAgent = args.allAgents.find((agent) => agent.agent_id === args.fallbackAgentId);
  if (!fallbackAgent) return { targets: [] };
  const shouldAskForDecision =
    fallbackAgent.agent_id === 'planner' && shouldRequestCollaborationDecision(args.prompt);
  const prompt = shouldAskForDecision
    ? buildPlannerFallbackDecisionPrompt(args.prompt, args.allAgents, fallbackAgent)
    : args.prompt;
  return {
    targets: [{ agent: fallbackAgent, prompt, internalMessage: shouldAskForDecision }],
    after: shouldAskForDecision ? 'decision_from_planner_fallback' : undefined,
  };
}

function buildPlannerFallbackDecisionPrompt(
  userPrompt: string,
  allAgents: RoomAgent[],
  fallbackAgent: RoomAgent,
): string {
  const agents = allAgents
    .filter((agent) => agent.id !== fallbackAgent.id)
    .map((agent) => ({
      agent_id: agent.agent_id,
      agent_name: agent.agent_name,
      agent_role: agent.agent_role,
      workflow_role: agent.workflow_role ?? null,
    }));
  return buildCollaborationDecisionPrompt({
    userPrompt,
    agents,
  });
}

export function shouldRequestCollaborationDecision(prompt: string): boolean {
  const normalized = prompt.trim().toLocaleLowerCase();
  if (!normalized) return false;

  const discussionSignals = [
    /是否/,
    /合理/,
    /怎么看/,
    /如何看待/,
    /分析/,
    /解释/,
    /为什么/,
    /原因/,
    /方案/,
    /建议/,
    /能不能/,
    /可以吗/,
    /\bwhy\b/,
    /\bwhat\b/,
    /\bhow\b/,
    /\banaly[sz]e\b/,
    /\bexplain\b/,
  ];
  const explicitTaskSignals = [
    /开始任务/,
    /启动任务/,
    /执行任务/,
    /开始执行/,
    /方案.*执行/,
    /执行.*方案/,
    /开始处理/,
    /直接处理/,
    /帮我做/,
    /帮我修/,
    /帮我实现/,
    /细化.*功能/,
    /功能.*细化/,
    /完善.*功能/,
    /功能.*完善/,
    /优化.*功能/,
    /功能.*优化/,
    /请修复/,
    /修复/,
    /修一下/,
    /实现/,
    /开发/,
    /写代码/,
    /改代码/,
    /提交/,
    /\bfix\b/,
    /\bimplement\b/,
    /\bbuild\b/,
    /\bcommit\b/,
  ];

  const hasTaskSignal = explicitTaskSignals.some((pattern) => pattern.test(normalized));
  if (!hasTaskSignal) return false;

  const hasDiscussionSignal = discussionSignals.some((pattern) => pattern.test(normalized));
  const hasStrongTaskSignal = [
    /开始任务/,
    /启动任务/,
    /执行任务/,
    /开始执行/,
    /方案.*执行/,
    /执行.*方案/,
    /开始处理/,
    /直接处理/,
    /请修复/,
    /帮我修/,
    /帮我实现/,
    /细化.*功能/,
    /功能.*细化/,
    /完善.*功能/,
    /功能.*完善/,
    /优化.*功能/,
    /功能.*优化/,
    /\bcommit\b/,
  ].some((pattern) => pattern.test(normalized));
  return hasStrongTaskSignal || !hasDiscussionSignal;
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

  return [
    '你的智能体身份：',
    ...identityLines,
    '',
    '当前用户请求：',
    prompt,
  ].join('\n');
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
  const prompt =
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
  const backend = agent.acp_enabled && agent.acp_backend ? agent.acp_backend : null;
  if (!backend) {
    throw new Error(`Agent ${agent.agent_name} has no ACP backend configured`);
  }
  const run = agentRunRepo.create({
    room_id: roomId,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend,
    session_key: null,
    acp_session_id: agent.acp_session_id,
    task_id: args.taskId,
    workflow_run_id: args.workflowRunId,
    workflow_step_id: args.workflowStepId,
    workflow_stage: args.workflowStage,
    collaboration_run_id: args.collaborationRunId,
    collaboration_stage: args.collaborationStage,
    prompt,
  });
  const controller = runRegistry.create(run.id);
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
      acp_session_id: agent.acp_session_id,
      internal: args.internalMessage ? true : undefined,
    },
  });
  if (!args.internalMessage) {
    wsHub.broadcast(roomId, { type: 'message:new', roomId, message: placeholder });
  }
  let streamSeq = 0;

  const onStdout = (chunk: string): void => {
    messageRepo.appendChunk(placeholder.id, chunk);
    const updated = agentRunRepo.appendStdout(run.id, chunk);
    if (updated) broadcastRun('agent_run:updated', updated);
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

  const onStderr = (chunk: string): void => {
    const updated = agentRunRepo.appendStderr(run.id, chunk);
    if (updated) broadcastRun('agent_run:updated', updated);
  };

  const onActivity = (chunk: string): void => {
    const text = formatActivityChunk(chunk);
    if (!text) return;
    const updated = agentRunRepo.appendActivity(run.id, text);
    if (updated) broadcastRun('agent_run:updated', updated);
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
      sessionId: agent.acp_session_id,
      prompt,
      imagePaths: args.imagePaths,
      acpPermissionMode: runtimeProfile.acpPermissionMode,
      acpWritableDirs: runtimeProfile.writableDirs,
      onChunk: (chunk) => {
        if (chunk.stream === 'stdout' && chunk.channel === 'activity') onActivity(chunk.text);
        else if (chunk.stream === 'stdout') onStdout(chunk.text);
        else onStderr(chunk.text);
      },
      onSession: (sessionId) => {
        const updated = agentRunRepo.updateStatus(run.id, 'running', {
          acp_session_id: sessionId,
        });
        if (updated) broadcastRun('agent_run:updated', updated);
      },
      signal: controller.signal,
    });
    if (result.sessionId) {
      const updated = agentRunRepo.updateStatus(run.id, 'running', {
        acp_session_id: result.sessionId,
      });
      if (updated) broadcastRun('agent_run:updated', updated);
    }
    // Persist newly minted session id if previously null
    if (!agent.acp_session_id && result.sessionId) {
      roomAgentRepo.setAcp(agent.id, {
        acp_enabled: true,
        acp_backend: agent.acp_backend,
        acp_session_id: result.sessionId,
        acp_session_label: agent.acp_session_label,
        acp_permission_mode: agent.acp_permission_mode,
        acp_writable_dirs: [],
      });
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
    const status: AgentRunStatus = controller.signal.aborted ? 'cancelled' : 'failed';
    const message = (err as Error).message;
    onStderr(`\n[error] ${message}`);
    finishRun(run.id, status, status === 'failed' ? message : null);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    runRegistry.remove(run.id);
    const finalRun = agentRunRepo.get(run.id);
    const finalMessage = messageRepo.get(placeholder.id);
    try {
      if (finalRun && finalMessage) {
        try {
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
      }
      if (finalRun && finalMessage && args.onFinished) {
        await args.onFinished({ run: finalRun, message: finalMessage, status: finalRun.status });
      }
    } finally {
      if (!args.internalMessage) {
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
      }
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
    if (updated) broadcastRun('agent_run:updated', updated);
  }
}

function annotateTaskReadiness(input: {
  message: Message;
  run: AgentRun;
  sourceMessageId?: string | null;
  agent: RoomAgent;
}): void {
  if (input.run.status !== 'completed') return;
  if (input.run.workflow_run_id || input.run.task_id || input.run.collaboration_run_id) return;
  if (input.agent.agent_id !== 'planner') return;

  const readiness = inferTaskReadiness(input.message.content, input.sourceMessageId);
  if (!readiness) return;
  messageRepo.mergeMetadata(input.message.id, { task_readiness: readiness });
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
  if (classification.decision !== 'auto_archive') {
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

export function inferTaskReadiness(content: string, sourceMessageId?: string | null): Record<string, unknown> | null {
  const text = content.trim();
  if (!text) return null;
  const normalized = text.toLocaleLowerCase();
  const executionIntent = inferTaskExecutionIntent(text);
  const hasImplementationScope = [
    /实施目标/,
    /实施范围/,
    /实施顺序/,
    /实施计划/,
    /工程排期/,
    /下一步交付物/,
    /可以进入工程排期/,
  ].some((pattern) => pattern.test(text));
  const hasAcceptance = [
    /验收标准/,
    /验收口径/,
    /验证方式/,
    /测试/,
    /build/,
    /npm run build/,
  ].some((pattern) => pattern.test(normalized));
  const asksForMoreInput = [
    /还需要/,
    /需要补充/,
    /请确认/,
    /请补充/,
    /缺少/,
    /待确认/,
  ].some((pattern) => pattern.test(text));
  if (!executionIntent || !hasAcceptance || asksForMoreInput) return null;
  if (isImplementationIntent(executionIntent) && !hasImplementationScope) return null;
  if (!isImplementationIntent(executionIntent) && !hasAnalysisReadinessSignal(text)) return null;

  return {
    ready: true,
    confidence: 0.82,
    title: extractTaskReadinessTitle(text),
    description: summarizeTaskReadinessDescription(text),
    missing_questions: [],
    recommended_mode: isImplementationIntent(executionIntent) ? 'formal_workflow' : 'chat_collaboration',
    execution_intent: executionIntent,
    source_message_id: sourceMessageId ?? undefined,
  };
}

type InferredTaskExecutionIntent =
  | 'analysis_only'
  | 'planning_only'
  | 'documentation_only'
  | 'implementation'
  | 'debug_fix'
  | 'review_only';

function inferTaskExecutionIntent(text: string): InferredTaskExecutionIntent | null {
  if (matchesAny(text, [
    /不进入实现/,
    /不修改代码/,
    /不改文件/,
    /只做方案/,
    /只做.*规则/,
    /只读分析/,
    /本轮不要求代码实现/,
    /未进入实现/,
  ])) return 'analysis_only';

  if (matchesAny(text, [/只做文档/, /文档说明/, /产品规则说明/])) return 'documentation_only';
  if (matchesAny(text, [/只做代码审查/, /review only/i, /审查.*不修改/])) return 'review_only';
  if (matchesAny(text, [/修复/, /bug/i, /故障/, /报错/, /阻塞/]) && matchesAny(text, [/实现/, /修改/, /改动/, /提交/])) return 'debug_fix';
  if (matchesAny(text, [/实施目标/, /实施范围/, /下一步可以进入工程排期/, /修改代码/, /实现/])) return 'implementation';
  return null;
}

function isImplementationIntent(intent: InferredTaskExecutionIntent): boolean {
  return intent === 'implementation' || intent === 'debug_fix';
}

function hasAnalysisReadinessSignal(text: string): boolean {
  return matchesAny(text, [
    /问题分析/,
    /原因分析/,
    /修复方案/,
    /方案设计/,
    /产品规则/,
    /边界/,
    /风险/,
    /后续实现输入/,
    /交付物/,
  ]);
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function extractTaskReadinessTitle(content: string): string {
  const titlePatterns = [
    /实施目标[：:]\s*([^\n。]+)/,
    /产品决策[：:]\s*([^\n。]+)/,
    /已锁定范围[：:]\s*([^\n。]+)/,
  ];
  for (const pattern of titlePatterns) {
    const match = content.match(pattern)?.[1]?.trim();
    if (match) return truncateTaskReadinessText(match, 80);
  }
  const firstMeaningfulLine = content
    .split(/\n+/)
    .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
    .find((line) => line && !/^大哥[，,]/.test(line));
  return truncateTaskReadinessText(firstMeaningfulLine || '根据 planner 方案启动任务', 80);
}

function summarizeTaskReadinessDescription(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return truncateTaskReadinessText(compact, 800);
}

function truncateTaskReadinessText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
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
