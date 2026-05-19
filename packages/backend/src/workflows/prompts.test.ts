import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStagePrompt } from './prompts.js';

test('buildStagePrompt uses analysis-document acceptance prompt for analysis-only intent', () => {
  const prompt = buildStagePrompt('acceptance', {
    projectName: 'Project',
    projectPath: '/tmp/project',
    room: {
      id: 'room',
      project_id: 'project',
      name: 'Room',
      description: null,
      created_at: 1,
    },
    task: {
      id: 'task',
      room_id: 'room',
      project_id: 'project',
      parent_task_id: null,
      title: '只读排查方案',
      description: '只做方案设计，不进入实现。\n\n任务意图：analysis_only',
      status: 'todo',
      priority: 'normal',
      interaction_mode: 'auto_recommended',
      assigned_agent_id: null,
      source_message_id: null,
      created_from: 'manual',
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    },
    agents: [],
  });

  assert.match(prompt, /不要要求代码修改、构建或提交/);
  assert.doesNotMatch(prompt, /请按任务要求修改代码/);
});

test('buildStagePrompt uses analysis-document acceptance prompt from workflow kind without intent marker', () => {
  const prompt = buildStagePrompt('acceptance', {
    ...basePromptContext(),
    workflowKind: 'analysis_document',
  });

  assert.match(prompt, /不要要求代码修改、构建或提交/);
  assert.doesNotMatch(prompt, /开发闭环的功能验收智能体/);
});

function basePromptContext(): Parameters<typeof buildStagePrompt>[1] {
  return {
    projectName: 'Project',
    projectPath: '/tmp/project',
    room: {
      id: 'room',
      project_id: 'project',
      name: 'Room',
      description: null,
      created_at: 1,
    },
    task: {
      id: 'task',
      room_id: 'room',
      project_id: 'project',
      parent_task_id: null,
      title: '方案文档闭环任务',
      description: '整理方案文档。',
      status: 'todo',
      priority: 'normal',
      interaction_mode: 'auto_recommended',
      assigned_agent_id: null,
      source_message_id: null,
      created_from: 'manual',
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    },
    agents: [],
  };
}
