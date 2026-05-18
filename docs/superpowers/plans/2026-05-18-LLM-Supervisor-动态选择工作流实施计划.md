# LLM Supervisor 动态选择工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 workflow 启动前引入 LLM Supervisor，从可见的已发布 workflow definitions 中动态选择合适流程，并保留 deterministic fallback。

**Architecture:** 新增 `workflow-supervisor` 纯服务，复用现有 LangChain planner 配置和 ChatOpenAI invoker。Graph runtime 在创建 workflow run 前调用 supervisor，校验输出后决定 `workflow_definition_id`；非法、低置信度或无配置时回退当前默认 workflow。第一阶段只记录 agent assignment 建议，不执行临时 workflow draft。

**Tech Stack:** Node.js、TypeScript、LangChain ChatOpenAI、SQLite repositories、LangGraph runtime、node:test。

---

### Task 1: Supervisor Parser And Prompt

**Files:**
- Create: `packages/backend/src/workflows/supervisor.ts`
- Test: `packages/backend/src/workflows/supervisor.test.ts`

- [ ] **Step 1: Write failing parser tests**

Cover:
- Parses fenced JSON decision.
- Accepts `select_existing_workflow` with `workflowDefinitionId`, `confidence`, `reason`, `assignments`.
- Rejects confidence outside `[0, 1]`.
- Rejects unknown `mode`.
- Treats `propose_temporary_workflow` as non-executable recommendation.

- [ ] **Step 2: Run parser test for RED**

Run:

```bash
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/workflows/supervisor.test.ts
```

- [ ] **Step 3: Implement parser and message builder**

Expose:

```ts
export interface WorkflowSupervisorDecision { ... }
export function parseWorkflowSupervisorDecision(raw: string): WorkflowSupervisorDecision
export function buildSupervisorMessages(input: WorkflowSupervisorInput): PlannerMessage[]
```

- [ ] **Step 4: Run test for GREEN**

Same command, expect all supervisor parser tests pass.

### Task 2: Supervisor Service And Runtime Integration

**Files:**
- Modify: `packages/backend/src/workflows/supervisor.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Test: `packages/backend/src/workflows/graph/runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add tests:
- High confidence valid supervisor choice writes selected `workflow_definition_id`.
- Low confidence valid choice falls back to default workflow.
- Unknown or invisible workflow id falls back to default workflow.
- LLM failure falls back to default workflow.

- [ ] **Step 2: Run runtime tests for RED**

Run:

```bash
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/workflows/graph/runtime.test.ts
```

- [ ] **Step 3: Implement runtime hook**

Add `supervisor?: (input: WorkflowSupervisorInput) => Promise<WorkflowSupervisorDecision>` to `GraphRuntimeDeps`.

`createGraphWorkflowRun` should accept optional deps or a resolved supervisor decision path:

```ts
export async function selectWorkflowDefinitionForTask(taskId, deps)
```

Keep `createGraphWorkflowRun` deterministic by accepting an optional selected definition if needed.

- [ ] **Step 4: Run runtime tests for GREEN**

Same command, expect supervisor runtime tests pass.

### Task 3: Decision Audit Metadata

**Files:**
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/backend/src/repos/workflows.ts`
- Modify: `packages/backend/src/db.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Test: `packages/backend/src/workflows/graph/runtime.test.ts`

- [ ] **Step 1: Decide storage path**

Prefer no schema migration if existing `workflow_definition_snapshot` can include `supervisorDecision`. If type constraints require clearer access, add nullable `supervisor_decision_json` to `workflow_runs`.

- [ ] **Step 2: Write failing audit test**

Assert selected/fallback supervisor decision is present in workflow detail.

- [ ] **Step 3: Implement minimal storage**

Store:
- mode
- selected workflow id
- confidence
- reason
- fallback reason

- [ ] **Step 4: Run audit test**

Targeted runtime test.

### Task 4: Assignment Hints Boundary

**Files:**
- Modify: `packages/backend/src/workflows/supervisor.ts`
- Modify: `packages/backend/src/workflows/graph/state.ts`
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Test: `packages/backend/src/workflows/graph/runtime.test.ts`

- [ ] **Step 1: Write failing assignment tests**

Cover:
- Legal supervisor assignment hint can assign implementation child task to a specific executable agent.
- Illegal assignment hint is ignored and deterministic resolver assigns instead.

- [ ] **Step 2: Implement hint storage**

Store validated hints in graph state or workflow context. Keep hints advisory.

- [ ] **Step 3: Wire dispatch**

Before deterministic resolver, try matching hint by stage/role/task title if present.

- [ ] **Step 4: Run tests**

Targeted graph runtime tests.

### Task 5: Final Verification And Commit

- [ ] Run supervisor tests:

```bash
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/workflows/supervisor.test.ts src/workflows/graph/runtime.test.ts src/workflows/role-resolver.test.ts
```

- [ ] Run build:

```bash
npm run build
```

- [ ] Review staged diff for unrelated changes.
- [ ] Commit:

```bash
git commit -m "feat(workflow): 增加 Supervisor 动态选择工作流"
```
