# 工作流并行调度 Active Run 续跑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 graph workflow 在已有某个 implementation 子任务 active run 时，仍能启动其他 ready、无写范围冲突、不同 agent 的 implementation 子任务。

**Architecture:** 保留 active run 防重入，但从“任意 active implementation run 阻塞整个 executeNode”收窄为“只排除已有 active run 的 child”。并行批次选择会接收 active child ids 和 active write scopes，避免重复启动同一 child，也避免与正在运行子任务发生写范围冲突。

**Tech Stack:** Node.js、TypeScript、SQLite/better-sqlite3、node:test。

---

## 工作区注意事项

当前工作区存在其他未暂存改动。执行本计划只修改并提交：

- `docs/superpowers/plans/2026-06-09-工作流并行调度active-run续跑实施计划.md`
- `packages/backend/src/workflows/graph/execute.test.ts`
- `packages/backend/src/workflows/graph/nodes.ts`

不要暂存或回滚其他文件。

## Task 1: RED active run 不阻塞 ready sibling

**Files:**
- Modify: `packages/backend/src/workflows/graph/execute.test.ts`

- [x] **Step 1: 新增 failing test**

在并行 execute 测试区新增：

```ts
test('execute node starts ready sibling while another implementation child run is active', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-execute-active-sibling-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Execute Active Sibling', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Execute Active Sibling Room' });
  const backend = createAcpExecutor(room.id, 'active-sibling-backend', ['packages/backend']);
  const frontend = createAcpExecutor(room.id, 'active-sibling-frontend', ['packages/frontend']);
  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Active sibling parent task',
  });
  const backendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Backend active child',
    description: 'Already running.',
    assigned_agent_id: backend.id,
    created_from: 'workflow_assignment',
  });
  const frontendChild = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Frontend ready child',
    description: 'Can start while backend is running.',
    assigned_agent_id: frontend.id,
    created_from: 'workflow_assignment',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: parentTask.id,
    status: 'running',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
  });
  const activeStep = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: backendChild.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: backend.id,
    assigned_room_agent_id: backend.id,
    scope_read: ['packages/backend/src/routes.ts'],
    scope_write: ['packages/backend/src/routes.ts'],
    prompt: 'active backend prompt',
    sort_order: 1,
  });
  agentRunRepo.create({
    room_id: room.id,
    room_agent_id: backend.id,
    agent_id: backend.agent_id,
    backend: backend.acp_backend ?? 'codex',
    task_id: backendChild.id,
    workflow_run_id: run.id,
    workflow_step_id: activeStep.id,
    workflow_stage: 'implementation',
    prompt: 'active backend prompt',
  });

  const started: string[] = [];
  const nodes = createGraphNodes(createGraphTools({
    runAcpAgent: async (input) => {
      started.push(input.agent.id);
      return createCompletedGraphAgentRun(room.id, input, 'ready sibling implementation done');
    },
  }));

  const nextState = await nodes.executeNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Start ready sibling despite active implementation run',
      assumptions: [],
      tasks: [
        {
          title: backendChild.title,
          description: backendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Backend keeps running'],
          scopeRead: ['packages/backend/src/routes.ts'],
          scopeWrite: ['packages/backend/src/routes.ts'],
          dependsOn: [],
        },
        {
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Frontend reaches review'],
          scopeRead: ['packages/frontend/src/pages/FilesPage.tsx'],
          scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    workflowPlan: {
      workflow_name: parentTask.title,
      source_message_id: parentTask.id,
      goal: parentTask.title,
      summary: 'Start ready sibling despite active implementation run',
      tasks: [
        {
          id: 'task-1-backend-active-child',
          title: backendChild.title,
          description: backendChild.description ?? '',
          role: 'executor',
          agent_id: backend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'running',
          progress: 35,
          result_refs: [],
        },
        {
          id: 'task-2-frontend-ready-child',
          title: frontendChild.title,
          description: frontendChild.description ?? '',
          role: 'executor',
          agent_id: frontend.id,
          mode: 'parallel',
          depends_on: [],
          status: 'pending',
          progress: 0,
          result_refs: [],
        },
      ],
    },
    currentNode: 'execute',
    currentStepId: activeStep.id,
    activeAgentRunId: null,
    childTaskIds: [backendChild.id, frontendChild.id],
    childTaskPlanIndexes: {
      [backendChild.id]: 0,
      [frontendChild.id]: 1,
    },
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.deepEqual(started, [frontend.id]);
  assert.equal(taskRepo.get(frontendChild.id)?.status, 'review');
  assert.deepEqual(nextState.workflowPlan?.tasks.map((task) => task.status), ['running', 'completed']);
  assert.equal(workflowRepo.listSteps(run.id).filter((step) => step.node_name === 'execute').length, 2);
});
```

