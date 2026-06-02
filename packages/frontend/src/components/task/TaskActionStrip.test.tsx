import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskActionStrip } from './TaskActionStrip';

Object.assign(globalThis, { React });

test('TaskActionStrip renders four task action entries', () => {
  const html = renderToStaticMarkup(
    <TaskActionStrip
      states={{}}
      onStartAction={() => undefined}
    />,
  );

  assert.match(html, /开始执行/u);
  assert.match(html, /头脑风暴/u);
  assert.match(html, /编写计划/u);
  assert.match(html, /子代理执行/u);
});

test('TaskActionStrip shows running state and disables active action', () => {
  const html = renderToStaticMarkup(
    <TaskActionStrip
      states={{ start_execution: { status: 'running', detail: '运行中' } }}
      onStartAction={() => undefined}
    />,
  );

  assert.match(html, /运行中/u);
  assert.match(html, /disabled/u);
});
