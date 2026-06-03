# Superpowers 自动推进任务卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将群聊任务卡片改为 `自动推进` 主入口，由 planner 先完成 Superpowers routing，再按 evidence 自动进入 brainstorming、writing-plans、执行、调试或验收阶段，并保证中断后不会永久转圈。

**Architecture:** 后端新增严格的 `superpowers_routing` 解析、routing prompt 与 `auto_advance` 调度入口，继续复用现有 task action event 作为 UI 状态来源。前端把四个并列按钮降级为 `自动推进` 和 `更多` 菜单，并新增阶段派生模型，把 evidence、running、failed、blocked 状态统一成用户可理解的卡片状态。

**Tech Stack:** TypeScript, Node.js `node:test`, Express route existing API, SQLite repos, React 18, Vite, lucide-react, Radix Dropdown Menu.

---

## 文件结构

- Modify: `packages/backend/src/types.ts`
  - 扩展 `TaskActionKind`，新增 `auto_advance`、`route_skills`、`systematic_debugging`、`verification`、`finish_branch`。
- Modify: `packages/frontend/src/lib/types.ts`
  - 与后端同步扩展 `TaskActionKind`。
- Create: `packages/backend/src/workflows/superpowers-routing.ts`
  - 从 planner 输出中提取并校验 `superpowers_routing`，非法输出返回结构化错误。
- Modify: `packages/backend/src/workflows/prompts.ts`
  - 新增 `buildSuperpowersRoutingPrompt()`，要求 planner 使用 `using-superpowers` 输出 routing JSON。
- Modify: `packages/backend/src/workflows/superpowers-skills.ts`
  - 增加 `systematic_debugging` phase 到 skill 映射。
- Modify: `packages/backend/src/task-actions.ts`
  - 增加 `auto_advance` 和 `route_skills` 分支；封装 evidence 查询；增加非 completed run 的终态错误文案；支持 debugging、verification、finish branch 的 phase 映射。
- Modify: `packages/backend/src/task-actions.test.ts`
  - 增加 routing parser、auto advance、缺 evidence 阻塞、中断终态事件测试。
- Modify: `packages/frontend/src/components/task/taskActionState.ts`
  - 支持新动作；新增 `SuperpowersTaskStage` 与 `deriveSuperpowersTaskStage()`。
- Modify: `packages/frontend/src/components/task/TaskActionStrip.tsx`
  - 改成一个主按钮 `自动推进` 和 Radix `更多` 菜单。
- Modify: `packages/frontend/src/components/task/TaskActionStrip.test.tsx`
  - 更新渲染和状态测试。
- Modify: `packages/frontend/src/components/chat/ChatTaskCard.test.tsx`
  - 更新任务卡片测试，验证不再渲染四个主按钮。
- Modify: `packages/frontend/src/components/TaskWorkspacePanel.test.tsx`
  - 更新工作区任务动作测试。
- Modify: `packages/frontend/src/index.css`
  - 调整 `task-action-strip`、主按钮、菜单按钮和状态文案样式。

## 任务拆分

### Task 1: 扩展共享动作类型

**Files:**
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/frontend/src/lib/types.ts`

- [x] **Step 1: 写后端类型变更**

在 `packages/backend/src/types.ts` 中把 `TaskActionKind` 改为：

```ts
export type TaskActionKind =
  | 'start_execution'
  | 'auto_advance'
  | 'route_skills'
  | 'brainstorming'
  | 'writing_plans'
  | 'subagent_execution'
  | 'systematic_debugging'
  | 'verification'
  | 'finish_branch';
```

- [x] **Step 2: 写前端类型变更**

在 `packages/frontend/src/lib/types.ts` 中把同名 union 改成与后端完全一致。

- [x] **Step 3: 运行类型检查**

Run: `npm run build -w @openclaw-room/backend`

Expected: FAIL，错误集中在尚未处理的新 `TaskActionKind` 分支或未使用类型处。

- [x] **Step 4: 提交类型入口**

```bash
git add packages/backend/src/types.ts packages/frontend/src/lib/types.ts
git commit -m "feat: 扩展任务动作类型"
```

### Task 2: 新增 Superpowers routing parser

**Files:**
- Create: `packages/backend/src/workflows/superpowers-routing.ts`
- Modify: `packages/backend/src/task-actions.test.ts`

- [x] **Step 1: 写 parser 失败测试**

在 `packages/backend/src/task-actions.test.ts` 顶部 import parser：

```ts
const { parseSuperpowersRouting } = await import('./workflows/superpowers-routing.js');
```

追加测试：

```ts
test('parseSuperpowersRouting extracts valid fenced routing json', () => {
  const result = parseSuperpowersRouting([
    '路由完成',
    '```json',
    '{',
    '  "superpowers_routing": {',
    '    "next_action": "brainstorming",',
    '    "required_skill": "brainstorming",',
    '    "reason": "功能变更需要先澄清需求并产出 spec。",',
    '    "recommended_agent_id": "planner",',
    '    "expected_evidence": ["designDocPath"]',
    '  }',
    '}',
    '```',
  ].join('\n'));

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.routing.next_action : '', 'brainstorming');
  assert.deepEqual(result.ok ? result.routing.expected_evidence : [], ['designDocPath']);
});

