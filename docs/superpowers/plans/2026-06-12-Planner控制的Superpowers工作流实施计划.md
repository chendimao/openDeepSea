# Planner 控制的 Superpowers 工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OpenDeepSea 的开发任务入口改造成 planner 控制的 Superpowers workflow-first 编排，并接入 artifact 版本、全局智能体分配和全栈工程师兜底。

**Architecture:** 后端以 `superpowers-v2` runtime profile 为主线：session 消息先进入 workflow intake，planner 负责生成和修订 spec/plan，worker/reviewer/verifier 只消费确认后的 artifact。新增 artifact version repo、stage registry、agent assignment 和 fullstack fallback 模块，前端展示只读 spec/plan、确认门禁、修改请求和子代理分配。

**Tech Stack:** Node.js、TypeScript、Express、SQLite、LangGraph、ACP provider、React 18、Vite、Tailwind、node:test。

---

## Scope And Sequencing

本计划按可独立交付的阶段拆分，避免一次性重写整个 workflow。实现时必须按任务顺序执行。每个任务结束都要提交，后续任务基于前一任务的提交继续。

当前 worktree 已有大量无关修改。执行本计划时先使用 `superpowers:using-git-worktrees` 创建隔离 worktree；执行过程中只提交本计划涉及的文件，不能纳入无关脏文件。

## File Structure

新增文件：

- `packages/backend/src/workflows/artifact-versions.ts`：artifact version 领域模型、SQLite repo、确认与 supersede 操作。
- `packages/backend/src/workflows/artifact-versions.test.ts`：artifact version repo 与确认状态测试。
- `packages/backend/src/workflows/superpowers-stage-registry.ts`：Superpowers v2 stage registry、阶段定义、门禁配置。
- `packages/backend/src/workflows/superpowers-stage-registry.test.ts`：阶段顺序、controller/worker/reviewer/verifier 映射测试。
- `packages/backend/src/workflows/agent-assignment.ts`：从全局 agent registry 选择 specialist，找不到时 fallback 到 fullstack-engineer。
- `packages/backend/src/workflows/agent-assignment.test.ts`：agent 匹配、scope 冲突、fullstack fallback 测试。
- `packages/backend/src/workflows/fullstack-engineer.ts`：内置 fullstack-engineer 模板常量与 ensure helper。
- `packages/backend/src/workflows/fullstack-engineer.test.ts`：内置模板和 room agent 初始化测试。
- `packages/backend/src/workflows/superpowers-invocation.ts`：构造 ACP skill invocation prompt、解析 evidence、状态映射。
- `packages/backend/src/workflows/superpowers-invocation.test.ts`：prompt 约束、missing evidence、timeout recovery 测试。
- `packages/backend/src/workflows/session-workflow-intake.ts`：session 用户消息到 workflow-first task/run 的入口服务。
- `packages/backend/src/workflows/session-workflow-intake.test.ts`：普通问答、轻量任务、标准开发、修改请求路由测试。

修改文件：

- `packages/backend/src/db.ts`：新增 `workflow_artifact_versions` 表和迁移保护。
- `packages/backend/src/types.ts`：新增 workflow artifact version、superpowers-v2 状态、全局 agent assignment 类型。
- `packages/backend/src/repos/workflows.ts`：从新 repo 重新导出 `workflowArtifactVersionRepo`，保持调用入口集中。
- `packages/backend/src/agent-templates.ts`：新增 fullstack-engineer 内置模板。
- `packages/backend/src/workflows/agent-provisioning.ts`：执行 agent provisioning 时使用 agent-assignment 和 fullstack fallback。
- `packages/backend/src/workflows/graph/state.ts`：扩展 state，记录 artifact version ids、change request、assignments、recovery。
- `packages/backend/src/workflows/graph/superpowers-runtime.ts`：升级 `SUPERPOWERS_GRAPH_VERSION` 到 `superpowers-v2`，用 stage registry 表达 definition。
- `packages/backend/src/workflows/graph/superpowers-nodes.ts`：把占位节点迁移为真实 invocation/gate 调用。
- `packages/backend/src/workflows/graph/runtime.ts`：识别 v2 state、intake/change request/recovery 状态，并保持 v1/phase-b 历史兼容。
- `packages/backend/src/session-message-dispatch.ts`：废弃 `low_risk_auto` 旁路，改为 session workflow intake。
- `packages/backend/src/session.routes.ts`：把 artifact versions、confirm gates、assignments 暴露给 session detail 和 workspace payload。
- `packages/backend/src/session.routes.ts`：新增 spec/plan 确认路由；修改请求复用现有发送消息入口并写入 change request metadata。
- `packages/frontend/src/lib/types.ts`：新增 artifact version、assignment、workflow gate 类型。
- `packages/frontend/src/lib/api.ts`：新增确认 spec/plan API。
- `packages/frontend/src/session-ui/SessionShellView.tsx`：展示只读 spec/plan、确认按钮、修改提示、子代理分配。
- `packages/frontend/src/session-ui/session-os.css`：补充只读 artifact/gate/assignment 样式。
- `packages/frontend/src/pages/SessionWorkspacePage.test.tsx`、`packages/frontend/src/session-ui/SessionShell.test.tsx`：前端回归测试。

## Task 1: Artifact Version Repo And Types

**Files:**
- Modify: `packages/backend/src/db.ts`
- Modify: `packages/backend/src/types.ts`
- Create: `packages/backend/src/workflows/artifact-versions.ts`
- Create: `packages/backend/src/workflows/artifact-versions.test.ts`

- [ ] **Step 1: Write failing artifact version repo test**

Create `packages/backend/src/workflows/artifact-versions.test.ts` with tests that prove draft creation, confirmation, supersede, and immutable approved lookup:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-artifact-version-')), 'test.db');

const { workflowArtifactVersionRepo } = await import('./artifact-versions.js');

