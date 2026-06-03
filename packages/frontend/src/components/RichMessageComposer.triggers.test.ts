import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_TRIGGER,
  TASK_TRIGGER,
  buildComposerTriggers,
  buildFileSuggestions,
  buildTaskSuggestions,
  encodeFileChipValue,
  encodeTaskChipValue,
  parseFileChipValue,
  parseTaskChipValue,
} from './RichMessageComposer.triggers';
import { api } from '../lib/api';
import { getChipsByTrigger } from './prompt-area/segment-helpers';
import { resolveChip } from './prompt-area/prompt-area-engine';
import type { ProjectFile, Task } from '../lib/types';

const projectFile = {
  id: 'f1',
  original_name: 'report.md',
  mime_type: 'text/markdown',
} as ProjectFile;

test('buildFileSuggestions merges project and workspace, dedups, limits', () => {
  const suggestions = buildFileSuggestions(
    [projectFile],
    [{ path: 'src/report.md', name: 'report.md', type: 'file' }],
    'report',
  );
  assert.equal(suggestions[0].value, 'project:f1');
  assert.ok(suggestions.some((s) => s.value === 'workspace:src/report.md'));
  assert.equal(
    suggestions.find((s) => s.value === 'workspace:src/report.md')?.label,
    'src/report.md',
  );
  assert.ok(suggestions.length <= 8);
});

test('workspace file chip displays full path while send references keep encoded payloads', () => {
  const nestedPath = 'packages/frontend/src/components/RichMessageComposer.tsx';
  const suggestions = buildFileSuggestions(
    [projectFile],
    [{ path: nestedPath, name: 'RichMessageComposer.tsx', type: 'file' }],
    'RichMessageComposer',
  );
  const projectSuggestions = buildFileSuggestions([projectFile], [], 'report');
  const triggers = buildComposerTriggers({
    projectId: 'project-1',
    tasks: [],
    labels: {
      fileMenuAria: 'files',
      fileEmpty: 'no files',
      taskMenuAria: 'tasks',
      taskEmpty: 'no tasks',
    },
  });
  const fileTrigger = triggers.find((trigger) => trigger.char === FILE_TRIGGER)!;
  const workspaceSuggestion = suggestions.find((suggestion) => suggestion.value === `workspace:${nestedPath}`)!;
  const projectSuggestion = projectSuggestions.find((suggestion) => suggestion.value === 'project:f1')!;

  const workspaceChip = resolveChip(
    [{ type: 'text', text: '@RichMessageComposer' }],
    { config: fileTrigger, startOffset: 0, query: 'RichMessageComposer' },
    {
      value: workspaceSuggestion.value,
      displayText: fileTrigger.onSelect?.(workspaceSuggestion) ?? workspaceSuggestion.label,
      data: workspaceSuggestion.data,
    },
  ).segments;
  const projectChip = resolveChip(
    [{ type: 'text', text: '@report' }],
    { config: fileTrigger, startOffset: 0, query: 'report' },
    {
      value: projectSuggestion.value,
      displayText: fileTrigger.onSelect?.(projectSuggestion) ?? projectSuggestion.label,
      data: projectSuggestion.data,
    },
  ).segments;

  assert.equal(getChipsByTrigger(workspaceChip, FILE_TRIGGER)[0]?.displayText, nestedPath);
  assert.equal(getChipsByTrigger(workspaceChip, FILE_TRIGGER)[0]?.value, `workspace:${nestedPath}`);
  assert.equal(getChipsByTrigger(projectChip, FILE_TRIGGER)[0]?.displayText, 'report.md');
  assert.equal(getChipsByTrigger(projectChip, FILE_TRIGGER)[0]?.value, 'project:f1');

  const selectedFileRefs = [...getChipsByTrigger(workspaceChip, FILE_TRIGGER), ...getChipsByTrigger(projectChip, FILE_TRIGGER)]
    .map((chip) => parseFileChipValue(chip.value))
    .filter((chip): chip is NonNullable<ReturnType<typeof parseFileChipValue>> => Boolean(chip));
  const fileRefs = selectedFileRefs
    .filter((chip) => chip.kind === 'workspace')
    .map((chip) => chip.ref);
  const fileIds = selectedFileRefs
    .filter((chip) => chip.kind === 'project')
    .map((chip) => chip.ref);

  assert.deepEqual(fileRefs, [nestedPath]);
  assert.deepEqual(fileIds, ['f1']);
});

test('buildFileSuggestions filters project files by query', () => {
  const suggestions = buildFileSuggestions([projectFile], [], 'nomatch');
  assert.equal(suggestions.length, 0);
});

test('encode/parse file chip value round-trips', () => {
  assert.equal(encodeFileChipValue('project', 'f1'), 'project:f1');
  assert.deepEqual(parseFileChipValue('project:f1'), { kind: 'project', ref: 'f1' });
  assert.deepEqual(parseFileChipValue('workspace:src/a.ts'), { kind: 'workspace', ref: 'src/a.ts' });
  assert.equal(parseFileChipValue('garbage'), null);
});

