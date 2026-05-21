import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import type { Message, RoomAgent, TaskArtifact, WorkflowDetail, WorkflowPlanJson, WorkflowRun, WorkflowStep } from '../lib/types';
import { WorkflowTaskBubble } from './WorkflowTaskBubble';

setupBrowserStubs();

test('renders task table from graph_state workflowPlan', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan({
        tasks: [
          ...createWorkflowPlan().tasks,
          {
            id: 'task-review',
            title: '代码审查',
            description: '审查执行结果',
            role: 'reviewer',
            agent_id: 'agent-review',
            mode: 'serial',
            depends_on: ['task-1'],
            status: 'completed',
            progress: 100,
            result_refs: [],
          },
          {
            id: 'task-accept',
            title: '功能验收',
            description: '验收整体任务是否满足用户需求',
            role: 'acceptor',
            agent_id: 'agent-accept',
            mode: 'serial',
            depends_on: ['task-review'],
            status: 'pending',
            progress: 0,
            result_refs: [],
          },
        ],
      }),
    }),
  });

  const html = renderBubble(detail, [
    createAgent(),
    createAgent({
      id: 'agent-review',
      agent_name: '审查智能体',
      workflow_role: 'reviewer',
    }),
    createAgent({
      id: 'agent-accept',
      agent_name: '验收智能体',
      workflow_role: 'acceptor',
    }),
  ]);

  assert.match(html, /工作流子任务表格/);
  assert.match(html, /实现聊天气泡/);
  assert.match(html, /前端执行者/);
  assert.match(html, /代码审查/);
  assert.match(html, /审查/);
  assert.match(html, /功能验收/);
  assert.match(html, /验收智能体/);
});

test('renders skipped workflow plan task from graph_state', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan({
        tasks: [
          {
            id: 'task-skipped',
            title: '必要时同步前后端共享展示字段',
            description: '仅当已有事件字段不足时才补充。',
            role: 'executor',
            agent_id: null,
            mode: 'serial',
            depends_on: [],
            status: 'skipped',
            progress: 100,
            result_refs: [],
          },
        ],
      }),
    }),
  });

  const html = renderBubble(detail, []);

  assert.match(html, /必要时同步前后端共享展示字段/);
  assert.match(html, /lucide-skip-forward/);
  assert.doesNotMatch(html, />skipped</);
});

test('renders task table from artifact metadata workflow_plan_json', () => {
  const detail = createWorkflowDetail({
    artifacts: [
      createArtifact({
        metadata: JSON.stringify({ workflow_plan_json: createWorkflowPlan({ workflowName: 'Artifact Plan' }) }),
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()]);

  assert.match(html, /工作流子任务表格/);
  assert.match(html, /Artifact Plan/);
  assert.match(html, /实现聊天气泡/);
});

test('compact mode renders superpowers gate summary from graph_state', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan(),
      runtimeProfile: 'superpowers',
      superpowersPhase: 'tdd_execute',
      designDocPath: 'docs/superpowers/specs/task-9.md',
      tddEvidence: [
        { stage: 'RED', command: 'npm test', passed: false, summary: 'red', },
        { stage: 'GREEN', command: 'npm test', passed: true, summary: 'green', },
      ],
      specComplianceReview: {
        verdict: 'changes_requested',
        findings: ['缺少设计文档路径'],
        reviewedAt: '2026-05-21T00:00:00.000Z',
      },
      codeQualityReview: {
        verdict: 'approved',
        findings: [],
        reviewedAt: '2026-05-21T00:00:00.000Z',
      },
      verificationEvidence: [
        {
          command: 'npm run build',
          status: 'passed',
          required: true,
          fresh: true,
          recordedAt: '2026-05-21T00:00:00.000Z',
        },
      ],
      finishBranchDecision: {
        decision: 'keep_branch',
        options: ['merge_local', 'create_pr', 'keep_branch', 'discard_work'],
        reason: 'awaiting explicit closeout automation',
        decidedAt: '2026-05-21T00:00:00.000Z',
      },
    }),
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.match(html, /当前门禁/);
  assert.match(html, /TDD 执行/);
  assert.match(html, /docs\/superpowers\/specs\/task-9\.md/);
  assert.match(html, /TDD 证据/);
  assert.match(html, /审查发现/);
  assert.match(html, /验证证据/);
  assert.match(html, /保留分支/);
});

