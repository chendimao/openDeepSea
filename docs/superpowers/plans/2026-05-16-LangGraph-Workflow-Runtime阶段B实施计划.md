# LangGraph Workflow Runtime 阶段 B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 LangGraph Workflow Runtime，逐步让图运行时接管 plan -> approve -> dispatch -> execute -> review -> verify -> accept -> memory 的串行开发闭环，同时保留现有数据库、API、WebSocket 和 UI 展示模型。

**Architecture:** 阶段 B 采用保守迁移：先增加持久化字段、graph state 类型和 graph shell，再把现有 `workflowOrchestrator` 的核心阶段代理到 graph runtime。LangGraph 节点只调用 OpenClaw Room 内部封装 tools，不暴露通用 shell；ACP 执行仍由现有 `respondAsAgent`/adapter 负责，现有 workflow tables 继续作为主审计来源。

**Tech Stack:** TypeScript, Node.js, Express, SQLite, zod, `@langchain/langgraph@^1.3.0`, LangChain JS, ACP adapters, React/Vite.

---

## 阶段 A 完成情况检查

阶段 A 计划文件：`docs/superpowers/plans/2026-05-15-LangChain-Planner阶段A实施计划.md`

阶段 A 设计来源：`docs/superpowers/specs/2026-05-15-LangChain-LangGraph替代OpenClaw编排层设计.md`

已完成：

- [x] LangChain Planner 依赖、配置面和 README 可选配置已加入。
- [x] `plan-parser.ts` 支持 modern plan schema，并保持 legacy plan artifact 兼容。
- [x] modern plan 关键字段已收紧为必填；缺 `scopeWrite`、`assumptions` 等字段会失败。
- [x] `langchain-planner.ts` 使用 fake invoker 测试，不依赖真实模型；默认最多重试 2 次。
- [x] `orchestrator.ts` planning 阶段在配置 `LANGCHAIN_PLANNER_MODEL` 和 `OPENAI_API_KEY` 时走 LangChain Planner，未配置时回退 ACP planning。
- [x] Planner 输出失败时记录失败并保存未解析 plan artifact。
- [x] 后端内置 ACP-only agent templates 与 `/api/agent-templates`、`/rooms/:roomId/agents/from-template` 已实现。
- [x] `room_agents` 已支持 `capabilities` 和 `default_runtime`。
- [x] 前端 `AddAgentDialog` 优先展示内置 ACP 模板。
- [x] OpenClaw Gateway 文案已调整为可选集成。
- [x] 最终验证通过：后端测试 104/104，根构建通过；前端仅有既有 Vite chunk size warning。
- [x] 浏览器冒烟验证：Gateway 离线时可通过 UI 创建 `Planner` ACP-only agent，API 字段为 `workflow_role=planner`、`acp_backend=codex`、`default_runtime=acp`。

已知非阻塞问题：

- 浏览器点击侧边栏 “OpenClaw 网关 / 网关离线” 按钮未能打开详情弹窗，源码中 `gateway.optionalDescription` 已存在；建议阶段 B 不扩大该问题，另开 UI 修复任务。
- 阶段 A 仍由现有 orchestrator 驱动完整闭环，LangGraph 未接管执行、review、verify、accept。

## Scope Check

本计划只实现阶段 B 的串行 LangGraph runtime 迁移，不实现自动并行写入、不新增通用 shell tool、不移除 OpenClaw legacy provider、不重做前端工作流 UI。

阶段 B 的目标是让 graph runtime 成为新的编排入口，并让现有 API/WS/UI 继续可用。为降低风险，本计划保留现有 `workflowOrchestrator` 作为 facade，逐步将 `start/approvePlan/retryStep/cancel` 代理到 graph runtime。

## Command Convention

除非步骤特别说明，后端单文件测试命令都在 `packages/backend` 目录执行。

由于本机可能存在 Node ABI mismatch，执行测试和构建时优先使用：

```bash
PATH="$(dirname $(mise which node)):$PATH" <command>
```

## File Structure

- Modify: `packages/backend/package.json`
  - 增加 `@langchain/langgraph` 依赖。
- Modify: `package-lock.json`
  - 锁定 LangGraph 依赖。
- Modify: `packages/backend/src/db.ts`
  - 增加 `workflow_runs.graph_version`、`workflow_runs.graph_state`、`workflow_steps.node_name`、`workflow_steps.scope_read`、`workflow_steps.scope_write`、`workflow_steps.assigned_room_agent_id` 字段和迁移。
- Modify: `packages/backend/src/types.ts`
  - 增加 graph state、node name、step metadata 字段类型。
- Modify: `packages/backend/src/repos/workflows.ts`
  - 读写 graph 字段，增加 `updateGraphState`、增强 `createStep/updateStep`。
- Create: `packages/backend/src/workflows/graph/state.ts`
  - 定义 `AgentWorkflowState`、`GraphNodeName`、`WorkflowGraphStatus`、zod schema 和序列化 helpers。
- Create: `packages/backend/src/workflows/graph/tools.ts`
  - 封装 graph nodes 可调用的内部 tools：读取 context、创建/更新 step、调用 ACP、记录 artifact、更新 workflow state、写 memory。
- Create: `packages/backend/src/workflows/graph/runtime.ts`
  - 构建 LangGraph `StateGraph`，编译 graph，提供 `startGraphWorkflow/resumeGraphWorkflow/cancelGraphWorkflow/recoverGraphWorkflow`。
- Create: `packages/backend/src/workflows/graph/nodes.ts`
  - 实现 `ContextNode`、`PlanningNode`、`ApprovalNode`、`DispatchNode`、`ExecuteNode`、`ReviewNode`、`RepairDecisionNode`、`VerifyNode`、`AcceptanceNode`、`MemoryNode`。
- Create: `packages/backend/src/workflows/graph/router.ts`
  - 定义 conditional edge 路由：approval、dispatch、review repair、verification、terminal。
- Create: `packages/backend/src/workflows/graph/verification.ts`
  - 安全验证命令 allowlist 和执行器；阶段 B 只允许显式白名单命令。
