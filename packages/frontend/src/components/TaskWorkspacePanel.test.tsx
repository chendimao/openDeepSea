import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskWorkspacePanel } from './TaskWorkspacePanel';
import type { TaskLayerVisibility } from './TaskDetailPanel';
import type {
  MessageLayer,
  RoomAgent,
  Task,
  TaskEvent,
  TaskEventType,
  TaskExecutorListItem,
  WorkflowRun,
} from '../lib/types';

const layers: TaskLayerVisibility = {
  chat: true,
  activity: true,
  timeline: true,
  runtime: true,
  diff: true,
};

test('TaskWorkspacePanel renders queue and active task surface together', () => {
  const html = renderToStaticMarkup(
    <TaskWorkspacePanel
      tasks={[task('task-active', '实现任务工作区'), task('task-next', '浏览器闭环验证')]}
      activeTask={task('task-active', '实现任务工作区')}
      activeTaskId="task-active"
      statusFilters={['todo', 'in_progress', 'review', 'done', 'failed']}
      activityEvents={[event('activity-1', 'message_routed', 'activity')]}
      taskEvents={[
        event('diff-1', 'diff_detected', 'diff', { path: 'src/index.ts', additions: 2, deletions: 1 }),
        event('runtime-1', 'runtime_event', 'runtime', { command: 'npm run build', output: 'ok' }),
      ]}
      taskEventsLoading={false}
      executors={[executor('executor-1')]}
      executorsLoading={false}
      agents={[agent('agent-row-1', 'Codex')]}
      workflows={[] as WorkflowRun[]}
      layerVisibility={layers}
      onStatusFiltersChange={() => undefined}
      onSelectTask={() => undefined}
      onChangeStatus={() => undefined}
      onLocateSourceMessage={() => undefined}
      onLayerVisibilityChange={() => undefined}
      onClearActiveTask={() => undefined}
      t={(key) => key}
      formatRelativeTime={(value) => `${value}`}
      taskStatusLabel={(value) => value}
      taskPriorityLabel={(value) => value}
      interactionModeLabel={(value) => value}
      workflowStatusLabel={(value) => value}
    />,
  );

  assert.match(html, /task-workspace-panel/);
  assert.match(html, /实现任务工作区/);
  assert.match(html, /浏览器闭环验证/);
  assert.match(html, /data-active="true"/);
  assert.match(html, /taskWorkspace.activeTask/);
  assert.match(html, /taskDetail.executors/);
  assert.match(html, /Codex/);
  assert.match(html, /src\/index\.ts/);
  assert.match(html, /npm run build/);
});

test('TaskWorkspacePanel keeps task selection explicit when no task is active', () => {
  const html = renderToStaticMarkup(
    <TaskWorkspacePanel
      tasks={[task('task-next', '选择后才激活')]}
      activeTask={null}
      activeTaskId={null}
      statusFilters={['todo', 'in_progress', 'review', 'done', 'failed']}
      activityEvents={[]}
      taskEvents={[]}
      taskEventsLoading={false}
      executors={[]}
      executorsLoading={false}
      agents={[]}
      workflows={[]}
      layerVisibility={layers}
      onStatusFiltersChange={() => undefined}
      onSelectTask={() => undefined}
      onChangeStatus={() => undefined}
      onLocateSourceMessage={() => undefined}
      onLayerVisibilityChange={() => undefined}
      onClearActiveTask={() => undefined}
      t={(key) => key}
      formatRelativeTime={(value) => `${value}`}
      taskStatusLabel={(value) => value}
      taskPriorityLabel={(value) => value}
      interactionModeLabel={(value) => value}
      workflowStatusLabel={(value) => value}
    />,
  );

  assert.match(html, /taskWorkspace.selectTaskTitle/);
  assert.doesNotMatch(html, /data-active="true"/);
});

function task(id: string, title: string): Task {
  return {
    id,
    room_id: 'room-1',
    project_id: 'project-1',
    parent_task_id: null,
    title,
    description: '用于验证任务工作区合并布局',
    status: id === 'task-active' ? 'in_progress' : 'todo',
    priority: id === 'task-active' ? 'high' : 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: id === 'task-active' ? 'agent-row-1' : null,
    source_message_id: 'message-1',
    created_from: 'manual',
    created_at: 1,
    updated_at: id === 'task-active' ? 20 : 10,
    completed_at: null,
    deleted_at: null,
  };
}

function event(
  id: string,
  type: TaskEventType,
  layer: MessageLayer,
  payload: Record<string, unknown> = {},
): TaskEvent {
  return {
    id,
    task_id: 'task-active',
    room_id: 'room-1',
    seq: 1,
    type,
    layer,
    payload,
    source_run_id: null,
    created_at: 3,
  };
}

function agent(id: string, name: string): RoomAgent {
  return {
    id,
    room_id: 'room-1',
    global_agent_id: null,
    agent_id: 'codex',
    agent_name: name,
    agent_role: null,
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: null,
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: null,
    tool_policy: null,
    workspace_policy: null,
    memory_scope: null,
    joined_at: 1,
    left_at: null,
    acp_enabled: 1,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: [],
  };
}

function executor(id: string): TaskExecutorListItem {
  return {
    id,
    task_id: 'task-active',
    room_id: 'room-1',
    room_agent_id: 'agent-row-1',
    agent_id: 'codex',
    agent_name: 'Codex',
    acp_backend: 'codex',
    acp_session_id: 'session-123456',
    status: 'running',
    acp_session_handoff_pending: 0,
    acp_session_handoff_reason: null,
    created_at: 1,
    updated_at: 2,
  };
}
