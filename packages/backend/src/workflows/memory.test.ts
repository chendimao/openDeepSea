import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTaskSummaryMemoryContent } from './orchestrator.js';
import { buildStagePrompt } from './prompts.js';

test('buildStagePrompt includes memory context when provided', () => {
  const prompt = buildStagePrompt('analysis', {
    ...basePromptContext(),
    memoryContext: '项目/聊天室记忆：\n1. [决策；project] Use explicit memory\nInject it.',
  });

  assert.match(prompt, /项目\/聊天室记忆：/);
  assert.match(prompt, /Use explicit memory/);
});

test('buildStagePrompt uses empty memory placeholder when no memory context is provided', () => {
  const prompt = buildStagePrompt('analysis', basePromptContext());

  assert.match(prompt, /项目\/聊天室记忆：暂无相关记忆。/);
});

test('buildTaskSummaryMemoryContent summarizes parsed acceptance verdict and truncates long notes', () => {
  const content = buildTaskSummaryMemoryContent('Build memory', {
    verdict: 'pass',
    acceptedCriteria: ['prompt includes memory', 'summary is saved'],
    failedCriteria: [],
    notes: 'Accepted. '.repeat(600),
  });

  assert.ok(content.length <= 4000);
  assert.match(content, /任务：Build memory/);
  assert.match(content, /验收结论：通过/);
  assert.match(content, /验收说明：/);
  assert.match(content, /通过标准：/);
  assert.match(content, /- prompt includes memory/);
  assert.doesNotMatch(content, /```json/);
  assert.match(content, /\.\.\.已截断/);
});

function basePromptContext(): Parameters<typeof buildStagePrompt>[1] {
  return {
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
      source_message_id: null,
      created_from: null,
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    },
    agents: [],
    artifacts: [],
  };
}
