import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-agent-provisioning-')), 'test.db');

const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { ensureWorkflowAgentsForRun } = await import('./agent-provisioning.js');
import type { ParsedPlanTask } from './plan-parser.js';

test('ensureWorkflowAgentsForRun provisions fullstack fallback for executor task without specialist signal', () => {
  const projectPath = join(tmpdir(), `opendeepsea-provisioning-project-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const result = ensureWorkflowAgentsForRun({
    roomId: room.id,
    agents: [],
    planTasks: [{
      title: '实现确认后的开发任务',
      description: '按计划完成实现和验证',
      suggestedRole: 'executor',
      priority: 'normal',
      acceptance: [],
      scopeRead: [],
      scopeWrite: [],
      dependsOn: [],
    }],
  });

  assert.equal(result.joinedAgents.length, 1);
  assert.equal(result.joinedAgents[0]?.agent_id, 'fullstack-engineer');
});

test('ensureWorkflowAgentsForRun keeps specialist mappings for frontend backend and documentation tasks', () => {
  const projectPath = join(tmpdir(), `opendeepsea-provisioning-specialists-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Project Specialists', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Specialist Room' });

  const result = ensureWorkflowAgentsForRun({
    roomId: room.id,
    agents: [],
    planTasks: [
      planTask({
        title: '实现 React 页面',
        scopeWrite: ['packages/frontend/src/pages/Home.tsx'],
      }),
      planTask({
        title: '实现后端 API',
        scopeWrite: ['packages/backend/src/routes.ts'],
      }),
      planTask({
        title: '补充验证文档',
        scopeWrite: ['docs/superpowers/verification.md'],
      }),
    ],
  });

  assert.deepEqual(result.joinedAgents.map((agent) => agent.agent_id).sort(), [
    'backend-executor',
    'frontend-executor',
    'technical-writer',
  ]);
});

test('ensureWorkflowAgentsForRun provisions frontend and backend specialists for cross frontend backend tasks', () => {
  const projectPath = join(tmpdir(), `opendeepsea-provisioning-cross-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Project Cross', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Cross Room' });

  const result = ensureWorkflowAgentsForRun({
    roomId: room.id,
    agents: [],
    planTasks: [
      planTask({
        title: '修复前后端集成',
        description: '同时更新 backend API 和 React 调用',
        scopeWrite: ['packages/backend/src/routes.ts', 'packages/frontend/src/lib/api.ts'],
      }),
    ],
  });

  assert.deepEqual(result.joinedAgents.map((agent) => agent.agent_id).sort(), [
    'backend-executor',
    'frontend-executor',
    'fullstack-engineer',
  ]);
});

test('ensureGlobalExecutorForRecovery falls back when requested template id is unknown', async () => {
  const projectPath = join(tmpdir(), `opendeepsea-provisioning-recovery-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Recovery Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Recovery Room' });
  const { ensureGlobalExecutorForRecovery } = await import('./agent-provisioning.js');

  const agent = ensureGlobalExecutorForRecovery({
    roomId: room.id,
    globalAgentTemplateId: 'missing-template',
    context: {
      childTask: { title: '修复跨端任务' },
      workflowStep: { scopeWrite: [] },
    },
  });

  assert.equal(agent.agent_id, 'fullstack-engineer');
});

function planTask(overrides: Partial<ParsedPlanTask>): ParsedPlanTask {
  return {
    title: '实现任务',
    description: '',
    suggestedRole: 'executor' as const,
    priority: 'normal' as const,
    acceptance: [],
    scopeRead: [],
    scopeWrite: [],
    dependsOn: [],
    ...overrides,
  };
}
