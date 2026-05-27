import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStagePrompt, buildSuperpowersPhasePrompt } from './prompts.js';
import type { SuperpowersPhase } from './superpowers-skills.js';

test('buildSuperpowersPhasePrompt includes required skills for each phase', () => {
  const phaseSkillExpectations: Record<SuperpowersPhase, readonly string[]> = {
    brainstorming: ['- using-superpowers', '- brainstorming'],
    worktree: ['- using-git-worktrees'],
    writing_plans: ['- writing-plans'],
    tdd_execute: ['- test-driven-development', '- subagent-driven-development'],
    spec_compliance_review: ['- requesting-code-review'],
    code_quality_review: ['- requesting-code-review'],
    verify: ['- verification-before-completion'],
    finish_branch: ['- finishing-a-development-branch'],
  };

  for (const [phase, expectedSkills] of Object.entries(phaseSkillExpectations) as Array<[SuperpowersPhase, readonly string[]]>) {
    const prompt = buildSuperpowersPhasePrompt(phase, basePromptContext());
    for (const skill of expectedSkills) {
      assert.match(prompt, new RegExp(escapeRegExp(skill)));
    }
    assert.match(prompt, /Superpowers workflow 顺序/);
    assert.match(prompt, /"superpowers"/);
  }
});

test('implementation prompt embeds Superpowers TDD evidence protocol', () => {
  const prompt = buildStagePrompt('implementation', basePromptContext());

  assert.match(prompt, /test-driven-development/);
  assert.match(prompt, /subagent-driven-development/);
  assert.match(prompt, /"tddEvidence"/);
  assert.match(prompt, /"RED"/);
  assert.match(prompt, /"GREEN"/);
});

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

test('planning prompt instructs task profiling before workflow template selection', () => {
  const prompt = buildStagePrompt('planning', basePromptContext());

  assert.match(prompt, /先判断任务类型/);
  assert.match(prompt, /workflow template|workflowTemplate/);
  assert.match(prompt, /前端 UI|前端\/UI/);
  assert.match(prompt, /packages\/frontend/);
  assert.match(prompt, /packages\/backend/);
  assert.match(prompt, /PPT|演示文稿/);
  assert.match(prompt, /不要.*前后端开发模板/);
  assert.match(prompt, /scopeWrite 为空只能用于只读|scopeWrite.*只读/);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
