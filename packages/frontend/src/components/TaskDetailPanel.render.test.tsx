import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskLayerToggles, type TaskLayerVisibility } from './TaskDetailPanel';

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
