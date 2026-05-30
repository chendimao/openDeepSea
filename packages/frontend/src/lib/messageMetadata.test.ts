import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMessageMetadata } from './messageMetadata';

test('parseMessageMetadata keeps legacy message upload attachments', () => {
  const metadata = JSON.stringify({
    attachments: [
      {
        id: 'message-attachment-1',
        name: 'legacy.png',
        mimeType: 'image/png',
        size: 1024,
        url: '/uploads/messages/stored.png',
        isImage: true,
      },
    ],
  });

  assert.deepEqual(parseMessageMetadata(metadata).attachments, [
    {
      id: 'message-attachment-1',
      fileId: undefined,
      name: 'legacy.png',
      mimeType: 'image/png',
      size: 1024,
      url: '/uploads/messages/stored.png',
      isImage: true,
      deleted: undefined,
    },
  ]);
});

test('parseMessageMetadata accepts project file upload attachments', () => {
  const metadata = JSON.stringify({
    attachments: [
      {
        id: 'file-1',
        fileId: 'file-1',
        name: 'screen.png',
        mimeType: 'image/png',
        size: 2048,
        url: '/uploads/files/project-1/stored.png',
        isImage: true,
        deleted: false,
      },
    ],
  });

  assert.deepEqual(parseMessageMetadata(metadata).attachments, [
    {
      id: 'file-1',
      fileId: 'file-1',
      name: 'screen.png',
      mimeType: 'image/png',
      size: 2048,
      url: '/uploads/files/project-1/stored.png',
      isImage: true,
      deleted: false,
    },
  ]);
});

test('parseMessageMetadata rejects unsafe attachment URLs', () => {
  const metadata = JSON.stringify({
    attachments: [
      {
        id: 'external',
        name: 'external.png',
        mimeType: 'image/png',
        size: 1,
        url: 'https://example.com/uploads/files/project-1/stored.png',
        isImage: true,
      },
      {
        id: 'traversal',
        name: 'traversal.png',
        mimeType: 'image/png',
        size: 1,
        url: '/uploads/files/project-1/%2e%2e/secret.png',
        isImage: true,
      },
      {
        id: 'script',
        name: 'script.png',
        mimeType: 'image/png',
        size: 1,
        url: 'javascript:alert(1)',
        isImage: true,
      },
    ],
  });

  assert.deepEqual(parseMessageMetadata(metadata).attachments, []);
});

