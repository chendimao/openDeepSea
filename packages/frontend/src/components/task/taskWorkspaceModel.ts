import type { MessageKey } from '../../lib/i18n';
import type { Task, TaskEvent } from '../../lib/types';

export type TaskWorkspacePlanStep = {
  title: string;
  state: 'completed' | 'running' | 'waiting';
  time: number | null;
};

export type TaskWorkspaceFileChange = {
  name: string;
  added: number;
  removed: number;
};

export type TaskWorkspaceToolCall = {
  name: string;
  status: string;
  time: number;
};

export function buildPlanSteps(
  task: Task,
  events: TaskEvent[],
  t: (key: MessageKey) => string,
): TaskWorkspacePlanStep[] {
  const eventSteps = events.slice(0, 5).map((event, index): TaskWorkspacePlanStep => ({
    title: taskEventTypeLabel(event.type, t),
    state: index === events.length - 1 && task.status !== 'done' ? 'running' : 'completed',
    time: event.created_at,
  }));
  if (eventSteps.length > 0) {
    return [
      ...eventSteps,
      ...(task.status === 'done' ? [] : [{ title: '等待验证与收口', state: 'waiting' as const, time: null }]),
    ];
  }
  return [
    { title: '分析需求与任务边界', state: task.status === 'todo' ? 'running' : 'completed', time: task.created_at },
    { title: '执行核心改动', state: task.status === 'in_progress' ? 'running' : task.status === 'todo' ? 'waiting' : 'completed', time: null },
    { title: '验证输出结果', state: task.status === 'review' ? 'running' : task.status === 'done' ? 'completed' : 'waiting', time: null },
  ];
}

export function taskProgressPercent(status: Task['status']): number {
  if (status === 'done') return 100;
  if (status === 'review') return 78;
  if (status === 'in_progress') return 46;
  if (status === 'failed') return 18;
  return 12;
}

export function buildFileChanges(events: TaskEvent[]): TaskWorkspaceFileChange[] {
  return events.slice(0, 6).map((event, index) => {
    const name =
      readPayloadString(event.payload, 'file') ??
      readPayloadString(event.payload, 'path') ??
      readPayloadString(event.payload, 'filename') ??
      `change-${index + 1}.diff`;
    return {
      name,
      added: readPayloadNumber(event.payload, 'added') ?? readPayloadNumber(event.payload, 'additions') ?? 0,
      removed: readPayloadNumber(event.payload, 'removed') ?? readPayloadNumber(event.payload, 'deletions') ?? 0,
    };
  });
}

export function buildToolCalls(logEvents: TaskEvent[], timelineEvents: TaskEvent[]): TaskWorkspaceToolCall[] {
  const source = [...logEvents, ...timelineEvents].slice(-5);
  return source.map((event) => ({
    name: readPayloadString(event.payload, 'tool') ?? readPayloadString(event.payload, 'command') ?? event.type,
    status: readPayloadString(event.payload, 'status') ?? 'done',
    time: event.created_at,
  }));
}

export function taskEventTypeLabel(type: TaskEvent['type'], t: (key: MessageKey) => string): string {
  const key = `taskEvent.${type}` as MessageKey;
  const translated = t(key);
  return translated === key ? type : translated;
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readPayloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