test('parseSuperpowersRouting rejects incomplete routing json', () => {
  const result = parseSuperpowersRouting('```json\n{"superpowers_routing":{"next_action":"brainstorming"}}\n```');

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /required_skill|reason|recommended_agent_id|expected_evidence/u);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm run test -w @openclaw-room/backend -- src/task-actions.test.ts`

Expected: FAIL，错误为 `Cannot find module './workflows/superpowers-routing.js'`。

- [x] **Step 3: 创建 parser 文件**

创建 `packages/backend/src/workflows/superpowers-routing.ts`：

```ts
import type { TaskActionKind } from '../types.js';

export type SuperpowersRoutingNextAction =
  | 'brainstorming'
  | 'writing_plans'
  | 'subagent_execution'
  | 'systematic_debugging'
  | 'verification'
  | 'finish_branch'
  | 'blocked';

export interface SuperpowersRouting {
  next_action: SuperpowersRoutingNextAction;
  required_skill: string;
  reason: string;
  recommended_agent_id: string;
  expected_evidence: string[];
}

export type SuperpowersRoutingParseResult =
  | { ok: true; routing: SuperpowersRouting }
  | { ok: false; error: string };

const NEXT_ACTIONS = new Set<SuperpowersRoutingNextAction>([
  'brainstorming',
  'writing_plans',
  'subagent_execution',
  'systematic_debugging',
  'verification',
  'finish_branch',
  'blocked',
]);

export function parseSuperpowersRouting(content: string): SuperpowersRoutingParseResult {
  const jsonBlocks = content.matchAll(/```json\s*([\s\S]*?)```/gu);
  const errors: string[] = [];
  for (const match of jsonBlocks) {
    try {
      const parsed = JSON.parse(match[1] ?? '{}') as unknown;
      const routing = isRecord(parsed) ? parsed.superpowers_routing : null;
      const validation = validateSuperpowersRouting(routing);
      if (validation.ok) return validation;
      errors.push(validation.error);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'routing JSON 解析失败');
    }
  }
  return { ok: false, error: errors[0] ?? '缺少 superpowers_routing JSON 代码块' };
}

export function routingActionToTaskAction(action: SuperpowersRoutingNextAction): TaskActionKind | null {
  if (action === 'blocked') return null;
  return action;
}

