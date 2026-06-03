import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun, Message } from '../../lib/types';
import { retryFailedAgentRun } from './chatMessageModel';

test('retryFailedAgentRun calls the agent-run retry endpoint instead of resending the previous user message', async () => {
  const calls: string[] = [];

  await retryFailedAgentRun({
    run: createAgentRun({ id: 'run-failed', status: 'failed' }),
    retrySourceMessage: createMessage({ id: 'source-message', content: '创建任务：不要重复创建' }),
    retryAgentRun: async (id) => {
      calls.push(`retry:${id}`);
    },
    sendMessage: async () => {
      calls.push('send-message');
    },
  });

  assert.deepEqual(calls, ['retry:run-failed']);
});

function createMessage(input: Pick<Message, 'id' | 'content'>): Message {
  return {
    id: input.id,
    room_id: 'room-1',
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: input.content,
    message_type: 'text',
    metadata: null,
    created_at: 1000,
  };
}

function createAgentRun(input: Partial<AgentRun>): AgentRun {
  return {
    id: input.id ?? 'run-1',
    room_id: 'room-1',
    room_agent_id: 'room-agent-1',
    agent_id: 'planner',
    backend: 'codex',
    status: input.status ?? 'failed',
    session_key: null,
    acp_session_id: null,
    task_id: null,
    workflow_run_id: null,
    workflow_step_id: null,
    workflow_stage: null,
    prompt: 'prompt',
    stdout: '',
    stderr: '',
    activity_log: '',
    error: null,
    started_at: 1000,
    updated_at: 1000,
    completed_at: 2000,
  };
}
