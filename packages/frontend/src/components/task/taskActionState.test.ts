import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskEvent } from '../../lib/types';
import { createTaskActionStates, deriveSuperpowersTaskStage } from './taskActionState';

test('createTaskActionStates folds task action events by task seq before status overwrite', () => {
  const completed = taskEvent({
    id: 'event-completed',
    seq: 2,
    payload: { task_action: 'start_execution', task_action_status: 'completed' },
  });
  const running = taskEvent({
    id: 'event-running',
    seq: 1,
    payload: { task_action: 'start_execution', task_action_status: 'running' },
  });

  const states = createTaskActionStates([completed, running], null);

  assert.equal(states.start_execution?.status, 'completed');
});

test('createTaskActionStates folds new task actions and extracts evidence', () => {
  const states = createTaskActionStates([
    taskEvent({
      payload: {
        task_action: 'brainstorming',
        task_action_status: 'completed',
        evidence: { designDocPath: 'docs/superpowers/specs/task-design.md' },
      },
    }),
    taskEvent({
      payload: {
        task_action: 'auto_advance',
        task_action_status: 'completed',
        evidence: { superpowers_routing: { next_action: 'writing_plans' } },
      },
    }),
  ], 'task-1:systematic_debugging');

  assert.equal(states.brainstorming?.status, 'completed');
  assert.equal(states.brainstorming?.evidence?.designDocPath, 'docs/superpowers/specs/task-design.md');
  assert.equal(states.auto_advance?.evidence?.superpowers_routing && typeof states.auto_advance.evidence.superpowers_routing, 'object');
  assert.equal(states.systematic_debugging?.status, 'running');
});

test('createTaskActionStates extracts review findings and fix rounds', () => {
  const states = createTaskActionStates([
    taskEvent({
      payload: {
        task_action: 'subagent_execution',
        task_action_status: 'failed',
        review_fix_rounds: 2,
        review_findings: [
          {
            severity: 'critical',
            summary: '仍会展示错误字典预览',
            file: 'index.vue',
            line: 1102,
          },
        ],
      },
    }),
  ], null);

  assert.equal(states.subagent_execution?.reviewFixRounds, 2);
  assert.deepEqual(states.subagent_execution?.reviewFindings, [
    {
      severity: 'critical',
      summary: '仍会展示错误字典预览',
      file: 'index.vue',
      line: 1102,
    },
  ]);
});

test('deriveSuperpowersTaskStage prioritizes failed and blocked before running', () => {
  assert.equal(deriveSuperpowersTaskStage({
    writing_plans: {
      status: 'running',
      detail: '编写计划中',
    },
    route_skills: {
      status: 'blocked',
      detail: '缺少可执行 planner',
    },
  }), 'blocked');

  assert.equal(deriveSuperpowersTaskStage({
    auto_advance: {
      status: 'failed',
      detail: '路由失败',
    },
    writing_plans: {
      status: 'running',
      detail: '编写计划中',
    },
  }), 'failed');
});

test('deriveSuperpowersTaskStage maps running actions and completed evidence', () => {
  assert.equal(deriveSuperpowersTaskStage({
    route_skills: { status: 'running', detail: '路由中' },
  }), 'routing');
  assert.equal(deriveSuperpowersTaskStage({
    brainstorming: { status: 'running', detail: '头脑风暴中' },
  }), 'brainstorming');
  assert.equal(deriveSuperpowersTaskStage({
    subagent_execution: { status: 'running', detail: '执行中' },
  }), 'executing');
  assert.equal(deriveSuperpowersTaskStage({
    systematic_debugging: { status: 'running', detail: '调试中' },
  }), 'debugging');
  assert.equal(deriveSuperpowersTaskStage({
    verification: { status: 'running', detail: '验收中' },
  }), 'verifying');

  assert.equal(deriveSuperpowersTaskStage({
    auto_advance: {
      status: 'completed',
      evidence: { superpowers_routing: { next_action: 'brainstorming' } },
    },
  }), 'routed');
  assert.equal(deriveSuperpowersTaskStage({
    brainstorming: {
      status: 'completed',
      evidence: { designDocPath: 'docs/superpowers/specs/task-design.md' },
    },
  }), 'spec_ready');
  assert.equal(deriveSuperpowersTaskStage({
    brainstorming: {
      status: 'completed',
      evidence: { designDocPath: 'docs/superpowers/specs/task-design.md' },
    },
    writing_plans: {
      status: 'completed',
      evidence: { implementationPlanPath: 'docs/superpowers/plans/task-plan.md' },
    },
  }), 'plan_ready');
  assert.equal(deriveSuperpowersTaskStage({
    finish_branch: { status: 'completed' },
  }), 'done');
});

function taskEvent(input: Partial<TaskEvent>): TaskEvent {
  return {
    id: input.id ?? 'event-1',
    task_id: input.task_id ?? 'task-1',
    room_id: input.room_id ?? 'room-1',
    seq: input.seq ?? 1,
    type: input.type ?? 'task_updated',
    layer: input.layer ?? 'timeline',
    payload: input.payload ?? {},
    source_run_id: input.source_run_id ?? null,
    created_at: input.created_at ?? 1000,
  };
}
