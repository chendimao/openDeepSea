# Workflow Coordinator 多智能体编排实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将正式 workflow 启动后的“重复产品经理分析 + 串行执行”改为由 Workflow Coordinator 消费已有产品经理计划、结构化分派智能体、展示任务表并启动执行。

**Architecture:** 本阶段采用增量式 Coordinator 壳层，不一次性替换整个 LangGraph runtime。新增独立的计划结构化与智能体匹配模块，复用现有 `workflowPlan`、`WorkflowTaskBubble` 和 graph nodes，并在 runtime 中优先消费 planner 消息背景，减少重复规划。

**Tech Stack:** TypeScript, Node.js, Express, SQLite repos, LangGraph runtime, React 18, Vite, Node test runner.

---

## Scope

本计划落地方案 C 的第一阶段和关键可见行为：

- 点击正式 workflow 后，graph planning 优先消费前序产品经理消息和原始用户需求。
- 结构化计划输出固定 JSON，作为 workflowPlan 的权威展示状态。
- dispatch 阶段按候选评分选择群聊/内置智能体并记录分配理由。
- 前端聊天事件中可展示 workflow 任务气泡。
- 修复 active run 等待循环和误拦截问题，保证执行智能体能被启动。

完整 DAG 多 active run 并行调度作为后续阶段，不在本批次强行完成。

## Task 1: Coordinator 计划结构化模块

**Files:**
- Create: `packages/backend/src/workflows/graph/coordinator-plan.ts`
- Test: `packages/backend/src/workflows/graph/coordinator-plan.test.ts`

- [x] **Step 1: Write failing tests**

覆盖：

- 从 graph state / plan artifact 中复用已有 `workflow_plan_json`。
- 从 `ParsedPlan` 派生 `WorkflowPlanJson`。
- 输出包含 `source_message_id`，任务包含 `mode`、`depends_on`、`status`、`progress`。

Run:

```bash
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/workflows/graph/coordinator-plan.test.ts
```

Expected: fail because module does not exist.

- [x] **Step 2: Implement module**

导出：

- `buildCoordinatorWorkflowPlan(input)`
- `parseWorkflowPlanFromArtifactMetadata(metadata)`
- `isWorkflowPlanJson(value)`

复用 `deriveWorkflowPlanFromParsedPlan()` 和现有前端/后端 schema 语义，不引入数据库表。

- [x] **Step 3: Run tests**

同 Step 1，Expected: pass.

## Task 2: Coordinator 智能体匹配模块

**Files:**
- Create: `packages/backend/src/workflows/graph/coordinator-agents.ts`
- Test: `packages/backend/src/workflows/graph/coordinator-agents.test.ts`

- [x] **Step 1: Write failing tests**

覆盖：

- 已在群聊且满足 workflow role、ACP、write boundary 的 agent 优先。
- 群聊缺失时建议内置 template id。
- 不选择没有写权限或未启用 ACP 的 agent。
- 返回 `assignmentReason`。

Run:

```bash
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/workflows/graph/coordinator-agents.test.ts
```

Expected: fail because module does not exist.

- [x] **Step 2: Implement module**

导出：

- `selectCoordinatorAgentForTask(input)`
- `requiredTemplateIdForTask(task)`
- `agentCanExecuteWorkflowTask(agent, task)`

先支持 frontend/backend executor、reviewer、acceptor。全局智能体库查询留给整合层。

- [x] **Step 3: Run tests**

同 Step 1，Expected: pass.

## Task 3: 前端聊天 workflow 气泡接入

**Files:**
- Modify: `packages/frontend/src/pages/RoomPage.tsx`
- Modify: `packages/frontend/src/components/WorkflowTaskBubble.tsx`
- Test: `packages/frontend/src/pages/RoomPage.test.tsx` 或现有相邻测试

- [x] **Step 1: Write failing UI test**

构造 workflow event message + workflowById + mocked detail，断言聊天消息气泡能展示 workflow task bubble 或入口容器。

Run:

```bash
node --import tsx --test src/pages/RoomPage.test.tsx
```

Expected: fail before UI接入。

- [x] **Step 2: Implement UI wiring**

