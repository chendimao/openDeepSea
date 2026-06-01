import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcpTaskAnalyzer, parseTaskAnalysisResult } from './acp-task-analyzer.js';
import type { SessionAdapter } from './acp/types.js';
import type { RoomAgent } from './types.js';

test('createAcpTaskAnalyzer invokes ACP in read-only mode and parses structured task JSON', async () => {
  let seenPrompt = '';
  let seenPermissionMode: string | null | undefined;
  let seenWritableDirs: string[] | null | undefined;
  let seenSessionId: string | null | undefined;
  const analyzer = createAcpTaskAnalyzer({
    projectPath: '/tmp/project',
    agent: createPlannerAgent(),
    adapter: createAdapterStub(async ({ prompt, sessionId, acpPermissionMode, acpWritableDirs, onChunk }) => {
      seenPrompt = prompt;
      seenSessionId = sessionId;
      seenPermissionMode = acpPermissionMode;
      seenWritableDirs = acpWritableDirs;
      onChunk({
        stream: 'stdout',
        channel: 'answer',
        text: JSON.stringify({
          task_type: 'light_task',
          execution_intent: 'implementation',
          confidence: 0.93,
          title: '移除 header 测试菜单',
          description: '删除 header 菜单里的测试入口。',
          acceptance: ['测试入口不可见'],
          missing_questions: [],
          recommended_next_action: 'create_task',
          requires_confirmation: false,
        }),
      });
      return { exitCode: 0, sessionId: null, stderr: '' };
    }),
  });

  const result = await analyzer({
    message: '去掉 header 菜单中的测试菜单',
    intentResult: {
      intent: 'light_task',
      confidence: 0.9,
      source: 'classifier',
      suggestedAction: 'create_light_task',
      reason: '明确轻量任务',
    },
    routeResult: {
      action: 'create_task',
      taskId: null,
      confidence: 0.9,
      reason: '创建任务',
      reason_code: 'create_task_intent',
    },
  });

  assert.match(seenPrompt, /只能判断任务类型并输出结构化任务信息/u);
  assert.match(seenPrompt, /不要执行用户请求/u);
  assert.match(seenPrompt, /去掉 header 菜单中的测试菜单/u);
  assert.equal(seenSessionId, null);
  assert.equal(seenPermissionMode, 'read-only');
  assert.deepEqual(seenWritableDirs, []);
  assert.equal(result.title, '移除 header 测试菜单');
  assert.equal(result.recommended_next_action, 'create_task');
});

test('createAcpTaskAnalyzer rejects ACP tool or command attempts', async () => {
  const analyzer = createAcpTaskAnalyzer({
    projectPath: '/tmp/project',
    agent: createPlannerAgent(),
    adapter: createAdapterStub(async ({ onChunk, signal }) => {
      onChunk({ stream: 'stdout', channel: 'tool', text: 'apply_patch' });
      if (signal?.aborted) throw new Error('aborted');
      return { exitCode: 0, sessionId: null, stderr: '' };
    }),
  });

  await assert.rejects(
    analyzer({
      message: '去掉 header 菜单中的测试菜单',
      intentResult: {
        intent: 'light_task',
        confidence: 0.9,
        source: 'classifier',
        suggestedAction: 'create_light_task',
        reason: '明确轻量任务',
      },
      routeResult: {
        action: 'create_task',
        taskId: null,
        confidence: 0.9,
        reason: '创建任务',
        reason_code: 'create_task_intent',
      },
    }),
    /aborted|invalid JSON/u,
  );
});

test('parseTaskAnalysisResult accepts nested task_analysis JSON', () => {
  const result = parseTaskAnalysisResult(JSON.stringify({
    task_analysis: {
      task_type: 'debugger',
      execution_intent: 'debug_fix',
      confidence: 0.88,
      title: '排查页面无变化',
      description: '分析页面修改没有生效的原因。',
      acceptance: ['找到根因'],
      missing_questions: [],
      recommended_next_action: 'create_task',
      requires_confirmation: true,
    },
  }));

  assert.equal(result?.task_type, 'debugger');
  assert.equal(result?.execution_intent, 'debug_fix');
  assert.equal(result?.requires_confirmation, true);
});

function createAdapterStub(invoke: SessionAdapter['invoke']): SessionAdapter {
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