- Create: `packages/backend/src/workflows/graph/index.ts`
  - 导出 graph runtime facade。
- Modify: `packages/backend/src/workflows/orchestrator.ts`
  - 增加 feature flag，允许 `LANGGRAPH_WORKFLOW_ENABLED=1` 时将 `start/approvePlan/retryStep/cancel/recoverOrphanedSteps` 代理到 graph runtime。
- Modify: `packages/backend/src/routes.ts`
  - 保持 API 形状不变；必要时返回 graph runtime 写入的新字段。
- Modify: `packages/frontend/src/lib/types.ts`
  - 同步 `WorkflowRun.graph_version/graph_state` 和 step scope metadata 字段，UI 暂不新增复杂视图。
- Create: `packages/backend/src/workflows/graph/*.test.ts`
  - 覆盖 state persistence、node routing、approval pause/resume、review repair loop、verification allowlist、recovery。
- Modify: `docs/superpowers/specs/2026-05-15-LangChain-LangGraph替代OpenClaw编排层设计.md`
  - 追加阶段 B 计划记录和明确本阶段边界。

## Task 1: Install LangGraph Dependency and Runtime Flag

**Files:**
- Modify: `packages/backend/package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Create: `packages/backend/src/workflows/graph/runtime-config.ts`
- Create: `packages/backend/src/workflows/graph/runtime-config.test.ts`

- [x] **Step 1: Write failing runtime config test**

Create `packages/backend/src/workflows/graph/runtime-config.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { getLangGraphWorkflowConfig } from './runtime-config.js';

test('getLangGraphWorkflowConfig is disabled by default', () => {
  const config = getLangGraphWorkflowConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.graphVersion, 'phase-b-v1');
});

test('getLangGraphWorkflowConfig enables graph runtime with explicit flag', () => {
  const config = getLangGraphWorkflowConfig({ LANGGRAPH_WORKFLOW_ENABLED: '1' });
  assert.equal(config.enabled, true);
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/runtime-config.test.ts
```

Expected: FAIL because `runtime-config.ts` does not exist.

- [x] **Step 3: Install dependency**

Run from repo root:

```bash
PATH="$(dirname $(mise which node)):$PATH" npm install -w @openclaw-room/backend @langchain/langgraph@^1.3.0
```

Expected: `packages/backend/package.json` and `package-lock.json` update; install exits 0.

- [x] **Step 4: Implement runtime config**

Create `packages/backend/src/workflows/graph/runtime-config.ts`:

```ts
export interface LangGraphWorkflowConfig {
  enabled: boolean;
  graphVersion: 'phase-b-v1';
}

export function getLangGraphWorkflowConfig(
  env: Partial<Pick<NodeJS.ProcessEnv, 'LANGGRAPH_WORKFLOW_ENABLED'>> = process.env,
): LangGraphWorkflowConfig {
  return {
    enabled: env.LANGGRAPH_WORKFLOW_ENABLED === '1' || env.LANGGRAPH_WORKFLOW_ENABLED === 'true',
    graphVersion: 'phase-b-v1',
  };
}
```

- [x] **Step 5: Run config test**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/runtime-config.test.ts
```

Expected: PASS.

- [x] **Step 6: Document runtime flag**

Modify `README.md` optional workflow configuration section:

```md
### Optional: LangGraph Workflow Runtime

LangGraph runtime is disabled by default during phase B migration. Enable it explicitly:

```bash
LANGGRAPH_WORKFLOW_ENABLED=1
```

When disabled, the existing workflow orchestrator remains the runtime.
```

- [x] **Step 7: Commit**

```bash
git add packages/backend/package.json package-lock.json README.md packages/backend/src/workflows/graph/runtime-config.ts packages/backend/src/workflows/graph/runtime-config.test.ts
git commit -m "feat(workflows): 添加 LangGraph 运行时配置"
```

## Task 2: Persist Graph State and Step Metadata

**Files:**
- Modify: `packages/backend/src/db.ts`
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/backend/src/repos/workflows.ts`
- Create: `packages/backend/src/workflows/graph/state.ts`
- Create: `packages/backend/src/workflows/graph/state.test.ts`

- [x] **Step 1: Write failing state persistence test**

Create `packages/backend/src/workflows/graph/state.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-state-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { serializeGraphState, emptyAgentWorkflowState } = await import('./state.js');

test('workflowRepo persists graph version and graph state', () => {
  const project = projectRepo.create({ name: 'Graph', path: '/tmp/graph' });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Graph task' });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    current_stage: 'planning',
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState(emptyAgentWorkflowState({
      workflowRunId: 'pending',
      projectId: project.id,
      roomId: room.id,
      taskId: task.id,
      userGoal: task.title,
      projectPath: project.path,
    })),
  });

  assert.equal(run.graph_version, 'phase-b-v1');
  assert.match(run.graph_state ?? '', /"userGoal":"Graph task"/);
});

test('workflowRepo persists workflow step node and scope metadata', () => {
  const project = projectRepo.create({ name: 'Graph 2', path: '/tmp/graph2' });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Room 2' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Graph step task' });
  const run = workflowRepo.createRun({ room_id: room.id, project_id: project.id, task_id: task.id });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: 'execute',
    scope_read: ['packages/backend/src/workflows/graph/runtime.ts'],
    scope_write: ['packages/backend/src/workflows/graph/runtime.ts'],
    sort_order: 1,
  });

  assert.equal(step.node_name, 'execute');
  assert.deepEqual(step.scope_read, ['packages/backend/src/workflows/graph/runtime.ts']);
  assert.deepEqual(step.scope_write, ['packages/backend/src/workflows/graph/runtime.ts']);
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/state.test.ts
```

Expected: FAIL because graph fields/types do not exist.

- [x] **Step 3: Add DB columns and migrations**

Modify `packages/backend/src/db.ts`:

```sql
workflow_runs:
  graph_version TEXT,
  graph_state TEXT,

