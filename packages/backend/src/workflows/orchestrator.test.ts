import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatParsedPlanArtifact,
  formatRecentMessagesForPlanner,
  shouldSkipAsyncWorkflowCompletion,
  shouldUseLangChainPlanner,
} from './orchestrator.js';
import type { Message, WorkflowRun, WorkflowStep } from '../types.js';

test('shouldUseLangChainPlanner only enables LangChain for planning stage with enabled config', () => {
  assert.equal(shouldUseLangChainPlanner('planning', { enabled: true, model: 'gpt-4.1-mini' }), true);
  assert.equal(shouldUseLangChainPlanner('analysis', { enabled: true, model: 'gpt-4.1-mini' }), false);
  assert.equal(shouldUseLangChainPlanner('planning', { enabled: false, model: null }), false);
});

test('formatParsedPlanArtifact emits modern fenced JSON and preserves needsApproval=false', () => {
  const artifact = formatParsedPlanArtifact({
    goal: 'Ship planner',
    summary: 'Use LangChain planner output.',
    assumptions: ['Config is enabled.'],
    tasks: [
      {
        title: 'Wire planner',
        description: 'Connect planning stage to planner service.',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Planning continues without approval when allowed.'],
        scopeRead: ['packages/backend/src/workflows/orchestrator.ts'],
        scopeWrite: ['packages/backend/src/workflows/orchestrator.ts'],
        preferredBackend: 'codex',
        dependsOn: ['analysis'],
      },
    ],
    reviewFocus: [],
    verification: ['npm run build'],
    risks: ['Planner output can be malformed.'],
    needsApproval: false,
  });

  assert.match(artifact, /^```json\n/);
  assert.match(artifact, /\n```$/);
  const parsed = JSON.parse(artifact.replace(/^```json\n/, '').replace(/\n```$/, '')) as {
    needsApproval: boolean;
    steps: Array<{ intent: string; assigneeRole: string; preferredBackend?: string }>;
    verification: Array<{ command: string; reason: string; required: boolean }>;
  };
  assert.equal(parsed.needsApproval, false);
  assert.equal(parsed.steps[0]?.intent, 'Connect planning stage to planner service.');
  assert.equal(parsed.steps[0]?.assigneeRole, 'executor');
  assert.equal(parsed.steps[0]?.preferredBackend, 'codex');
  assert.deepEqual(parsed.verification[0], { command: 'npm run build', reason: '', required: true });
});

test('formatRecentMessagesForPlanner keeps latest messages in chronological order and bounds text', () => {
  const messages = Array.from({ length: 25 }, (_, index) =>
    fakeMessage({
      id: `message-${index + 1}`,
      sender_type: index % 2 === 0 ? 'user' : 'agent',
      sender_id: `sender-${index + 1}`,
      sender_name: index % 2 === 0 ? null : `Agent ${index + 1}`,
      content: index === 24 ? 'x'.repeat(300) : `content-${index + 1}`,
      created_at: index + 1,
    }),
  );

  const formatted = formatRecentMessagesForPlanner(messages, {
    limit: 3,
    maxMessageChars: 12,
    maxTotalChars: 200,
  });

  assert.equal(formatted.length, 3);
  assert.match(formatted[0] ?? '', /sender-23: content-23/);
  assert.match(formatted[1] ?? '', /Agent 24: content-24/);
  assert.match(formatted[2] ?? '', /sender-25: x{9}\.\.\./);
  assert.ok(formatted.join('\n').length <= 200);

  const totalBounded = formatRecentMessagesForPlanner(messages, {
    limit: 3,
    maxMessageChars: 100,
    maxTotalChars: 60,
  });
  assert.ok(totalBounded.join('\n').length <= 60);
});

test('shouldSkipAsyncWorkflowCompletion skips terminal workflow or step states', () => {
  assert.equal(shouldSkipAsyncWorkflowCompletion(fakeRun({ status: 'cancelled' }), fakeStep()), true);
  assert.equal(shouldSkipAsyncWorkflowCompletion(fakeRun({ status: 'completed' }), fakeStep()), true);
  assert.equal(shouldSkipAsyncWorkflowCompletion(fakeRun({ status: 'failed' }), fakeStep()), true);
  assert.equal(shouldSkipAsyncWorkflowCompletion(fakeRun({ status: 'running' }), fakeStep({ status: 'failed' })), true);
  assert.equal(shouldSkipAsyncWorkflowCompletion(fakeRun({ status: 'running' }), fakeStep({ status: 'running' })), false);
});

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    room_id: 'room-1',
    sender_type: 'user',
    sender_id: 'user-1',
    sender_name: null,
    content: 'hello',
    message_type: 'text',
    metadata: null,
    created_at: 1,
    ...overrides,
  };
}

function fakeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    room_id: 'room-1',
    project_id: 'project-1',
    task_id: 'task-1',
    status: 'running',
    current_stage: 'planning',
    graph_version: null,
    graph_state: null,
    approval_required: 1,
    approved_at: null,
    approved_by: null,
    openclaw_flow_id: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    error: null,
    ...overrides,
  };
}

function fakeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 'step-1',
    workflow_run_id: 'run-1',
    task_id: 'task-1',
    stage: 'planning',
    node_name: null,
    status: 'running',
    room_agent_id: null,
    assigned_room_agent_id: null,
    scope_read: [],
    scope_write: [],
    agent_run_id: null,
    prompt: '',
    result: '',
    result_message_id: null,
    openclaw_child_task_id: null,
    started_at: 1,
    completed_at: null,
    error: null,
    sort_order: 1,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}
