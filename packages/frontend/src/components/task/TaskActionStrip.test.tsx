import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskActionStrip } from './TaskActionStrip';

Object.assign(globalThis, { React });

test('TaskActionStrip renders auto advance, more trigger, and override menu entries', () => {
  const html = renderToStaticMarkup(
    <TaskActionStrip
      states={{}}
      onStartAction={() => undefined}
    />,
  );

  assert.match(html, /自动推进/u);
  assert.match(html, /更多/u);
  assert.match(html, /重新运行路由判断/u);
  assert.match(html, /强制头脑风暴/u);
  assert.match(html, /强制编写计划/u);
  assert.match(html, /强制执行计划/u);
  assert.match(html, /强制诊断\/调试/u);
  assert.doesNotMatch(html, /开始执行/u);
  assert.doesNotMatch(html, /子代理执行/u);
});

test('TaskActionStrip shows running stage and disables primary and menu controls', () => {
  const html = renderToStaticMarkup(
    <TaskActionStrip
      states={{ writing_plans: { status: 'running', detail: '正在编写 implementation plan' } }}
      onStartAction={() => undefined}
    />,
  );

  assert.match(html, /编写计划中/u);
  assert.match(html, /正在编写 implementation plan/u);
  assert.match(html, /disabled/u);
});

test('TaskActionStrip renders retry copy for failed or blocked actions', () => {
  const failedHtml = renderToStaticMarkup(
    <TaskActionStrip
      states={{ systematic_debugging: { status: 'failed', detail: '测试失败' } }}
      onStartAction={() => undefined}
    />,
  );
  const blockedHtml = renderToStaticMarkup(
    <TaskActionStrip
      states={{ route_skills: { status: 'blocked', detail: '缺少可执行 planner' } }}
      onStartAction={() => undefined}
    />,
  );

  assert.match(failedHtml, /重试自动推进/u);
  assert.match(failedHtml, /测试失败/u);
  assert.match(blockedHtml, /重试自动推进/u);
  assert.match(blockedHtml, /缺少可执行 planner/u);
});

test('TaskActionStrip renders boundary confirmation copy before failed retry copy', () => {
  const html = renderToStaticMarkup(
    <TaskActionStrip
      states={{ auto_advance: { status: 'failed', detail: '任务动作 auto_advance 已进入 failed' } }}
      pendingTaskExecution={{
        state: 'needs_boundary_confirmation',
        status: 'suggested',
        summary: '确认 @文件 chip 完整路径的适用范围后进入设计定稿',
        reason: '需要确认是否只改 workspace 文件/文件夹。',
        next_steps: [{ agent_id: 'planner', goal: '确认适用范围后提出方案' }],
      }}
      onStartAction={() => undefined}
    />,
  );

  assert.match(html, /等待用户确认边界/u);
  assert.match(html, /确认 @文件 chip 完整路径的适用范围后进入设计定稿/u);
  assert.doesNotMatch(html, /重试自动推进/u);
});

test('TaskActionStrip renders review findings and automatic fix rounds', () => {
  const html = renderToStaticMarkup(
    <TaskActionStrip
      states={{
        subagent_execution: {
          status: 'failed',
          detail: '审查仍有阻断问题',
          reviewFixRounds: 2,
          reviewFindings: [
            {
              severity: 'critical',
              summary: '仍会展示错误字典预览',
              file: 'index.vue',
              line: 1102,
            },
          ],
        },
      }}
      onStartAction={() => undefined}
    />,
  );

  assert.match(html, /审查问题/u);
  assert.match(html, /已自动回派修复 2 轮/u);
  assert.match(html, /仍会展示错误字典预览/u);
  assert.match(html, /index.vue:1102/u);
});