test('workflow artifact versions supersede confirmed plan when planner creates a new draft', () => {
  const v1 = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: 'run-1',
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v1',
    structured_data: { tasks: [{ id: 'task-1' }] },
    created_by_agent_id: 'planner',
  });
  const approved = workflowArtifactVersionRepo.approve(v1.id, {
    approved_by: 'user',
    approval_message_id: 'msg-confirm-1',
  });

  assert.equal(approved?.status, 'approved');
  assert.equal(workflowArtifactVersionRepo.getApproved('run-1', 'plan')?.id, v1.id);

  const v2 = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: 'run-1',
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v2',
    structured_data: { tasks: [{ id: 'task-1' }, { id: 'task-2' }] },
    created_by_agent_id: 'planner',
    change_request_message_id: 'msg-change-1',
    supersedes_artifact_version_id: v1.id,
  });

  assert.equal(v2.version, 2);
  assert.equal(workflowArtifactVersionRepo.get(v1.id)?.status, 'superseded');
  assert.equal(workflowArtifactVersionRepo.getApproved('run-1', 'plan'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/artifact-versions.test.ts
```

Expected: FAIL because `./artifact-versions.js` does not exist.

- [ ] **Step 3: Add DB schema and types**

In `packages/backend/src/db.ts`, add the table after `task_artifacts`:

```ts
CREATE TABLE IF NOT EXISTS workflow_artifact_versions (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'reviewing', 'approved', 'superseded', 'rejected')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  structured_data TEXT NOT NULL DEFAULT '{}',
  created_by_agent_id TEXT NOT NULL,
  change_request_message_id TEXT,
  supersedes_artifact_version_id TEXT,
  approved_by TEXT,
  approval_message_id TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (supersedes_artifact_version_id) REFERENCES workflow_artifact_versions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_artifact_versions_run_type
  ON workflow_artifact_versions(workflow_run_id, artifact_type, version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_artifact_versions_approved
  ON workflow_artifact_versions(workflow_run_id, artifact_type)
  WHERE status = 'approved';
```

In `packages/backend/src/types.ts`, add:

```ts
export type WorkflowArtifactVersionType = 'spec' | 'plan' | 'lightweight_plan' | 'review' | 'verification';
export type WorkflowArtifactVersionStatus = 'draft' | 'reviewing' | 'approved' | 'superseded' | 'rejected';

export interface WorkflowArtifactVersion {
  id: string;
  workflow_run_id: string;
  artifact_type: WorkflowArtifactVersionType;
  version: number;
  status: WorkflowArtifactVersionStatus;
  title: string;
  content: string;
  structured_data: string;
  created_by_agent_id: string;
  change_request_message_id: string | null;
  supersedes_artifact_version_id: string | null;
  approved_by: string | null;
  approval_message_id: string | null;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
}
```

- [ ] **Step 4: Implement artifact version repo**

Create `packages/backend/src/workflows/artifact-versions.ts`:

```ts
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { WorkflowArtifactVersion, WorkflowArtifactVersionType } from '../types.js';

type WorkflowArtifactVersionRow = WorkflowArtifactVersion;

interface CreateDraftInput {
  workflow_run_id: string;
  artifact_type: WorkflowArtifactVersionType;
  title: string;
  content: string;
  structured_data?: unknown;
  created_by_agent_id: string;
  change_request_message_id?: string | null;
  supersedes_artifact_version_id?: string | null;
}

interface ApproveInput {
  approved_by: string;
  approval_message_id?: string | null;
}

function nextVersion(workflowRunId: string, artifactType: WorkflowArtifactVersionType): number {
  const row = db.prepare(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM workflow_artifact_versions WHERE workflow_run_id = ? AND artifact_type = ?',
  ).get(workflowRunId, artifactType) as { next: number };
  return row.next;
}

function encodeStructuredData(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export const workflowArtifactVersionRepo = {
  createDraft(input: CreateDraftInput): WorkflowArtifactVersion {
    return db.transaction(() => {
      const ts = now();
      if (input.supersedes_artifact_version_id) {
        db.prepare(
          `UPDATE workflow_artifact_versions
           SET status = 'superseded', updated_at = ?
           WHERE id = ?`,
        ).run(ts, input.supersedes_artifact_version_id);
      }
      db.prepare(
        `UPDATE workflow_artifact_versions
         SET status = 'superseded', updated_at = ?
         WHERE workflow_run_id = ? AND artifact_type = ? AND status = 'approved'`,
      ).run(ts, input.workflow_run_id, input.artifact_type);

      const id = nanoid(14);
      db.prepare(
        `INSERT INTO workflow_artifact_versions (
          id, workflow_run_id, artifact_type, version, status, title, content, structured_data,
          created_by_agent_id, change_request_message_id, supersedes_artifact_version_id,
          approved_by, approval_message_id, approved_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      ).run(
        id,
        input.workflow_run_id,
        input.artifact_type,
        nextVersion(input.workflow_run_id, input.artifact_type),
        input.title,
        input.content,
        encodeStructuredData(input.structured_data),
        input.created_by_agent_id,
        input.change_request_message_id ?? null,
        input.supersedes_artifact_version_id ?? null,
        ts,
        ts,
      );
      return this.get(id)!;
    })();
  },

  get(id: string): WorkflowArtifactVersion | null {
    return db.prepare('SELECT * FROM workflow_artifact_versions WHERE id = ?').get(id) as WorkflowArtifactVersionRow | undefined ?? null;
  },

  listByRun(workflowRunId: string): WorkflowArtifactVersion[] {
    return db.prepare(
      'SELECT * FROM workflow_artifact_versions WHERE workflow_run_id = ? ORDER BY artifact_type ASC, version ASC',
    ).all(workflowRunId) as WorkflowArtifactVersion[];
  },

  getLatest(workflowRunId: string, artifactType: WorkflowArtifactVersionType): WorkflowArtifactVersion | null {
    return db.prepare(
      `SELECT * FROM workflow_artifact_versions
       WHERE workflow_run_id = ? AND artifact_type = ?
       ORDER BY version DESC LIMIT 1`,
    ).get(workflowRunId, artifactType) as WorkflowArtifactVersionRow | undefined ?? null;
  },

  getApproved(workflowRunId: string, artifactType: WorkflowArtifactVersionType): WorkflowArtifactVersion | null {
    return db.prepare(
      `SELECT * FROM workflow_artifact_versions
       WHERE workflow_run_id = ? AND artifact_type = ? AND status = 'approved'
       ORDER BY version DESC LIMIT 1`,
    ).get(workflowRunId, artifactType) as WorkflowArtifactVersionRow | undefined ?? null;
  },

  approve(id: string, input: ApproveInput): WorkflowArtifactVersion | null {
    const existing = this.get(id);
    if (!existing) return null;
    return db.transaction(() => {
      const ts = now();
      db.prepare(
        `UPDATE workflow_artifact_versions
         SET status = 'superseded', updated_at = ?
         WHERE workflow_run_id = ? AND artifact_type = ? AND status = 'approved' AND id <> ?`,
      ).run(ts, existing.workflow_run_id, existing.artifact_type, id);
      db.prepare(
        `UPDATE workflow_artifact_versions
         SET status = 'approved', approved_by = ?, approval_message_id = ?, approved_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.approved_by, input.approval_message_id ?? null, ts, ts, id);
      return this.get(id);
    })();
  },
};
```

- [ ] **Step 5: Run artifact version test**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/artifact-versions.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/backend/src/db.ts packages/backend/src/types.ts packages/backend/src/workflows/artifact-versions.ts packages/backend/src/workflows/artifact-versions.test.ts
git commit -m "feat(workflow): 新增工作流产物版本仓储"
```

## Task 2: Stage Registry And Superpowers v2 State

**Files:**
- Create: `packages/backend/src/workflows/superpowers-stage-registry.ts`
- Create: `packages/backend/src/workflows/superpowers-stage-registry.test.ts`
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/backend/src/workflows/graph/state.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-runtime.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`

- [ ] **Step 1: Write failing stage registry test**

Create `packages/backend/src/workflows/superpowers-stage-registry.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUPERPOWERS_V2_GRAPH_VERSION,
  getSuperpowersStage,
  listSuperpowersStages,
} from './superpowers-stage-registry.js';

test('Superpowers v2 stage registry defines planner controlled gates before execution', () => {
  assert.equal(SUPERPOWERS_V2_GRAPH_VERSION, 'superpowers-v2');
  assert.deepEqual(listSuperpowersStages().slice(0, 6).map((stage) => stage.id), [
    'intake',
    'route_skills',
    'brainstorming',
    'spec_review',
    'spec_confirm',
    'writing_plans',
  ]);
  assert.equal(getSuperpowersStage('brainstorming')?.controller, 'planner');
  assert.equal(getSuperpowersStage('execute')?.controller, 'worker');
  assert.equal(getSuperpowersStage('code_quality_review')?.controller, 'reviewer');
  assert.equal(getSuperpowersStage('verification')?.controller, 'verifier');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test packages/backend/src/workflows/superpowers-stage-registry.test.ts
```

Expected: FAIL because `superpowers-stage-registry.js` does not exist.

- [ ] **Step 3: Implement stage registry**

Create `packages/backend/src/workflows/superpowers-stage-registry.ts`:

```ts
export const SUPERPOWERS_V2_GRAPH_VERSION = 'superpowers-v2';

export type SuperpowersStageController = 'planner' | 'worker' | 'reviewer' | 'verifier' | 'user';
export type SuperpowersStageId =
  | 'intake'
  | 'route_skills'
  | 'answer'
  | 'analysis_plan'
  | 'lightweight_plan'
  | 'brainstorming'
  | 'spec_review'
  | 'spec_confirm'
  | 'writing_plans'
  | 'plan_review'
  | 'plan_confirm'
  | 'worktree'
  | 'dispatch'
  | 'execute'
  | 'debug'
  | 'spec_compliance_review'
  | 'code_quality_review'
  | 'verification'
  | 'finish_branch'
  | 'acceptance'
  | 'memory';

export interface SuperpowersStageDefinition {
  id: SuperpowersStageId;
  controller: SuperpowersStageController;
  requiredSkills: string[];
  requiredInputs: string[];
  expectedArtifacts: string[];
  gates: string[];
  next: SuperpowersStageId[];
}

const STAGES: SuperpowersStageDefinition[] = [
  { id: 'intake', controller: 'planner', requiredSkills: ['using-superpowers'], requiredInputs: ['user_message'], expectedArtifacts: ['intent_routing'], gates: ['artifact_schema'], next: ['route_skills', 'answer'] },
  { id: 'route_skills', controller: 'planner', requiredSkills: ['using-superpowers'], requiredInputs: ['intent_routing'], expectedArtifacts: ['superpowers_routing'], gates: ['artifact_schema'], next: ['lightweight_plan', 'brainstorming', 'analysis_plan', 'debug'] },
  { id: 'brainstorming', controller: 'planner', requiredSkills: ['brainstorming'], requiredInputs: ['user_message'], expectedArtifacts: ['spec'], gates: ['artifact_schema'], next: ['spec_review'] },
  { id: 'spec_review', controller: 'reviewer', requiredSkills: ['brainstorming'], requiredInputs: ['spec'], expectedArtifacts: ['spec_review'], gates: ['review_clear'], next: ['spec_confirm'] },
  { id: 'spec_confirm', controller: 'user', requiredSkills: [], requiredInputs: ['spec_review'], expectedArtifacts: ['approved_spec_version'], gates: ['user_confirm'], next: ['writing_plans'] },
  { id: 'writing_plans', controller: 'planner', requiredSkills: ['writing-plans'], requiredInputs: ['approved_spec_version'], expectedArtifacts: ['plan'], gates: ['artifact_schema'], next: ['plan_review'] },
  { id: 'plan_review', controller: 'reviewer', requiredSkills: ['writing-plans'], requiredInputs: ['plan'], expectedArtifacts: ['plan_review'], gates: ['review_clear'], next: ['plan_confirm'] },
  { id: 'plan_confirm', controller: 'user', requiredSkills: [], requiredInputs: ['plan_review'], expectedArtifacts: ['approved_plan_version'], gates: ['user_confirm'], next: ['worktree', 'dispatch'] },
  { id: 'lightweight_plan', controller: 'planner', requiredSkills: ['using-superpowers'], requiredInputs: ['user_message'], expectedArtifacts: ['lightweight_plan'], gates: ['artifact_schema', 'user_confirm'], next: ['dispatch'] },
  { id: 'analysis_plan', controller: 'planner', requiredSkills: ['brainstorming'], requiredInputs: ['user_message'], expectedArtifacts: ['analysis_plan'], gates: ['user_confirm'], next: ['execute'] },
  { id: 'answer', controller: 'planner', requiredSkills: [], requiredInputs: ['user_message'], expectedArtifacts: ['answer'], gates: [], next: [] },
  { id: 'worktree', controller: 'planner', requiredSkills: ['using-git-worktrees'], requiredInputs: ['approved_plan_version'], expectedArtifacts: ['worktree'], gates: ['artifact_schema'], next: ['dispatch'] },
  { id: 'dispatch', controller: 'planner', requiredSkills: ['subagent-driven-development'], requiredInputs: ['approved_plan_version'], expectedArtifacts: ['agent_assignments'], gates: ['artifact_schema'], next: ['execute'] },
  { id: 'execute', controller: 'worker', requiredSkills: ['test-driven-development'], requiredInputs: ['assigned_task'], expectedArtifacts: ['tddEvidence'], gates: ['artifact_schema'], next: ['spec_compliance_review'] },
  { id: 'debug', controller: 'worker', requiredSkills: ['systematic-debugging'], requiredInputs: ['failure_context'], expectedArtifacts: ['debuggingEvidence'], gates: ['root_cause'], next: ['verification'] },
  { id: 'spec_compliance_review', controller: 'reviewer', requiredSkills: ['requesting-code-review'], requiredInputs: ['diff', 'approved_plan_version'], expectedArtifacts: ['specComplianceReview'], gates: ['review_clear'], next: ['code_quality_review', 'execute'] },
  { id: 'code_quality_review', controller: 'reviewer', requiredSkills: ['requesting-code-review'], requiredInputs: ['diff'], expectedArtifacts: ['codeQualityReview'], gates: ['review_clear'], next: ['verification', 'execute'] },
  { id: 'verification', controller: 'verifier', requiredSkills: ['verification-before-completion'], requiredInputs: ['verification_commands'], expectedArtifacts: ['verificationEvidence'], gates: ['fresh_evidence'], next: ['finish_branch'] },
  { id: 'finish_branch', controller: 'planner', requiredSkills: ['finishing-a-development-branch'], requiredInputs: ['verificationEvidence'], expectedArtifacts: ['finishBranchDecision'], gates: ['user_confirm'], next: ['acceptance'] },
  { id: 'acceptance', controller: 'planner', requiredSkills: [], requiredInputs: ['approved_plan_version', 'verificationEvidence'], expectedArtifacts: ['acceptance'], gates: ['completion_audit'], next: ['memory'] },
  { id: 'memory', controller: 'planner', requiredSkills: [], requiredInputs: ['acceptance'], expectedArtifacts: ['memory'], gates: [], next: [] },
];

export function listSuperpowersStages(): SuperpowersStageDefinition[] {
  return STAGES.map((stage) => ({
    ...stage,
    requiredSkills: [...stage.requiredSkills],
    requiredInputs: [...stage.requiredInputs],
    expectedArtifacts: [...stage.expectedArtifacts],
    gates: [...stage.gates],
    next: [...stage.next],
  }));
}

export function getSuperpowersStage(id: SuperpowersStageId): SuperpowersStageDefinition | null {
  return listSuperpowersStages().find((stage) => stage.id === id) ?? null;
}
```

- [ ] **Step 4: Extend state and runtime version**

In `packages/backend/src/workflows/graph/state.ts`, add nullable/default fields to `agentWorkflowStateSchema`:

```ts
  activeSuperpowersStage: z.string().nullable().default(null),
  draftSpecArtifactVersionId: z.string().nullable().default(null),
  approvedSpecArtifactVersionId: z.string().nullable().default(null),
  draftPlanArtifactVersionId: z.string().nullable().default(null),
  approvedPlanArtifactVersionId: z.string().nullable().default(null),
  lightweightPlanArtifactVersionId: z.string().nullable().default(null),
  artifactChangeRequestMessageId: z.string().nullable().default(null),
  agentAssignments: z.array(z.object({
    taskId: z.string(),
    assignedAgentId: z.string().nullable(),
    fallbackAgentIds: z.array(z.string()).default([]),
    fallbackReason: z.string().nullable().default(null),
    executionMode: z.enum(['serial', 'parallel', 'hybrid']).default('serial'),
    scopeRead: z.array(z.string()).default([]),
    scopeWrite: z.array(z.string()).default([]),
  })).default([]),
  recoveryState: z.object({
    reason: z.string(),
    failedStage: z.string().nullable().default(null),
    retryable: z.boolean().default(true),
  }).nullable().default(null),
```

In `packages/backend/src/workflows/graph/superpowers-runtime.ts`, import `SUPERPOWERS_V2_GRAPH_VERSION` and change exported graph version to `superpowers-v2` while keeping runtime profile `superpowers`.

- [ ] **Step 5: Run targeted tests**

```bash
node --import tsx --test packages/backend/src/workflows/superpowers-stage-registry.test.ts
node --import tsx --test packages/backend/src/workflows/graph/state.test.ts
node --import tsx --test packages/backend/src/workflows/graph/superpowers-runtime.test.ts
```

Expected: PASS. Existing tests that assert `superpowers-v1` must be updated to `superpowers-v2` only for new-run behavior. Historical compatibility tests should keep explicit old values where needed.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/backend/src/workflows/superpowers-stage-registry.ts packages/backend/src/workflows/superpowers-stage-registry.test.ts packages/backend/src/types.ts packages/backend/src/workflows/graph/state.ts packages/backend/src/workflows/graph/superpowers-runtime.ts packages/backend/src/workflows/graph/state.test.ts packages/backend/src/workflows/graph/superpowers-runtime.test.ts
git commit -m "feat(workflow): 定义Superpowers v2阶段注册表"
```

## Task 3: Fullstack Engineer Template And Agent Assignment

**Files:**
- Modify: `packages/backend/src/agent-templates.ts`
- Modify: `packages/backend/src/agent-templates.test.ts`
- Create: `packages/backend/src/workflows/fullstack-engineer.ts`
- Create: `packages/backend/src/workflows/fullstack-engineer.test.ts`
- Create: `packages/backend/src/workflows/agent-assignment.ts`
- Create: `packages/backend/src/workflows/agent-assignment.test.ts`
- Modify: `packages/backend/src/workflows/agent-provisioning.ts`

- [ ] **Step 1: Write failing fullstack template test**

In `packages/backend/src/agent-templates.test.ts`, add:

```ts
test('built-in templates include fullstack engineer executor fallback', () => {
  const template = listBuiltInAgentTemplates().find((item) => item.id === 'fullstack-engineer');
  assert.ok(template);
  assert.equal(template.name, '全栈工程师');
  assert.equal(template.workflow_role, 'executor');
  assert.equal(template.acp_permission_mode, 'workspace-write');
  assert.ok(template.capabilities.includes('frontend'));
  assert.ok(template.capabilities.includes('backend'));
  assert.ok(template.capabilities.includes('testing'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test packages/backend/src/agent-templates.test.ts
```

Expected: FAIL because fullstack-engineer template is missing.

- [ ] **Step 3: Add built-in template**

In `packages/backend/src/agent-templates.ts`, add a built-in template:

```ts
{
  id: 'fullstack-engineer',
  name: '全栈工程师',
  description: '跨前端、后端、测试和集成任务的兜底执行智能体。仅在没有更匹配的专业执行者时使用。',
  preferred_user_name: null,
  personality: '务实、端到端负责，能在前端、后端、测试和集成边界之间切换，但优先遵循 planner 已确认的任务范围。',
  rules: '只能执行已确认 plan 中分配给自己的任务；找不到专门子代理时才作为兜底执行者；不得替代 planner、reviewer、verifier 或修改未确认的 spec/plan。',
  responsibilities: '跨前后端实现、接口联调、测试补充、集成修复和执行阶段兜底。',
  workflow_role: 'executor',
  acp_enabled: true,
  acp_backend: 'codex',
  acp_permission_mode: 'workspace-write',
  runtime_backend: 'acp',
  tool_policy: { allowed: ['read_files', 'write_files', 'run_shell', 'commit'] },
  workspace_policy: { read: ['.'], write: ['.'] },
  memory_scope: 'agent',
  capabilities: ['frontend', 'backend', 'typescript', 'react', 'node', 'sqlite', 'testing', 'debugging', 'integration'],
}
```

- [ ] **Step 4: Implement fullstack ensure helper**

Create `packages/backend/src/workflows/fullstack-engineer.ts`:

```ts
import { agentRepo } from '../repos/agents.js';
import { roomAgentRepo } from '../repos/rooms.js';
import type { Agent, RoomAgent } from '../types.js';

export const FULLSTACK_ENGINEER_AGENT_ID = 'fullstack-engineer';

export function getGlobalFullstackEngineer(): Agent | null {
  return agentRepo.getByAgentId(FULLSTACK_ENGINEER_AGENT_ID)
    ?? agentRepo.getByBuiltinKey(FULLSTACK_ENGINEER_AGENT_ID)
    ?? null;
}

export function ensureFullstackEngineerRoomAgent(roomId: string): RoomAgent {
  return roomAgentRepo.ensureBuiltInAgent(roomId, FULLSTACK_ENGINEER_AGENT_ID);
}
```

Create `packages/backend/src/workflows/fullstack-engineer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-fullstack-engineer-')), 'test.db');

const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { ensureFullstackEngineerRoomAgent, getGlobalFullstackEngineer } = await import('./fullstack-engineer.js');

test('ensureFullstackEngineerRoomAgent joins global fullstack engineer to room', () => {
  const project = projectRepo.create({ name: 'Project', path: '/tmp/project' });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = ensureFullstackEngineerRoomAgent(room.id);

  assert.equal(agent.agent_id, 'fullstack-engineer');
  assert.equal(agent.workflow_role, 'executor');
  assert.equal(agent.acp_enabled, 1);
  assert.equal(getGlobalFullstackEngineer()?.agent_id, 'fullstack-engineer');
});
```

- [ ] **Step 5: Write failing assignment tests**

Create `packages/backend/src/workflows/agent-assignment.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { assignPlanTaskAgent } from './agent-assignment.js';

const baseAgent = {
  id: 'agent-id',
  name: 'Agent',
  provider: 'codex' as const,
  acpEnabled: true,
  available: true,
  priority: 0,
};

test('assignPlanTaskAgent prefers specialist over fullstack fallback', () => {
  const result = assignPlanTaskAgent({
    taskId: 'task-1',
    title: '实现 React 页面',
    requiredCapabilities: ['frontend', 'react'],
    scopeWrite: ['packages/frontend/src/pages/Home.tsx'],
    agents: [
      { ...baseAgent, id: 'fullstack-engineer', name: '全栈工程师', capabilities: ['frontend', 'backend', 'testing'], workflowRoles: ['executor'], fallback: true },
      { ...baseAgent, id: 'frontend-executor', name: '前端工程师', capabilities: ['frontend', 'react'], workflowRoles: ['executor'], fallback: false },
    ],
  });
  assert.equal(result.assignedAgentId, 'frontend-executor');
  assert.equal(result.fallbackReason, null);
});

test('assignPlanTaskAgent falls back to fullstack engineer when no specialist matches', () => {
  const result = assignPlanTaskAgent({
    taskId: 'task-2',
    title: '修复跨端集成',
    requiredCapabilities: ['integration'],
    scopeWrite: ['packages/backend/src/routes.ts', 'packages/frontend/src/lib/api.ts'],
    agents: [
      { ...baseAgent, id: 'fullstack-engineer', name: '全栈工程师', capabilities: ['frontend', 'backend', 'integration'], workflowRoles: ['executor'], fallback: true },
    ],
  });
  assert.equal(result.assignedAgentId, 'fullstack-engineer');
  assert.match(result.fallbackReason ?? '', /未找到更匹配/);
  assert.equal(result.executionMode, 'serial');
});
```

- [ ] **Step 6: Implement agent assignment**

Create `packages/backend/src/workflows/agent-assignment.ts`:

```ts
export interface AvailableWorkflowAgent {
  id: string;
  name: string;
  provider: 'codex' | 'claudecode' | 'opencode';
  capabilities: string[];
  workflowRoles: string[];
  acpEnabled: boolean;
  available: boolean;
  fallback?: boolean;
  priority?: number;
}

export interface AssignPlanTaskAgentInput {
  taskId: string;
  title: string;
  requiredCapabilities: string[];
  scopeWrite: string[];
  agents: AvailableWorkflowAgent[];
}

export interface PlanTaskAgentAssignment {
  taskId: string;
  assignedAgentId: string | null;
  fallbackAgentIds: string[];
  fallbackReason: string | null;
  executionMode: 'serial' | 'parallel' | 'hybrid';
  scopeWrite: string[];
}

export function assignPlanTaskAgent(input: AssignPlanTaskAgentInput): PlanTaskAgentAssignment {
  const candidates = input.agents.filter((agent) =>
    agent.available &&
    agent.acpEnabled &&
    agent.workflowRoles.includes('executor')
  );
  const specialists = candidates
    .filter((agent) => !agent.fallback)
    .map((agent) => ({ agent, score: scoreAgent(agent, input.requiredCapabilities, input.title) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || (right.agent.priority ?? 0) - (left.agent.priority ?? 0));

  const specialist = specialists[0]?.agent;
  if (specialist) {
    return {
      taskId: input.taskId,
      assignedAgentId: specialist.id,
      fallbackAgentIds: candidates.filter((agent) => agent.fallback).map((agent) => agent.id),
      fallbackReason: null,
      executionMode: 'parallel',
      scopeWrite: [...input.scopeWrite],
    };
  }

  const fullstack = candidates.find((agent) => agent.id === 'fullstack-engineer' || agent.fallback);
  if (fullstack) {
    return {
      taskId: input.taskId,
      assignedAgentId: fullstack.id,
      fallbackAgentIds: [fullstack.id],
      fallbackReason: '未找到更匹配的专门子代理，使用全栈工程师兜底执行',
      executionMode: input.scopeWrite.length > 1 ? 'serial' : 'parallel',
      scopeWrite: [...input.scopeWrite],
    };
  }

  return {
    taskId: input.taskId,
    assignedAgentId: null,
    fallbackAgentIds: [],
    fallbackReason: '未找到可用执行智能体',
    executionMode: 'serial',
    scopeWrite: [...input.scopeWrite],
  };
}

function scoreAgent(agent: AvailableWorkflowAgent, requiredCapabilities: string[], title: string): number {
  const haystack = new Set([
    ...agent.capabilities.map((item) => item.toLowerCase()),
    agent.id.toLowerCase(),
    agent.name.toLowerCase(),
  ]);
  let score = 0;
  for (const capability of requiredCapabilities) {
    if (haystack.has(capability.toLowerCase())) score += 5;
  }
  const lowerTitle = title.toLowerCase();
  for (const token of haystack) {
    if (token.length > 2 && lowerTitle.includes(token)) score += 1;
  }
  return score;
}
```

- [ ] **Step 7: Integrate provisioning fallback**

In `packages/backend/src/workflows/agent-provisioning.ts`, change executor provisioning fallback so unknown/null domain uses `fullstack-engineer` instead of defaulting to `backend-executor` when no specialist signal is present. Keep frontend/backend/documentation specialist mapping unchanged.

Expected local behavior:

```ts
function templateIdForPlanTask(task: ParsedPlanTask): string {
  const domain = inferTaskDomain(task);
  if (domain === 'frontend') return 'frontend-executor';
  if (domain === 'backend') return 'backend-executor';
  if (domain === 'documentation') return 'technical-writer';
  return 'fullstack-engineer';
}
```

- [ ] **Step 8: Run targeted tests**

```bash
node --import tsx --test packages/backend/src/agent-templates.test.ts
node --import tsx --test packages/backend/src/workflows/fullstack-engineer.test.ts
node --import tsx --test packages/backend/src/workflows/agent-assignment.test.ts
node --import tsx --test packages/backend/src/workflows/graph/coordinator-agents.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add packages/backend/src/agent-templates.ts packages/backend/src/agent-templates.test.ts packages/backend/src/workflows/fullstack-engineer.ts packages/backend/src/workflows/fullstack-engineer.test.ts packages/backend/src/workflows/agent-assignment.ts packages/backend/src/workflows/agent-assignment.test.ts packages/backend/src/workflows/agent-provisioning.ts packages/backend/src/workflows/graph/coordinator-agents.test.ts
git commit -m "feat(workflow): 添加全栈工程师兜底分配"
```

## Task 4: Session Workflow-first Intake

**Files:**
- Create: `packages/backend/src/workflows/session-workflow-intake.ts`
- Create: `packages/backend/src/workflows/session-workflow-intake.test.ts`
- Modify: `packages/backend/src/session-message-dispatch.ts`
- Modify: `packages/backend/src/session-message-dispatch.test.ts`

- [x] **Step 1: Write failing intake tests**

Create `packages/backend/src/workflows/session-workflow-intake.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-workflow-intake-')), 'test.db');

const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { sessionRepo, sessionMessageRepo } = await import('../repos/sessions.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { createSessionWorkflowIntake } = await import('./session-workflow-intake.js');
const { SUPERPOWERS_V2_GRAPH_VERSION } = await import('./superpowers-stage-registry.js');

test('createSessionWorkflowIntake creates task and superpowers v2 workflow for user message', () => {
  const project = projectRepo.create({ name: 'Project', path: '/tmp/project' });
  const room = roomRepo.create({ project_id: project.id, name: 'Workflow Room' });
  const session = sessionRepo.create({ project_id: project.id, title: 'Session', mode: 'code' });
  const sourceMessage = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    content: '修复 planner workflow',
    metadata: {},
  });

  const result = createSessionWorkflowIntake({
    project,
    session,
    sourceMessage,
    room,
    workspaceFileRefs: [],
    libraryFileRefs: [],
    platformSkillRefs: [],
  });

  assert.equal(taskRepo.get(result.task.id)?.source_message_id, sourceMessage.id);
  assert.equal(workflowRepo.getRun(result.workflow.id)?.graph_version, SUPERPOWERS_V2_GRAPH_VERSION);
  assert.equal(result.workflow.current_stage, 'planning');
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test packages/backend/src/workflows/session-workflow-intake.test.ts
```

Expected: FAIL because `session-workflow-intake.js` does not exist.

- [x] **Step 3: Implement session workflow intake**

Create `packages/backend/src/workflows/session-workflow-intake.ts`:

```ts
import { taskRepo } from '../repos/tasks.js';
import { workflowRepo } from '../repos/workflows.js';
import type { PlatformSkillRef, Project, Room, Session, SessionMessage } from '../types.js';
import { SUPERPOWERS_V2_GRAPH_VERSION } from './superpowers-stage-registry.js';
import { emptyAgentWorkflowState, serializeGraphState } from './graph/state.js';

interface SessionWorkflowIntakeInput {
  project: Project;
  session: Session;
  sourceMessage: SessionMessage;
  room: Room;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
  platformSkillRefs: PlatformSkillRef[];
}

export function createSessionWorkflowIntake(input: SessionWorkflowIntakeInput) {
  const task = taskRepo.create({
    room_id: input.room.id,
    project_id: input.project.id,
    title: buildIntakeTaskTitle(input.sourceMessage.content),
    description: input.sourceMessage.content,
    status: 'todo',
    priority: 'normal',
    interaction_mode: 'guided',
    assigned_agent_id: 'planner',
    source_message_id: input.sourceMessage.id,
    created_from: 'chat_plan',
  });
  const pendingState = emptyAgentWorkflowState({
    workflowRunId: 'pending',
    projectId: input.project.id,
    roomId: input.room.id,
    taskId: task.id,
    userGoal: input.sourceMessage.content,
    projectPath: input.project.path,
  });
  const workflow = workflowRepo.createRun({
    room_id: input.room.id,
    project_id: input.project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'planning',
    approval_required: true,
    graph_version: SUPERPOWERS_V2_GRAPH_VERSION,
    graph_state: serializeGraphState(pendingState),
  });
  workflowRepo.updateGraphState(workflow.id, serializeGraphState({
    ...pendingState,
    workflowRunId: workflow.id,
    activeSuperpowersStage: 'intake',
  }));
  return { task, workflow: workflowRepo.getRun(workflow.id) ?? workflow };
}

function buildIntakeTaskTitle(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 40 ? `${compact.slice(0, 40)}...` : compact || 'Session workflow';
}
```

- [x] **Step 4: Refactor session-message-dispatch away from low_risk_auto**

In `packages/backend/src/session-message-dispatch.ts`:

1. Stop calling `assessSessionMessageRisk` as the primary execution gate for implementation messages.
2. Keep approval-decision handling for existing pending approvals for compatibility.
3. Replace `riskGate.applies && shouldStartAutomaticWorkflow(...)` with `createSessionWorkflowIntake(...)`.
4. Keep ordinary non-workflow chat path only when planner intake classifies it as answer-only in later tasks. For this task, route code/development mode messages into workflow-first.
5. Run `rg -n "startAutomaticSessionWorkflow|shouldStartAutomaticWorkflow|low_risk_auto" packages/backend/src`. Delete `startAutomaticSessionWorkflow` and `shouldStartAutomaticWorkflow` when the only remaining references are their definitions and tests being updated in this task. Keep `low_risk_auto` only inside historical compatibility assertions that explicitly create old metadata.

Expected behavior: a user implementation message no longer creates `trigger: low_risk_auto` metadata.

- [x] **Step 5: Update dispatch tests**

In `packages/backend/src/session-message-dispatch.test.ts`, update tests that expect `low_risk_auto`:

- Replace expected `trigger: 'low_risk_auto'` with `activeSuperpowersStage: 'intake'` evidence or `graph_version: 'superpowers-v2'`.
- Assert no session evidence payload contains `trigger: 'low_risk_auto'` for new messages.
- Keep tests for old approval message parsing if they are about backward compatibility.

- [x] **Step 6: Run targeted tests**

```bash
node --import tsx --test packages/backend/src/workflows/session-workflow-intake.test.ts
node --import tsx --test packages/backend/src/session-message-dispatch.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 4**

```bash
git add packages/backend/src/workflows/session-workflow-intake.ts packages/backend/src/workflows/session-workflow-intake.test.ts packages/backend/src/session-message-dispatch.ts packages/backend/src/session-message-dispatch.test.ts
git commit -m "feat(session): 统一消息进入Superpowers工作流"
```

## Task 5: ACP Skill Invocation And Evidence Gate

**Files:**
- Create: `packages/backend/src/workflows/superpowers-invocation.ts`
- Create: `packages/backend/src/workflows/superpowers-invocation.test.ts`
- Modify: `packages/backend/src/workflows/prompts.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-nodes.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`

- [x] **Step 1: Write failing invocation tests**

Create `packages/backend/src/workflows/superpowers-invocation.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSuperpowersInvocationPrompt,
  parseRequiredSuperpowersEvidence,
} from './superpowers-invocation.js';

test('buildSuperpowersInvocationPrompt constrains worker not to act as planner', () => {
  const prompt = buildSuperpowersInvocationPrompt({
    stageId: 'execute',
    controller: 'worker',
    requiredSkills: ['test-driven-development'],
    roleInstruction: '你是 frontend implementer。',
    context: 'Task 2 context',
    expectedEvidence: ['tddEvidence'],
  });

  assert.match(prompt, /你不是 planner/);
  assert.match(prompt, /只执行分配给你的阶段或任务/);
  assert.match(prompt, /test-driven-development/);
  assert.match(prompt, /tddEvidence/);
});

test('parseRequiredSuperpowersEvidence reports missing evidence', () => {
  const result = parseRequiredSuperpowersEvidence('自然语言完成了', ['designDocPath']);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /missing required evidence/);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test packages/backend/src/workflows/superpowers-invocation.test.ts
```

Expected: FAIL because module does not exist.

- [x] **Step 3: Implement invocation helper**

Create `packages/backend/src/workflows/superpowers-invocation.ts`:

```ts
import { parseSuperpowersEvidence } from './graph/superpowers-evidence.js';

interface BuildInvocationPromptInput {
  stageId: string;
  controller: 'planner' | 'worker' | 'reviewer' | 'verifier' | 'user';
  requiredSkills: string[];
  roleInstruction: string;
  context: string;
  expectedEvidence: string[];
}

export function buildSuperpowersInvocationPrompt(input: BuildInvocationPromptInput): string {
  return [
    `当前 Superpowers 阶段：${input.stageId}`,
    `执行权限：${input.controller}`,
    input.roleInstruction,
    '',
    input.controller !== 'planner'
      ? '你不是 planner。不要重新设计 workflow，不要修改 approved spec/plan，只执行分配给你的阶段或任务。'
      : '你是 planner controller。你负责流程控制、artifact 修订、用户确认和子代理分配。',
    '',
    '必须遵循以下 Superpowers skills：',
    ...input.requiredSkills.map((skill) => `- ${skill}`),
    '',
    '阶段上下文：',
    input.context,
    '',
    '阶段完成时必须输出 fenced JSON evidence，至少包含：',
    ...input.expectedEvidence.map((item) => `- ${item}`),
  ].join('\n');
}

export function parseRequiredSuperpowersEvidence(output: string, requiredFields: string[]): { ok: true; evidence: Record<string, unknown> } | { ok: false; error: string } {
  const evidence = parseSuperpowersEvidence(output);
  if (!evidence) return { ok: false, error: `missing required evidence: ${requiredFields.join(', ')}` };
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(evidence, field));
  if (missing.length > 0) return { ok: false, error: `missing required evidence: ${missing.join(', ')}` };
  return { ok: true, evidence: evidence as Record<string, unknown> };
}
```

- [x] **Step 4: Integrate into superpowers nodes**

In `packages/backend/src/workflows/graph/superpowers-nodes.ts`:

1. Replace default path-only behavior in `brainstorming` and `writingPlans` with invocation path when `tools` exists.
2. Use `buildSuperpowersInvocationPrompt` with controller `planner`.
3. Create a workflow step.
4. Run planner ACP agent through `tools.runAcpAgent`.
5. Parse required evidence.
6. If evidence missing, update step failed and state blocked with `missing_required_evidence`.
7. If ACP run throws timeout error, update state `recoveryState` and status `blocked` or `awaiting_decision` according to existing status enum.

Keep no-tools fallback for pure unit tests, but mark it as deterministic test fallback.

- [x] **Step 5: Run targeted tests**

```bash
node --import tsx --test packages/backend/src/workflows/superpowers-invocation.test.ts
node --import tsx --test packages/backend/src/workflows/graph/superpowers-runtime.test.ts
node --import tsx --test packages/backend/src/workflows/prompts.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit Task 5**

```bash
git add packages/backend/src/workflows/superpowers-invocation.ts packages/backend/src/workflows/superpowers-invocation.test.ts packages/backend/src/workflows/prompts.ts packages/backend/src/workflows/graph/superpowers-nodes.ts packages/backend/src/workflows/graph/superpowers-runtime.test.ts packages/backend/src/workflows/prompts.test.ts
git commit -m "feat(workflow): 接入Superpowers阶段调用证据门禁"
```

## Task 6: Plan Confirmation And Change Requests

**Files:**
- Modify: `packages/backend/src/session.routes.ts`
- Modify: `packages/backend/src/session.routes.test.ts`
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/lib/api.ts`

- [x] **Step 1: Write failing backend workspace payload test**

In `packages/backend/src/session.routes.test.ts`, import `workflowRepo`, `workflowArtifactVersionRepo`, and `serializeGraphState`, then add a test that creates a workflow run plus a draft artifact version and expects the workspace payload to include it:

```ts
test('session workspace payload exposes workflow artifact versions and approval gate', () => {
  const project = projectRepo.create({
    name: 'artifact project',
    path: mkdtempSync(join(tmpdir(), 'session-artifacts-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Artifact Room' });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Artifact Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const sourceMessage = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    content: '实现 workflow-first',
    metadata: {},
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Artifact workflow',
    source_message_id: sourceMessage.id,
    created_from: 'chat_plan',
  });
  const workflow = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'awaiting_approval',
    current_stage: 'planning',
    approval_required: true,
    graph_version: 'superpowers-v2',
    graph_state: serializeGraphState({
      workflowRunId: '',
      projectId: project.id,
      roomId: room.id,
      taskId: task.id,
      taskTitle: task.title,
      projectPath: project.path,
      status: 'awaiting_approval',
      activeSuperpowersStage: 'writing_plans',
    }),
  });
  const draft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan',
    structured_data: { tasks: [] },
    created_by_agent_id: 'planner',
  });

  const payload = buildWorkspacePayload(project, session);
  assert.equal(payload.activeSession.workflowArtifacts?.[0]?.id, draft.id);
  assert.equal(payload.activeSession.workflowGates?.some((gate) => gate.kind === 'plan_confirm'), true);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test packages/backend/src/session.routes.test.ts --test-name-pattern "workflow artifact versions"
```

Expected: FAIL because `SessionDetail` and `buildWorkspacePayload` do not expose `workflowArtifacts` or `workflowGates`.

- [x] **Step 3: Extend types**

In backend and frontend types, add:

```ts
export interface WorkflowArtifactVersionView {
  id: string;
  workflow_run_id: string;
  artifact_type: WorkflowArtifactVersionType;
  version: number;
  status: WorkflowArtifactVersionStatus;
  title: string;
  content: string;
  structured_data: unknown;
  created_by_agent_id: string;
  change_request_message_id: string | null;
  approved_by: string | null;
  approved_at: number | null;
  created_at: number;
}

export interface WorkflowGateView {
  kind: 'spec_confirm' | 'plan_confirm' | 'finish_branch';
  workflow_run_id: string;
  artifact_version_id: string | null;
  status: 'pending' | 'approved' | 'blocked';
  reason: string;
}
```

Extend `SessionDetail` with:

```ts
workflowArtifacts?: WorkflowArtifactVersionView[];
workflowGates?: WorkflowGateView[];
```

- [x] **Step 4: Implement workspace payload exposure**

In `packages/backend/src/session.routes.ts`, update `buildSessionDetail(session)`:

1. Find tasks whose `source_message_id` belongs to a message in the session, then find workflow runs whose `task_id` is one of those task ids.
2. Load `workflowArtifactVersionRepo.listByRun(run.id)`.
3. Convert `structured_data` from JSON string to object.
4. Build gates:
   - draft spec without approved spec -> `spec_confirm` pending after review.
   - draft plan without approved plan -> `plan_confirm` pending after review.
5. Return arrays in session detail.

- [x] **Step 5: Add API confirm endpoints**

In `packages/backend/src/session.routes.ts`, add routes:

```text
POST /api/sessions/:sessionId/workflow-artifacts/:artifactVersionId/approve
```

Handler:

1. Validate artifact belongs to a workflow linked to session.
2. Call `workflowArtifactVersionRepo.approve`.
3. Update graph state approved id field based on artifact type.
4. Broadcast session update.

In `packages/frontend/src/lib/api.ts`, add:

```ts
approveWorkflowArtifactVersion: (sessionId: string, artifactVersionId: string) =>
  request<WorkflowArtifactVersionView>(`/sessions/${sessionId}/workflow-artifacts/${artifactVersionId}/approve`, { method: 'POST' }),
```

- [x] **Step 6: Run targeted tests**

```bash
node --import tsx --test packages/backend/src/session.routes.test.ts
node --import tsx --test packages/backend/src/session-types.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 6**

```bash
git add packages/backend/src/session.routes.ts packages/backend/src/session.routes.test.ts packages/backend/src/types.ts packages/frontend/src/lib/types.ts packages/frontend/src/lib/api.ts
git commit -m "feat(session): 暴露工作流产物确认门禁"
```

## Task 7: Frontend Read-only Spec/Plan Gates

**Files:**
- Modify: `packages/frontend/src/session-ui/SessionShellView.tsx`
- Modify: `packages/frontend/src/session-ui/session-os.css`
- Modify: `packages/frontend/src/session-ui/SessionShell.test.tsx`
- Modify: `packages/frontend/src/pages/SessionWorkspacePage.test.tsx`

- [ ] **Step 1: Write failing frontend render test**

In `packages/frontend/src/session-ui/SessionShell.test.tsx`, add fixture data with `workflowArtifacts` and `workflowGates`. Assert:

```ts
assert.match(container.textContent ?? '', /Plan v1/);
assert.match(container.textContent ?? '', /只读计划/);
assert.match(container.textContent ?? '', /请求 planner 修改/);
assert.match(container.textContent ?? '', /确认 plan/);
assert.doesNotMatch(container.innerHTML, /textarea/);
```

Use existing render helper in the test file.

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test packages/frontend/src/session-ui/SessionShell.test.tsx
```

Expected: FAIL because UI does not render workflow artifact gates.

- [ ] **Step 3: Implement read-only artifact panel**

In `SessionShellView.tsx`, add component:

```tsx
function WorkflowArtifactGatePanel({
  artifacts,
  gates,
  onApprove,
  onRequestChange,
}: {
  artifacts: WorkflowArtifactVersionView[];
  gates: WorkflowGateView[];
  onApprove: (artifactVersionId: string) => void;
  onRequestChange: (artifact: WorkflowArtifactVersionView) => void;
}): JSX.Element | null {
  const visible = artifacts.filter((artifact) =>
    artifact.artifact_type === 'spec' ||
    artifact.artifact_type === 'plan' ||
    artifact.artifact_type === 'lightweight_plan'
  );
  if (visible.length === 0) return null;
  return (
    <section className="deepsea-workflow-artifacts" aria-label="Workflow artifacts">
      {visible.map((artifact) => {
        const gate = gates.find((item) => item.artifact_version_id === artifact.id);
        return (
          <article key={artifact.id} className="deepsea-workflow-artifact">
            <header>
              <div>
                <strong>{artifact.title}</strong>
                <span>v{artifact.version} · {artifact.status}</span>
              </div>
              <span>只读计划</span>
            </header>
            <pre>{artifact.content}</pre>
            <div className="deepsea-workflow-artifact__actions">
              <button type="button" onClick={() => onRequestChange(artifact)}>请求 planner 修改</button>
              {gate?.status === 'pending' ? (
                <button type="button" onClick={() => onApprove(artifact.id)}>
                  确认 {artifact.artifact_type === 'spec' ? 'spec' : 'plan'}
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}
```

Wire `onRequestChange` to prefill/send a normal session message template:

```text
请修改 plan vN：
```

Do not add a direct text editor for artifact content.

- [ ] **Step 4: Add styles**

In `session-os.css`, add scoped styles:

```css
.deepsea-workflow-artifacts {
  display: grid;
  gap: 12px;
  margin: 12px 0;
}

.deepsea-workflow-artifact {
  border: 1px solid var(--deepsea-border-subtle);
  border-radius: 8px;
  padding: 12px;
  background: var(--deepsea-surface);
}

.deepsea-workflow-artifact pre {
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
}

.deepsea-workflow-artifact__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
```

Use the existing neutral session CSS variables already present in `session-os.css`: `--session-panel`, `--session-border`, `--session-muted`, and `--session-text`.

- [ ] **Step 5: Wire approve mutation**

In the component/page layer that owns API calls, call `api.approveWorkflowArtifactVersion(sessionId, artifactVersionId)` and refresh session detail. Wire “请求 planner 修改” to the existing message send handler with content prefixed by `请修改 plan vN：` or `请修改 spec vN：`; do not add a second mutation endpoint for change requests in this task.

- [ ] **Step 6: Run frontend tests**

```bash
node --import tsx --test packages/frontend/src/session-ui/SessionShell.test.tsx
node --import tsx --test packages/frontend/src/pages/SessionWorkspacePage.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add packages/frontend/src/session-ui/SessionShellView.tsx packages/frontend/src/session-ui/session-os.css packages/frontend/src/session-ui/SessionShell.test.tsx packages/frontend/src/pages/SessionWorkspacePage.test.tsx
git commit -m "feat(frontend): 展示只读工作流产物确认门禁"
```

## Task 8: Runtime Dispatch Uses Approved Plan And Assignments

**Files:**
- Modify: `packages/backend/src/workflows/graph/superpowers-nodes.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.test.ts`
- Modify: `packages/backend/src/workflows/graph/execute.test.ts`

- [ ] **Step 1: Write failing runtime test**

In `packages/backend/src/workflows/graph/runtime.test.ts`, add a test:

```ts
test('Superpowers v2 dispatch blocks without approved plan artifact version', async () => {
  const run = createSuperpowersV2TestRunWithoutApprovedPlan();
  const result = await continueGraphWorkflow(run.id, {
    runAcpAgent: fakeRunAcpAgent,
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.error ?? '', /approved plan/i);
});
```

Add a local helper named `createSuperpowersV2TestRunWithoutApprovedPlan()` in `runtime.test.ts` near the existing helper functions. It must create `project`, `room`, and `task` with `projectRepo`, `roomRepo`, and `taskRepo`, then call `createGraphWorkflowRun(task.id)`, update its graph state with `createRunnableSuperpowersState(run.id, project.id, room.id, task.id, task.title, project.path)`, set `activeSuperpowersStage: 'subagent_driven_development'`, and intentionally leave `approvedPlanArtifactVersionId` unset.

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test packages/backend/src/workflows/graph/runtime.test.ts --test-name-pattern "approved plan artifact"
```

Expected: FAIL because dispatch still relies on parsed `state.plan` or existing behavior.

- [ ] **Step 3: Enforce approved artifact in dispatch**

In `superpowers-nodes.ts` or runtime routing before dispatch:

1. Load approved `plan` or `lightweight_plan` artifact version for run.
2. If missing, block with `Superpowers dispatch requires approved plan artifact version`.
3. Parse structured data for tasks.
4. Use `agentAssignments` from state or regenerate through `agent-assignment.ts`.
5. Ensure no worker prompt can modify approved artifact.

- [ ] **Step 4: Ensure reviewer/verifier separation**

In dispatch/review node:

1. When selecting reviewer/verifier, exclude implementer agent id for same task if another reviewer/verifier exists.
2. If only fullstack exists, block with `needs_agent_assignment` for review rather than self-reviewing execution work.

- [ ] **Step 5: Run graph tests**

```bash
node --import tsx --test packages/backend/src/workflows/graph/runtime.test.ts
node --import tsx --test packages/backend/src/workflows/graph/execute.test.ts
node --import tsx --test packages/backend/src/workflows/graph/review.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add packages/backend/src/workflows/graph/superpowers-nodes.ts packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/runtime.test.ts packages/backend/src/workflows/graph/execute.test.ts packages/backend/src/workflows/graph/review.test.ts
git commit -m "feat(workflow): 执行阶段只消费已确认计划"
```

## Task 9: Final Integration Verification

**Files:**
- No production file changes expected. Test edits are limited to exact assertion-name or fixture-shape adjustments caused by Tasks 1-8, and each test diff must preserve the same behavior being asserted.

- [ ] **Step 1: Run backend targeted suite**

```bash
node --import tsx --test packages/backend/src/workflows/artifact-versions.test.ts
node --import tsx --test packages/backend/src/workflows/superpowers-stage-registry.test.ts
node --import tsx --test packages/backend/src/workflows/fullstack-engineer.test.ts
node --import tsx --test packages/backend/src/workflows/agent-assignment.test.ts
node --import tsx --test packages/backend/src/workflows/superpowers-invocation.test.ts
node --import tsx --test packages/backend/src/workflows/session-workflow-intake.test.ts
node --import tsx --test packages/backend/src/session-message-dispatch.test.ts
node --import tsx --test packages/backend/src/session-workspace-view-model.test.ts
node --import tsx --test packages/backend/src/workflows/graph/superpowers-runtime.test.ts
node --import tsx --test packages/backend/src/workflows/graph/runtime.test.ts
```

Expected: all listed tests PASS.

- [ ] **Step 2: Run frontend targeted suite**

```bash
node --import tsx --test packages/frontend/src/session-ui/SessionShell.test.tsx
node --import tsx --test packages/frontend/src/pages/SessionWorkspacePage.test.tsx
```

Expected: both tests PASS.

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: TypeScript compilation and frontend build complete with exit 0.

- [ ] **Step 4: Completion verification audit**

Use `superpowers:verification-before-completion`. Check requirements from `docs/superpowers/specs/2026-06-12-Planner控制的Superpowers工作流设计.md`:

1. Session messages no longer use `low_risk_auto`.
2. Superpowers graph version for new workflow runs is `superpowers-v2`.
3. spec/plan artifacts are versioned and read-only to users.
4. User change request creates a new planner-owned version.
5. approved artifact is required before dispatch.
6. global agent assignment prefers specialist.
7. fullstack-engineer fallback works.
8. worker/reviewer/verifier cannot mutate approved plan.
9. missing evidence blocks workflow.
10. targeted tests and build pass.

- [ ] **Step 5: Final code review**

Use `superpowers:requesting-code-review` for the full branch diff:

```bash
BASE_SHA=$(git rev-parse HEAD~9)
HEAD_SHA=$(git rev-parse HEAD)
```

Dispatch reviewer with:

- Description: Planner 控制的 Superpowers workflow-first 改造。
- Requirements: this implementation plan and the design spec.
- Base SHA and HEAD SHA from commands above.

Fix Critical and Important findings before completing.

- [ ] **Step 6: Commit verification fixes if any**

If review or verification required fixes:

```bash
git add <changed-files>
git commit -m "fix(workflow): 修复Superpowers工作流收尾问题"
```

If no changes were needed, do not create an empty commit.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-12-Planner控制的Superpowers工作流实施计划.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
