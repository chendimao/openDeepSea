import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../../lib/i18n';
import type { Message, Task, WorkflowRun } from '../../lib/types';
import { ChatTaskCard } from './ChatTaskCard';

setupBrowserStubs();

test('ChatTaskCard renders start workflow entrance for open task card', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ChatTaskCard
        message={message('msg-task-created')}
        metadata={{ attachments: [], event_type: 'task_created', task_id: 'task-open-123456' }}
        task={task('task-open-123456', 'todo')}
        roomAgents={[]}
        active={false}
        onSelectTask={() => undefined}
        onStartWorkflow={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(html, /TASK-task-open-/);
  assert.match(html, /去掉header菜单中的测试菜单/);
  assert.match(html, /aria-label="启动闭环"/);
  assert.match(html, /Owner/);
  assert.match(html, /Priority/);
  assert.match(html, /Status/);
  assert.match(html, /Time/);
});

test('ChatTaskCard hides start workflow entrance for done task and active workflow', () => {
  const doneHtml = renderToStaticMarkup(
    <I18nProvider>
      <ChatTaskCard
        message={message('msg-done')}
        metadata={{ attachments: [], event_type: 'task_created', task_id: 'task-done-123456' }}
        task={task('task-done-123456', 'done')}
        roomAgents={[]}
        active={false}
        onSelectTask={() => undefined}
        onStartWorkflow={() => undefined}
      />
    </I18nProvider>,
  );

  const activeWorkflowHtml = renderToStaticMarkup(
    <I18nProvider>
      <ChatTaskCard
        message={message('msg-workflow')}
        metadata={{ attachments: [], event_type: 'task_created', task_id: 'task-workflow-123456' }}
        task={task('task-workflow-123456', 'todo')}
        workflow={workflowRun('task-workflow-123456', 'running')}
        roomAgents={[]}
        active={false}
        onSelectTask={() => undefined}
        onStartWorkflow={() => undefined}
      />
    </I18nProvider>,
  );

  assert.doesNotMatch(doneHtml, /aria-label="启动闭环"/);
  assert.doesNotMatch(activeWorkflowHtml, /aria-label="启动闭环"/);
});

test('ChatTaskCard keeps start workflow entrance after terminal workflow', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ChatTaskCard
        message={message('msg-terminal')}
        metadata={{ attachments: [], event_type: 'task_created', task_id: 'task-terminal-123456' }}
        task={task('task-terminal-123456', 'todo')}
        workflow={workflowRun('task-terminal-123456', 'failed')}
        roomAgents={[]}
        active={false}
        onSelectTask={() => undefined}
        onStartWorkflow={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(html, /aria-label="启动闭环"/);
});

function task(id: string, status: Task['status']): Task {
  return {
    id,
    room_id: 'room-1',
    project_id: 'project-1',
    parent_task_id: null,
    title: '去掉header菜单中的测试菜单',
    description: '建议动作：start_workflow 判断原因：用户提出明确前端实现需求',
    status,
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: null,
    source_message_id: 'msg-task-created',
    created_from: 'chat_plan',
    created_at: 1,
    updated_at: 2,
    completed_at: null,
    deleted_at: null,
  };
}

function message(id: string): Message {
  return {
    id,
    room_id: 'room-1',
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content: '已创建任务 #task-open-123456：去掉header菜单中的测试菜单',
    message_type: 'text',
    metadata: null,
    created_at: 3,
    layer: 'activity',
  };
}

function workflowRun(taskId: string, status: WorkflowRun['status']): WorkflowRun {
  return {
    id: `workflow-${taskId}`,
    room_id: 'room-1',
    project_id: 'project-1',
    task_id: taskId,
    status,
    current_stage: 'planning',
    graph_version: null,
    graph_state: null,
    approval_required: 1,
    approved_at: null,
    approved_by: null,
    openclaw_flow_id: null,
    workflow_definition_id: null,
    workflow_definition_version: null,
    workflow_definition_snapshot: null,
    created_at: 5,
    updated_at: 5,
    completed_at: null,
    error: null,
  };
}

function setupBrowserStubs(): void {
  Object.assign(globalThis, { React });

  if (!('localStorage' in globalThis)) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => null,
        setItem: () => undefined,
      },
      configurable: true,
    });
  }

  if (!('document' in globalThis)) {
    Object.defineProperty(globalThis, 'document', {
      value: { documentElement: { lang: 'zh' } },
      configurable: true,
    });
  }
}
