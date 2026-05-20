import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveWorkflowPlanFromParsedPlan,
  normalizeWorkflowPlanMarkdown,
  normalizeWorkflowPlanObject,
  type WorkflowPlanInput,
} from './workflow-plan-json.js';

test('normalizeWorkflowPlanMarkdown converts a fenced JSON plan into executable workflow plan json', () => {
  const plan = normalizeWorkflowPlanMarkdown(`
产品经理计划如下：

\`\`\`json
{
  "workflow_name": "自动归档规则实现",
  "source_message_id": "msg-user-1",
  "goal": "实现智能体 Markdown 文档自动归档",
  "summary": "先实现后端规则，再接入前端展示。",
  "tasks": [
    {
      "id": "backend-rules",
      "title": "实现自动归档规则",
      "description": "实现硬排除和评分规则",
      "role": "executor",
      "agent_id": "backend-agent",
      "depends_on": []
    },
    {
      "id": "frontend-ui",
      "title": "展示归档入口",
      "description": "在消息气泡展示保存为文档入口",
      "role": "executor",
      "agent_id": "frontend-agent",
      "depends_on": []
    },
    {
      "id": "review",
      "title": "审查归档闭环",
      "description": "审查后端规则和前端入口",
      "role": "reviewer",
      "agent_id": "reviewer-agent",
      "depends_on": ["backend-rules", "frontend-ui"]
    }
  ]
}
\`\`\`
`);

  assert.equal(plan.workflow_name, '自动归档规则实现');
  assert.equal(plan.source_message_id, 'msg-user-1');
  assert.equal(plan.tasks.length, 3);
  assert.equal(plan.tasks[0]?.mode, 'parallel');
  assert.equal(plan.tasks[1]?.mode, 'parallel');
  assert.equal(plan.tasks[2]?.mode, 'serial');
  assert.equal(plan.tasks[0]?.status, 'pending');
  assert.equal(plan.tasks[0]?.progress, 0);
  assert.deepEqual(plan.tasks[2]?.depends_on, ['backend-rules', 'frontend-ui']);
});

test('normalizeWorkflowPlanObject derives serial mode from depends_on and ignores supplied mode', () => {
  const input: WorkflowPlanInput = {
    workflow_name: '依赖推导',
    source_message_id: 'msg-user-2',
    goal: '验证依赖关系',
    summary: '外部 mode 不可信，必须由 depends_on 推导。',
    tasks: [
      {
        id: 'first',
        title: '第一步',
        description: '无依赖，可并行',
        role: 'executor',
        agent_id: null,
        mode: 'serial',
        depends_on: [],
        status: 'completed',
        progress: 100,
        result_refs: ['message-1'],
      },
      {
        id: 'second',
        title: '第二步',
        description: '依赖第一步',
        role: 'executor',
        agent_id: null,
        mode: 'parallel',
        depends_on: ['first'],
        status: 'running',
        progress: 50,
        result_refs: [],
      },
    ],
  };

  const plan = normalizeWorkflowPlanObject(input);

  assert.equal(plan.tasks[0]?.mode, 'parallel');
  assert.equal(plan.tasks[0]?.status, 'completed');
  assert.equal(plan.tasks[0]?.progress, 100);
  assert.deepEqual(plan.tasks[0]?.result_refs, ['message-1']);
  assert.equal(plan.tasks[1]?.mode, 'serial');
});

test('normalizeWorkflowPlanObject rejects missing required root fields', () => {
  assert.throws(
    () => normalizeWorkflowPlanObject({
      workflow_name: '缺少 goal',
      source_message_id: 'msg-user-3',
      summary: '缺少 goal 应拒绝。',
      tasks: [],
    }),
    /goal/i,
  );
});

