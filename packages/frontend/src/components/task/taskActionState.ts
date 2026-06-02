import type { TaskActionKind, TaskActionState, TaskEvent } from '../../lib/types';

const ACTIONS: TaskActionKind[] = ['start_execution', 'brainstorming', 'writing_plans', 'subagent_execution'];

export function createTaskActionStates(
  events: TaskEvent[],
  pendingKey: string | null,
): Partial<Record<TaskActionKind, TaskActionState>> {
  const states: Partial<Record<TaskActionKind, TaskActionState>> = {};
  for (const event of [...events].sort(compareTaskActionEvents)) {
    const action = getTaskActionKind(event.payload.task_action ?? event.payload.action);
    if (!action) continue;
    const status = getTaskActionStatus(event.payload.task_action_status ?? event.payload.status);
    if (!status) continue;
    states[action] = {
      status,
      detail: getTaskActionDetail(event.payload),
    };
  }

  if (pendingKey) {
    const [, action] = splitPendingKey(pendingKey);
    if (action) {
      states[action] = {
        status: 'running',
        detail: '运行中',
      };
    }
  }

  return states;
}

function compareTaskActionEvents(a: TaskEvent, b: TaskEvent): number {
  if (a.task_id === b.task_id && a.seq !== b.seq) return a.seq - b.seq;
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id.localeCompare(b.id);
}

export function createTaskActionPendingKey(taskId: string, action: TaskActionKind): string {
  return `${taskId}:${action}`;
}

function splitPendingKey(value: string): [string, TaskActionKind | null] {
  const [taskId, rawAction] = value.split(':');
  return [taskId ?? '', getTaskActionKind(rawAction)];
}

function getTaskActionKind(value: unknown): TaskActionKind | null {
  return typeof value === 'string' && ACTIONS.includes(value as TaskActionKind)
    ? value as TaskActionKind
    : null;
}

function getTaskActionStatus(value: unknown): TaskActionState['status'] | null {
  return value === 'queued' ||
    value === 'running' ||
    value === 'failed' ||
    value === 'completed' ||
    value === 'blocked'
    ? value
    : null;
}

function getTaskActionDetail(payload: Record<string, unknown>): string | undefined {
  const blockedReason = payload.blocked_reason;
  if (typeof blockedReason === 'string' && blockedReason.trim()) return blockedReason.trim();
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  const content = payload.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  return undefined;
}