在 `MessageBubble` 的 workflow event 分支中，当存在 `metadata.workflow_run_id` 且 `workflowById` 有对应 workflow 时，渲染可嵌入的 workflow bubble。若 detail 未加载，显示紧凑 loading/状态占位。避免在前端推断任务状态。

- [x] **Step 3: Run UI test**

同 Step 1，Expected: pass.

## Task 4: 后端 graph 整合

**Files:**
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Modify: `packages/backend/src/workflows/conversation.ts`
- Modify: `packages/backend/src/routes.ts`
- Test: `packages/backend/src/workflows/graph/runtime.test.ts`
- Test: `packages/backend/src/workflows/graph/execute.test.ts`
- Test: `packages/backend/src/collaboration.routes.test.ts`

- [x] **Step 1: Add regression tests**

覆盖：

- promote-to-workflow 后 graph planning 能获得 planner 背景，不把 analysis-only wording 写入执行任务。
- execute active run 只等待当前 implementation child，不被其他 stage active run 拦截。
- continueGraphWorkflow 遇到当前 child active run 时等待，不触发 resume limit。

- [x] **Step 2: Integrate coordinator plan**

`planningNode` 创建 `workflowPlan` 改走 coordinator module；当 task description 有产品经理背景时，优先由 coordinator 确定性提取可执行 `ParsedPlan`，不再二次调用 planner。没有产品经理背景时保留原 planner 兜底。

- [x] **Step 3: Integrate coordinator agent selection**

`dispatchNode` 和 `executeNode` 使用 coordinator agent helper 做执行资格判断和 assignment reason 记录。保持现有 `ensureWorkflowAgentsForRun()` 兜底。

- [x] **Step 4: Active run wait fix**

保留并完善当前工作区已有修复：运行时遇到 active agent run 后停止本轮恢复；execute 节点只复用当前 implementation child 的 active run。

- [x] **Step 5: Run tests**

```bash
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/workflows/graph/execute.test.ts src/workflows/graph/runtime.test.ts src/collaboration.routes.test.ts
```

Expected: pass.

## Task 5: Final verification and browser smoke

**Files:**
- No planned source writes except test/docs updates if issues are found.

- [x] **Step 1: Run targeted backend tests**

```bash
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/workflows/graph/coordinator-agents.test.ts src/workflows/graph/execute.test.ts src/workflows/graph/runtime.test.ts src/workflows/langchain-planner.test.ts src/collaboration.routes.test.ts src/dispatcher.test.ts
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/workflows/supervisor.test.ts
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/workflows/workflow-plan-json.test.ts src/workflows/graph/coordinator-plan.test.ts
```

Result: backend targeted bundle 96 pass / 0 fail；supervisor 6 pass / 0 fail；workflow plan/coordinator plan 12 pass / 0 fail。

- [x] **Step 2: Run frontend test**

```bash
node --import tsx --test src/components/WorkflowTaskBubble.test.tsx
```

Result: 4 pass / 0 fail。

- [x] **Step 3: Run build**

```bash
npm run build
```

Result: build pass；Vite 仅提示 chunk size warning。

- [x] **Step 4: Browser smoke**

启动或复用本地服务，打开真实浏览器，建立群聊，输入：

```text
细化文件管理功能 ，比如有些是用户上传的文件，有些是智能体生成的md文档
```

验收：

- 产品经理先生成计划。
- 点击正式 workflow。
- 气泡或 workflow 详情出现子任务表格。
- 缺失执行智能体被拉入。
- 执行智能体开始执行，不能只有产品经理反复分析。

Result: 子代理真实浏览器烟测确认页面可见正式 workflow、子任务表格、角色、智能体、模式和进度；本地 Playwright smoke 确认 `http://localhost:5173` 可达且无 page error。完整 ACP 写入执行仍依赖本机模型/API/权限环境。

- [x] **Step 5: Code review and commit**

只提交本次实现相关文件，不提交用户已有无关改动。

Review result: 首轮代码审查指出 planning 二次调用、workflow detail 缓存、并行显示与串行执行不一致、旧任务复用丢失 PM 背景；本轮已分别补确定性 PM 背景解析、消息事件失效、串行 mode 派生、旧任务背景刷新和回归测试。
