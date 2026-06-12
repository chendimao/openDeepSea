import assert from 'node:assert/strict';
import test from 'node:test';
import { assignPlanTaskAgent } from './agent-assignment.js';

const baseAgent = {
  id: 'agent-id',
  name: 'Agent',
  provider: 'codex' as const,
  acpEnabled: true,
  available: true,
  priority: 0,
};

test('assignPlanTaskAgent prefers specialist over fullstack fallback', () => {
  const result = assignPlanTaskAgent({
    taskId: 'task-1',
    title: '实现 React 页面',
    requiredCapabilities: ['frontend', 'react'],
    scopeWrite: ['packages/frontend/src/pages/Home.tsx'],
    agents: [
      {
        ...baseAgent,
        id: 'fullstack-engineer',
        name: '全栈工程师',
        capabilities: ['frontend', 'backend', 'testing'],
        workflowRoles: ['executor'],
        fallback: true,
      },
      {
        ...baseAgent,
        id: 'frontend-executor',
        name: '前端工程师',
        capabilities: ['frontend', 'react'],
        workflowRoles: ['executor'],
        fallback: false,
      },
    ],
  });

  assert.equal(result.assignedAgentId, 'frontend-executor');
  assert.equal(result.fallbackReason, null);
});

test('assignPlanTaskAgent falls back to fullstack engineer when no specialist matches', () => {
  const result = assignPlanTaskAgent({
    taskId: 'task-2',
    title: '修复跨端集成',
    requiredCapabilities: ['integration'],
    scopeWrite: ['packages/backend/src/routes.ts', 'packages/frontend/src/lib/api.ts'],
    agents: [
      {
        ...baseAgent,
        id: 'fullstack-engineer',
        name: '全栈工程师',
        capabilities: ['frontend', 'backend', 'integration'],
        workflowRoles: ['executor'],
        fallback: true,
      },
    ],
  });

  assert.equal(result.assignedAgentId, 'fullstack-engineer');
  assert.match(result.fallbackReason ?? '', /未找到更匹配/);
  assert.equal(result.executionMode, 'serial');
});

test('assignPlanTaskAgent treats fullstack engineer as fallback even without fallback flag', () => {
  const result = assignPlanTaskAgent({
    taskId: 'task-3',
    title: '实现 React 页面',
    requiredCapabilities: ['frontend', 'react'],
    scopeWrite: ['packages/frontend/src/pages/Home.tsx'],
    agents: [
      {
        ...baseAgent,
        id: 'fullstack-engineer',
        name: '全栈工程师',
        capabilities: ['frontend', 'backend', 'react', 'testing'],
        workflowRoles: ['executor'],
      },
    ],
  });

  assert.equal(result.assignedAgentId, 'fullstack-engineer');
  assert.match(result.fallbackReason ?? '', /未找到更匹配/);
});

test('assignPlanTaskAgent uses fullstack fallback when required capabilities are empty', () => {
  const result = assignPlanTaskAgent({
    taskId: 'task-4',
    title: 'testing integration work',
    requiredCapabilities: [],
    scopeWrite: [],
    agents: [
      {
        ...baseAgent,
        id: 'backend-executor',
        name: '后端工程师',
        capabilities: ['backend', 'testing'],
        workflowRoles: ['executor'],
      },
      {
        ...baseAgent,
        id: 'fullstack-engineer',
        name: '全栈工程师',
        capabilities: ['frontend', 'backend', 'testing'],
        workflowRoles: ['executor'],
      },
    ],
  });

  assert.equal(result.assignedAgentId, 'fullstack-engineer');
  assert.match(result.fallbackReason ?? '', /未找到更匹配/);
});