test('buildTaskSuggestions lists routable tasks for hash trigger', () => {
  const openTask = createTask({ id: 'task-open-123456', title: '修复聊天路由', status: 'in_progress' });
  const doneTask = createTask({ id: 'task-done-123456', title: '已完成任务', status: 'done' });

  const suggestions = buildTaskSuggestions([openTask, doneTask], '聊天');

  assert.equal(TASK_TRIGGER, '#');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.value, 'task:task-open-123456');
  assert.equal(suggestions[0]?.label, '修复聊天路由');
  assert.match(suggestions[0]?.description ?? '', /in_progress/);
});

test('task chip value round-trips and renders as #task:id', () => {
  const task = createTask({ id: 'task-open-abcdef', title: '绑定任务' });
  const triggers = buildComposerTriggers({
    projectId: 'project-1',
    tasks: [task],
    labels: {
      fileMenuAria: 'files',
      fileEmpty: 'no files',
      taskMenuAria: 'tasks',
      taskEmpty: 'no tasks',
    },
  });
  const taskTrigger = triggers.find((trigger) => trigger.char === '#');
  const suggestion = buildTaskSuggestions([task], '')[0]!;

  assert.equal(encodeTaskChipValue(task.id), 'task:task-open-abcdef');
  assert.equal(parseTaskChipValue('task:task-open-abcdef'), 'task-open-abcdef');
  assert.equal(taskTrigger?.onSelect?.(suggestion), 'task:task-open-abcdef');
});

test('file trigger searches workspace files inside the current workspace path', async () => {
  const originalListProjectFiles = api.listProjectFiles;
  const originalSearchWorkspaceFiles = api.searchWorkspaceFiles;
  const calls: Array<{ projectId: string; query: string; path?: string }> = [];
  api.listProjectFiles = async () => [];
  api.searchWorkspaceFiles = async (projectId, query, filters = {}) => {
    calls.push({ projectId, query, path: filters.path });
    return { entries: [{ path: 'packages/frontend/src/App.tsx', name: 'App.tsx', type: 'file' }], truncated: false };
  };

  try {
    const triggers = buildComposerTriggers({
      projectId: 'project-1',
      workspacePath: 'packages/frontend',
      tasks: [],
      labels: {
        fileMenuAria: 'files',
        fileEmpty: 'no files',
        taskMenuAria: 'tasks',
        taskEmpty: 'no tasks',
      },
    });
    const fileTrigger = triggers.find((trigger) => trigger.char === FILE_TRIGGER);
    const suggestions = await fileTrigger?.onSearch?.('App', { signal: new AbortController().signal });

    assert.deepEqual(calls, [{ projectId: 'project-1', query: 'App', path: 'packages/frontend' }]);
    assert.equal(suggestions?.[0]?.value, 'workspace:packages/frontend/src/App.tsx');
  } finally {
    api.listProjectFiles = originalListProjectFiles;
    api.searchWorkspaceFiles = originalSearchWorkspaceFiles;
  }
});

test('file trigger searches from the workspace root when workspace path is absolute', async () => {
  const originalListProjectFiles = api.listProjectFiles;
  const originalSearchWorkspaceFiles = api.searchWorkspaceFiles;
  const calls: Array<{ projectId: string; query: string; path?: string }> = [];
  api.listProjectFiles = async () => [];
  api.searchWorkspaceFiles = async (projectId, query, filters = {}) => {
    calls.push({ projectId, query, path: filters.path });
    return { entries: [{ path: 'docs/guide.md', name: 'guide.md', type: 'file' }], truncated: false };
  };

  try {
    const triggers = buildComposerTriggers({
      projectId: 'project-1',
      workspacePath: '/Users/chendimao/WWW/openclaw-room',
      tasks: [],
      labels: {
        fileMenuAria: 'files',
        fileEmpty: 'no files',
        taskMenuAria: 'tasks',
        taskEmpty: 'no tasks',
      },
    });
    const fileTrigger = triggers.find((trigger) => trigger.char === FILE_TRIGGER);
    const suggestions = await fileTrigger?.onSearch?.('guide', { signal: new AbortController().signal });

    assert.deepEqual(calls, [{ projectId: 'project-1', query: 'guide', path: undefined }]);
    assert.equal(suggestions?.[0]?.value, 'workspace:docs/guide.md');
  } finally {
    api.listProjectFiles = originalListProjectFiles;
    api.searchWorkspaceFiles = originalSearchWorkspaceFiles;
  }
});

function createTask(input: { id: string; title: string; status?: Task['status'] }): Task {
  return {
    id: input.id,
    project_id: 'project-1',
    room_id: 'room-1',
    title: input.title,
    description: null,
    status: input.status ?? 'todo',
    priority: 'normal',
    interaction_mode: 'ask_user',
    parent_task_id: null,
    source_message_id: null,
    created_from: 'manual',
    assigned_agent_id: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    deleted_at: null,
  };
}
