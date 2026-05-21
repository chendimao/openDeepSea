import test from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedPlan } from '../plan-parser.js';
import type { WorkflowPlanJson } from '../../types.js';
import {
  buildCoordinatorWorkflowPlan,
  deriveCoordinatorPlanFromProductManagerBackground,
  isWorkflowPlanJson,
  parseWorkflowPlanFromArtifactMetadata,
} from './coordinator-plan.js';

test('buildCoordinatorWorkflowPlan derives WorkflowPlanJson from ParsedPlan', () => {
  const parsedPlan: ParsedPlan = {
    goal: '实现 Workflow Coordinator',
    summary: '先实现结构化计划，再执行审查。',
    assumptions: [],
    tasks: [
      {
        title: '实现结构化计划模块',
        description: '新增 coordinator plan 模块并覆盖测试。',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['可从 ParsedPlan 派生 WorkflowPlanJson'],
        scopeRead: [],
        scopeWrite: ['packages/backend/src/workflows/graph/coordinator-plan.ts'],
        dependsOn: [],
      },
      {
        title: '审查结构化计划模块',
        description: '审查派生结果和 metadata 容错。',
        suggestedRole: 'reviewer',
        priority: 'normal',
        acceptance: ['审查通过'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: ['实现结构化计划模块'],
      },
    ],
    reviewFocus: [],
    verification: [],
    verificationCommands: [],
    risks: [],
    needsApproval: false,
  };

  const plan = buildCoordinatorWorkflowPlan({
    workflowName: 'Coordinator 计划结构化',
    sourceMessageId: 'msg-source-1',
    parsedPlan,
  });

  assert.ok(plan);
  assert.equal(plan.workflow_name, 'Coordinator 计划结构化');
  assert.equal(plan.source_message_id, 'msg-source-1');
  assert.equal(plan.goal, '实现 Workflow Coordinator');
  assert.equal(plan.summary, '先实现结构化计划，再执行审查。');
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0]?.mode, 'parallel');
  assert.deepEqual(plan.tasks[0]?.depends_on, []);
  assert.equal(plan.tasks[0]?.status, 'pending');
  assert.equal(plan.tasks[0]?.progress, 0);
  assert.equal(plan.tasks[1]?.mode, 'serial');
  assert.deepEqual(plan.tasks[1]?.depends_on, ['task-1-实现结构化计划模块']);
});

test('buildCoordinatorWorkflowPlan serializes executable tasks to match current runtime execution', () => {
  const parsedPlan: ParsedPlan = {
    goal: '实现文件管理',
    summary: '后端和前端按当前 runtime 串行执行。',
    assumptions: [],
    tasks: [
      {
        title: '补充后端文件元数据',
        description: '修改后端接口。',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['后端接口返回来源类型'],
        scopeRead: [],
        scopeWrite: ['packages/backend/src/routes.ts'],
        dependsOn: [],
      },
      {
        title: '改造前端文件列表',
        description: '修改前端展示。',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['前端显示来源类型'],
        scopeRead: [],
        scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
        dependsOn: [],
      },
    ],
    reviewFocus: [],
    verification: [],
    verificationCommands: [],
    risks: [],
    needsApproval: false,
  };

  const plan = buildCoordinatorWorkflowPlan({
    workflowName: '文件管理',
    sourceMessageId: 'msg-source-2',
    parsedPlan,
  });

  assert.equal(plan?.tasks[0]?.mode, 'parallel');
  assert.deepEqual(plan?.tasks[0]?.depends_on, []);
  assert.equal(plan?.tasks[1]?.mode, 'serial');
  assert.deepEqual(plan?.tasks[1]?.depends_on, ['task-1-补充后端文件元数据']);
});