workflow_steps:
  node_name TEXT,
  scope_read TEXT NOT NULL DEFAULT '[]',
  scope_write TEXT NOT NULL DEFAULT '[]',
  assigned_room_agent_id TEXT,
```

Add migration checks after existing column migrations:

```ts
if (!workflowRunColumnNames.has('graph_version')) {
  db.exec('ALTER TABLE workflow_runs ADD COLUMN graph_version TEXT');
}
if (!workflowRunColumnNames.has('graph_state')) {
  db.exec('ALTER TABLE workflow_runs ADD COLUMN graph_state TEXT');
}
if (!workflowStepColumnNames.has('node_name')) {
  db.exec('ALTER TABLE workflow_steps ADD COLUMN node_name TEXT');
}
if (!workflowStepColumnNames.has('scope_read')) {
  db.exec("ALTER TABLE workflow_steps ADD COLUMN scope_read TEXT NOT NULL DEFAULT '[]'");
}
if (!workflowStepColumnNames.has('scope_write')) {
  db.exec("ALTER TABLE workflow_steps ADD COLUMN scope_write TEXT NOT NULL DEFAULT '[]'");
}
if (!workflowStepColumnNames.has('assigned_room_agent_id')) {
  db.exec('ALTER TABLE workflow_steps ADD COLUMN assigned_room_agent_id TEXT');
}
```

- [x] **Step 4: Extend types**

Modify `packages/backend/src/types.ts`:

```ts
export type GraphNodeName =
  | 'context'
  | 'planning'
  | 'approval'
  | 'dispatch'
  | 'execute'
  | 'review'
  | 'repair_decision'
  | 'verify'
  | 'acceptance'
  | 'memory';

export interface WorkflowRun {
  graph_version: string | null;
  graph_state: string | null;
}

export interface WorkflowStep {
  node_name: GraphNodeName | null;
  scope_read: string[];
  scope_write: string[];
  assigned_room_agent_id: string | null;
}
```

- [x] **Step 5: Implement graph state schema helpers**

Create `packages/backend/src/workflows/graph/state.ts`:

```ts
import { z } from 'zod';
import type { ParsedPlan } from '../plan-parser.js';
import type { GraphNodeName, WorkflowStatus } from '../../types.js';

export const verificationResultSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});

export const agentWorkflowStateSchema = z.object({
  workflowRunId: z.string(),
  projectId: z.string(),
  roomId: z.string(),
  taskId: z.string(),
  userGoal: z.string(),
  projectPath: z.string(),
  plan: z.unknown().nullable(),
  currentNode: z.string().nullable(),
  currentStepId: z.string().nullable(),
  activeAgentRunId: z.string().nullable(),
  childTaskIds: z.array(z.string()),
  reviewFindings: z.array(z.string()),
  verificationResults: z.array(verificationResultSchema),
  repairAttempts: z.number().int().min(0),
  approval: z.enum(['not_required', 'pending', 'approved', 'rejected']),
  status: z.enum(['draft', 'running', 'awaiting_decision', 'awaiting_approval', 'blocked', 'cancelled', 'completed', 'failed']),
  error: z.string().nullable(),
});

export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type AgentWorkflowState = Omit<z.infer<typeof agentWorkflowStateSchema>, 'plan' | 'currentNode'> & {
  plan: ParsedPlan | null;
  currentNode: GraphNodeName | null;
  status: WorkflowStatus;
};

export function emptyAgentWorkflowState(input: {
  workflowRunId: string;
  projectId: string;
  roomId: string;
  taskId: string;
  userGoal: string;
  projectPath: string;
}): AgentWorkflowState {
  return {
    ...input,
    plan: null,
    currentNode: null,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    reviewFindings: [],
    verificationResults: [],
    repairAttempts: 0,
    approval: 'pending',
    status: 'running',
    error: null,
  };
}

export function serializeGraphState(state: AgentWorkflowState): string {
  return JSON.stringify(state);
}

export function parseGraphState(value: string | null): AgentWorkflowState | null {
  if (!value) return null;
  return agentWorkflowStateSchema.parse(JSON.parse(value)) as AgentWorkflowState;
}
```

- [x] **Step 6: Extend workflow repo**

Modify `packages/backend/src/repos/workflows.ts`:

- `createRun` accepts optional `graph_version` and `graph_state`.
- `updateRun` can patch `graph_version` and `graph_state`.
- Add `updateGraphState(id, state)` convenience method.
- `createStep` accepts `node_name`, `scope_read`, `scope_write`, `assigned_room_agent_id`.
- `updateStep` can patch graph metadata fields.
- Normalize `scope_read`/`scope_write` from JSON strings into arrays.

Use one helper:

```ts
function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
```

- [x] **Step 7: Run graph state tests**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/state.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add packages/backend/src/db.ts packages/backend/src/types.ts packages/backend/src/repos/workflows.ts packages/backend/src/workflows/graph/state.ts packages/backend/src/workflows/graph/state.test.ts
git commit -m "feat(workflows): 持久化 LangGraph 工作流状态"
```

## Task 3: Build LangGraph Shell with Context and Planning Nodes

**Files:**
- Create: `packages/backend/src/workflows/graph/tools.ts`
- Create: `packages/backend/src/workflows/graph/nodes.ts`
- Create: `packages/backend/src/workflows/graph/router.ts`
- Create: `packages/backend/src/workflows/graph/runtime.ts`
- Create: `packages/backend/src/workflows/graph/runtime.test.ts`

- [x] **Step 1: Write failing graph shell test**