test('compact mode renders superpowers gate summary without workflow plan', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      runtimeProfile: 'superpowers',
      superpowersPhase: 'brainstorming',
      designDocPath: 'docs/superpowers/specs/no-plan.md',
      tddEvidence: [],
      specComplianceReview: null,
      codeQualityReview: null,
      verificationEvidence: [],
      finishBranchDecision: null,
    }),
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.match(html, /当前门禁/);
  assert.match(html, /brainstorming|Brainstorming/);
  assert.match(html, /docs\/superpowers\/specs\/no-plan\.md/);
});

test('compact mode ignores malformed superpowers graph_state without crashing', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      runtimeProfile: 'superpowers',
      superpowersPhase: 'tdd_execute',
      designDocPath: 'docs/superpowers/specs/broken.md',
      tddEvidence: [{ stage: 'RED', command: 'npm test' }],
      verificationEvidence: 'bad-data',
      finishBranchDecision: { decision: 'keep_branch' },
    }),
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.equal(html, '');
});

test('compact mode omits agent result tabs for chat embedding', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({ workflowPlan: createWorkflowPlan() }),
    steps: [
      createWorkflowStep({
        id: 'step-1',
        assignedRoomAgentId: 'agent-1',
        result: '已完成紧凑任务表格接入。',
        completedAt: 3,
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.doesNotMatch(html, /按智能体查看执行结果/);
  assert.match(html, /前端执行者/);
  assert.match(html, /已完成紧凑任务表格接入/);
  assert.doesNotMatch(html, /工作流子任务表格/);
});

test('compact mode omits legacy task table actions', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({ workflowPlan: createWorkflowPlan() }),
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.doesNotMatch(html, /操作/);
  assert.doesNotMatch(html, /workflow-task-detail-button/);
  assert.doesNotMatch(html, />详情</);
});

test('timeline mode exposes task detail action from full task table', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({ workflowPlan: createWorkflowPlan() }),
  });

  const html = renderBubble(detail, [createAgent()]);

  assert.match(html, /工作流子任务表格/);
  assert.match(html, /操作/);
  assert.match(html, /aria-label="查看「实现聊天气泡」详情"/);
});

test('task flow falls back to workflow role or id labels', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan({
        tasks: [
          {
            id: 'task-unknown',
            title: '未知智能体任务',
            description: '缺失 room agent 时仍可展示',
            role: 'reviewer',
            agent_id: 'missing-agent',
            mode: 'serial',
            depends_on: [],
            status: 'completed',
            progress: 100,
            result_refs: [],
          },
        ],
      }),
    }),
    steps: [
      createWorkflowStep({
        id: 'step-missing',
        taskId: 'task-unknown',
        assignedRoomAgentId: 'missing-agent',
        result: '审查内容已聚合。',
        completedAt: 5,
      }),
    ],
  });

  const html = renderBubble(detail, [], { compact: true });

  assert.match(html, /missing-agent/);
  assert.match(html, /审查内容已聚合/);
});

