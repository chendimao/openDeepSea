import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TASK_TRIGGER,
  buildComposerTriggers,
  buildFileSuggestions,
  buildTaskSuggestions,
  encodeFileChipValue,
  encodeTaskChipValue,
  parseFileChipValue,
  parseTaskChipValue,
} from './RichMessageComposer.triggers';
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
  assert.ok(suggestions.length <= 8);
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
