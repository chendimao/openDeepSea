import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStagePrompt } from './prompts.js';

test('buildStagePrompt includes memory context when provided', () => {
  const prompt = buildStagePrompt('analysis', {
    projectName: 'Memory Project',
    projectPath: '/tmp/memory-project',
    room: {
      id: 'room-1',
      project_id: 'project-1',
      name: 'Memory Room',
      description: null,
      created_at: 1,
    },
    task: {
      id: 'task-1',
      room_id: 'room-1',
      project_id: 'project-1',
      parent_task_id: null,
      title: 'Build memory',
      description: 'Add memory context',
      status: 'todo',
      priority: 'normal',
      interaction_mode: 'ask_user',
      assigned_agent_id: null,
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    },
    agents: [],
    artifacts: [],
    memoryContext: '项目/聊天室记忆：\n1. [决策；project] Use explicit memory\nInject it.',
  });

  assert.match(prompt, /项目\/聊天室记忆：/);
  assert.match(prompt, /Use explicit memory/);
});