test('buildCoordinatorWorkflowPlan reuses an existing graph state workflow plan first', () => {
  const existing = makeWorkflowPlanJson('msg-state-1');
  const parsedPlan: ParsedPlan = {
    goal: '不应使用',
    summary: '已有 workflowPlan 时不重新派生。',
    assumptions: [],
    tasks: [
      {
        title: '不应派生',
        description: '不应派生',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: [],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      },
    ],
    reviewFocus: [],
    verification: [],
    verificationCommands: [],
    risks: [],
    needsApproval: false,
  };

  const plan = buildCoordinatorWorkflowPlan({
    workflowName: '不应覆盖',
    sourceMessageId: 'msg-derived-1',
    workflowPlan: existing,
    parsedPlan,
  });

  assert.equal(plan, existing);
  assert.equal(plan?.source_message_id, 'msg-state-1');
});

test('parseWorkflowPlanFromArtifactMetadata accepts object and JSON string metadata', () => {
  const objectPlan = makeWorkflowPlanJson('msg-object-1');
  const stringPlan = makeWorkflowPlanJson('msg-string-1');

  assert.deepEqual(
    parseWorkflowPlanFromArtifactMetadata({ workflow_plan_json: objectPlan }),
    objectPlan,
  );
  assert.deepEqual(
    parseWorkflowPlanFromArtifactMetadata(JSON.stringify({ workflow_plan_json: stringPlan })),
    stringPlan,
  );
});

test('parseWorkflowPlanFromArtifactMetadata returns null for invalid metadata', () => {
  assert.equal(parseWorkflowPlanFromArtifactMetadata(null), null);
  assert.equal(parseWorkflowPlanFromArtifactMetadata('not-json'), null);
  assert.equal(parseWorkflowPlanFromArtifactMetadata({ workflow_plan_json: { source_message_id: 123 } }), null);
  assert.equal(parseWorkflowPlanFromArtifactMetadata(JSON.stringify({ workflow_plan_json: { tasks: 'bad' } })), null);
});

test('isWorkflowPlanJson validates the WorkflowPlanJson shape', () => {
  assert.equal(isWorkflowPlanJson(makeWorkflowPlanJson('msg-valid-1')), true);
  assert.equal(isWorkflowPlanJson({ ...makeWorkflowPlanJson('msg-invalid-1'), tasks: [{ id: 'missing-fields' }] }), false);
});

test('deriveCoordinatorPlanFromProductManagerBackground extracts executable tasks without planner call', () => {
  const plan = deriveCoordinatorPlanFromProductManagerBackground({
    taskTitle: '细化文件管理功能',
    taskDescription: [
      '细化文件管理功能，区分用户上传文件和智能体生成 md 文档。',
      '',
      '产品经理方案背景：',
      '实施计划：',
      '1. 梳理现状并冻结实现方案',
      '- 验收：作为执行上下文，不单独开发',
      '2. 补充后端资源元数据与查询能力',
      '- 改动：packages/backend/src/routes.ts',
      '- 验收：后端返回文件来源类型',
      '3. 改造前端资源库展示与详情',
      '- 改动：packages/frontend/src/pages/FilesPage.tsx',
      '- 验收：前端显示用户上传和智能体生成文档',
      '',
      '验证方式：',
      '- npm run build',
      '',
      '任务意图：implementation',
    ].join('\n'),
  });

  assert.ok(plan);
  assert.equal(plan.goal, '细化文件管理功能');
  assert.equal(plan.needsApproval, false);
  assert.deepEqual(plan.tasks.map((task) => task.title), [
    '补充后端资源元数据与查询能力',
    '改造前端资源库展示与详情',
  ]);
  assert.deepEqual(plan.tasks.map((task) => task.suggestedRole), ['executor', 'executor']);
  assert.deepEqual(plan.tasks[0]?.scopeWrite, ['packages/backend/src/routes.ts']);
  assert.deepEqual(plan.tasks[1]?.dependsOn, []);
  assert.match(plan.tasks[1]?.acceptance.join('\n') ?? '', /前端显示/);
  assert.deepEqual(plan.verificationCommands, [
    {
      command: 'npm run build',
      reason: '产品经理方案背景中的验证方式',
      required: true,
    },
  ]);
});

