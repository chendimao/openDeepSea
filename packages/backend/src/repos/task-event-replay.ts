import type {
  TaskCreatedFrom,
  TaskEvent,
  TaskInteractionMode,
  TaskPriority,
  TaskStatus,
} from '../types.js';

export interface TaskEventReplayState {
  task_id: string;
  room_id: string;
  title: string | null;
  description: string | null;
  status: TaskStatus | null;
  priority: TaskPriority | null;
  interaction_mode: TaskInteractionMode | null;
  assigned_agent_id: string | null;
  source_message_id: string | null;
  created_from: TaskCreatedFrom | null;
  deleted: boolean;
  created_event_id: string | null;
  last_event_id: string | null;
  last_seq: number;
}

export function replayTaskEvents(events: TaskEvent[]): TaskEventReplayState | null {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let state: TaskEventReplayState | null = null;

  for (const event of ordered) {
    if (!state) {
      state = createEmptyReplayState(event);
    }
    state.last_event_id = event.id;
    state.last_seq = event.seq;

    if (event.type === 'task_created') {
      state.created_event_id = state.created_event_id ?? event.id;
      applyCreatedEvent(state, event);
    } else if (event.type === 'task_updated') {
      applyUpdatedEvent(state, event);
    } else if (event.type === 'task_status_changed') {
      const nextStatus = readTaskStatus(event.payload.next_status);
      if (nextStatus) state.status = nextStatus;
    } else if (event.type === 'task_deleted') {
      state.deleted = true;
    }
  }

  return state;
}

function createEmptyReplayState(event: TaskEvent): TaskEventReplayState {
  return {
    task_id: event.task_id,
    room_id: event.room_id,
    title: null,
    description: null,
    status: null,
    priority: null,
    interaction_mode: null,
    assigned_agent_id: null,
    source_message_id: null,
    created_from: null,
    deleted: false,
    created_event_id: null,
    last_event_id: null,
    last_seq: 0,
  };
}

function applyCreatedEvent(state: TaskEventReplayState, event: TaskEvent): void {
  state.title = readString(event.payload.title) ?? readString(event.payload.task_title) ?? state.title;
  state.description = readNullableString(event.payload.description);
  state.status = readTaskStatus(event.payload.status) ?? 'todo';
  state.priority = readTaskPriority(event.payload.priority) ?? 'normal';
  state.interaction_mode = readTaskInteractionMode(event.payload.interaction_mode) ?? 'ask_user';
  state.assigned_agent_id = readNullableString(event.payload.assigned_agent_id);
  state.source_message_id = readNullableString(event.payload.source_message_id);
  state.created_from = readTaskCreatedFrom(event.payload.created_from) ?? readTaskCreatedFrom(event.payload.origin);
  state.deleted = false;
}

function applyUpdatedEvent(state: TaskEventReplayState, event: TaskEvent): void {
  const nextTitle = readString(event.payload.next_title);
  if (nextTitle !== null) state.title = nextTitle;

  if ('next_description' in event.payload) {
    state.description = readNullableString(event.payload.next_description);
  }

  const nextPriority = readTaskPriority(event.payload.next_priority);
  if (nextPriority) state.priority = nextPriority;

  const nextInteractionMode = readTaskInteractionMode(event.payload.next_interaction_mode);
  if (nextInteractionMode) state.interaction_mode = nextInteractionMode;

  if ('next_assigned_agent_id' in event.payload) {
    state.assigned_agent_id = readNullableString(event.payload.next_assigned_agent_id);
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : null;
}

function readTaskStatus(value: unknown): TaskStatus | null {
  return value === 'todo' ||
    value === 'in_progress' ||
    value === 'review' ||
    value === 'done' ||
    value === 'failed'
    ? value
    : null;
}

function readTaskPriority(value: unknown): TaskPriority | null {
  return value === 'low' || value === 'normal' || value === 'high' || value === 'urgent' ? value : null;
}

function readTaskInteractionMode(value: unknown): TaskInteractionMode | null {
  return value === 'ask_user' || value === 'auto_recommended' ? value : null;
}

function readTaskCreatedFrom(value: unknown): TaskCreatedFrom | null {
  return value === 'manual' ||
    value === 'chat_plan' ||
    value === 'slash_command' ||
    value === 'workflow_assignment'
    ? value
    : null;
}
