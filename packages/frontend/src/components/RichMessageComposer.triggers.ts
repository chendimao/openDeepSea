import { api } from '../lib/api';
import type { ProjectFile, Task, WorkspaceSearchResult } from '../lib/types';
import type { TriggerConfig, TriggerSuggestion } from './prompt-area/types';

export const FILE_TRIGGER = '@';
export const TASK_TRIGGER = '#';
const SUGGESTION_LIMIT = 8;

export interface ComposerTriggerLabels {
  fileMenuAria: string;
  fileEmpty: string;
  taskMenuAria: string;
  taskEmpty: string;
}

export type FileChipKind = 'project' | 'workspace';

export function encodeFileChipValue(kind: FileChipKind, ref: string): string {
  return `${kind}:${ref}`;
}

export function parseFileChipValue(value: string): { kind: FileChipKind; ref: string } | null {
  const sep = value.indexOf(':');
  if (sep < 0) return null;
  const kind = value.slice(0, sep);
  const ref = value.slice(sep + 1);
  if ((kind !== 'project' && kind !== 'workspace') || !ref) return null;
  return { kind, ref };
}

export function buildFileSuggestions(
  projectFiles: ProjectFile[],
  workspaceEntries: WorkspaceSearchResult[],
  query: string,
): TriggerSuggestion[] {
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const suggestions: TriggerSuggestion[] = [];

  for (const file of projectFiles) {
    if (needle && !file.original_name.toLowerCase().includes(needle)) continue;
    const value = encodeFileChipValue('project', file.id);
    if (seen.has(value)) continue;
    seen.add(value);
    suggestions.push({
      value,
      label: file.original_name,
      description: '项目文件',
      data: { kind: 'project', file },
    });
  }

  for (const entry of workspaceEntries) {
    const value = encodeFileChipValue('workspace', entry.path);
    if (seen.has(value)) continue;
    seen.add(value);
    suggestions.push({
      value,
      label: entry.name,
      description: entry.path,
      data: { kind: 'workspace', path: entry.path, name: entry.name },
    });
  }

  return suggestions.slice(0, SUGGESTION_LIMIT);
}

export function encodeTaskChipValue(taskId: string): string {
  return `task:${taskId}`;
}

export function parseTaskChipValue(value: string): string | null {
  return value.startsWith('task:') && value.length > 5 ? value.slice(5) : null;
}

export function buildTaskSuggestions(tasks: Task[], query: string): TriggerSuggestion[] {
  const needle = query.trim().toLowerCase();
  return tasks
    .filter((task) => isRoutableTask(task))
    .filter((task) => {
      if (!needle) return true;
      const haystack = `${task.id} ${task.title} ${task.status}`.toLowerCase();
      return haystack.includes(needle);
    })
    .slice(0, SUGGESTION_LIMIT)
    .map((task) => ({
      value: encodeTaskChipValue(task.id),
      label: task.title,
      description: `${task.status} · #${task.id.slice(0, 6)}`,
      data: { kind: 'task', task },
    }));
}

function isRoutableTask(task: Task): boolean {
  return task.status === 'todo' || task.status === 'in_progress' || task.status === 'review';
}

interface BuildComposerTriggersInput {
  projectId: string;
  tasks: Task[];
  labels: ComposerTriggerLabels;
}

const EMPTY_WORKSPACE_RESULT = { entries: [] as WorkspaceSearchResult[], truncated: false };

export function buildComposerTriggers({
  projectId,
  tasks,
  labels,
}: BuildComposerTriggersInput): TriggerConfig[] {
  return [
    {
      char: TASK_TRIGGER,
      position: 'any',
      mode: 'dropdown',
      accessibilityLabel: labels.taskMenuAria,
      onSearch: (query) => buildTaskSuggestions(tasks, query),
      onSelect: (suggestion) => `task:${parseTaskChipValue(suggestion.value) ?? suggestion.value}`,
      emptyMessage: labels.taskEmpty,
    },
    {
      char: FILE_TRIGGER,
      position: 'any',
      mode: 'dropdown',
      accessibilityLabel: labels.fileMenuAria,
      searchDebounceMs: 200,
      onSearch: async (query) => {
        const [projectFiles, workspace] = await Promise.all([
          api.listProjectFiles(projectId, query ? { q: query } : {}).catch(() => [] as ProjectFile[]),
          query
            ? api.searchWorkspaceFiles(projectId, query).catch(() => EMPTY_WORKSPACE_RESULT)
            : Promise.resolve(EMPTY_WORKSPACE_RESULT),
        ]);
        return buildFileSuggestions(projectFiles, workspace.entries, query);
      },
      onSelect: (suggestion) => suggestion.label,
      emptyMessage: labels.fileEmpty,
    },
  ];
}