test('normalizeWorkflowPlanObject rejects duplicate task ids and unknown dependencies', () => {
  assert.throws(
    () => normalizeWorkflowPlanObject({
      workflow_name: '重复任务',
      source_message_id: 'msg-user-4',
      goal: '验证重复任务',
      summary: '重复 id 应拒绝。',
      tasks: [
        { id: 'same', title: 'A', description: 'A', role: 'executor', depends_on: [] },
        { id: 'same', title: 'B', description: 'B', role: 'executor', depends_on: [] },
      ],
    }),
    /duplicate task id/i,
  );

  assert.throws(
    () => normalizeWorkflowPlanObject({
      workflow_name: '未知依赖',
      source_message_id: 'msg-user-5',
      goal: '验证未知依赖',
      summary: '未知依赖应拒绝。',
      tasks: [
        { id: 'only', title: 'A', description: 'A', role: 'executor', depends_on: ['missing'] },
      ],
    }),
    /unknown dependency/i,
  );
});

test('deriveWorkflowPlanFromParsedPlan maps ParsedPlan tasks to executable plan json', () => {
  const plan = deriveWorkflowPlanFromParsedPlan({
    workflowName: '自动归档实现',
    sourceMessageId: 'msg-user-6',
    plan: {
      goal: '实现自动归档',
      summary: '先做后端，再做前端，最后审查。',
      assumptions: [],
      tasks: [
        {
          title: '实现后端规则',
          description: '实现硬排除和评分规则。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['规则可测试'],
          scopeRead: [],
          scopeWrite: ['packages/backend/src/agent-document-classifier.ts'],
          dependsOn: [],
        },
        {
          title: '实现前端入口',
          description: '展示保存为文档入口。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['入口可见'],
          scopeRead: [],
          scopeWrite: ['packages/frontend/src/pages/RoomPage.tsx'],
          dependsOn: [],
        },
        {
          title: '审查自动归档闭环',
          description: '检查规则和 UI 是否满足验收。',
          suggestedRole: 'reviewer',
          priority: 'normal',
          acceptance: ['审查完成'],
          scopeRead: [],
          scopeWrite: [],
          dependsOn: ['实现后端规则', '实现前端入口'],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
  });

  assert.equal(plan.goal, '实现自动归档');
  assert.equal(plan.tasks[0]?.id, 'task-1-实现后端规则');
  assert.equal(plan.tasks[1]?.id, 'task-2-实现前端入口');
  assert.equal(plan.tasks[2]?.role, 'reviewer');
  assert.deepEqual(plan.tasks[2]?.depends_on, ['task-1-实现后端规则', 'task-2-实现前端入口']);
  assert.equal(plan.tasks[2]?.mode, 'serial');
});

test('deriveWorkflowPlanFromParsedPlan gives duplicate parsed tasks distinct short titles', () => {
  const plan = deriveWorkflowPlanFromParsedPlan({
    workflowName: '确定,生成任务',
    sourceMessageId: 'msg-user-7',
    plan: {
      goal: '确定,生成任务',
      summary: '把用户确认的需求拆成可执行任务。',
      assumptions: [],
      tasks: [
        {
          title: '确定,生成任务',
          description: '补充后端任务流转数据结构与接口。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['后端返回任务流转关系。'],
          scopeRead: [],
          scopeWrite: ['packages/backend/src/workflows/graph/nodes.ts'],
          dependsOn: [],
        },
        {
          title: '确定,生成任务',
          description: '改造前端工作流任务卡片和关系展示。',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['前端显示清晰的子任务流转。'],
          scopeRead: [],
          scopeWrite: ['packages/frontend/src/components/WorkflowTaskFlow.tsx'],
          dependsOn: ['确定,生成任务'],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
  });

  assert.deepEqual(plan.tasks.map((task) => task.title), [
    '补充后端任务流转数据结构与接口',
    '改造前端工作流任务卡片和关系展示',
  ]);
  assert.equal(plan.tasks[0]?.id, 'task-1-补充后端任务流转数据结构与接口');
  assert.deepEqual(plan.tasks[1]?.depends_on, ['task-1-补充后端任务流转数据结构与接口']);
});