test('deriveCoordinatorPlanFromProductManagerBackground splits inline prose implementation plan into executable tasks', () => {
  const plan = deriveCoordinatorPlanFromProductManagerBackground({
    taskTitle: '文件管理来源细化',
    taskDescription: [
      '文件管理来源细化。',
      '',
      '产品经理方案背景：',
      '实施计划：补充后端来源字段，改造前端文件列表。',
      '验收标准：文件列表显示来源。',
      '',
      '任务意图：implementation',
    ].join('\n'),
  });

  assert.ok(plan);
  assert.deepEqual(plan.tasks.map((task) => task.title), [
    '补充后端来源字段',
    '改造前端文件列表',
  ]);
  assert.deepEqual(plan.tasks.map((task) => task.suggestedRole), ['executor', 'executor']);
  assert.match(plan.tasks[0]?.acceptance.join('\n') ?? '', /文件列表显示来源/);
  assert.match(plan.tasks[1]?.description ?? '', /改造前端文件列表/);
});

test('deriveCoordinatorPlanFromProductManagerBackground summarizes fallback task title from background', () => {
  const plan = deriveCoordinatorPlanFromProductManagerBackground({
    taskTitle: '确定,生成任务',
    taskDescription: [
      '确定生成任务。',
      '',
      '产品经理方案背景：',
      '补充工作流任务标题生成逻辑，避免多个子任务都显示父任务名称。',
      '验收标准：每个子任务都有简短、可区分的名称。',
      '',
      '任务意图：implementation',
    ].join('\n'),
  });

  assert.ok(plan);
  assert.deepEqual(plan.tasks.map((task) => task.title), [
    '补充工作流任务标题生成逻辑，避免多个子任务都显示',
  ]);
});

test('deriveCoordinatorPlanFromProductManagerBackground keeps review and acceptance titles distinct', () => {
  const plan = deriveCoordinatorPlanFromProductManagerBackground({
    taskTitle: '聊天室工作流修复',
    taskDescription: [
      '聊天室工作流修复。',
      '',
      '产品经理方案背景：',
      '实施计划：',
      '1. 补充前端侧边栏最近聊天室',
      '- 改动：packages/frontend/src/components/Sidebar.tsx',
      '- 验收：前端侧边栏显示最近聊天室',
      '2. 补充后端任务分配状态',
      '- 改动：packages/backend/src/workflows/orchestrator.ts',
      '- 验收：后端完成状态仅在验收通过后更新',
      '3. 代码审查',
      '- 验收：审查结果可见且不是重复子任务名',
      '4. 功能验收',
      '- 验收：最终状态与子步骤一致',
      '',
      '任务意图：implementation',
    ].join('\n'),
  });

  assert.ok(plan);
  assert.deepEqual(plan.tasks.map((task) => task.title), [
    '补充前端侧边栏最近聊天室',
    '补充后端任务分配状态',
    '代码审查',
    '功能验收',
  ]);
  assert.deepEqual(plan.tasks.map((task) => task.suggestedRole), [
    'executor',
    'executor',
    'reviewer',
    'acceptor',
  ]);
  assert.notEqual(plan.tasks[2]?.title, plan.tasks[3]?.title);
});

function makeWorkflowPlanJson(sourceMessageId: string): WorkflowPlanJson {
  return {
    workflow_name: 'Coordinator 计划',
    source_message_id: sourceMessageId,
    goal: '实现结构化计划',
    summary: '结构化展示并执行。',
    tasks: [
      {
        id: 'task-1',
        title: '实现模块',
        description: '实现 coordinator plan 模块。',
        role: 'executor',
        agent_id: null,
        mode: 'parallel',
        depends_on: [],
        status: 'pending',
        progress: 0,
        result_refs: [],
      },
    ],
  };
}