test('task flow renders review target and acceptance target labels', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan({
        tasks: [
          ...createWorkflowPlan().tasks,
          {
            id: 'task-review',
            title: '代码审查',
            description: '审查执行结果',
            role: 'reviewer',
            agent_id: 'agent-review',
            mode: 'serial',
            depends_on: ['task-1'],
            status: 'completed',
            progress: 100,
            result_refs: [],
          },
          {
            id: 'task-accept',
            title: '功能验收',
            description: '验收整体结果',
            role: 'acceptor',
            agent_id: 'agent-accept',
            mode: 'serial',
            depends_on: ['task-1', 'task-review'],
            status: 'completed',
            progress: 100,
            result_refs: [],
          },
        ],
      }),
    }),
    steps: [
      createWorkflowStep({
        id: 'step-impl',
        assignedRoomAgentId: 'agent-1',
        result: '第一轮实现完成。',
        completedAt: 2,
      }),
      createWorkflowStep({
        id: 'step-review',
        assignedRoomAgentId: 'agent-review',
        taskId: 'task-root',
        stage: 'code_review',
        nodeName: 'review',
        result: '代码审查要求修改。',
        completedAt: 3,
      }),
      createWorkflowStep({
        id: 'step-accept',
        assignedRoomAgentId: 'agent-accept',
        taskId: 'task-root',
        stage: 'acceptance',
        nodeName: 'acceptance',
        result: '验收通过。',
        completedAt: 4,
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.match(html, /workflow-flow-sidebar/);
  assert.match(html, /审查 \/ 验收/);
  assert.match(html, /完成/);
  assert.match(html, /workflow-flow-status-pill is-completed/);
  assert.match(html, /审查目标 · 实现聊天气泡/);
  assert.match(html, /验收目标 · 实现聊天气泡/);
});

test('task flow keeps empty review and acceptance stages selectable', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan(),
    }),
    steps: [
      createWorkflowStep({
        id: 'step-plan',
        assignedRoomAgentId: null,
        taskId: 'task-root',
        stage: 'planning',
        nodeName: 'planning',
        result: '规划完成。',
        completedAt: 10,
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.match(html, /审查 \/ 验收/);
  assert.match(html, /完成/);
  assert.match(html, /workflow-flow-overview-step is-review/);
  assert.match(html, /workflow-flow-overview-step is-done/);
  assert.match(html, /workflow-flow-status-pill is-pending/);
  assert.match(html, /workflow-flow-task-card-title">任务规划/);
  assert.match(html, /规划完成。/);
});

test('workflow bubble renders compact orchestration layout without agent tabs', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({ workflowPlan: createWorkflowPlan() }),
    steps: [
      createWorkflowStep({
        id: 'step-impl',
        assignedRoomAgentId: 'agent-1',
        taskId: 'task-1',
        result: '执行完成。',
        completedAt: 2,
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.match(html, /workflow-flow-layout/);
  assert.doesNotMatch(html, /按智能体查看执行结果/);
  assert.match(html, /计划 \/ 分析/);
  assert.match(html, /执行层/);
  assert.match(html, /审查 \/ 验收/);
});

test('task flow renders staged board controls and row actions', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan({
        tasks: [
          ...createWorkflowPlan().tasks,
          {
            id: 'task-review',
            title: '代码审查',
            description: '审查执行结果',
            role: 'reviewer',
            agent_id: 'agent-review',
            mode: 'serial',
            depends_on: ['task-1'],
            status: 'running',
            progress: 20,
            result_refs: [],
          },
          {
            id: 'task-accept',
            title: '功能验收',
            description: '验收整体结果',
            role: 'acceptor',
            agent_id: 'agent-accept',
            mode: 'serial',
            depends_on: ['task-review'],
            status: 'completed',
            progress: 100,
            result_refs: [],
          },
        ],
      }),
    }),
    steps: [
      createWorkflowStep({
        id: 'step-plan',
        assignedRoomAgentId: null,
        taskId: 'task-root',
        stage: 'planning',
        nodeName: 'planning',
        result: '规划完成。',
        completedAt: 10,
      }),
      createWorkflowStep({
        id: 'step-impl',
        assignedRoomAgentId: 'agent-1',
        taskId: 'task-1',
        stage: 'implementation',
        nodeName: 'execute',
        result: '执行完成。',
        completedAt: 20,
      }),
      createWorkflowStep({
        id: 'step-review',
        assignedRoomAgentId: 'agent-review',
        taskId: 'task-review',
        stage: 'code_review',
        nodeName: 'review',
        result: '代码审查中。',
        completedAt: null,
      }),
      createWorkflowStep({
        id: 'step-accept',
        assignedRoomAgentId: 'agent-accept',
        taskId: 'task-accept',
        stage: 'acceptance',
        nodeName: 'acceptance',
        result: '验收通过。',
        completedAt: 40,
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });

  assert.doesNotMatch(html, /workflow-flow-section-title/);
  assert.doesNotMatch(html, /添加任务/);
  assert.match(html, /workflow-flow-overview/);
  assert.match(html, /workflow-flow-sidebar/);
  assert.doesNotMatch(html, /workflow-flow-progress-card/);
  assert.doesNotMatch(html, /workflow-flow-detail-shell/);
  assert.doesNotMatch(html, /workflow-flow-substage-panel/);
  assert.match(html, /workflow-flow-detail-panel/);
  assert.match(html, /审查 \/ 验收/);
  assert.match(html, /workflow-event-stack/);
  assert.equal(html.match(/workflow-event-stack/g)?.length, 1);
  assert.match(html, /workflow-flow-log-panel/);
  assert.match(html, /<\/div><div class="workflow-flow-log-panel"><div class="workflow-event-stack">/);
  assert.match(html, /计划 \/ 分析/);
  assert.match(html, /workflow-flow-task-card-title">任务规划</);
  assert.doesNotMatch(html, /workflow-flow-task-card-title">分析</);
  assert.doesNotMatch(html, /workflow-flow-task-card-title">分配/);
  assert.match(html, /aria-label="查看「任务规划」详情"/);
  assert.doesNotMatch(html, /任务内容<\/h4><p>实现聊天气泡<\/p>/);
  assert.doesNotMatch(html, /workflow-flow-entry-content/);
  assert.doesNotMatch(html, /workflow-flow-section-title">任务内容/);
});

test('task flow treats analysis and dispatch steps as execution log events instead of task cards', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({ workflowPlan: createWorkflowPlan() }),
    steps: [
      createWorkflowStep({
        id: 'step-context',
        assignedRoomAgentId: null,
        taskId: 'task-root',
        stage: 'analysis',
        nodeName: 'context',
        result: '已读取任务上下文。',
        completedAt: 10,
      }),
      createWorkflowStep({
        id: 'step-plan',
        assignedRoomAgentId: null,
        taskId: 'task-root',
        stage: 'planning',
        nodeName: 'planning',
        result: '规划完成。',
        completedAt: 20,
      }),
      createWorkflowStep({
        id: 'step-dispatch',
        assignedRoomAgentId: null,
        taskId: 'task-root',
        stage: 'assignment',
        nodeName: 'dispatch',
        result: '已分配 1 个执行子任务。',
        completedAt: 30,
      }),
      createWorkflowStep({
        id: 'step-impl',
        assignedRoomAgentId: 'agent-1',
        taskId: 'task-1',
        stage: 'implementation',
        nodeName: 'execute',
        result: '执行完成。',
        completedAt: 40,
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });
  const cardListStart = html.indexOf('<div class="workflow-flow-task-cards">');
  const logStart = html.indexOf('<div class="workflow-event-stack">');
  const cardListHtml = html.slice(cardListStart, logStart);
  const logHtml = html.slice(logStart);

  assert.match(cardListHtml, /workflow-flow-task-card-title">任务规划/);
  assert.match(cardListHtml, /workflow-flow-task-card-title">实现聊天气泡/);
  assert.doesNotMatch(cardListHtml, /已读取任务上下文/);
  assert.doesNotMatch(cardListHtml, /已分配 1 个执行子任务/);
  assert.match(logHtml, /已读取任务上下文/);
  assert.match(logHtml, /已分配 1 个执行子任务/);
});

test('task flow maps runtime child task steps back to workflow plan tasks', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan(),
      childTaskPlanIndexes: {
        'child-task-1': 0,
      },
    }),
    steps: [
      createWorkflowStep({
        id: 'step-impl-child',
        assignedRoomAgentId: 'agent-1',
        taskId: 'child-task-1',
        stage: 'implementation',
        nodeName: 'execute',
        result: '子任务真实执行完成。',
        completedAt: 40,
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });
  const cardListStart = html.indexOf('<div class="workflow-flow-task-cards">');
  const logStart = html.indexOf('<div class="workflow-event-stack">');
  const cardListHtml = html.slice(cardListStart, logStart);
  const logHtml = html.slice(logStart);

  assert.match(cardListHtml, /workflow-flow-task-card-title">实现聊天气泡/);
  assert.match(logHtml, /子任务真实执行完成。/);
});

test('task flow keeps workflow planner plan items out of child task cards', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan({
        tasks: [
          {
            id: 'task-planner-note',
            title: '整理需求说明',
            description: '作为 workflow 规划阶段处理，不生成执行子任务。',
            role: 'planner',
            agent_id: 'agent-planner',
            mode: 'parallel',
            depends_on: [],
            status: 'completed',
            progress: 100,
            result_refs: [],
          },
          ...createWorkflowPlan().tasks,
        ],
      }),
    }),
    steps: [
      createWorkflowStep({
        id: 'step-plan',
        assignedRoomAgentId: 'agent-planner',
        taskId: 'task-root',
        stage: 'planning',
        nodeName: 'planning',
        result: '规划完成。',
        completedAt: 20,
      }),
    ],
  });

  const html = renderBubble(detail, [
    createAgent({ id: 'agent-planner', agent_name: '规划智能体', workflow_role: 'planner' }),
    createAgent(),
  ], { compact: true });
  const cardListStart = html.indexOf('<div class="workflow-flow-task-cards">');
  const logStart = html.indexOf('<div class="workflow-event-stack">');
  const cardListHtml = html.slice(cardListStart, logStart);

  assert.match(cardListHtml, /workflow-flow-task-card-title">任务规划/);
  assert.match(cardListHtml, /workflow-flow-task-card-title">实现聊天气泡/);
  assert.doesNotMatch(cardListHtml, /workflow-flow-task-card-title">整理需求说明/);
});

test('task flow renders review and verification as ordered workflow nodes', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({
      workflowPlan: createWorkflowPlan({
        tasks: [
          ...createWorkflowPlan().tasks,
          {
            id: 'task-review',
            title: '代码审查',
            description: '审查执行结果',
            role: 'reviewer',
            agent_id: 'agent-review',
            mode: 'serial',
            depends_on: ['task-1'],
            status: 'completed',
            progress: 100,
            result_refs: [],
          },
        ],
      }),
    }),
    steps: [
      createWorkflowStep({
        id: 'step-review',
        assignedRoomAgentId: 'agent-review',
        taskId: 'task-root',
        stage: 'code_review',
        nodeName: 'review',
        result: '代码审查通过。',
        completedAt: 30,
      }),
      createWorkflowStep({
        id: 'step-impl',
        assignedRoomAgentId: 'agent-1',
        taskId: 'task-1',
        stage: 'implementation',
        nodeName: 'execute',
        result: '执行完成。',
        completedAt: 20,
      }),
      createWorkflowStep({
        id: 'step-verify',
        assignedRoomAgentId: null,
        taskId: 'task-root',
        stage: 'code_review',
        nodeName: 'verify',
        result: '验证命令通过。',
        completedAt: 40,
      }),
      createWorkflowStep({
        id: 'step-accept',
        assignedRoomAgentId: 'agent-accept',
        taskId: 'task-root',
        stage: 'acceptance',
        nodeName: 'acceptance',
        result: '验收通过。',
        completedAt: 50,
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });
  const executionIndex = html.indexOf('is-execution');
  const reviewIndex = html.indexOf('is-review');
  const doneIndex = html.indexOf('is-done');

  assert.notEqual(executionIndex, -1);
  assert.notEqual(reviewIndex, -1);
  assert.notEqual(doneIndex, -1);
  assert.equal(executionIndex < reviewIndex, true);
  assert.equal(reviewIndex < doneIndex, true);
  assert.match(html, /审查 \/ 验收/);
  assert.match(html, /workflow-event-stack/);
});

test('task flow does not render long execution content inline', () => {
  const longResult = '这是很长的执行结果，隐藏默认智能体结果栏后不应该撑开任务流转节点。'.repeat(12);
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({ workflowPlan: createWorkflowPlan() }),
    steps: [
      createWorkflowStep({
        id: 'step-impl',
        assignedRoomAgentId: 'agent-1',
        taskId: 'task-1',
        stage: 'implementation',
        nodeName: 'execute',
        result: longResult,
        completedAt: 20,
      }),
    ],
  });

  const html = renderBubble(detail, [createAgent()], { compact: true });
  const cardListStart = html.indexOf('<div class="workflow-flow-task-cards">');
  const logStart = html.indexOf('<div class="workflow-event-stack">');

  assert.notEqual(cardListStart, -1);
  assert.notEqual(logStart, -1);

  const cardListHtml = html.slice(cardListStart, logStart);

  assert.doesNotMatch(cardListHtml, /这是很长的执行结果/);
  assert.doesNotMatch(html, /这是很长的执行结果/);
  assert.match(html, /生成中间结果/);
});

test('task flow merges workflow event messages into execution log', () => {
  const detail = createWorkflowDetail({
    graphState: JSON.stringify({ workflowPlan: createWorkflowPlan() }),
    steps: [
      createWorkflowStep({
        id: 'step-impl',
        assignedRoomAgentId: 'agent-1',
        taskId: 'task-1',
        stage: 'implementation',
        nodeName: 'execute',
        result: '执行完成。',
        completedAt: 20,
      }),
    ],
  });
  const html = renderBubble(detail, [createAgent()], {
    compact: true,
    eventMessages: [
      createWorkflowEventMessage({
        id: 'event-review',
        content: '代码审查任务已加入执行日志',
        createdAt: 30,
      }),
    ],
  });

  assert.match(html, /workflow-event-stack/);
  assert.match(html, /代码审查任务已加入执行日志/);
  assert.equal(html.match(/workflow-event-stack/g)?.length, 1);
});

test('returns null when workflow plan is unavailable', () => {
  const detail = createWorkflowDetail();

  const html = renderBubble(detail, []);

  assert.equal(html, '');
});

function createWorkflowPlan(input: { workflowName?: string; tasks?: WorkflowPlanJson['tasks'] } = {}): WorkflowPlanJson {
  return {
    workflow_name: input.workflowName ?? 'Workflow Plan',
    source_message_id: 'message-1',
    goal: '在聊天消息内展示 workflow 子任务',
    summary: '最小接入 workflow task bubble',
    tasks: input.tasks ?? [
      {
        id: 'task-1',
        title: '实现聊天气泡',
        description: '在消息气泡里复用子任务表格',
        role: 'executor',
        agent_id: 'agent-1',
        mode: 'parallel',
        depends_on: [],
        status: 'running',
        progress: 40,
        result_refs: [],
      },
    ],
  };
}

function renderBubble(
  detail: WorkflowDetail,
  agents: RoomAgent[],
  options: { compact?: boolean; eventMessages?: Message[] } = {},
): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <WorkflowTaskBubble
        detail={detail}
        agents={agents}
        eventMessages={options.eventMessages}
        compact={options.compact}
      />
    </I18nProvider>,
  );
}

function setupBrowserStubs(): void {
  Object.defineProperty(globalThis, 'React', {
    configurable: true,
    value: React,
  });

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
    },
  });
}