Create `packages/backend/src/workflows/graph/runtime.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-runtime-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { startGraphWorkflow } = await import('./runtime.js');

test('startGraphWorkflow runs context and planning nodes into awaiting approval', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Room' });
  roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'planner',
    agent_name: 'Planner',
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Plan with graph',
    description: 'Use graph shell to produce a plan artifact.',
  });

  const run = await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: 'Plan with graph',
      summary: 'Graph shell planning',
      assumptions: [],
      tasks: [{
        title: 'Implement shell',
        description: 'Create context and planning nodes',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Plan is persisted'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      risks: [],
      needsApproval: true,
    }),
  });

  const detail = workflowRepo.detail(run.id);
  assert.equal(detail?.run.status, 'awaiting_approval');
  assert.equal(detail?.run.graph_version, 'phase-b-v1');
  assert.ok(detail?.run.graph_state);
  assert.ok(detail?.artifacts.some((artifact) => artifact.artifact_type === 'plan'));
  assert.ok(detail?.steps.some((step) => step.node_name === 'context'));
  assert.ok(detail?.steps.some((step) => step.node_name === 'planning'));
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/runtime.test.ts
```

Expected: FAIL because graph runtime modules do not exist.

- [x] **Step 3: Implement graph tools**

Create `packages/backend/src/workflows/graph/tools.ts`.

Expose a factory with dependencies so tests can inject fake planner:

```ts
import { generateLangChainPlan } from '../langchain-planner.js';
import { formatMemoryContext } from '../../memory/context.js';
import { memoryRepo } from '../../repos/memory.js';
import { projectRepo } from '../../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../../repos/rooms.js';
import { taskRepo } from '../../repos/tasks.js';
import { workflowRepo } from '../../repos/workflows.js';
import type { ParsedPlan } from '../plan-parser.js';
import type { RoomAgent } from '../../types.js';

export interface GraphRuntimeDeps {
  planner?: (input: Parameters<typeof generateLangChainPlan>[0]) => Promise<ParsedPlan>;
}

export function createGraphTools(deps: GraphRuntimeDeps = {}) {
  const planner = deps.planner ?? ((input) => generateLangChainPlan(input));

  return {
    readWorkflowContext(workflowRunId: string) {
      const run = workflowRepo.getRun(workflowRunId);
      if (!run) throw new Error('workflow not found');
      const room = roomRepo.get(run.room_id);
      const project = projectRepo.get(run.project_id);
      const task = taskRepo.get(run.task_id);
      if (!room || !project || !task) throw new Error('workflow context is incomplete');
      return {
        run,
        room,
        project,
        task,
        agents: roomAgentRepo.listByRoom(run.room_id),
        artifacts: workflowRepo.listArtifacts(run.id),
        memories: formatMemoryContext(memoryRepo.listForRoomContext({
          projectId: project.id,
          roomId: room.id,
          taskId: task.id,
        })),
      };
    },
    async generatePlan(input: Parameters<typeof generateLangChainPlan>[0]) {
      return planner(input);
    },
    createGraphStep(input: Parameters<typeof workflowRepo.createStep>[0]) {
      return workflowRepo.createStep(input);
    },
    updateGraphStep: workflowRepo.updateStep.bind(workflowRepo),
    createArtifact: workflowRepo.createArtifact.bind(workflowRepo),
    updateRun: workflowRepo.updateRun.bind(workflowRepo),
    updateGraphState: workflowRepo.updateGraphState.bind(workflowRepo),
    selectAgentForRole(role: string, agents: RoomAgent[]) {
      const exact = agents.filter((agent) => agent.workflow_role === role);
      return exact.find((agent) => agent.acp_enabled) ?? exact[0] ?? null;
    },
  };
}
```

- [x] **Step 4: Implement context and planning nodes**

Create `packages/backend/src/workflows/graph/nodes.ts`.

Implement initially:

- `contextNode`: loads context, creates completed workflow step with `node_name='context'`, writes graph state.
- `planningNode`: calls planner, creates completed planning step, writes plan artifact with metadata, writes graph state.
- `approvalNode`: if `plan.needsApproval` is true, sets run `awaiting_approval`; else marks `approval='not_required'` and lets graph continue.

Use `formatParsedPlanArtifact` from `../orchestrator.js` for plan artifact content to keep UI compatibility.

- [x] **Step 5: Implement router**

Create `packages/backend/src/workflows/graph/router.ts`:

```ts
import { END } from '@langchain/langgraph';
import type { AgentWorkflowState } from './state.js';

export function routeAfterApproval(state: AgentWorkflowState): 'dispatch' | typeof END {
  if (state.approval === 'pending') return END;
  if (state.approval === 'rejected') return END;
  return 'dispatch';
}
```

For Task 3, `dispatch` can route to `END` until implemented.

- [x] **Step 6: Implement runtime shell**

Create `packages/backend/src/workflows/graph/runtime.ts`:

Use LangGraph JS API:

```ts
import { END, MemorySaver, START, StateGraph, StateSchema } from '@langchain/langgraph';
import * as z from 'zod';
```

Build a graph:

```ts
const State = new StateSchema({
  workflowRunId: z.string(),
  projectId: z.string(),
  roomId: z.string(),
  taskId: z.string(),
  userGoal: z.string(),
  projectPath: z.string(),
  plan: z.unknown().nullable(),
  currentNode: z.string().nullable(),
  currentStepId: z.string().nullable(),
  activeAgentRunId: z.string().nullable(),
  childTaskIds: z.array(z.string()).default(() => []),
  reviewFindings: z.array(z.string()).default(() => []),
  verificationResults: z.array(z.unknown()).default(() => []),
  repairAttempts: z.number().default(0),
  approval: z.enum(['not_required', 'pending', 'approved', 'rejected']),
  status: z.string(),
  error: z.string().nullable(),
});
```

Graph edges for Task 3:

```ts
new StateGraph(State)
  .addNode('context', nodes.contextNode)
  .addNode('planning', nodes.planningNode)
  .addNode('approval', nodes.approvalNode)
  .addEdge(START, 'context')
  .addEdge('context', 'planning')
  .addEdge('planning', 'approval')
  .addConditionalEdges('approval', routeAfterApproval)
  .compile({ checkpointer: new MemorySaver() });
```

`startGraphWorkflow(taskId, deps)` creates `workflow_run` with `graph_version='phase-b-v1'`, creates initial `AgentWorkflowState`, invokes graph with `configurable.thread_id = run.id`, stores final state in `workflow_runs.graph_state`, and returns latest run.