- [x] **Step 2: 运行 RED**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/execute.test.ts --test-name-pattern "ready sibling while another"
```

Expected: FAIL，当前 `findActiveImplementationRunForChildren()` 直接返回 active run，导致 frontend child 不会启动。

## Task 2: active run 过滤和冲突保护

**Files:**
- Modify: `packages/backend/src/workflows/graph/nodes.ts`

- [x] **Step 1: 替换整轮 active run 早退**

在 `executeNode` 中把 `findActiveImplementationRunForChildren()` 早退改为：

1. 读取所有 active implementation runs。
2. 提取 `activeChildTaskIds`。
3. 提取 active running step 的 `scope_write` 作为 `activeWrites`。
4. 后续候选选择时排除 `activeChildTaskIds`，并用 `activeWrites` 做写冲突检查。

- [x] **Step 2: 扩展 batch 选择参数**

把 `selectParallelImplementationBatch()` 参数扩展为：

```ts
activeChildTaskIds: Set<string>;
activeWrites: string[][];
```

选择时：

```ts
if (input.activeChildTaskIds.has(child.id)) continue;
if (input.activeWrites.some((existing) => scopeWritesConflict(existing, writes, input.projectPath))) continue;
```

- [x] **Step 3: 扩展单 child fallback**

把 `selectNextImplementationChild()` 参数扩展为同样的 `activeChildTaskIds`、`activeWrites`、`projectPath`，并在 `find()` 中跳过 active child 和与 active writes 冲突的 child。

- [x] **Step 4: 运行 GREEN**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/execute.test.ts --test-name-pattern "ready sibling while another"
```

Expected: PASS。

## Task 3: 回归验证与提交

**Files:**
- Modify: `docs/superpowers/plans/2026-06-09-工作流并行调度active-run续跑实施计划.md`
- Modify: `packages/backend/src/workflows/graph/execute.test.ts`
- Modify: `packages/backend/src/workflows/graph/nodes.ts`

- [x] **Step 1: 运行 execute 回归**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/execute.test.ts --test-name-pattern "parallel|conflict|depends|dependency-blocked child|ready sibling while another|active workflow run|starts assigned ACP agent"
```

- [x] **Step 2: 运行 runtime 定向回归**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/runtime.test.ts --test-name-pattern "continueGraphWorkflow waits|execute node maps duplicate child titles"
```

- [x] **Step 3: 运行后端构建**

Run:

```bash
npm run build -w @openclaw-room/backend
```

- [x] **Step 4: 检查并提交本阶段文件**

Run:

```bash
git diff --check -- docs/superpowers/plans/2026-06-09-工作流并行调度active-run续跑实施计划.md packages/backend/src/workflows/graph/execute.test.ts packages/backend/src/workflows/graph/nodes.ts
git add docs/superpowers/plans/2026-06-09-工作流并行调度active-run续跑实施计划.md packages/backend/src/workflows/graph/execute.test.ts packages/backend/src/workflows/graph/nodes.ts
git commit --only -m "fix(workflow): 续跑并行执行空闲子任务" -- docs/superpowers/plans/2026-06-09-工作流并行调度active-run续跑实施计划.md packages/backend/src/workflows/graph/execute.test.ts packages/backend/src/workflows/graph/nodes.ts
```
