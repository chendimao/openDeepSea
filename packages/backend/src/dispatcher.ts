import { resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import { getAdapter } from './acp/index.js';
import type { AcpStreamTrace } from './acp/types.js';
import { buildAgentRuntimeContextPrompt, resolveAgentRuntimeProfile } from './agent-runtime.js';
import { generateModelChatReply, isModelChatConfigured, type ModelChatInvoker } from './chat-model.js';
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
  MessageTrace,
  MessageReplyMetadata,
  PlannerDecision,
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

  await runTargets({
    targets: routing.targets,
    projectPath: project.path,
    roomId,
    sourceMessageId: userMessage.id,
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
}): { targets: { agent: RoomAgent; prompt: string; internalMessage?: boolean }[] } {
  if (args.explicitlyMentionedAgents.length > 0) {
    return {
      targets: args.explicitlyMentionedAgents.map((agent) => ({ agent, prompt: args.prompt })),
    };
  }
  if (args.mode === 'mentions_only' || !args.fallbackAgentId) return { targets: [] };
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

  const onTrace = (channel: 'thinking' | 'tool' | 'command', chunk: string, trace?: AcpStreamTrace): void => {
    const text = chunk.trim();
    if (!text) return;
    const updatedMessage = messageRepo.mergeTrace(placeholder.id, toTracePatch(channel, text, trace));
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
    }
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
        else if (chunk.stream === 'stdout' && chunk.channel === 'thinking') onTrace('thinking', chunk.text, chunk.trace);
        else if (chunk.stream === 'stdout' && chunk.channel === 'tool') onTrace('tool', chunk.text, chunk.trace);
        else if (chunk.stream === 'stdout' && chunk.channel === 'command') onTrace('command', chunk.text, chunk.trace);
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
          annotatePlannerDecision({
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

function annotatePlannerDecision(input: {
  message: Message;
  run: AgentRun;
  sourceMessageId?: string | null;
  agent: RoomAgent;
}): void {
  if (input.run.status !== 'completed') return;
  if (input.run.workflow_run_id || input.run.task_id || input.run.collaboration_run_id) return;
  if (input.agent.agent_id !== 'planner') return;

  const decision = parsePlannerDecision(input.message.content);
  if (!decision) return;
  messageRepo.mergeMetadata(input.message.id, {
    planner_decision: decision,
    source_message_id: input.sourceMessageId ?? undefined,
  });
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
  for (const candidate of extractJsonObjectCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const decision = readPlannerDecisionObject(parsed);
      if (decision) return decision;
    } catch {
      // Ignore malformed JSON blocks.
    }
  }
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

function readPlannerDecisionObject(value: unknown): PlannerDecision | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.planner_decision) ? value.planner_decision : value;
  if (
    !isPlannerExecutionMode(candidate.mode) ||
    !isPlannerDecisionStatus(candidate.status) ||
    typeof candidate.summary !== 'string' ||
    !candidate.summary.trim() ||
    typeof candidate.awaiting_user_confirmation !== 'boolean' ||
    !Array.isArray(candidate.next_steps)
  ) {
    return null;
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
    mode: candidate.mode,
    status: candidate.status,
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
  return value === 'pause_after_suggestion' || value === 'auto_continue';
}

function isPlannerDecisionStatus(value: unknown): value is PlannerDecision['status'] {
  return value === 'suggested' || value === 'dispatching' || value === 'completed' || value === 'blocked';
}

function buildPlannerDecisionPrompt(): string[] {
  return [
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
  ];
}

function toTracePatch(
  channel: 'thinking' | 'tool' | 'command',
  text: string,
  trace?: AcpStreamTrace,
): MessageTrace {
  if (trace?.kind === 'thinking') return { thinking: [{ text: trace.text }] };
  if (trace?.kind === 'tool') return { tool_calls: [{ name: trace.name, input: trace.input, output: trace.output }] };
  if (trace?.kind === 'command') return { commands: [{ command: trace.command, output: trace.output }] };
  if (channel === 'thinking') return { thinking: [{ text }] };
  if (channel === 'tool') return { tool_calls: [{ name: 'trace', input: text }] };
  return { commands: [{ command: text }] };
}

async function dispatchPlannerDecision(args: {
  roomId: string;
  sourceMessageId: string;
  decision: PlannerDecision;
}): Promise<void> {
  const room = roomRepo.get(args.roomId);
  if (!room) throw new Error('room not found');
  const project = projectRepo.get(room.project_id);
  if (!project) throw new Error('project not found');
  const allAgents = roomAgentRepo.listByRoom(args.roomId);
  const targets = args.decision.next_steps
    .map((step) => {
      const agent = allAgents.find((item) => item.agent_id === step.agent_id);
      return agent ? { agent, prompt: step.goal } : null;
    })
    .filter((target): target is { agent: RoomAgent; prompt: string } => Boolean(target));
  if (targets.length === 0) return;
  await runTargets({
    targets,
    projectPath: project.path,
    roomId: args.roomId,
    sourceMessageId: args.sourceMessageId,
  });
}

export async function continueLatestPlannerDecision(args: { roomId: string }): Promise<boolean> {
  const plannerMessage = messageRepo
    .listByRoom(args.roomId, 200)
    .slice()
    .reverse()
    .find((message) => {
      if (message.sender_type !== 'agent' || message.sender_id !== 'planner') return false;
      const metadata = parsePlannerMessageMetadata(message.metadata);
      return Boolean(metadata.planner_decision);
    });
  if (!plannerMessage) return false;
  const metadata = parsePlannerMessageMetadata(plannerMessage.metadata);
  if (!metadata.planner_decision || !metadata.planner_decision.awaiting_user_confirmation) return false;
  await dispatchPlannerDecision({
    roomId: args.roomId,
    sourceMessageId: metadata.source_message_id ?? plannerMessage.id,
    decision: metadata.planner_decision,
  });
  return true;
}

export async function dispatchPlannerDecisionForRoom(args: {
  roomId: string;
  sourceMessageId: string;
  decision: PlannerDecision;
}): Promise<void> {
  await dispatchPlannerDecision(args);
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
