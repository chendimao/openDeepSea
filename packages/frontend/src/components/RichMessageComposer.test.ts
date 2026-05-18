import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoomAgent } from '../lib/types';
import { buildComposerTriggers } from './RichMessageComposer.triggers';
import type { TriggerSuggestion } from './prompt-area/types';

test('buildComposerTriggers registers agent mention and slash command triggers', () => {
  const agent: RoomAgent = {
    id: 'room-agent-1',
    room_id: 'room-1',
    global_agent_id: null,
    agent_id: 'planner',
    agent_name: 'Planner',
    agent_role: null,
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: null,
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: null,
    tool_policy: null,
    workspace_policy: null,
    memory_scope: null,
    joined_at: 1,
    left_at: null,
    acp_enabled: 1,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: [],
  };

  const triggers = buildComposerTriggers({
    agents: [agent],
    labels: {
      mentionMenuAria: 'mention menu',
      mentionEmpty: 'No agents',
      commandMenuAria: 'command menu',
      taskCommandDescription: 'Create a task',
      startTaskCommandDescription: 'Start a task workflow',
      commandEmpty: 'No commands',
    },
  });

  const mentionTrigger = triggers.find((trigger) => trigger.char === '@');
  assert.equal(mentionTrigger?.position, 'any');
  assert.equal(mentionTrigger?.mode, 'dropdown');
  const mentionResults = asSuggestions(mentionTrigger?.onSearch?.('', { signal: new AbortController().signal }));
  assert.equal(mentionResults?.[0]?.value, 'room-agent-1');
  assert.equal(mentionResults?.[0]?.label, 'Planner');
  assert.equal(mentionResults?.[0]?.data, agent);

  const commandTrigger = triggers.find((trigger) => trigger.char === '/');
  assert.equal(commandTrigger?.position, 'start');
  assert.equal(commandTrigger?.mode, 'dropdown');
  assert.equal(commandTrigger?.chipStyle, 'inline');
  assert.deepEqual(asSuggestions(commandTrigger?.onSearch?.('', { signal: new AbortController().signal })), [
    { value: 'task', label: '/task', description: 'Create a task' },
    { value: 'start-task', label: '/start-task', description: 'Start a task workflow' },
  ]);
  assert.equal(commandTrigger?.onSelect?.({ value: 'task', label: '/task' }), 'task');
});

function asSuggestions(
  value: TriggerSuggestion[] | Promise<TriggerSuggestion[]> | undefined,
): TriggerSuggestion[] | undefined {
  assert.ok(!isPromise(value));
  return value;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value;
}