function createWorkflowDetail(input: {
  graphState?: string | null;
  artifacts?: TaskArtifact[];
  steps?: WorkflowStep[];
} = {}): WorkflowDetail {
  return {
    run: createWorkflowRun({ graphState: input.graphState ?? null }),
    steps: input.steps ?? [],
    artifacts: input.artifacts ?? [],
  };
}

function createWorkflowRun(input: { graphState: string | null }): WorkflowRun {
  return {
    id: 'workflow-1',
    room_id: 'room-1',
    project_id: 'project-1',
    task_id: 'task-root',
    status: 'running',
    current_stage: 'implementation',
    approval_required: 0,
    approved_at: null,
    approved_by: null,
    openclaw_flow_id: null,
    graph_version: 'graph-v1',
    graph_state: input.graphState,
    workflow_definition_id: null,
    workflow_definition_version: null,
    workflow_definition_snapshot: null,
    created_at: 1,
    updated_at: 2,
    completed_at: null,
    error: null,
  };
}

function createArtifact(input: { metadata: string | null }): TaskArtifact {
  return {
    id: 'artifact-1',
    task_id: 'task-root',
    workflow_run_id: 'workflow-1',
    workflow_step_id: null,
    artifact_type: 'plan',
    title: 'Plan',
    content: 'Plan content',
    metadata: input.metadata,
    created_at: 1,
  };
}