- [x] **Step 7: Run graph shell test**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/runtime.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add packages/backend/src/workflows/graph/tools.ts packages/backend/src/workflows/graph/nodes.ts packages/backend/src/workflows/graph/router.ts packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/runtime.test.ts
git commit -m "feat(workflows): 建立 LangGraph 工作流骨架"
```

## Task 4: Dispatch Plan into Child Tasks in Graph Runtime

**Files:**
- Modify: `packages/backend/src/workflows/graph/tools.ts`
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Modify: `packages/backend/src/workflows/graph/router.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.test.ts`

- [x] **Step 1: Add failing dispatch test**

Append to `runtime.test.ts`:

```ts
test('graph dispatch creates child tasks and assignment artifact after no-approval plan', async () => {
  // Create project/room/task and executor room agent.
  // Planner returns needsApproval=false with one executor task.
  // startGraphWorkflow should create one child task, assignment artifact, and store childTaskIds.
});
```

Concrete assertions:

```ts
assert.equal(detail?.run.current_stage, 'implementation');
assert.ok(detail?.artifacts.some((artifact) => artifact.artifact_type === 'assignment'));
assert.equal(taskRepo.listChildren(task.id).length, 1);
assert.equal(taskRepo.listChildren(task.id)[0]?.assigned_agent_id, executor.id);
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/runtime.test.ts
```

Expected: FAIL because dispatch node is not implemented.

- [x] **Step 3: Implement dispatch tools**

Add to `createGraphTools`:

```ts
createChildTask(input) {
  return taskRepo.create(input);
},
broadcastTaskCreated(task) {
  wsHub.broadcast(task.room_id, { type: 'task:created', task });
},
recordWorkflowEvent(input) {
  recordTaskEvent(input);
},
```

Keep broadcast helpers internal and typed.

- [x] **Step 4: Implement dispatch node**

In `nodes.ts`, implement `dispatchNode`:

- Read context.
- Require `state.plan`.
- Create completed `workflow_steps` row with `stage='assignment'`, `node_name='dispatch'`.
- For each `plan.tasks`, select agent by `suggestedRole`, create child task with `created_from='workflow_assignment'`.
- Store `scopeRead/scopeWrite` on assignment step metadata or child execution step metadata.
- Create `assignment` artifact.
- Update run to `status='running'`, `current_stage='implementation'`.
- Persist state with `childTaskIds` and `currentNode='dispatch'`.

- [x] **Step 5: Update graph edges**

In `runtime.ts`, add node and edge:

```ts
.addNode('dispatch', nodes.dispatchNode)
.addEdge('dispatch', 'execute')
```

For this task only, route `execute` to `END` with a placeholder node that stores current stage. The real execute node is Task 5.

- [x] **Step 6: Run dispatch test**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/runtime.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/backend/src/workflows/graph/tools.ts packages/backend/src/workflows/graph/nodes.ts packages/backend/src/workflows/graph/router.ts packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/runtime.test.ts
git commit -m "feat(workflows): 用 LangGraph 分配计划任务"
```

## Task 5: Execute Node via Existing ACP Dispatcher

