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
  const chat = classifyMessageIntent({ message: '解释一下当前 AI Task OS 的 M1-M4 是什么' });
  const lightTask = classifyMessageIntent({ message: '临时插入一点修改，把默认主题改成极简风' });
  const debuggerIntent = classifyMessageIntent({ message: '为什么页面中没有任何变化，帮我找根因' });
  const brainstorming = classifyMessageIntent({ message: '头脑风暴，将左侧任务栏和右侧任务详情合并在一起' });
  const workflow = classifyMessageIntent({
    message: '实现消息意图自动路由，需要完整闭环，完成后浏览器实际测试、代码审查并提交',
  });

  assert.equal(chat.intent, 'chat');
  assert.equal(chat.suggestedAction, 'reply_in_chat');
  assert.equal(lightTask.intent, 'light_task');
  assert.equal(lightTask.suggestedAction, 'create_light_task');
  assert.equal(debuggerIntent.intent, 'debugger');
  assert.equal(debuggerIntent.suggestedAction, 'start_debugger');
  assert.equal(brainstorming.intent, 'brainstorming');
  assert.equal(brainstorming.suggestedAction, 'start_brainstorming');
  assert.equal(workflow.intent, 'workflow');
  assert.equal(workflow.suggestedAction, 'start_workflow');
});

test('classifyMessageIntent uses priority debugger > brainstorming > workflow > light_task > chat', () => {
  const result = classifyMessageIntent({
    message: '先头脑风暴，再走 workflow，另外这个报错也要调试，还要做个轻量任务。',
  });

  assert.equal(result.intent, 'debugger');
});

test('classifyMessageIntent lets anchored explicit prefixes override mixed signals', () => {
  const workflow = classifyMessageIntent({ message: 'workflow：这个报错需要完整闭环' });
  const brainstorming = classifyMessageIntent({ message: '头脑风暴：为什么页面没有变化' });
  const task = classifyMessageIntent({ message: '/task 整理发布说明' });

  assert.equal(workflow.intent, 'workflow');
  assert.equal(workflow.source, 'user_override');
  assert.equal(workflow.suggestedAction, 'start_workflow');
  assert.equal(brainstorming.intent, 'brainstorming');
  assert.equal(brainstorming.source, 'user_override');
  assert.equal(brainstorming.suggestedAction, 'start_brainstorming');
  assert.equal(task.intent, 'light_task');
  assert.equal(task.source, 'user_override');
  assert.equal(task.suggestedAction, 'create_light_task');
});

test('shouldAskUserForIntent returns true for low-confidence intent results', () => {
  const lowConfidence = classifyMessageIntent({ message: '这个先处理一下。' });
  assert.equal(shouldAskUserForIntent(lowConfidence), true);
});

test('applyIntentToRouteResult upgrades global chat route to create_task for high-confidence task-like intent', () => {
  const askUserRouteResult: RouteResult = {
    taskId: null,
    action: 'reply_in_chat',
    confidence: 0,
    reason: '未显式引用任务，按全局聊天回复',
    reason_code: 'reply_in_chat',
  };
  const intentResult: MessageIntentResult = {
    intent: 'light_task',
    confidence: 0.93,
    source: 'rule',
    suggestedAction: 'create_light_task',
    reason: '匹配到轻量任务关键词',
  };

  const next = applyIntentToRouteResult(askUserRouteResult, intentResult);
  assert.equal(next.action, 'create_task');
  assert.equal(next.reason_code, 'create_task_intent');
});

test('applyIntentToRouteResult upgrades non-explicit task routing for high-confidence task-like intent', () => {
  const activeTaskRouteResult: RouteResult = {
    taskId: 'task-1',
    action: 'append_to_task',
    confidence: 0.9,
    reason: '旧的非显式任务路由',
    reason_code: 'reply_in_chat',
  };
  const intentResult: MessageIntentResult = {
    intent: 'workflow',
    confidence: 0.95,
    source: 'rule',
    suggestedAction: 'start_workflow',
    reason: '匹配到 workflow 关键词',
  };

  const next = applyIntentToRouteResult(activeTaskRouteResult, intentResult);

  assert.equal(next.action, 'create_task');
  assert.equal(next.taskId, null);
  assert.equal(next.reason_code, 'create_task_intent');
});

test('applyIntentToRouteResult preserves explicit task routing and explicit terminal-task guardrails', () => {
  const intentResult: MessageIntentResult = {
    intent: 'debugger',
    confidence: 0.95,
    source: 'rule',
    suggestedAction: 'start_debugger',
    reason: '匹配到 debugger 关键词',
  };
  const explicitAppend: RouteResult = {
    taskId: 'task-1',
    action: 'append_to_task',
    confidence: 1,
    reason: '显式任务引用：task-1',
    reason_code: 'explicit_task',
  };
  const terminalAsk: RouteResult = {
    taskId: null,
    action: 'ask_user',
    confidence: 0,
    reason: '显式任务引用不可接收新消息：task-1（done）',
    reason_code: 'explicit_task_terminal',
  };

  assert.equal(applyIntentToRouteResult(explicitAppend, intentResult).action, 'append_to_task');
  assert.equal(applyIntentToRouteResult(terminalAsk, intentResult).action, 'ask_user');
});

test('applyIntentToRouteResult preserves explicit task routing for high-confidence intent', () => {
  const explicitMatch: RouteResult = {
    taskId: 'task-1',
    action: 'append_to_task',
    confidence: 1,
    reason: '显式任务引用：task-1',
    reason_code: 'explicit_task',
  };
  const intentResult: MessageIntentResult = {
    intent: 'debugger',
    confidence: 0.95,
    source: 'rule',
    suggestedAction: 'start_debugger',
    reason: '匹配到 debugger 关键词',
  };

  const next = applyIntentToRouteResult(explicitMatch, intentResult);

  assert.equal(next.action, 'append_to_task');
  assert.equal(next.taskId, 'task-1');
});

test('applyIntentToRouteResult keeps ask_user when intent confidence is low', () => {
  const askUserRouteResult: RouteResult = {
    taskId: null,
    action: 'ask_user',
    confidence: 0,
    reason: '无法确定消息应归属哪个任务',
    reason_code: 'reply_in_chat',
  };
  const intentResult: MessageIntentResult = {
    intent: 'debugger',
    confidence: 0.5,
    source: 'rule',
    suggestedAction: 'ask_user',
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
    suggestedAction: 'start_workflow',
    reason: '模型判断应走工作流',
    signals: ['workflow'],
  }));

  assert.ok(parsed);
  assert.equal(parsed.intent, 'workflow');
  assert.equal(parsed.confidence, 0.91);
  assert.equal(parsed.source, 'classifier');
  assert.equal(parsed.suggestedAction, 'start_workflow');
  assert.deepEqual(parsed.signals, ['workflow']);
});

test('parseClassifierIntentResult returns null for non-raw JSON payload', () => {
  assert.equal(
    parseClassifierIntentResult(`
\`\`\`json
{"intent":"chat","confidence":0.9}
\`\`\`
`),
    null,
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
        suggestedAction: 'create_light_task',
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