function createWorkflowStep(input: {
  id: string;
  assignedRoomAgentId: string | null;
  taskId?: string;
  stage?: WorkflowStep['stage'];
  nodeName?: WorkflowStep['node_name'];
  result: string;
  completedAt: number | null;
}): WorkflowStep {
  return {
    id: input.id,
    workflow_run_id: 'workflow-1',
    task_id: input.taskId ?? 'task-1',
    stage: input.stage ?? 'implementation',
    node_name: input.nodeName ?? 'execute',
    status: input.completedAt ? 'completed' : 'running',
    room_agent_id: input.assignedRoomAgentId,
    assigned_room_agent_id: input.assignedRoomAgentId,
    agent_run_id: null,
    scope_read: [],
    scope_write: [],
    prompt: '执行任务',
    result: input.result,
    result_message_id: null,
    openclaw_child_task_id: null,
    started_at: 2,
    completed_at: input.completedAt,
    error: null,
    sort_order: 1,
    created_at: 1,
    updated_at: input.completedAt ?? 2,
  };
}

function createAgent(input: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id: 'agent-1',
    room_id: 'room-1',
    global_agent_id: null,
    agent_id: 'frontend-executor',
    agent_name: '前端执行者',
    agent_role: null,
    preferred_user_name: null,
    personality: null,
    rules: null,
    responsibilities: null,
    workflow_role: 'executor',
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: 'acp',
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
    ...input,
  };
}

function createWorkflowEventMessage(input: { id: string; content: string; createdAt: number }): Message {
  return {
    id: input.id,
    room_id: 'room-1',
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content: input.content,
    message_type: 'system',
    metadata: JSON.stringify({
      event_type: 'workflow_stage_changed',
      workflow_run_id: 'workflow-1',
      task_id: 'task-1',
    }),
    created_at: input.createdAt,
  };
}
