import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStructuredAgentEvent, toTaskEventMetadata } from './agent-events.js';

test('parseStructuredAgentEvent accepts decision request event', () => {
  const event = parseStructuredAgentEvent({
    workflowRunId: 'run',
    stepId: 'step',
    agentRunId: 'agent-run',
    type: 'decision_request',
    summary: '需要确认是否扩大写入范围。',
    requestedDecision: {
      question: '是否允许修改 shared types?',
      options: ['允许', '拒绝'],
      recommendation: '允许',
      impact: '会影响前后端 contract。',
    },
    createdAt: 1,
  });

  assert.equal(event.type, 'decision_request');
  assert.equal(event.requestedDecision?.question, '是否允许修改 shared types?');
});

test('toTaskEventMetadata stores event as runtime event metadata', () => {
  const metadata = toTaskEventMetadata({
    workflowRunId: 'run',
    stepId: 'step',
    agentRunId: 'agent-run',
    type: 'progress',
    summary: '完成 50%',
    progress: 50,
    createdAt: 1,
  });
  const agentEvent = metadata.agent_event as { type: string; progress?: number };

  assert.equal(metadata.timeline_type, 'agent_progress');
  assert.equal(agentEvent.type, 'progress');
  assert.equal(agentEvent.progress, 50);
});
