import type { Task, TaskEvent } from '../lib/types';

export type TaskStatusFilter = Task['status'];

export function filterRootTasks(tasks: Task[], statusFilters: TaskStatusFilter[]): Task[] {
  const enabled = new Set(statusFilters);
  return tasks
    .filter((task) => !task.parent_task_id)
    .filter((task) => enabled.size === 0 || enabled.has(task.status))
    .sort((a, b) => b.updated_at - a.updated_at);
}

export function selectActivityEvents(events: TaskEvent[], limit = 8): TaskEvent[] {
  return events
    .filter((event) => event.layer === 'activity')
    .sort((a, b) => b.created_at - a.created_at || b.seq - a.seq)
    .slice(0, limit);
}
