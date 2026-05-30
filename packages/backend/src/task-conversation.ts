import { db } from './db.js';
import { isMemorySourceConflictError, memoryRepo } from './repos/memory.js';
import { messageRepo } from './repos/messages.js';
import { roomRepo } from './repos/rooms.js';
import { settingsRepo } from './repos/settings.js';
import { taskEventRepo } from './repos/task-events.js';
import { taskRepo } from './repos/tasks.js';
import type {
  Message,
  MessageLayer,
  MessageMetadata,
  Task,
  TaskCreatedFrom,
  TaskEvent,
  TaskEventType,
  TaskInteractionMode,
  TaskPriority,
} from './types.js';
import { startWorkflowWithConversation } from './workflows/conversation.js';
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
  taskEvent?: TaskEvent;
}

export interface RecordedTaskEvent {
  message: Message;
  event: TaskEvent;
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
  metadata?: Record<string, unknown>;
}

export function recordTaskCreatedEvent(input: {
  roomId: string;
  task: Task;
  origin?: TaskCreatedFrom;
  content?: string;
  metadata?: Record<string, unknown>;
}, options?: { broadcast?: boolean }): RecordedTaskEvent {
  return recordTaskEvent(buildTaskCreatedEventInput(input), options);
}

export function recordTaskStatusChanged(input: {
  before: Task;
  after: Task;
  metadata?: Record<string, unknown>;
}, options?: { broadcast?: boolean }): RecordedTaskEvent | null {
  if (input.before.status === input.after.status) return null;
  return recordTaskEvent({
    roomId: input.after.room_id,
    taskId: input.after.id,
    taskTitle: input.after.title,
    eventType: 'task_status_changed',
    content: `任务「${input.after.title}」状态变更为 ${input.after.status}`,
    metadata: {
      ...(input.metadata ?? {}),
      previous_status: input.before.status,
      next_status: input.after.status,
    },
  }, options);
}

export function recordTaskUpdated(input: {
  before: Task;
  after: Task;
  changedFields: Array<'title' | 'description' | 'priority' | 'interaction_mode' | 'assigned_agent_id'>;
  metadata?: Record<string, unknown>;
}, options?: { broadcast?: boolean }): RecordedTaskEvent | null {
  const changedFields = input.changedFields.filter((field) => input.before[field] !== input.after[field]);
  if (changedFields.length === 0) return null;
  const assignmentMetadata = changedFields.includes('assigned_agent_id')
    ? {
        previous_assigned_agent_id: input.before.assigned_agent_id,
        next_assigned_agent_id: input.after.assigned_agent_id,
      }
    : {};
  return recordTaskEvent({
    roomId: input.after.room_id,
    taskId: input.after.id,
    taskTitle: input.after.title,
    eventType: 'task_updated',
    content: `任务「${input.after.title}」已更新：${changedFields.join(', ')}`,
    metadata: {
      ...(input.metadata ?? {}),
      ...assignmentMetadata,
      changed_fields: changedFields,
      next_title: input.after.title,
      next_description: input.after.description,
      next_priority: input.after.priority,
      next_interaction_mode: input.after.interaction_mode,
      next_assigned_agent_id: input.after.assigned_agent_id,
    },
  }, options);
}

function buildTaskCreatedEventInput(input: {
  roomId: string;
  task: Task;
  origin?: TaskCreatedFrom;
  content?: string;
  metadata?: Record<string, unknown>;
}): RecordTaskEventInput {
  return {
    roomId: input.roomId,
    taskId: input.task.id,
    taskTitle: input.task.title,
    eventType: 'task_created',
    origin: input.origin,
    content: input.content ?? buildTaskCreatedMessage(input.task),
    metadata: {
      ...(input.metadata ?? {}),
      title: input.task.title,
      description: input.task.description,
      status: input.task.status,
      priority: input.task.priority,
      interaction_mode: input.task.interaction_mode,
      assigned_agent_id: input.task.assigned_agent_id,
      source_message_id: input.task.source_message_id,
      created_from: input.task.created_from,
      parent_task_id: input.task.parent_task_id,
    },
  };
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
    const replayed = findTaskCreationBySourceMessage(input.roomId, normalizedSourceMessageId);
    if (replayed) return replayed;
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

    const taskEventResult = createTaskEventMessage(buildTaskCreatedEventInput({
      roomId: input.roomId,
      task,
      origin: input.origin,
    }));

    return { task, userMessage, systemMessage: taskEventResult.message, taskEvent: taskEventResult.event };
  });
  const result = runCreate();

  if (result.userMessage) {
    broadcastMessageCreated(input.roomId, result.userMessage);
  }
  wsHub.broadcast(input.roomId, { type: 'task:created', task: result.task });
  if (result.taskEvent) {
    broadcastTaskEventCreated(input.roomId, result.taskEvent);
  }
  broadcastMessageCreated(input.roomId, result.systemMessage);
  maybeAutoStartTaskWorkflow(input.roomId, result.task);

  return result;
}

