import { api } from '../lib/api';
import type { ProjectFile, WorkspaceSearchResult } from '../lib/types';
import type { TriggerConfig, TriggerSuggestion } from './prompt-area/types';

export const FILE_TRIGGER = '@';
const SUGGESTION_LIMIT = 8;

export interface ComposerTriggerLabels {
  fileMenuAria: string;
  fileEmpty: string;
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

interface BuildComposerTriggersInput {
  projectId: string;
  labels: ComposerTriggerLabels;
}

const EMPTY_WORKSPACE_RESULT = { entries: [] as WorkspaceSearchResult[], truncated: false };

export function buildComposerTriggers({
  projectId,
  labels,
}: BuildComposerTriggersInput): TriggerConfig[] {
  return [
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
