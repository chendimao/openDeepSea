import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageIntentResult, RouteResult } from './types.js';
import {
  applyIntentToRouteResult,
  classifyMessageIntent,
  classifyMessageIntentWithClassifier,
  parseClassifierIntentResult,
  shouldAskUserForIntent,
} from './message-intent-router.js';

test('classifyMessageIntent covers chat/light_task/debugger/brainstorming/workflow', () => {
  assert.equal(classifyMessageIntent({ message: '今天这个需求先简单聊一下思路。' }).intent, 'chat');
  assert.equal(classifyMessageIntent({ message: '帮我做一个轻量任务：整理一下 README。' }).intent, 'light_task');
  assert.equal(classifyMessageIntent({ message: '这个报错需要调试，先看堆栈。' }).intent, 'debugger');
  assert.equal(classifyMessageIntent({ message: '我们先头脑风暴三个方案再决策。' }).intent, 'brainstorming');
  assert.equal(classifyMessageIntent({ message: '请按 workflow 执行：writing-plans -> implementation。' }).intent, 'workflow');
});

test('classifyMessageIntent uses priority debugger > brainstorming > workflow > light_task > chat', () => {
  const result = classifyMessageIntent({
    message: '先头脑风暴，再走 workflow，另外这个报错也要调试，还要做个轻量任务。',
  });

  assert.equal(result.intent, 'debugger');
});

test('shouldAskUserForIntent returns true for low-confidence intent results', () => {
  const lowConfidence = classifyMessageIntent({ message: '这个先处理一下。' });
  assert.equal(shouldAskUserForIntent(lowConfidence), true);
});

test('applyIntentToRouteResult upgrades ask_user to create_task for high-confidence task-like intent', () => {
  const askUserRouteResult: RouteResult = {
    taskId: null,
    action: 'ask_user',
    confidence: 0,
    reason: '无法确定消息应归属哪个任务',
  };
  const intentResult: MessageIntentResult = {
    intent: 'light_task',
    confidence: 0.93,
    source: 'rule',
    suggested_action: 'create_task',
    reason: '匹配到轻量任务关键词',
  };

  const next = applyIntentToRouteResult(askUserRouteResult, intentResult);
  assert.equal(next.action, 'create_task');
});

test('applyIntentToRouteResult keeps ask_user when intent confidence is low', () => {
  const askUserRouteResult: RouteResult = {
    taskId: null,
    action: 'ask_user',
    confidence: 0,
    reason: '无法确定消息应归属哪个任务',
  };
  const intentResult: MessageIntentResult = {
    intent: 'debugger',
    confidence: 0.5,
    source: 'rule',
    suggested_action: 'ask_user',
    reason: '信号不足',
  };

  const next = applyIntentToRouteResult(askUserRouteResult, intentResult);
  assert.equal(next.action, 'ask_user');
});

test('parseClassifierIntentResult parses strict JSON and forces source=classifier', () => {
  const parsed = parseClassifierIntentResult(JSON.stringify({
    intent: 'workflow',
    confidence: 0.91,
    source: 'rule',
    suggested_action: 'create_task',
    reason: '模型判断应走工作流',
  }));

  assert.equal(parsed.intent, 'workflow');
  assert.equal(parsed.confidence, 0.91);
  assert.equal(parsed.source, 'classifier');
  assert.equal(parsed.suggested_action, 'create_task');
});

test('parseClassifierIntentResult rejects non-raw JSON payload', () => {
  assert.throws(
    () =>
      parseClassifierIntentResult(`
\`\`\`json
{"intent":"chat","confidence":0.9}
\`\`\`
`),
    /raw JSON object/,
  );
});

test('classifyMessageIntentWithClassifier skips classifier when rule confidence is high', async () => {
  let called = false;
  const result = await classifyMessageIntentWithClassifier({
    message: '这个报错需要调试，先看堆栈。',
    classifier: async () => {
      called = true;
      return JSON.stringify({
        intent: 'chat',
        confidence: 0.99,
      });
    },
  });

  assert.equal(called, false);
  assert.equal(result.source, 'rule');
  assert.equal(result.intent, 'debugger');
});

test('classifyMessageIntentWithClassifier uses classifier on low confidence and falls back on parse error', async () => {
  const classifierResult = await classifyMessageIntentWithClassifier({
    message: '这个先处理一下。',
    classifier: async () =>
      JSON.stringify({
        intent: 'light_task',
        confidence: 0.9,
        suggested_action: 'create_task',
        reason: '补全判断',
      }),
  });
  assert.equal(classifierResult.source, 'classifier');
  assert.equal(classifierResult.intent, 'light_task');

  const fallback = await classifyMessageIntentWithClassifier({
    message: '这个先处理一下。',
    classifier: async () => 'not-json',
  });
  assert.equal(fallback.source, 'rule');
});
