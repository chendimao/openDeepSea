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

export function createTaskWithConversation(input: CreateTaskWithConversationInput): CreateTaskWithConversationResult {
  const room = roomRepo.get(input.roomId);
  if (!room) throw new Error('room not found');

  const title = input.taskInput.title.trim();
  if (!title) throw new Error('title is required');

  const shouldCreateUserMessage = input.createUserMessage !== false && !input.sourceMessageId;
  const userMessage = shouldCreateUserMessage
    ? createUserIntentMessage({
        roomId: input.roomId,
        senderId: input.actor?.sender_id ?? 'user',
        senderName: input.actor?.sender_name ?? 'You',
        content: input.userFacingContent ?? `创建任务：${title}`,
        origin: input.origin,
      })
    : null;

  const sourceMessageId = input.sourceMessageId ?? userMessage?.id ?? null;
  const interactionMode =
    input.taskInput.interaction_mode ?? settingsRepo.resolveForRoom(input.roomId)?.effective.interaction_mode ?? 'ask_user';

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

  wsHub.broadcast(input.roomId, { type: 'task:created', task });

  const systemMessage = recordTaskEvent({
    roomId: input.roomId,
    taskId: task.id,
    taskTitle: task.title,
    eventType: 'task_created',
    origin: input.origin,
    content: buildTaskCreatedMessage(task),
  });

  return { task, userMessage, systemMessage };
}

export function recordTaskEvent(input: {
  roomId: string;
  taskId: string;
  taskTitle?: string;
  workflowRunId?: string | null;
  workflowStepId?: string | null;
  eventType: TaskEventType;
  origin?: TaskCreatedFrom;
  content: string;
}): Message {
  const metadata: MessageMetadata = {
    task_id: input.taskId,
    task_title: input.taskTitle,
    workflow_run_id: input.workflowRunId ?? undefined,
    workflow_step_id: input.workflowStepId ?? undefined,
    event_type: input.eventType,
    origin: input.origin,
  };
  const message = messageRepo.create({
    room_id: input.roomId,
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content: input.content,
    message_type: 'system',
    metadata: metadata as Record<string, unknown>,
  });
  wsHub.broadcast(input.roomId, { type: 'message:new', roomId: input.roomId, message });
  return message;
}

function createUserIntentMessage(input: {
  roomId: string;
  senderId: string;
  senderName: string;
  content: string;
  origin: TaskCreatedFrom;
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
  wsHub.broadcast(input.roomId, { type: 'message:new', roomId: input.roomId, message });
  return message;
}

function buildTaskCreatedMessage(task: Task): string {
  const parts = [`已创建任务 #${task.id}：${task.title}`];
  parts.push(`优先级 ${task.priority}`);
  parts.push(task.assigned_agent_id ? `已指派 ${task.assigned_agent_id}` : '未指派');
  return parts.join('，');
}
