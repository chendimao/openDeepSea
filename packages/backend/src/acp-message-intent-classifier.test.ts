import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcpMessageIntentClassifier } from './acp-message-intent-classifier.js';
import type { SessionAdapter } from './acp/types.js';
import type { RoomAgent } from './types.js';

process.env.OPENCLAW_ACP_MESSAGE_INTENT_CLASSIFIER = '0';

test('createAcpMessageIntentClassifier invokes ACP in read-only mode and returns answer JSON', async () => {
  let seenPrompt = '';
  let seenPermissionMode: string | null | undefined;
  const classifier = createAcpMessageIntentClassifier({
    projectPath: '/tmp/project',
    agent: createPlannerAgent(),
    adapter: createAdapterStub(async ({ prompt, acpPermissionMode, onChunk }) => {
      seenPrompt = prompt;
      seenPermissionMode = acpPermissionMode;
      onChunk({
        stream: 'stdout',
        channel: 'answer',
        text: JSON.stringify({
          intent: 'light_task',
          confidence: 0.92,
          suggestedAction: 'create_light_task',
          reason: '用户要求移除 header 测试菜单，属于小范围前端改动',
          signals: ['去掉', 'header菜单', '测试菜单'],
        }),
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    }),
  });

  const output = await classifier({
    message: '去掉header菜单中的测试菜单',
    ruleResult: {
      intent: 'chat',
      confidence: 0.6,
      source: 'rule',
      suggestedAction: 'ask_user',
      reason: '未命中明确任务类信号，按聊天意图处理',
      signals: [],
    },
  });

  assert.match(seenPrompt, /只判断消息意图/u);
  assert.match(seenPrompt, /去掉header菜单中的测试菜单/u);
  assert.equal(seenPermissionMode, 'read-only');
  assert.deepEqual(JSON.parse(output), {
    intent: 'light_task',
    confidence: 0.92,
    suggestedAction: 'create_light_task',
    reason: '用户要求移除 header 测试菜单，属于小范围前端改动',
    signals: ['去掉', 'header菜单', '测试菜单'],
  });
});

test('createAcpMessageIntentClassifier aborts slow ACP classification', async () => {
  const classifier = createAcpMessageIntentClassifier({
    projectPath: '/tmp/project',
    agent: createPlannerAgent(),
    timeoutMs: 1,
    adapter: createAdapterStub(({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })),
  });

  await assert.rejects(
    Promise.resolve(classifier({
      message: '去掉header菜单中的测试菜单',
      ruleResult: {
        intent: 'chat',
        confidence: 0.6,
        source: 'rule',
        suggestedAction: 'ask_user',
        reason: '未命中明确任务类信号，按聊天意图处理',
      },
    })),
    /timed out|aborted/u,
  );
});

function createAdapterStub(
  invoke: SessionAdapter['invoke'],
): SessionAdapter {
  return {
    backend: 'codex',
    listSessions: async () => [],
    invoke,
  };
}

function createPlannerAgent(): RoomAgent {
  return {
    id: 'room-agent-planner',
    room_id: 'room-1',
    global_agent_id: null,
    agent_id: 'planner',
    agent_name: '规划师',
    agent_role: null,
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: 'planner',
    joined_at: 1,
    left_at: null,
    acp_enabled: 1,
    acp_backend: 'codex',
    acp_session_id: 'session-1',
    acp_session_label: null,
    acp_session_handoff_pending: 0,
    acp_session_handoff_reason: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: ['.'],
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: 'acp',
    tool_policy: null,
    workspace_policy: null,
    memory_scope: null,
    memory_max_context_chars: null,
  };
}
