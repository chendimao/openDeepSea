import { sessionMessageRepo } from './repos/sessions.js';
import { taskRepo } from './repos/tasks.js';
import { broadcastActiveSessionUpsert } from './session-active-broadcast.js';
import { wsHub } from './ws-hub.js';
import type { Message, SessionMessage, SessionMessageType, Task, TaskEventType, WorkflowRun } from './types.js';

const MIRRORED_WORKFLOW_EVENT_TYPES = new Set<TaskEventType>([
  'task_created',
  'task_status_changed',
  'workflow_started',
  'workflow_stage_changed',
  'workflow_plan_ready',
  'workflow_assignment_created',
  'workflow_blocked',
  'workflow_recovery_decided',
  'workflow_completed',
  'workflow_cancelled',
  'workflow_failed',
  'workflow_memory_written',
]);

export function mirrorWorkflowRoomMessageToSession(input: {
  roomId: string;
  message: Message;
  taskId?: string | null;
  workflowRunId?: string | null;
  workflowStepId?: string | null;
  agentRunId?: string | null;
  eventType?: TaskEventType | null;
  force?: boolean;
}): SessionMessage | null {
  const content = input.message.content.trim();
  if (!content) return null;

  const metadata = parseMetadata(input.message.metadata);
  if (metadata.internal === true || metadata.internal === 1) return null;
  const eventType = input.eventType ?? readTaskEventType(metadata.event_type);
  if (!input.force && !shouldMirrorWorkflowMessage(input.message, eventType)) return null;

  const task = resolveTask(input.taskId ?? readString(metadata.task_id));
  const rootTask = task ? resolveRootTask(task) : null;
  if (!rootTask?.source_message_id) return null;

  const sourceMessage = sessionMessageRepo.get(rootTask.source_message_id);
  if (!sourceMessage) return null;
  if (hasMirroredRoomMessage(sourceMessage.session_id, input.message.id)) return null;

  const sessionMessage = sessionMessageRepo.create({
    session_id: sourceMessage.session_id,
    role: input.message.sender_type === 'agent' ? 'assistant' : 'system',
    sender_id: input.message.sender_type === 'agent' ? input.message.sender_id : 'workflow',
    sender_name: input.message.sender_type === 'agent' ? input.message.sender_name : '工作流',
    content,
    message_type: toSessionMessageType(input.message),
    metadata: {
      session_workflow_bridge: {
        sourceRoomId: input.roomId,
        sourceRoomMessageId: input.message.id,
        sourceMessageId: sourceMessage.id,
        taskId: task?.id,
        rootTaskId: rootTask.id,
        workflowRunId: input.workflowRunId ?? readString(metadata.workflow_run_id),
        workflowStepId: input.workflowStepId ?? readString(metadata.workflow_step_id),
        agentRunId: input.agentRunId ?? readString(metadata.run_id) ?? readString(metadata.agent_run_id),
        eventType,
        createdAt: Date.now(),
      },
      source_room_message_id: input.message.id,
      source_message_id: sourceMessage.id,
      task_id: task?.id,
      root_task_id: rootTask.id,
      workflow_run_id: input.workflowRunId ?? readString(metadata.workflow_run_id),
      workflow_step_id: input.workflowStepId ?? readString(metadata.workflow_step_id),
      agent_run_id: input.agentRunId ?? readString(metadata.run_id) ?? readString(metadata.agent_run_id),
      event_type: eventType,
    },
  });
  wsHub.broadcastSession(sourceMessage.session_id, {
    type: 'session_message:new',
    sessionId: sourceMessage.session_id,
    message: sessionMessage,
  });
  broadcastActiveSessionUpsert(sourceMessage.session_id);
  return sessionMessage;
}

export function broadcastSessionWorkflowUpdated(workflow: WorkflowRun): void {
  const sessionId = resolveWorkflowSessionId(workflow);
  if (!sessionId) return;
  wsHub.broadcastSession(sessionId, {
    type: 'session_workflow:updated',
    sessionId,
    workflow,
  });
  broadcastActiveSessionUpsert(sessionId);
}

function shouldMirrorWorkflowMessage(message: Message, eventType: TaskEventType | null): boolean {
  if (message.sender_type === 'agent') return true;
  return eventType ? MIRRORED_WORKFLOW_EVENT_TYPES.has(eventType) : false;
}

function resolveWorkflowSessionId(workflow: WorkflowRun): string | null {
  const task = resolveTask(workflow.task_id);
  const rootTask = task ? resolveRootTask(task) : null;
  if (!rootTask?.source_message_id) return null;
  return sessionMessageRepo.get(rootTask.source_message_id)?.session_id ?? null;
}

function resolveTask(taskId: string | null | undefined): Task | null {
  if (!taskId) return null;
  return taskRepo.get(taskId) ?? null;
}

function resolveRootTask(task: Task): Task {
  let current = task;
  const seen = new Set<string>();
  while (current.parent_task_id && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = taskRepo.get(current.parent_task_id);
    if (!parent) return current;
    current = parent;
  }
  return current;
}

function hasMirroredRoomMessage(sessionId: string, roomMessageId: string): boolean {
  return sessionMessageRepo.listBySession(sessionId).some((message) => {
    const metadata = parseMetadata(message.metadata);
    const bridge = isRecord(metadata.session_workflow_bridge) ? metadata.session_workflow_bridge : null;
    return readString(bridge?.sourceRoomMessageId) === roomMessageId ||
      readString(metadata.source_room_message_id) === roomMessageId;
  });
}

function toSessionMessageType(message: Message): SessionMessageType {
  if (message.message_type === 'agent_stream') return 'agent_stream';
  if (message.message_type === 'system' || message.sender_type === 'system') return 'system';
  return 'text';
}

function readTaskEventType(value: unknown): TaskEventType | null {
  return typeof value === 'string' && MIRRORED_WORKFLOW_EVENT_TYPES.has(value as TaskEventType)
    ? value as TaskEventType
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
