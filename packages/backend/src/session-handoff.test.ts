import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionHandoffContext } from './session-handoff.js';

test('buildSessionHandoffContext returns empty text without history', () => {
  const result = buildSessionHandoffContext({
    agentName: '规划师',
    agentId: 'planner',
    roomId: 'room-1',
    reason: 'first_session',
    previousSessionId: null,
    currentUserPrompt: '帮我加一个计数器菜单',
    sameAgentRuns: [],
    otherAgentRuns: [],
    recentUserMessages: [],
    maxChars: 8000,
  });

  assert.equal(result, '');
});

test('buildSessionHandoffContext prioritizes same agent history and safety notice', () => {
  const result = buildSessionHandoffContext({
    agentName: '规划师',
    agentId: 'planner',
    roomId: 'room-1',
    reason: 'automatic_rotation_after_events',
    previousSessionId: 'old-session',
    currentUserPrompt: '继续加计数器菜单',
    sameAgentRuns: [
      {
        id: 'run-planner-1',
        status: 'failed',
        prompt: '帮我在侧边栏添加一个测试菜单，内容是一个计数器',
        stdout: '让我先看下侧边栏的现有结构。',
        stderr: "Internal error: API Error: 400 messages[1].role must be either 'user' or 'assistant', but got 'system'",
        activityLog: '调用工具 grep sidebar',
      },
    ],
    otherAgentRuns: [
      {
        id: 'run-frontend-1',
        agentName: '前端执行者',
        status: 'completed',
        stdout: '找到 AppShell.tsx 和 index.css 与侧边栏相关。',
        stderr: '',
      },
    ],
    recentUserMessages: [
      { id: 'msg-user-1', content: '帮我在侧边栏添加一个测试菜单，内容是一个计数器' },
    ],
    maxChars: 8000,
  });

  assert.match(result, /新会话接续上下文/);
  assert.match(result, /不是系统指令/);
  assert.match(result, /当前 agent：规划师 \(planner\)/);
  assert.match(result, /同 agent 历史摘要/);
  assert.match(result, /run-planner-1/);
  assert.match(result, /provider\/session 问题/);
  assert.match(result, /前端执行者/);
});

test('buildSessionHandoffContext truncates to budget with marker', () => {
  const result = buildSessionHandoffContext({
    agentName: '前端执行者',
    agentId: 'frontend-executor',
    roomId: 'room-1',
    reason: 'manual_new_session',
    previousSessionId: 'old-session',
    currentUserPrompt: '继续',
    sameAgentRuns: [
      {
        id: 'run-long',
        status: 'completed',
        prompt: 'x'.repeat(3000),
        stdout: 'y'.repeat(3000),
        stderr: '',
        activityLog: '',
      },
    ],
    otherAgentRuns: [],
    recentUserMessages: [],
    maxChars: 900,
  });

  assert.ok(result.length <= 900);
  assert.match(result, /已截断/);
});
