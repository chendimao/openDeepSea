import { db } from './db.js';
import { isMemorySourceConflictError, memoryRepo } from './repos/memory.js';
import { messageRepo } from './repos/messages.js';
import { roomRepo } from './repos/rooms.js';
import { settingsRepo } from './repos/settings.js';
import { taskRepo } from './repos/tasks.js';
import type {
  Message,
  MessageMetadata,
  Task,
  TaskCreatedFrom,
  TaskEventType,
  TaskInteractionMode,
  TaskPriority,
} from './types.js';
import { wsHub } from './ws-hub.js';

export interface CreateTaskWithConversationInput {
  roomId: string;
  actor?: {
    sender_id?: string;
    sender_name?: string;
  };
  taskInput: {
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    interaction_mode?: TaskInteractionMode;
    assigned_agent_id?: string | null;
    parent_task_id?: string | null;
  };
  origin: TaskCreatedFrom;
  sourceMessageId?: string | null;
  userFacingContent?: string;
  createUserMessage?: boolean;
}

export interface CreateTaskWithConversationResult {
  task: Task;
  userMessage: Message | null;
  systemMessage: Message;
}

interface RecordTaskEventInput {
  roomId: string;
  taskId: string;
  taskTitle?: string;
  workflowRunId?: string | null;
  workflowStepId?: string | null;
  eventType: TaskEventType;
  origin?: TaskCreatedFrom;
  content: string;
}

export function createTaskWithConversation(input: CreateTaskWithConversationInput): CreateTaskWithConversationResult {
  const room = roomRepo.get(input.roomId);
  if (!room) throw new Error('room not found');

  const title = input.taskInput.title.trim();
  if (!title) throw new Error('title is required');

  const normalizedSourceMessageId =
    input.sourceMessageId === null || input.sourceMessageId === undefined ? null : input.sourceMessageId.trim();
  if (input.sourceMessageId !== null && input.sourceMessageId !== undefined && !normalizedSourceMessageId) {
    throw new Error('source message id is empty');
  }

  let sourceMessage: Message | undefined;
  if (normalizedSourceMessageId) {
    sourceMessage = messageRepo.get(normalizedSourceMessageId);
    if (!sourceMessage) throw new Error('source message not found');
    if (sourceMessage.room_id !== input.roomId) throw new Error('source message room mismatch');
  }

  const shouldCreateUserMessage = input.createUserMessage !== false && !normalizedSourceMessageId;
  const interactionMode =
    input.taskInput.interaction_mode ?? settingsRepo.resolveForRoom(input.roomId)?.effective.interaction_mode ?? 'ask_user';

  const runCreate = db.transaction(() => {
    const userMessage = shouldCreateUserMessage
      ? createUserIntentMessage(
          {
            roomId: input.roomId,
            senderId: input.actor?.sender_id ?? 'user',
            senderName: input.actor?.sender_name ?? 'You',
            content: input.userFacingContent ?? `创建任务：${title}`,
            origin: input.origin,
          },
          { broadcast: false },
        )
      : null;

    const sourceMessageId = normalizedSourceMessageId ?? userMessage?.id ?? null;
    const task = taskRepo.create({
      room_id: input.roomId,
      project_id: room.project_id,
      parent_task_id: input.taskInput.parent_task_id ?? undefined,
      title,
      description: input.taskInput.description ?? undefined,
      priority: input.taskInput.priority,
      interaction_mode: interactionMode,
      assigned_agent_id: input.taskInput.assigned_agent_id ?? undefined,
      source_message_id: sourceMessageId,
      created_from: input.origin,
    });

    createTaskCreationMemorySafely({
      projectId: room.project_id,
      roomId: input.roomId,
      task,
      origin: input.origin,
      sourceMessageContent: sourceMessage?.content ?? userMessage?.content ?? null,
    });

    const systemMessage = createTaskEventMessage({
      roomId: input.roomId,
      taskId: task.id,
      taskTitle: task.title,
      eventType: 'task_created',
      origin: input.origin,
      content: buildTaskCreatedMessage(task),
    });

    return { task, userMessage, systemMessage };
  });
  const result = runCreate();

  if (result.userMessage) {
    broadcastMessageCreated(input.roomId, result.userMessage);
  }
  wsHub.broadcast(input.roomId, { type: 'task:created', task: result.task });
  broadcastMessageCreated(input.roomId, result.systemMessage);

  return result;
}

export function createTaskCreationMemorySafely(input: {
  projectId: string;
  roomId: string;
  task: Task;
  origin: TaskCreatedFrom;
  sourceMessageContent: string | null;
}): void {
  try {
    memoryRepo.create({
      project_id: input.projectId,
      room_id: input.roomId,
      task_id: input.task.id,
      scope: 'task',
      memory_type: 'task_summary',
      title: `任务创建：${input.task.title}`,
      content: buildTaskCreationMemoryContent({
        title: input.task.title,
        description: input.task.description,
        origin: input.origin,
        sourceMessageContent: input.sourceMessageContent,
      }),
      source_type: 'task',
      source_id: `created:${input.task.id}`,
    });
  } catch (err) {
    if (isMemorySourceConflictError(err)) return;
    throw err;
  }
}

export function recordTaskEvent(input: RecordTaskEventInput): Message {
  const message = createTaskEventMessage(input);
  broadcastMessageCreated(input.roomId, message);
  return message;
}

function createTaskEventMessage(input: RecordTaskEventInput): Message {
  const metadata: MessageMetadata = {
    task_id: input.taskId,
    task_title: input.taskTitle,
    workflow_run_id: input.workflowRunId ?? undefined,
    workflow_step_id: input.workflowStepId ?? undefined,
    event_type: input.eventType,
    origin: input.origin,
  };
  return messageRepo.create({
    room_id: input.roomId,
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content: input.content,
    message_type: 'system',
    metadata: metadata as Record<string, unknown>,
  });
}

function createUserIntentMessage(input: {
  roomId: string;
  senderId: string;
  senderName: string;
  content: string;
  origin: TaskCreatedFrom;
}, options?: {
  broadcast?: boolean;
}): Message {
  const message = messageRepo.create({
    room_id: input.roomId,
    sender_type: 'user',
    sender_id: input.senderId,
    sender_name: input.senderName,
    content: input.content,
    message_type: 'text',
    metadata: { origin: input.origin },
  });
  if (options?.broadcast !== false) {
    broadcastMessageCreated(input.roomId, message);
  }
  return message;
}

function broadcastMessageCreated(roomId: string, message: Message): void {
  wsHub.broadcast(roomId, { type: 'message:new', roomId, message });
}

function buildTaskCreatedMessage(task: Task): string {
  const parts = [`已创建任务 #${task.id}：${task.title}`];
  parts.push(`优先级 ${task.priority}`);
  parts.push(task.assigned_agent_id ? `已指派 ${task.assigned_agent_id}` : '未指派');
  return parts.join('，');
}

function buildTaskCreationMemoryContent(input: {
  title: string;
  description: string | null;
  origin: TaskCreatedFrom;
  sourceMessageContent: string | null;
}): string {
  const lines = [`任务：${input.title}`, `来源：${input.origin}`];
  if (input.description?.trim()) {
    lines.push(`描述：${input.description.trim()}`);
  }
  if (input.sourceMessageContent?.trim()) {
    lines.push(`来源消息：${input.sourceMessageContent.trim().slice(0, 1000)}`);
  }
  return lines.join('\n');
}