function validateSuperpowersRouting(value: unknown): SuperpowersRoutingParseResult {
  if (!isRecord(value)) return { ok: false, error: 'superpowers_routing 必须是对象' };
  const missing = ['next_action', 'required_skill', 'reason', 'recommended_agent_id', 'expected_evidence']
    .filter((key) => !(key in value));
  if (missing.length > 0) return { ok: false, error: `superpowers_routing 缺少字段：${missing.join(', ')}` };
  if (!isNonEmptyString(value.next_action) || !NEXT_ACTIONS.has(value.next_action as SuperpowersRoutingNextAction)) {
    return { ok: false, error: 'superpowers_routing.next_action 非法' };
  }
  if (!isNonEmptyString(value.required_skill)) return { ok: false, error: 'superpowers_routing.required_skill 必须是非空字符串' };
  if (!isNonEmptyString(value.reason)) return { ok: false, error: 'superpowers_routing.reason 必须是非空字符串' };
  if (!isNonEmptyString(value.recommended_agent_id)) return { ok: false, error: 'superpowers_routing.recommended_agent_id 必须是非空字符串' };
  if (!Array.isArray(value.expected_evidence) || !value.expected_evidence.every(isNonEmptyString)) {
    return { ok: false, error: 'superpowers_routing.expected_evidence 必须是非空字符串数组' };
  }
  return {
    ok: true,
    routing: {
      next_action: value.next_action as SuperpowersRoutingNextAction,
      required_skill: value.required_skill,
      reason: value.reason,
      recommended_agent_id: value.recommended_agent_id,
      expected_evidence: value.expected_evidence,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
```

- [x] **Step 4: 运行 parser 测试确认通过**

Run: `npm run test -w @openclaw-room/backend -- src/task-actions.test.ts`

Expected: PASS 当前文件内新增 parser 测试；旧测试可能因 Task 1 的新 union 仍需后续代码处理。

- [x] **Step 5: 提交 parser**

```bash
git add packages/backend/src/workflows/superpowers-routing.ts packages/backend/src/task-actions.test.ts
git commit -m "feat: 解析Superpowers路由证据"
```

### Task 3: 新增 routing prompt 与 systematic debugging phase

**Files:**
- Modify: `packages/backend/src/workflows/prompts.ts`
- Modify: `packages/backend/src/workflows/superpowers-skills.ts`
- Modify: `packages/backend/src/task-actions.test.ts`

- [x] **Step 1: 写 prompt 测试**

在 `packages/backend/src/task-actions.test.ts` 的 auto advance 测试前追加断言用例：

```ts
test('route_skills action dispatches planner with using-superpowers routing prompt', async () => {
  const project = projectRepo.create({
    name: '路由判断动作',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-route-skills-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({ room_id: room.id, project_id: project.id, title: '自动判断下一步' });
  let prompt = '';

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'route_skills',
    runAgent: async (input) => {
      prompt = input.prompt;
      return {
        status: 'completed',
        content: '```json\n{"superpowers_routing":{"next_action":"brainstorming","required_skill":"brainstorming","reason":"需要 spec","recommended_agent_id":"planner","expected_evidence":["designDocPath"]}}\n```',
        error: null,
        runId: 'run-route',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.match(prompt, /using-superpowers/u);
  assert.match(prompt, /superpowers_routing/u);
  assert.deepEqual(result.run_ids, ['run-route']);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm run test -w @openclaw-room/backend -- src/task-actions.test.ts`

Expected: FAIL，错误为 `unsupported action: route_skills` 或缺少 prompt builder。

- [x] **Step 3: 扩展 skill phase**

在 `packages/backend/src/workflows/superpowers-skills.ts` 中把 `SuperpowersPhase` 增加：

```ts
  | 'systematic_debugging'
```

并在 `SUPERPOWERS_PHASE_SKILLS` 中增加：

```ts
  systematic_debugging: ['systematic-debugging'],
```

- [x] **Step 4: 新增 routing prompt builder**

在 `packages/backend/src/workflows/prompts.ts` 中导出：

```ts
export function buildSuperpowersRoutingPrompt(context: PromptContext): string {
  return [
    '你是 Superpowers 开发闭环的 planner 路由智能体。',
    '必须先遵循 using-superpowers，判断当前任务下一步应调用哪个 Superpowers skill 或进入哪个执行阶段。',
    'routing 只做判断，不替代 brainstorming、writing-plans、systematic-debugging 或执行阶段。',
    '如果输出不是合法 JSON，runtime 会把任务动作标记为 blocked。',
    '',
    '允许的 next_action：brainstorming、writing_plans、subagent_execution、systematic_debugging、verification、finish_branch、blocked。',
    'brainstorming 与 writing_plans 必须推荐 recommended_agent_id=planner。',
    '已有 implementationPlanPath 后，前端、后端、测试、审查或验收智能体才可进入执行、调试、验证阶段。',
    '',
    baseContext(context),
    '',
    workflowContext(context),
    '',
    '最后必须输出一个 fenced JSON 代码块，格式如下：',
    '```json',
    '{',
    '  "superpowers_routing": {',
    '    "next_action": "brainstorming",',
    '    "required_skill": "brainstorming",',
    '    "reason": "任务是功能或行为变更，需要先澄清需求并产出 spec。",',
    '    "recommended_agent_id": "planner",',
    '    "expected_evidence": ["designDocPath"]',
    '  }',
    '}',
    '```',
  ].join('\n');
}
```

- [x] **Step 5: 运行后端测试**

Run: `npm run test -w @openclaw-room/backend -- src/task-actions.test.ts`

Expected: route prompt 测试在 Task 4 接入 `task-actions.ts` 后通过；当前失败点应只剩 `route_skills` 分支未实现。

- [x] **Step 6: 提交 prompt 与 phase**

```bash
git add packages/backend/src/workflows/prompts.ts packages/backend/src/workflows/superpowers-skills.ts packages/backend/src/task-actions.test.ts
git commit -m "feat: 增加Superpowers路由提示"
```

### Task 4: 实现 route_skills 与 auto_advance 调度

**Files:**
- Modify: `packages/backend/src/task-actions.ts`
- Modify: `packages/backend/src/task-actions.test.ts`

- [x] **Step 1: 写 auto advance RED 测试**

追加测试：

```ts
test('auto_advance routes missing spec task to planner brainstorming', async () => {
  const project = projectRepo.create({
    name: '自动推进缺 spec',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-no-spec-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({ room_id: room.id, project_id: project.id, title: '新增任务卡片入口' });
  const actions: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async ({ prompt }) => {
      actions.push(prompt.includes('superpowers_routing') ? 'route' : 'phase');
      if (prompt.includes('superpowers_routing')) {
        return {
          status: 'completed',
          content: '```json\n{"superpowers_routing":{"next_action":"brainstorming","required_skill":"brainstorming","reason":"缺少 spec","recommended_agent_id":"planner","expected_evidence":["designDocPath"]}}\n```',
          error: null,
          runId: 'run-route',
        };
      }
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"designDocPath":"docs/superpowers/specs/auto-design.md","designReviewVerdict":"approved"}}\n```',
        error: null,
        runId: 'run-brainstorming',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(actions, ['route', 'phase']);
  assert.deepEqual(result.run_ids, ['run-route', 'run-brainstorming']);
});
```

再追加已有 spec 进入 plan、已有 plan 进入执行、非法 routing blocked 三个用例，分别断言：

```ts
assert.match(prompt, /writing-plans|writing_plans/u);
assert.match(prompt, /test-driven-development|subagent-driven-development/u);
assert.equal(result.status, 'blocked');
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm run test -w @openclaw-room/backend -- src/task-actions.test.ts`

Expected: FAIL，错误为 `unsupported action: auto_advance`。

- [x] **Step 3: 接入 route_skills 分支**

在 `packages/backend/src/task-actions.ts` import：

```ts
import { buildSuperpowersPhasePrompt, buildSuperpowersRoutingPrompt } from './workflows/prompts.js';
import { parseSuperpowersRouting, routingActionToTaskAction, type SuperpowersRouting } from './workflows/superpowers-routing.js';
```

在 `startTaskAction()` 的 `start_execution` 分支后增加：

```ts
  if (input.action === 'route_skills') {
    return runSuperpowersRoutingAction({
      roomId: input.roomId,
      taskId: input.taskId,
      action: input.action,
      runAgent: input.runAgent ?? defaultRunAgent,
    });
  }

  if (input.action === 'auto_advance') {
    return runAutoAdvanceAction({
      roomId: input.roomId,
      taskId: input.taskId,
      runAgent: input.runAgent ?? defaultRunAgent,
    });
  }
```

- [x] **Step 4: 增加 routing runner**

在 `runSuperpowersPhaseAction()` 前增加：

```ts
async function runSuperpowersRoutingAction(input: {
  roomId: string;
  taskId: string;
  action: TaskActionKind;
  runAgent: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}): Promise<TaskActionStartResult & { routing?: SuperpowersRouting }> {
  recordTaskActionEvent(input.roomId, input.taskId, input.action, 'running', { superpowers_phase: 'using_superpowers' });
  const context = buildTaskPromptContext(input.roomId, input.taskId, `任务动作入口：${input.action}`);
  const planner = selectOrAddPlanner(input.roomId);
  const result = await input.runAgent({
    agent: planner,
    taskId: input.taskId,
    sourceMessageId: context.task.source_message_id,
    prompt: buildSuperpowersRoutingPrompt(context),
  });
  const runIds = result.runId ? [result.runId] : [];
  if (result.status !== 'completed') {
    const error = result.error ?? `${input.action} 未完成：${result.status}`;
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'failed', {
      superpowers_phase: 'using_superpowers',
      run_id: result.runId,
      run_ids: runIds,
      error,
    });
    return { action: input.action, status: 'failed', message_id: messageId, run_ids: runIds };
  }
  const parsed = parseSuperpowersRouting(result.content);
  if (!parsed.ok) {
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'blocked', {
      superpowers_phase: 'using_superpowers',
      run_id: result.runId,
      run_ids: runIds,
      blocked_reason: parsed.error,
      error: parsed.error,
    });
    return { action: input.action, status: 'blocked', message_id: messageId, run_ids: runIds, blocked_reason: parsed.error };
  }
  const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'completed', {
    superpowers_phase: 'using_superpowers',
    run_id: result.runId,
    run_ids: runIds,
    superpowers_routing: parsed.routing,
  });
  return { action: input.action, status: 'completed', message_id: messageId, run_ids: runIds, routing: parsed.routing };
}
```

同时新增 `buildTaskPromptContext()`，复用 `project`、`room`、`task`、`agents` 查询，避免 phase 和 routing 重复散落。

- [x] **Step 5: 增加 auto advance dispatcher**

增加：

```ts
async function runAutoAdvanceAction(input: {
  roomId: string;
  taskId: string;
  runAgent: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}): Promise<TaskActionStartResult> {
  recordTaskActionEvent(input.roomId, input.taskId, 'auto_advance', 'running', {});
  const routingResult = await runSuperpowersRoutingAction({
    roomId: input.roomId,
    taskId: input.taskId,
    action: 'route_skills',
    runAgent: input.runAgent,
  });
  if (routingResult.status !== 'completed' || !routingResult.routing) {
    const reason = routingResult.blocked_reason ?? 'Superpowers 路由未完成';
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, 'auto_advance', routingResult.status, {
      run_ids: routingResult.run_ids,
      blocked_reason: routingResult.status === 'blocked' ? reason : undefined,
      error: routingResult.status === 'failed' ? reason : undefined,
    });
    return { action: 'auto_advance', status: routingResult.status, message_id: messageId, run_ids: routingResult.run_ids, blocked_reason: routingResult.blocked_reason };
  }
  const targetAction = chooseAutoAdvanceTarget(input.taskId, routingResult.routing);
  if (!targetAction) {
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, 'auto_advance', 'blocked', {
      superpowers_routing: routingResult.routing,
      blocked_reason: routingResult.routing.reason,
    });
    return { action: 'auto_advance', status: 'blocked', message_id: messageId, run_ids: routingResult.run_ids, blocked_reason: routingResult.routing.reason };
  }
  const phaseResult = await runSuperpowersPhaseAction({
    roomId: input.roomId,
    taskId: input.taskId,
    action: targetAction,
    runAgent: input.runAgent,
  });
  const runIds = [...routingResult.run_ids, ...phaseResult.run_ids];
  const messageId = recordTaskActionEvent(input.roomId, input.taskId, 'auto_advance', phaseResult.status, {
    run_ids: runIds,
    delegated_action: targetAction,
    superpowers_routing: routingResult.routing,
    blocked_reason: phaseResult.blocked_reason,
  });
  return { action: 'auto_advance', status: phaseResult.status, message_id: messageId, run_ids: runIds, blocked_reason: phaseResult.blocked_reason };
}
```

`chooseAutoAdvanceTarget()` 规则：

```ts
function chooseAutoAdvanceTarget(taskId: string, routing: SuperpowersRouting): TaskActionKind | null {
  if (!hasCompletedSuperpowersEvidence(taskId, 'brainstorming', 'designDocPath')) return 'brainstorming';
  if (!hasCompletedSuperpowersEvidence(taskId, 'writing_plans', 'implementationPlanPath')) return 'writing_plans';
  return routingActionToTaskAction(routing.next_action);
}
```

- [x] **Step 6: 扩展 phase 映射与 evidence 校验**

在 `actionToPhase()` 中增加：

```ts
  if (action === 'systematic_debugging') return 'systematic_debugging';
  if (action === 'verification') return 'verify';
  if (action === 'finish_branch') return 'finish_branch';
```

在 `validatePhasePrerequisite()` 中让 `subagent_execution`、`systematic_debugging`、`verification`、`finish_branch` 都要求 `implementationPlanPath`，错误文案使用：

```ts
return '缺少编写计划产出的 implementation plan，请先运行编写计划';
```

- [x] **Step 7: 运行后端测试**

Run: `npm run test -w @openclaw-room/backend -- src/task-actions.test.ts`

Expected: PASS。

- [x] **Step 8: 提交 auto advance 后端调度**

```bash
git add packages/backend/src/task-actions.ts packages/backend/src/task-actions.test.ts
git commit -m "feat: 实现Superpowers自动推进"
```

### Task 5: 修复非 completed run 的终态事件语义

**Files:**
- Modify: `packages/backend/src/task-actions.ts`
- Modify: `packages/backend/src/task-actions.test.ts`

- [x] **Step 1: 写中断终态测试**

追加测试：

```ts
test('brainstorming records failed terminal event when planner run is interrupted', async () => {
  const project = projectRepo.create({
    name: '头脑风暴中断',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-brainstorm-interrupted-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({ room_id: room.id, project_id: project.id, title: '中断后不能转圈' });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'brainstorming',
    runAgent: async () => ({
      status: 'interrupted',
      content: '',
      error: 'Backend restarted before agent run completed',
      runId: 'run-interrupted',
    }),
  });

  assert.equal(result.status, 'failed');
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const failedEvent = events.find((event) =>
    event.payload.action === 'brainstorming' &&
    event.payload.status === 'failed'
  );
  assert.equal(failedEvent?.payload.task_action_status, 'failed');
  assert.match(String(failedEvent?.payload.error ?? ''), /Backend restarted/u);
});
```

- [x] **Step 2: 运行测试确认失败或错误文案不足**

Run: `npm run test -w @openclaw-room/backend -- src/task-actions.test.ts`

Expected: 如果当前已有 failed 事件但错误为空，FAIL 在 error 断言。

- [x] **Step 3: 改进 phase runner error**

在 `runSuperpowersPhaseAction()` 中替换完成后状态计算：

```ts
  const evidence = extractSuperpowersEvidence(result.content);
  const evidenceError = result.status === 'completed' ? validateCompletedPhaseEvidence(phase, evidence) : null;
  const nonCompletedError = result.status === 'completed'
    ? null
    : result.error ?? `${phase} 阶段未完成：${result.status}`;
  const status = result.status === 'completed' && !evidenceError ? 'completed' : 'failed';
  const error = evidenceError ?? nonCompletedError;
```

- [x] **Step 4: 运行后端测试**

Run: `npm run test -w @openclaw-room/backend -- src/task-actions.test.ts`

Expected: PASS。

- [x] **Step 5: 提交中断收尾**

```bash
git add packages/backend/src/task-actions.ts packages/backend/src/task-actions.test.ts
git commit -m "fix: 记录任务动作中断终态"
```

### Task 6: 前端新增阶段派生模型

**Files:**
- Modify: `packages/frontend/src/components/task/taskActionState.ts`
- Modify: `packages/frontend/src/components/task/taskActionState.test.ts`

- [x] **Step 1: 写 stage 派生测试**

在 `packages/frontend/src/components/task/taskActionState.test.ts` 追加：

```ts
import { createTaskActionStates, deriveSuperpowersTaskStage } from './taskActionState';

test('deriveSuperpowersTaskStage reports spec_ready from brainstorming evidence', () => {
  const states = createTaskActionStates([
    event('brainstorming', 'completed', { evidence: { designDocPath: 'docs/superpowers/specs/a.md' } }),
  ], null);

  const stage = deriveSuperpowersTaskStage(states);

  assert.equal(stage.id, 'spec_ready');
  assert.equal(stage.label, 'Spec 已生成');
});

test('deriveSuperpowersTaskStage reports failed action before ready stages', () => {
  const states = createTaskActionStates([
    event('brainstorming', 'completed', { evidence: { designDocPath: 'docs/superpowers/specs/a.md' } }),
    event('writing_plans', 'failed', { error: '缺少 implementationPlanPath' }),
  ], null);

  const stage = deriveSuperpowersTaskStage(states);

  assert.equal(stage.id, 'failed');
  assert.match(stage.detail ?? '', /implementationPlanPath/u);
});
```

测试辅助函数：

```ts
function event(action: string, status: string, payload: Record<string, unknown> = {}) {
  return {
    id: `${action}-${status}`,
    room_id: 'room-1',
    task_id: 'task-1',
    type: 'task_updated',
    layer: 'timeline',
    seq: 1,
    created_at: 1,
    payload: {
      action,
      status,
      task_action: action,
      task_action_status: status,
      ...payload,
    },
  } as const;
}
```

- [x] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test packages/frontend/src/components/task/taskActionState.test.ts`

Expected: FAIL，错误为 `deriveSuperpowersTaskStage` 未导出。

- [x] **Step 3: 扩展 action 列表与 state evidence**

在 `taskActionState.ts` 中把 `ACTIONS` 改为：

```ts
const ACTIONS: TaskActionKind[] = [
  'start_execution',
  'auto_advance',
  'route_skills',
  'brainstorming',
  'writing_plans',
  'subagent_execution',
  'systematic_debugging',
  'verification',
  'finish_branch',
];
```

扩展 `TaskActionState` 类型需要同步在 `packages/frontend/src/lib/types.ts` 加字段：

```ts
export interface TaskActionState {
  status: TaskActionStatus;
  detail?: string;
  evidence?: Record<string, unknown>;
}
```

在 `createTaskActionStates()` 写入：

```ts
      evidence: isRecord(event.payload.evidence) ? event.payload.evidence : undefined,
```

- [x] **Step 4: 新增 stage 类型和派生函数**

在 `taskActionState.ts` 中增加：

```ts
export type SuperpowersTaskStageId =
  | 'unrouted'
  | 'routing'
  | 'routed'
  | 'brainstorming'
  | 'spec_ready'
  | 'planning'
  | 'plan_ready'
  | 'executing'
  | 'debugging'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'blocked';

export interface SuperpowersTaskStage {
  id: SuperpowersTaskStageId;
  label: string;
  detail?: string;
}

export function deriveSuperpowersTaskStage(states: Partial<Record<TaskActionKind, TaskActionState>>): SuperpowersTaskStage {
  const failed = findStatus(states, 'failed');
  if (failed) return { id: 'failed', label: '失败', detail: failed.detail };
  const blocked = findStatus(states, 'blocked');
  if (blocked) return { id: 'blocked', label: '阻塞', detail: blocked.detail };
  if (isRunning(states.route_skills) || isRunning(states.auto_advance)) return { id: 'routing', label: '路由判断中' };
  if (isRunning(states.brainstorming)) return { id: 'brainstorming', label: '头脑风暴中' };
  if (isRunning(states.writing_plans)) return { id: 'planning', label: '编写计划中' };
  if (isRunning(states.systematic_debugging)) return { id: 'debugging', label: '调试中' };
  if (isRunning(states.verification)) return { id: 'verifying', label: '验收中' };
  if (isRunning(states.subagent_execution) || isRunning(states.start_execution)) return { id: 'executing', label: '执行中' };
  if (hasEvidence(states.writing_plans, 'implementationPlanPath')) return { id: 'plan_ready', label: 'Plan 已生成' };
  if (hasEvidence(states.brainstorming, 'designDocPath')) return { id: 'spec_ready', label: 'Spec 已生成' };
  if (states.route_skills?.status === 'completed') return { id: 'routed', label: '路由完成', detail: states.route_skills.detail };
  return { id: 'unrouted', label: '待路由' };
}
```

并增加 `findStatus()`、`isRunning()`、`hasEvidence()`、`isRecord()` 小函数。

- [x] **Step 5: 运行前端状态测试**

Run: `node --import tsx --test packages/frontend/src/components/task/taskActionState.test.ts`

Expected: PASS。

- [x] **Step 6: 提交阶段派生**

```bash
git add packages/frontend/src/components/task/taskActionState.ts packages/frontend/src/components/task/taskActionState.test.ts packages/frontend/src/lib/types.ts
git commit -m "feat: 派生Superpowers任务阶段"
```

### Task 7: 改造任务动作 UI 为自动推进加更多菜单

**Files:**
- Modify: `packages/frontend/src/components/task/TaskActionStrip.tsx`
- Modify: `packages/frontend/src/components/task/TaskActionStrip.test.tsx`
- Modify: `packages/frontend/src/components/chat/ChatTaskCard.test.tsx`
- Modify: `packages/frontend/src/components/TaskWorkspacePanel.test.tsx`
- Modify: `packages/frontend/src/index.css`

- [x] **Step 1: 更新 TaskActionStrip RED 测试**

把 `TaskActionStrip.test.tsx` 第一条测试改为：

```ts
test('TaskActionStrip renders auto advance as primary action and manual actions in menu', () => {
  const html = renderToStaticMarkup(
    <TaskActionStrip
      states={{}}
      onStartAction={() => undefined}
    />,
  );

  assert.match(html, /自动推进/u);
  assert.match(html, /更多/u);
  assert.match(html, /重新运行路由判断/u);
  assert.match(html, /强制头脑风暴/u);
  assert.match(html, /强制编写计划/u);
  assert.match(html, /强制执行计划/u);
  assert.match(html, /强制诊断\/调试/u);
  assert.doesNotMatch(html, /<strong>开始执行<\/strong>/u);
});
```

把 running 测试改为：

```ts
test('TaskActionStrip disables auto advance while action is running', () => {
  const html = renderToStaticMarkup(
    <TaskActionStrip
      states={{ auto_advance: { status: 'running', detail: '路由判断中' } }}
      onStartAction={() => undefined}
    />,
  );

  assert.match(html, /路由判断中/u);
  assert.match(html, /disabled/u);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test packages/frontend/src/components/task/TaskActionStrip.test.tsx`

Expected: FAIL，仍渲染四个并列按钮。

- [x] **Step 3: 改造 TaskActionStrip**

将 import 改为：

```ts
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bot, Brain, ChevronDown, ClipboardList, Loader2, Route, Stethoscope, Workflow } from 'lucide-react';
```

定义主按钮和菜单项：

```ts
const MANUAL_ACTIONS: TaskActionDefinition[] = [
  { id: 'route_skills', label: '重新运行路由判断', description: '只重新生成下一步 Superpowers routing', icon: Route },
  { id: 'brainstorming', label: '强制头脑风暴', description: '由 planner 澄清需求并产出 spec', icon: Brain },
  { id: 'writing_plans', label: '强制编写计划', description: '要求已有 spec，由 planner 产出 plan', icon: ClipboardList },
  { id: 'subagent_execution', label: '强制执行计划', description: '要求已有 plan，进入执行阶段', icon: Workflow },
  { id: 'systematic_debugging', label: '强制诊断/调试', description: '要求已有 plan，进入系统化调试', icon: Stethoscope },
];
```

组件核心结构：

```tsx
const autoState = states.auto_advance;
const stage = deriveSuperpowersTaskStage(states);
const autoStatus = autoState?.status ?? 'idle';
const autoRunning = autoStatus === 'queued' || autoStatus === 'running';
const anyRunning = Object.values(states).some((state) => state?.status === 'queued' || state?.status === 'running');
const autoDisabled = disabled || autoRunning || anyRunning;
const autoLabel = autoStatus === 'failed' || autoStatus === 'blocked' ? '重试自动推进' : '自动推进';

return (
  <div className={cn('task-action-strip', compact && 'is-compact')}>
    <button
      type="button"
      className={cn('task-action-button task-action-primary', `is-${autoStatus}`)}
      disabled={autoDisabled}
      onClick={() => onStartAction('auto_advance')}
      title={autoState?.detail ?? stage.detail ?? '自动判断并推进下一步 Superpowers 流程'}
    >
      {autoRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
      <span>
        <strong>{autoRunning ? stage.label : autoLabel}</strong>
        {!compact && <small>{autoState?.detail ?? stage.label}</small>}
      </span>
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-action-more-button" disabled={disabled || anyRunning}>
          <span>更多</span>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content className="task-action-menu" align="end">
        {MANUAL_ACTIONS.map((action) => {
          const state = states[action.id];
          const status = state?.status ?? 'idle';
          const running = status === 'queued' || status === 'running';
          const Icon = action.icon;
          return (
            <DropdownMenu.Item
              key={action.id}
              className={cn('task-action-menu-item', `is-${status}`)}
              disabled={disabled || anyRunning}
              onSelect={() => onStartAction(action.id)}
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
              <span>
                <strong>{action.label}</strong>
                <small>{state?.detail ?? action.description}</small>
              </span>
            </DropdownMenu.Item>
          );
        })}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
);
```

- [x] **Step 4: 更新卡片和工作区测试断言**

在 `ChatTaskCard.test.tsx` 中把四按钮断言替换为：

```ts
assert.match(html, /自动推进/u);
assert.match(html, /更多/u);
assert.doesNotMatch(html, /<strong>开始执行<\/strong>/u);
```

在 `TaskWorkspacePanel.test.tsx` 中把测试名和断言从 “four task actions” 改为自动推进入口，断言 `自动推进`、`更多`、`强制头脑风暴` 存在。

- [x] **Step 5: 更新 CSS**

在 `packages/frontend/src/index.css` 的 `.task-action-strip` 相关区域替换为：

```css
.task-action-strip {
  display: flex;
  align-items: stretch;
  gap: 8px;
  min-width: 0;
}

.task-action-button.task-action-primary {
  flex: 1 1 auto;
  min-width: 0;
}

.task-action-more-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}

.task-action-menu {
  z-index: 80;
  min-width: 220px;
  padding: 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--popover);
  color: var(--popover-foreground);
  box-shadow: var(--shadow-lg);
}

.task-action-menu-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  outline: none;
}

.task-action-menu-item[data-highlighted] {
  background: var(--accent);
}

.task-action-menu-item[data-disabled] {
  opacity: 0.55;
  pointer-events: none;
}
```

- [x] **Step 6: 运行前端组件测试**

Run:

```bash
node --import tsx --test \
  packages/frontend/src/components/task/TaskActionStrip.test.tsx \
  packages/frontend/src/components/chat/ChatTaskCard.test.tsx \
  packages/frontend/src/components/TaskWorkspacePanel.test.tsx
```

Expected: PASS。

- [x] **Step 7: 提交前端入口改造**

```bash
git add packages/frontend/src/components/task/TaskActionStrip.tsx packages/frontend/src/components/task/TaskActionStrip.test.tsx packages/frontend/src/components/chat/ChatTaskCard.test.tsx packages/frontend/src/components/TaskWorkspacePanel.test.tsx packages/frontend/src/index.css
git commit -m "feat: 改造任务卡片自动推进入口"
```

### Task 8: 后端路由 API 与最终验证

**Files:**
- Modify: `packages/backend/src/routes.ts`
- Modify: `packages/backend/src/task-actions.test.ts`

- [x] **Step 1: 确认 route 校验允许新动作**

打开 `packages/backend/src/routes.ts` 的 task action route，找到解析 `action` 的位置。如果代码使用硬编码数组，改为包含：

```ts
const taskActions: TaskActionKind[] = [
  'start_execution',
  'auto_advance',
  'route_skills',
  'brainstorming',
  'writing_plans',
  'subagent_execution',
  'systematic_debugging',
  'verification',
  'finish_branch',
];
```

如果 route 只把 body action 透传给 `startTaskAction()`，保留现状并不改该文件。

- [x] **Step 2: 运行后端测试**

Run: `npm run test -w @openclaw-room/backend -- src/task-actions.test.ts`

Expected: PASS。

- [x] **Step 3: 运行前端状态和 UI 测试**

Run:

```bash
node --import tsx --test \
  packages/frontend/src/components/task/taskActionState.test.ts \
  packages/frontend/src/components/task/TaskActionStrip.test.tsx \
  packages/frontend/src/components/chat/ChatTaskCard.test.tsx \
  packages/frontend/src/components/TaskWorkspacePanel.test.tsx
```

Expected: PASS。

- [x] **Step 4: 运行全量构建**

Run: `npm run build`

Expected: PASS，后端 TypeScript 编译通过，前端 `tsc -b` 和 Vite build 通过。

- [x] **Step 5: 启动本地服务做手动 smoke**

Run: `npm run dev`

Expected: 后端监听默认 `7330`，前端监听 `http://localhost:5173`。

手动检查 `http://localhost:5173/projects/ZwgdJRslFpih/rooms/htzG4V6hkegx`：

- 新任务卡片只露出 `自动推进` 和 `更多`。
- 点击 `自动推进` 后先出现 route action 事件，再出现 delegated phase action。
- 缺 spec 时进入 `brainstorming`。
- 已有 spec 缺 plan 时进入 `writing_plans`。
- run 返回 `interrupted`、`failed` 或 `cancelled` 时，卡片显示失败或阻塞，不再持续 spinner。

- [x] **Step 6: 最终代码审查**

Run: `git diff -- packages/backend/src packages/frontend/src`

Expected:

- 未改动无关工作区文件。
- `brainstorming` 和 `writing_plans` 仍由 planner 执行。
- `using-superpowers` routing 只输出 `superpowers_routing`，不替代实际 skill。
- 所有 task-bound action 都有 terminal event。
- 前端没有四个并列主按钮。

- [x] **Step 7: 最终提交**

如果 Task 8 修改了 `routes.ts` 或测试文件：

```bash
git add packages/backend/src/routes.ts packages/backend/src/task-actions.test.ts
git commit -m "fix: 放行自动推进任务动作"
```

如果 Task 8 没有代码改动，只记录验证结果到本次任务消息，不创建空提交。

## 验收覆盖映射

- 默认主入口 `自动推进`：Task 7。
- `更多` 菜单保留人工覆盖：Task 7。
- planner 先产出 `superpowers_routing`：Task 2、Task 3、Task 4。
- 缺 spec 自动进入 `brainstorming`：Task 4。
- 有 spec 缺 plan 自动进入 `writing_plans`：Task 4。
- 有 plan 进入执行、调试或验证：Task 4。
- `brainstorming`、`writing_plans` 由 planner 执行：Task 4 沿用 `selectOrAddPlanner()`。
- 执行类智能体只在 plan 后介入：Task 4 的 `chooseAutoAdvanceTarget()` 和 prerequisite。
- failed、cancelled、interrupted 写终态事件：Task 5。
- UI 不再永久转圈：Task 5、Task 6、Task 7。

## 最终验证命令

```bash
npm run test -w @openclaw-room/backend -- src/task-actions.test.ts
node --import tsx --test \
  packages/frontend/src/components/task/taskActionState.test.ts \
  packages/frontend/src/components/task/TaskActionStrip.test.tsx \
  packages/frontend/src/components/chat/ChatTaskCard.test.tsx \
  packages/frontend/src/components/TaskWorkspacePanel.test.tsx
npm run build
```

预期结果：全部 PASS；如果 smoke 需要本地 ACP provider，先确认 planner agent 已启用 ACP backend，否则 `auto_advance` 应返回 blocked 并显示可读原因。

## 实际收口记录

- 本次实现通过并行 worker 完成前后端主体改造，随后在主会话统一整合、修复和提交；未按计划中的每个 Task 单独创建提交。
- `brainstorming` 与 `writing_plans` 仍固定由 planner 执行。
- `subagent_execution`、`systematic_debugging`、`verification`、`finish_branch` 在 `auto_advance` 已有 plan 后优先使用 routing 返回的 `recommended_agent_id`；如果推荐的是内置执行者且尚未加入房间，后端会自动拉入；推荐智能体不存在或不可执行时写入 `blocked` 终态。
- 手动覆盖执行/调试入口会优先选择可执行 executor，验证/收尾入口优先选择 reviewer/acceptor。