**Files:**
- Modify: `packages/backend/src/dispatcher.ts`
- Modify: `packages/backend/src/workflows/graph/tools.ts`
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Modify: `packages/backend/src/workflows/graph/router.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Create: `packages/backend/src/workflows/graph/execute.test.ts`

- [x] **Step 1: Add failing execute test with fake ACP runner**

Create `packages/backend/src/workflows/graph/execute.test.ts`:

```ts
test('execute node starts assigned ACP agent and records completed implementation step', async () => {
  // Arrange graph state with a parent task, one child task, executor agent.
  // Inject deps.runAcpAgent that returns completed message content and agentRun id.
  // Invoke execute node or graph runtime.
  // Assert workflow step stage=implementation, node_name=execute, room_agent_id=executor.id, status=completed.
  // Assert child task status becomes review.
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/execute.test.ts
```

Expected: FAIL because execute node cannot run ACP via injectable tool yet.

- [x] **Step 3: Extract promise-based ACP runner**

Modify `packages/backend/src/dispatcher.ts` to export a safe promise wrapper without changing current `respondAsAgent` API:

```ts
export async function runAgentOnce(input: RespondAsAgentInput): Promise<{
  run: AgentRun;
  message: Message;
  status: AgentRunStatus;
}> {
  return new Promise((resolve, reject) => {
    void respondAsAgent({
      ...input,
      onFinished: resolve,
    }).catch(reject);
  });
}
```

If `RespondAsAgentInput` is not exported, export its interface.

- [x] **Step 4: Add graph runAcpAgent tool**

In `tools.ts`, add injectable dependency:

```ts
runAcpAgent?: typeof runAgentOnce;
```

Default to `runAgentOnce`.

- [x] **Step 5: Implement execute node**

`executeNode` behavior:

- Pick next child task with `todo` or `in_progress`.
- Select assigned agent or fallback executor.
- If no executor, set workflow `blocked` and state `error='No executor available for implementation'`.
- Set child task `in_progress`.
- Build implementation prompt via `buildStagePrompt('implementation', ...)`.
- Create running workflow step with `stage='implementation'`, `node_name='execute'`, `room_agent_id`, `assigned_room_agent_id`, scope metadata from plan task.
- Call `runAcpAgent`.
- On completion, update step completed, bind `agent_run_id/result/result_message_id`, set child task `review`.
- Store `activeAgentRunId` and latest step id in graph state.

- [x] **Step 6: Run execute test**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/execute.test.ts
```

Expected: PASS.

- [x] **Step 7: Run dispatcher regression tests**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/dispatcher.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add packages/backend/src/dispatcher.ts packages/backend/src/workflows/graph/tools.ts packages/backend/src/workflows/graph/nodes.ts packages/backend/src/workflows/graph/router.ts packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/execute.test.ts
git commit -m "feat(workflows): 用 LangGraph 执行 ACP 步骤"
```

## Task 6: Review, Repair Decision, and Acceptance Nodes

**Files:**
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Modify: `packages/backend/src/workflows/graph/router.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Create: `packages/backend/src/workflows/graph/review.test.ts`

- [x] **Step 1: Write failing review pass test**

Create `packages/backend/src/workflows/graph/review.test.ts`:

```ts
test('review pass routes to acceptance and completes workflow on acceptance pass', async () => {
  // Arrange parent task with child tasks already in review.
  // Inject reviewer and acceptor fake ACP outputs with valid JSON verdicts.
  // Run graph from review state.
  // Assert review and acceptance artifacts exist.
  // Assert parent task done and workflow completed.
});
```

- [x] **Step 2: Write failing repair loop test**

Append:

```ts
test('review changes_requested routes back to execute with bounded repair attempts', async () => {
  // First reviewer output: changes_requested.
  // Assert workflow state repairAttempts increments and current node returns to execute.
  // Second reviewer output can pass.
});
```

Expected max attempts in phase B: `2`.

- [x] **Step 3: Run tests to verify failure**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/review.test.ts
```

Expected: FAIL because review/acceptance nodes are not implemented.

- [x] **Step 4: Implement review node**

`reviewNode` behavior:

- Select reviewer agent by `workflow_role='reviewer'`, fallback to executor only if no reviewer exists.
- Build review prompt via `buildStagePrompt('code_review', ...)`.
- Create workflow step `stage='code_review'`, `node_name='review'`.
- Call `runAcpAgent`.
- Create `review` artifact.
- Parse via `parseReviewVerdict`.
- Store findings and `reviewFindings` in graph state.
- If `verdict='pass'`, route to verify.
- If `changes_requested`, route to repair decision.
- If `failed`, block workflow.

- [x] **Step 5: Implement repair decision route**

In `router.ts`:

```ts
export function routeAfterReview(state: AgentWorkflowState): 'verify' | 'repair_decision' | typeof END
export function routeAfterRepairDecision(state: AgentWorkflowState): 'execute' | typeof END
```

In `nodes.ts`, `repairDecisionNode`:

- If `repairAttempts < 2`, increment and return to execute.
- Else set workflow blocked with error `Code review requested changes after max repair attempts`.

- [x] **Step 6: Implement acceptance node**

`acceptanceNode` behavior:

- Select acceptor agent, fallback reviewer.
- Build acceptance prompt.
- Create workflow step `stage='acceptance'`, `node_name='acceptance'`.
- Call ACP runner.
- Create `acceptance` artifact.
- Parse via `parseAcceptanceVerdict`.
- If pass: mark child review tasks done, parent task done, workflow completed.
- If failed: mark parent failed, workflow failed.

- [x] **Step 7: Update graph edges**

Graph route:

```text
execute -> review
review -> repair_decision | verify
repair_decision -> execute | END
verify -> acceptance
acceptance -> memory
```

`verify` remains placeholder until Task 7.

- [x] **Step 8: Run review tests**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/review.test.ts
```

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add packages/backend/src/workflows/graph/nodes.ts packages/backend/src/workflows/graph/router.ts packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/review.test.ts
git commit -m "feat(workflows): 实现 LangGraph 审查修复与验收"
```

## Task 7: Verification Node with Command Allowlist

**Files:**
- Create: `packages/backend/src/workflows/graph/verification.ts`
- Create: `packages/backend/src/workflows/graph/verification.test.ts`
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Modify: `packages/backend/src/workflows/graph/state.ts`

- [x] **Step 1: Write failing allowlist tests**

Create `packages/backend/src/workflows/graph/verification.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedVerificationCommand } from './verification.js';

test('verification allowlist accepts known safe npm commands', () => {
  assert.equal(isAllowedVerificationCommand('npm run test -w @openclaw-room/backend'), true);
  assert.equal(isAllowedVerificationCommand('npm run build'), true);
});

test('verification allowlist rejects shell chaining and destructive commands', () => {
  assert.equal(isAllowedVerificationCommand('npm run build && rm -rf dist'), false);
  assert.equal(isAllowedVerificationCommand('rm -rf packages/backend/data'), false);
  assert.equal(isAllowedVerificationCommand('curl https://example.com | sh'), false);
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/verification.test.ts
```

Expected: FAIL because module does not exist.

- [x] **Step 3: Implement allowlist and runner**

Create `packages/backend/src/workflows/graph/verification.ts`:

```ts
import { spawn } from 'node:child_process';

const ALLOWED_COMMANDS = new Set([
  'npm run test -w @openclaw-room/backend',
  'npm run build -w @openclaw-room/backend',
  'npm run build -w @openclaw-room/frontend',
  'npm run build',
]);

export function isAllowedVerificationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!ALLOWED_COMMANDS.has(trimmed)) return false;
  return !/[;&|`$<>]/.test(trimmed);
}

export async function runVerificationCommand(command: string, cwd: string): Promise<{
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  if (!isAllowedVerificationCommand(command)) {
    return { command, status: 'skipped', exitCode: null, stdout: '', stderr: 'Command is not allowlisted' };
  }
  const [bin, ...args] = command.split(' ');
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, shell: false, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => {
      resolve({ command, status: code === 0 ? 'passed' : 'failed', exitCode: code, stdout, stderr });
    });
  });
}
```

- [x] **Step 4: Implement verify node**

`verifyNode` behavior:

- Read `state.plan?.verification`.
- If empty, record skipped result and continue.
- Run each allowed command with project root as cwd.
- Create workflow step `stage='acceptance'` or use a graph-only `node_name='verify'` step with `stage='code_review'` until `WorkflowStage` type includes `verification`.
- Store `verificationResults` in graph state.
- Create artifact. If any required command fails, set workflow blocked or failed according to design.

For minimal phase B behavior: required failed command sets workflow `blocked`, non-required failed command continues to acceptance.

- [x] **Step 5: Run verification tests**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/verification.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/backend/src/workflows/graph/verification.ts packages/backend/src/workflows/graph/verification.test.ts packages/backend/src/workflows/graph/nodes.ts packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/state.ts
git commit -m "feat(workflows): 增加 LangGraph 验证节点"
```

## Task 8: Memory Node and Recovery Semantics

**Files:**
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Modify: `packages/backend/src/workflows/graph/tools.ts`
- Create: `packages/backend/src/workflows/graph/recovery.test.ts`

- [x] Task 8 completed
- [x] Task 8 review-fix（2026-05-16）：修复 memory 缺少 acceptance artifact 时误写成功记忆；修复 recovery 中断同 workflow 全部 active agent run；修复坏 graph_state 不阻断后续 run 恢复；补充对应回归测试覆盖。

- [ ] **Step 1: Write failing memory node test**

Create `packages/backend/src/workflows/graph/recovery.test.ts`:

```ts
test('memory node stores accepted task summary and completes graph state', async () => {
  // Arrange completed acceptance pass state.
  // Run memory node.
  // Assert task_summary memory exists and workflow graph_state.status is completed.
});
```

- [ ] **Step 2: Write failing recovery test**

Append:

```ts
test('recoverGraphWorkflow marks running graph steps interrupted and keeps retry context', async () => {
  // Create graph workflow with running execute step and active agent run.
  // Call recoverGraphWorkflow(error).
  // Assert step interrupted, agent run interrupted, run blocked, graph_state.status blocked.
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/recovery.test.ts
```

Expected: FAIL because memory/recovery graph behavior is missing.

- [ ] **Step 4: Implement memory node**

`memoryNode` behavior:

- Reuse existing `rememberAcceptedTask` behavior if it can be extracted safely.
- If extraction is too invasive, call `memoryRepo.upsertTaskSummary`/existing equivalent directly using same content rules from current orchestrator.
- Persist graph state `status='completed'`, `currentNode='memory'`.

- [ ] **Step 5: Implement recovery runtime**

In `runtime.ts`, export:

```ts
export function recoverGraphWorkflow(error: string): number
```

Behavior:

- Find running steps where `node_name IS NOT NULL`.
- Interrupt active `agent_runs` bound to graph workflow.
- Mark steps `interrupted`.
- Update run `blocked`.
- Parse `graph_state`, set `status='blocked'`, `error`.
- Return count.

- [ ] **Step 6: Run recovery tests**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/recovery.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/workflows/graph/nodes.ts packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/tools.ts packages/backend/src/workflows/graph/recovery.test.ts
git commit -m "feat(workflows): 实现 LangGraph 记忆与恢复"
```

## Task 9: Wire Existing Orchestrator Facade to Graph Runtime

**Files:**
- Modify: `packages/backend/src/workflows/orchestrator.ts`
- Create: `packages/backend/src/workflows/graph/facade.test.ts`
- Modify: `packages/backend/src/routes.ts`

- [x] **Step 1: Write failing facade tests**

Create `packages/backend/src/workflows/graph/facade.test.ts`:

```ts
test('workflowOrchestrator.start delegates to graph runtime when enabled', async () => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  // Create task and fake graph deps if needed.
  // Start workflow.
  // Assert returned run.graph_version === 'phase-b-v1'.
});

test('workflowOrchestrator.start uses legacy runtime when graph disabled', async () => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '';
  // Existing behavior should create analysis step or block if no agent.
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/facade.test.ts
```

Expected: FAIL because orchestrator does not delegate to graph runtime.

- [x] **Step 3: Add graph facade imports**

Modify `orchestrator.ts`:

```ts
import { getLangGraphWorkflowConfig } from './graph/runtime-config.js';
import {
  startGraphWorkflow,
  approveGraphWorkflow,
  retryGraphWorkflow,
  cancelGraphWorkflow,
  recoverGraphWorkflow,
} from './graph/runtime.js';
```

- [x] **Step 4: Delegate public methods behind flag**

At the start of `workflowOrchestrator.start`:

```ts
if (getLangGraphWorkflowConfig().enabled) {
  return startGraphWorkflow(taskId);
}
```

Similarly:

- `approvePlan`: if run has `graph_version`, call `approveGraphWorkflow`.
- `retryStep`: if run has `graph_version`, call `retryGraphWorkflow`.
- `cancel`: if run has `graph_version`, call `cancelGraphWorkflow`.
- `recoverOrphanedSteps`: run `recoverGraphWorkflow` first, then legacy recovery, return total.

- [x] **Step 5: Preserve API responses**

Routes should keep returning `WorkflowRun` or `WorkflowDetail` without changing endpoint contracts. Only add graph fields to types already serialized from DB.

- [x] **Step 6: Run facade tests**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/facade.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/backend/src/workflows/orchestrator.ts packages/backend/src/workflows/graph/facade.test.ts packages/backend/src/routes.ts
git commit -m "feat(workflows): 将编排入口代理到 LangGraph"
```

- [x] **Review fix: tighten graph facade semantics**

修复 Task 9 review：approval resume 继续按 router 驱动到 execute/合法终态；cancel 调用 `runRegistry.cancel` 并返回最新 graph_state；retry 恢复 failed child task 后继续 execute；recovery 不再遗留 graph run 的 `node_name` 为空 running step。

- [x] **Review fix 2: separate resume target node from completed node**

修复 Task 9 第二轮 review：resume loop 显式维护 `nodeToRun` 并基于刚执行节点路由，覆盖 `repair_decision -> execute -> review`；retry 从 review/acceptance 回退后重新执行 execute；graph retry 遇到 active agent run 时拒绝。

## Task 10: Frontend Types and Workflow Metadata Display

**Files:**
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/components/WorkflowTimeline.tsx`
- Modify: `packages/frontend/src/lib/i18n.tsx`

- [ ] **Step 1: Update frontend types**

Modify `packages/frontend/src/lib/types.ts`:

```ts
export type GraphNodeName =
  | 'context'
  | 'planning'
  | 'approval'
  | 'dispatch'
  | 'execute'
  | 'review'
  | 'repair_decision'
  | 'verify'
  | 'acceptance'
  | 'memory';

export interface WorkflowRun {
  graph_version: string | null;
  graph_state: string | null;
}

export interface WorkflowStep {
  node_name: GraphNodeName | null;
  scope_read: string[];
  scope_write: string[];
  assigned_room_agent_id: string | null;
}
```

- [ ] **Step 2: Render graph metadata lightly**

Modify `WorkflowTimeline.tsx`:

- If `step.node_name`, show a compact mono label `Graph: {node_name}`.
- If `scope_write.length > 0`, show collapsed or small text `scopeWrite: ...`.
- Do not redesign timeline.

- [ ] **Step 3: Add i18n keys**

Add zh/en keys:

```ts
'workflow.graphNode': 'Graph 节点: {node}',
'workflow.scopeWrite': '写入范围: {scope}',
```

and English equivalents.

- [ ] **Step 4: Run frontend build**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" npm run build -w @openclaw-room/frontend
```

Expected: PASS, existing Vite chunk warning only.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/lib/types.ts packages/frontend/src/components/WorkflowTimeline.tsx packages/frontend/src/lib/i18n.tsx
git commit -m "feat(frontend): 显示 LangGraph 工作流元数据"
```

## Task 11: End-to-End Graph Runtime Verification

**Files:**
- Create: `packages/backend/src/workflows/graph/e2e.test.ts`
- Modify: `docs/superpowers/specs/2026-05-15-LangChain-LangGraph替代OpenClaw编排层设计.md`

- [ ] **Step 1: Write graph E2E test with fake agents**

Create `packages/backend/src/workflows/graph/e2e.test.ts`:

```ts
test('graph runtime completes ACP-only development loop without OpenClaw gateway', async () => {
  // Use temp DB and project directory.
  // Create built-in ACP-only executor/reviewer/acceptor agents.
  // Inject fake planner and fake runAcpAgent outputs:
  // - implementation output text
  // - review JSON pass
  // - acceptance JSON pass
  // Enable LANGGRAPH_WORKFLOW_ENABLED=1.
  // Start workflow through workflowOrchestrator.start(task.id).
  // Assert workflow completed, parent task done, artifacts plan/assignment/review/acceptance exist, graph_state completed.
});
```

- [ ] **Step 2: Run E2E test to verify failure or pass**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test src/workflows/graph/e2e.test.ts
```

Expected before final integration fixes: may FAIL; fix graph routing/state until PASS.

- [ ] **Step 3: Update design doc with phase B implementation note**

Append to `docs/superpowers/specs/2026-05-15-LangChain-LangGraph替代OpenClaw编排层设计.md`:

```md
## 阶段 B 实施计划记录

- 阶段 B 计划采用 feature flag `LANGGRAPH_WORKFLOW_ENABLED` 保守启用。
- LangGraph runtime 先复刻串行开发闭环，不开放自动并行写入。
- `workflow_runs.graph_state` 作为 graph state 快照，现有 workflow tables 继续作为 UI 与审计来源。
- 验证命令通过 allowlist 执行，不暴露通用 shell tool。
```

- [ ] **Step 4: Run backend graph test suite**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" node --import tsx --test "src/workflows/graph/*.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/workflows/graph/e2e.test.ts docs/superpowers/specs/2026-05-15-LangChain-LangGraph替代OpenClaw编排层设计.md
git commit -m "test(workflows): 覆盖 LangGraph 端到端闭环"
```

## Task 12: Final Verification and Review

**Files:**
- Modify only if verification exposes defects.

- [ ] **Step 1: Run backend tests**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" npm run test -w @openclaw-room/backend
```

Expected: PASS.

- [ ] **Step 2: Run root build**

Run:

```bash
PATH="$(dirname $(mise which node)):$PATH" npm run build
```

Expected:

- Backend TypeScript build passes.
- Frontend build passes.
- Vite may print existing chunk size warning only.

- [ ] **Step 3: Browser smoke test**

With dev server running:

1. Create a temporary project and room.
2. Add built-in ACP-only executor/reviewer/acceptor agents.
3. Create a task.
4. Enable `LANGGRAPH_WORKFLOW_ENABLED=1` for backend.
5. Start workflow.
6. Confirm workflow timeline shows graph node labels and reaches expected paused/completed state.
7. Delete temporary project after test.

Expected: No OpenClaw Gateway dependency is required.

- [ ] **Step 4: Request code review**

Use `superpowers:requesting-code-review` for the whole phase B range:

- Base SHA: phase B start commit.
- Head SHA: current HEAD.
- Focus: graph state persistence, recovery, feature flag fallback, ACP execution behavior, allowlist safety, UI compatibility.

- [ ] **Step 5: Fix review findings**

Address Critical and Important findings. Re-run targeted tests for every fix.

- [ ] **Step 6: Completion verification**

Use `superpowers:verification-before-completion` and re-run:

```bash
PATH="$(dirname $(mise which node)):$PATH" npm run test -w @openclaw-room/backend
PATH="$(dirname $(mise which node)):$PATH" npm run build
git status --short --branch
```

- [ ] **Step 7: Commit final fixes if any**

```bash
git add <changed-files>
git commit -m "fix(workflows): 收尾 LangGraph 阶段 B 验证问题"
```

Skip commit if there are no changes.

## Phase B Self-Review Checklist

- [ ] LangGraph runtime behind `LANGGRAPH_WORKFLOW_ENABLED` feature flag.
- [ ] Feature flag disabled时，现有 orchestrator 行为保持不变。
- [ ] `workflow_runs.graph_state` 和 `workflow_steps.node_name/scope_*` 可落库和恢复。
- [ ] Graph 节点不暴露通用 shell tool。
- [ ] ACP 执行仍通过现有 adapters。
- [ ] 人工审批可以暂停和继续。
- [ ] Review changes_requested 可以进入 bounded repair loop。
- [ ] Verification command 只允许 allowlist。
- [ ] 后端重启 recovery 可中断 running graph step 和 active agent run。
- [ ] 无 OpenClaw Gateway 时，ACP-only agents 可完成 graph runtime 闭环。