function maybeAutoStartTaskWorkflow(roomId: string, task: Task): void {
  if (task.interaction_mode !== 'auto_recommended') return;
  try {
    startWorkflowWithConversation({
      roomId,
      taskId: task.id,
      source: 'auto_start',
    });
  } catch (err) {
    recordTaskEvent({
      roomId,
      taskId: task.id,
      taskTitle: task.title,
      eventType: 'workflow_failed',
      content: `自动启动工作流失败：${(err as Error).message}`,
      metadata: {
        workflow_source: 'auto_start',
      },
    });
  }
}

function findTaskCreationBySourceMessage(roomId: string, sourceMessageId: string): CreateTaskWithConversationResult | null {
  const task = taskRepo.getBySourceMessage(roomId, sourceMessageId);
  if (!task) return null;
  const systemMessage = db.prepare(
    `SELECT * FROM messages
     WHERE room_id = ?
       AND metadata IS NOT NULL
       AND json_valid(metadata)
       AND json_extract(metadata, '$.event_type') = 'task_created'
       AND json_extract(metadata, '$.task_id') = ?
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
  ).get(roomId, task.id) as Message | undefined;
  if (!systemMessage) return null;
  return { task, userMessage: null, systemMessage };
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

export function recordTaskEvent(input: RecordTaskEventInput, options?: { broadcast?: boolean }): RecordedTaskEvent {
  const taskEventResult = db.transaction(() => createTaskEventMessage(input))();
  if (options?.broadcast !== false) {
    broadcastTaskEventCreated(input.roomId, taskEventResult.event);
    broadcastMessageCreated(input.roomId, taskEventResult.message);
  }
  return taskEventResult;
}

function createTaskEventMessage(input: RecordTaskEventInput): { message: Message; event: TaskEvent } {
  const metadata: MessageMetadata = {
    ...(input.metadata ?? {}),
    task_id: input.taskId,
    task_title: input.taskTitle,
    workflow_run_id: input.workflowRunId ?? undefined,
    workflow_step_id: input.workflowStepId ?? undefined,
    event_type: input.eventType,
    origin: input.origin,
  };
  const layer = inferTaskEventLayer(input.eventType);
  const message = messageRepo.create({
    room_id: input.roomId,
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content: input.content,
    message_type: 'system',
    layer,
    metadata: metadata as Record<string, unknown>,
  });
  const event = taskEventRepo.create({
    task_id: input.taskId,
    room_id: input.roomId,
    type: input.eventType,
    layer,
    source_run_id: typeof input.metadata?.source_run_id === 'string' ? input.metadata.source_run_id : null,
    payload: {
      ...metadata,
      message_id: typeof metadata.message_id === 'string' ? metadata.message_id : message.id,
      event_message_id: message.id,
      content: input.content,
    },
  });
  return { message, event };
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

function broadcastTaskEventCreated(roomId: string, event: TaskEvent): void {
  wsHub.broadcast(roomId, { type: 'task_event:new', roomId, event });
}

function inferTaskEventLayer(eventType: TaskEventType): MessageLayer {
  if (
    eventType === 'workflow_started' ||
    eventType === 'workflow_stage_changed' ||
    eventType === 'workflow_plan_ready' ||
    eventType === 'workflow_assignment_created'
  ) {
    return 'timeline';
  }
  return 'activity';
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