test('parseMessageMetadata accepts message intent uncertain event type', () => {
  const metadata = JSON.stringify({
    event_type: 'message_intent_uncertain',
    message_id: 'msg-1',
    intent_result: {
      intent: 'chat',
      source: 'classifier',
      confidence: 0.54,
      reason: '上下文不足',
      suggestedAction: 'ask_user',
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.event_type, 'message_intent_uncertain');
  assert.equal(parsed.intent_result?.intent, 'chat');
});

test('parseMessageMetadata accepts collaboration decision metadata', () => {
  const metadata = JSON.stringify({
    event_type: 'collaboration_decision',
    source_message_id: 'message-1',
    fallback_agent_id: 'planner',
    collaboration_decision: {
      intent: 'implementation',
      recommendedMode: 'formal_workflow',
      problemArea: 'frontend',
      summary: '修复群聊协作调度',
      rationale: '涉及代码修改，应由用户选择正式 workflow 或轻量协作。',
      needsUserChoice: true,
      proposedAgents: {
        executors: ['frontend-dev'],
        reviewers: ['reviewer'],
        testers: [],
        acceptors: [],
      },
      stages: [
        {
          stage: 'execute',
          agentIds: ['frontend-dev'],
          parallel: false,
          goal: '实现修复',
        },
        {
          stage: 'review',
          agentIds: ['reviewer'],
          parallel: false,
          goal: '审查修复',
        },
      ],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.source_message_id, 'message-1');
  assert.equal(parsed.fallback_agent_id, 'planner');
  assert.equal(parsed.collaboration_decision?.summary, '修复群聊协作调度');
  assert.equal(parsed.collaboration_decision?.stages[1]?.stage, 'review');
});

test('parseMessageMetadata keeps valid trace events and ignores invalid ones', () => {
  const metadata = JSON.stringify({
    trace: {
      events: [
        {
          id: 'run-1:1',
          message_id: 'message-1',
          run_id: 'run-1',
          agent_id: 'planner',
          seq: 1,
          type: 'plan_update',
          status: 'completed',
          title: '更新计划',
          payload: { status: 'completed', plan: [{ title: 'A' }] },
          created_at: 1000,
        },
        {
          id: '',
          message_id: 'message-1',
          run_id: 'run-1',
          agent_id: 'planner',
          seq: 2,
          type: 'raw',
          status: 'completed',
          title: '坏事件',
          payload: {},
          created_at: 1001,
        },
      ],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.trace?.events?.length, 1);
  assert.equal(parsed.trace?.events?.[0]?.type, 'plan_update');
  assert.equal(parsed.trace?.events?.[0]?.payload.status, 'completed');
});

test('parseMessageMetadata rejects trace events with invalid payload shape', () => {
  const metadata = JSON.stringify({
    trace: {
      events: [
        {
          id: 'run-1:1',
          message_id: 'message-1',
          run_id: 'run-1',
          agent_id: 'planner',
          seq: 1,
          type: 'plan_update',
          status: 'completed',
          title: '更新计划',
          payload: null,
          created_at: 1000,
        },
      ],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.trace, undefined);
});

test('parseMessageMetadata accepts collaboration decision stages without assigned agents', () => {
  const metadata = JSON.stringify({
    event_type: 'collaboration_decision',
    source_message_id: 'message-1',
    fallback_agent_id: 'planner',
    collaboration_decision: {
      intent: 'analysis',
      recommendedMode: 'chat_collaboration',
      problemArea: 'fullstack',
      summary: '检查图片未收到的原因',
      rationale: '这是只读排查，可以先给出分析路径，不需要立即分配具体执行智能体。',
      needsUserChoice: true,
      proposedAgents: {
        executors: [],
        reviewers: [],
        testers: [],
        acceptors: [],
      },
      stages: [
        {
          stage: 'execute',
          agentIds: [],
          parallel: false,
          goal: '收集上下文并定位图片消息链路。',
        },
        {
          stage: 'summary',
          agentIds: [],
          parallel: false,
          goal: '输出根因和后续建议。',
        },
      ],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.source_message_id, 'message-1');
  assert.equal(parsed.collaboration_decision?.proposedAgents.executors.length, 0);
  assert.deepEqual(parsed.collaboration_decision?.stages.map((stage) => stage.agentIds), [[], []]);
});

test('parseMessageMetadata ignores invalid collaboration decision metadata', () => {
  const metadata = JSON.stringify({
    event_type: 'collaboration_decision',
    source_message_id: 'message-1',
    collaboration_decision: {
      intent: 'implementation',
      recommendedMode: 'chat_collaboration',
      problemArea: 'mobile',
      summary: '',
      rationale: 'bad',
      needsUserChoice: true,
      proposedAgents: {
        executors: ['frontend-dev'],
        reviewers: ['reviewer'],
        testers: [],
        acceptors: [],
      },
      stages: [
        {
          stage: 'deploy',
          agentIds: ['frontend-dev'],
          parallel: false,
          goal: 'bad',
        },
      ],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.source_message_id, undefined);
  assert.equal(parsed.collaboration_decision, undefined);
});

test('parseMessageMetadata accepts task readiness metadata', () => {
  const metadata = JSON.stringify({
    task_readiness: {
      ready: true,
      confidence: 0.91,
      title: '收口 ACP 权限派生',
      description: '以 workspace_policy 和 tool_policy 为主配置源，自动派生 Codex 权限。',
      missing_questions: [],
      recommended_mode: 'formal_workflow',
      source_message_id: 'source-message-1',
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.deepEqual(parsed.task_readiness, {
    ready: true,
    confidence: 0.91,
    title: '收口 ACP 权限派生',
    description: '以 workspace_policy 和 tool_policy 为主配置源，自动派生 Codex 权限。',
    missing_questions: [],
    recommended_mode: 'formal_workflow',
    source_message_id: 'source-message-1',
  });
});

test('parseMessageMetadata accepts reply target metadata', () => {
  const metadata = JSON.stringify({
    reply_to: {
      message_id: 'message-1',
      sender_type: 'agent',
      sender_id: 'planner',
      sender_name: '产品经理',
      excerpt: '你希望这个按钮点击后是哪一种行为？',
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.deepEqual(parsed.reply_to, {
    message_id: 'message-1',
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: '产品经理',
    excerpt: '你希望这个按钮点击后是哪一种行为？',
  });
});

test('parseMessageMetadata accepts task readiness metadata with execution intent', () => {
  const metadata = JSON.stringify({
    task_readiness: {
      ready: true,
      confidence: 0.91,
      title: '只读排查方案',
      description: '只做原因分析，不进入实现。',
      missing_questions: [],
      recommended_mode: 'chat_collaboration',
      execution_intent: 'analysis_only',
      source_message_id: 'source-message-1',
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.task_readiness?.execution_intent, 'analysis_only');
  assert.equal(parsed.task_readiness?.recommended_mode, 'chat_collaboration');
});

test('parseMessageMetadata accepts workflow recovery decision task event', () => {
  const metadata = JSON.stringify({
    task_id: 'task-1',
    task_title: '实现资源资产后端模型与接口',
    workflow_run_id: 'workflow-1',
    workflow_step_id: 'step-1',
    event_type: 'workflow_recovery_decided',
    incident_id: 'incident-1',
    incident_type: 'executor_unavailable',
    recovery_action: 'retry_with_global_agent',
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.task_id, 'task-1');
  assert.equal(parsed.workflow_run_id, 'workflow-1');
  assert.equal(parsed.workflow_step_id, 'step-1');
  assert.equal(parsed.event_type, 'workflow_recovery_decided');
});

test('parseMessageMetadata accepts planner decision and structured trace metadata', () => {
  const metadata = JSON.stringify({
    source_message_id: 'user-message-1',
    planner_decision: {
      mode: 'pause_after_suggestion',
      status: 'suggested',
      summary: '建议先验证模型配置与连接测试链路',
      next_steps: [
        {
          agent_id: 'frontend-executor',
          goal: '检查设置页是否已有测试模型入口',
        },
      ],
      awaiting_user_confirmation: true,
    },
    trace: {
      thinking: [{ text: '完整 thinking 原文' }],
      tool_calls: [
        {
          name: 'search_files',
          input: '{"pattern":"model settings"}',
          output: 'found SettingsDialogs.tsx',
        },
      ],
      commands: [
        {
          command: 'rg -n "model" packages/frontend/src',
          output: 'packages/frontend/src/lib/types.ts:1:model',
        },
      ],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.deepEqual(parsed.planner_decision, {
    mode: 'pause_after_suggestion',
    status: 'suggested',
    summary: '建议先验证模型配置与连接测试链路',
    next_steps: [
      {
        agent_id: 'frontend-executor',
        goal: '检查设置页是否已有测试模型入口',
      },
    ],
    awaiting_user_confirmation: true,
  });
  assert.equal(parsed.source_message_id, 'user-message-1');
  assert.equal(parsed.trace?.thinking?.[0]?.text, '完整 thinking 原文');
  assert.equal(parsed.trace?.tool_calls?.[0]?.name, 'search_files');
  assert.equal(parsed.trace?.commands?.[0]?.command, 'rg -n "model" packages/frontend/src');
});

test('parseMessageMetadata keeps trace events alongside legacy trace fields', () => {
  const metadata = JSON.stringify({
    trace: {
      thinking: [{ text: 'keep me' }],
      events: [
        {
          id: 'run-1:1',
          message_id: 'message-1',
          run_id: 'run-1',
          agent_id: 'planner',
          seq: 1,
          type: 'raw',
          status: 'completed',
          title: '原始事件',
          payload: { stdout: 'hello' },
          created_at: 2000,
        },
      ],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.trace?.thinking?.[0]?.text, 'keep me');
  assert.equal(parsed.trace?.events?.[0]?.type, 'raw');
});

test('parseMessageMetadata ignores invalid planner decisions and invalid trace rows', () => {
  const metadata = JSON.stringify({
    planner_decision: {
      mode: 'legacy_mode',
      status: 'suggested',
      summary: 'bad',
      next_steps: [],
      awaiting_user_confirmation: true,
    },
    trace: {
      thinking: [{ text: '' }],
      tool_calls: [{ name: 'search_files' }],
      commands: [{ output: 'missing command' }],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.equal(parsed.planner_decision, undefined);
  assert.equal(parsed.trace, undefined);
});

test('parseMessageMetadata accepts valid intent_result metadata and sanitizes signals', () => {
  const metadata = JSON.stringify({
    intent_result: {
      intent: 'workflow',
      source: 'classifier',
      confidence: 0.92,
      reason: '用户明确要求实现与修复',
      suggested_action: 'start_workflow',
      signals: ['实现', '', '修复', '  ', '任务', '前端', 1, null, 'A', 'B', 'C', 'D', 'E'],
    },
  });

  const parsed = parseMessageMetadata(metadata);

  assert.deepEqual(parsed.intent_result, {
    intent: 'workflow',
    source: 'classifier',
    confidence: 0.92,
    reason: '用户明确要求实现与修复',
    suggestedAction: 'start_workflow',
    signals: ['实现', '修复', '任务', '前端', 'A', 'B', 'C', 'D'],
  });
});

test('parseMessageMetadata rejects invalid intent_result metadata', () => {
  const cases = [
    {
      name: 'invalid intent',
      value: {
        intent: 'invalid',
        source: 'classifier',
        confidence: 0.8,
        reason: 'bad',
        suggestedAction: 'start_workflow',
      },
    },
    {
      name: 'invalid source',
      value: {
        intent: 'workflow',
        source: 'unknown',
        confidence: 0.8,
        reason: 'bad',
        suggestedAction: 'start_workflow',
      },
    },
    {
      name: 'invalid action',
      value: {
        intent: 'workflow',
        source: 'classifier',
        confidence: 0.8,
        reason: 'bad',
        suggestedAction: 'do_anything',
      },
    },
    {
      name: 'invalid confidence',
      value: {
        intent: 'workflow',
        source: 'classifier',
        confidence: 1.2,
        reason: 'bad',
        suggestedAction: 'start_workflow',
      },
    },
    {
      name: 'invalid reason',
      value: {
        intent: 'workflow',
        source: 'classifier',
        confidence: 0.8,
        reason: '   ',
        suggestedAction: 'start_workflow',
      },
    },
  ];

  for (const item of cases) {
    const metadata = JSON.stringify({ intent_result: item.value });
    const parsed = parseMessageMetadata(metadata);
    assert.equal(parsed.intent_result, undefined, item.name);
  }
});
