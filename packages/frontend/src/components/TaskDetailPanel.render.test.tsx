import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskExecutorSessions, TaskLayerToggles, type TaskLayerVisibility } from './TaskDetailPanel';

const visible: TaskLayerVisibility = {
  chat: true,
  activity: true,
  timeline: false,
  runtime: true,
  diff: true,
};

test('TaskLayerToggles exposes native checkbox state inside clickable labels', () => {
  const html = renderToStaticMarkup(
    <TaskLayerToggles
      layerVisibility={visible}
      onChange={() => undefined}
      t={(key) => key}
    />,
  );

  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 4);
  assert.match(html, /<input type="checkbox" checked=""/);
  assert.match(html, /<input type="checkbox"\/><span class="task-event-dot" data-layer="timeline"/);
  assert.match(html, /data-layer="timeline"/);
  assert.match(html, />timeline</);
});

test('TaskExecutorSessions renders task scoped session state compactly', () => {
  const html = renderToStaticMarkup(
    <TaskExecutorSessions
      executors={[
        {
          id: 'executor-1',
          task_id: 'task-1',
          room_id: 'room-1',
          room_agent_id: 'agent-row-1',
          agent_id: 'codex',
          agent_name: 'Codex Agent',
          acp_backend: 'codex',
          acp_session_id: 'session-123456789',
          status: 'running',
          acp_session_handoff_pending: 1,
          acp_session_handoff_reason: 'automatic_rotation',
          created_at: 1,
          updated_at: 2,
        },
      ]}
      isLoading={false}
      t={(key) => key}
    />,
  );

  assert.match(html, /taskDetail.executors/);
  assert.match(html, /Codex Agent/);
  assert.match(html, /session-/);
  assert.match(html, /data-status="running">running</);
  assert.match(html, /taskExecutor.handoffPending/);
});
