import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskWorkspacePanel } from './TaskWorkspacePanel';
import type { TaskLayerVisibility } from './TaskDetailPanel';
import type {
  AgentRun,
  Message,
  MessageLayer,
  RoomAgent,
  Task,
  TaskEvent,
  TaskEventType,
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
      messages={[plannerMessage('message-planner', 'task-active')]}
      agentRuns={[agentRun('run-1', 'task-active')]}
      taskEvents={[
        event('diff-1', 'diff_detected', 'diff', { path: 'src/index.ts', additions: 2, deletions: 1 }),
        event('runtime-1', 'runtime_event', 'runtime', { command: 'npm run build', output: 'ok' }),
      ]}
      taskEventsLoading={false}
      agents={[agent('agent-row-1', 'Codex')]}
      workflows={[] as WorkflowRun[]}
      layerVisibility={layers}
      onStatusFiltersChange={() => undefined}
      onSelectTask={() => undefined}
      onLocateSourceMessage={() => undefined}
      onClearActiveTask={() => undefined}
      t={(key) => key}
      formatRelativeTime={(value) => `${value}`}
      taskStatusLabel={(value) => value}
      taskPriorityLabel={(value) => value}
      interactionModeLabel={(value) => value}
    />,
  );

  assert.match(html, /task-workspace-panel/);
  assert.match(html, /实现任务工作区/);
  assert.match(html, /浏览器闭环验证/);
  assert.match(html, /data-active="true"/);
  assert.match(html, /taskWorkspace.activeTask/);
  assert.match(html, /Records/);
  assert.match(html, /规划决策/);
  assert.match(html, /Codex/);
  assert.doesNotMatch(html, /src\/index\.ts/);
  assert.doesNotMatch(html, /npm run build/);
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
      messages={[]}
      agentRuns={[]}
      taskEventsLoading={false}
      agents={[]}
      workflows={[]}
      layerVisibility={layers}
      onStatusFiltersChange={() => undefined}
      onSelectTask={() => undefined}
      onLocateSourceMessage={() => undefined}
      onClearActiveTask={() => undefined}
      t={(key) => key}
      formatRelativeTime={(value) => `${value}`}
      taskStatusLabel={(value) => value}
      taskPriorityLabel={(value) => value}
      interactionModeLabel={(value) => value}
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

function plannerMessage(id: string, taskId: string): Message {
  return {
    id,
    room_id: 'room-1',
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '规划师',
    content: '规划完成',
    message_type: 'text',
    layer: 'activity',
    metadata: JSON.stringify({
      attachments: [],
      task_id: taskId,
      planner_decision: {
        mode: 'pause_after_suggestion',
        status: 'suggested',
        summary: '建议先执行前端重构',
        next_steps: [{ agent_id: 'codex', goal: '实现任务工作区重构' }],
        awaiting_user_confirmation: false,
      },
    }),
    created_at: 2,
  };
}

function agentRun(id: string, taskId: string): AgentRun {
  return {
    id,
    room_id: 'room-1',
    room_agent_id: 'agent-row-1',
    agent_id: 'codex',
    backend: 'codex',
    status: 'completed',
    session_key: null,
    acp_session_id: 'session-123456',
    task_id: taskId,
    workflow_run_id: null,
    workflow_step_id: null,
    workflow_stage: null,
    prompt: '执行任务工作区重构',
    stdout: '',
    stderr: '',
    activity_log: '已读取上下文',
    error: null,
    started_at: 2,
    updated_at: 3,
    completed_at: 3,
  };
}
