# Superpowers C 原生强门禁集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一所有新任务只进入 Superpowers C 原生强门禁 runtime，历史默认/自定义工作流仅保留只读兼容展示。

**Architecture:** 仅保留内置且唯一可用的 `superpowers-development` workflow definition，并扩展 workflow definition 类型、graph state、Superpowers 专属节点和 UI 展示。后端新任务启动时固定进入 Superpowers runtime；旧 definition 和历史 run 仅保留只读兼容展示，不再参与新任务选择。

**Tech Stack:** TypeScript, Node.js, Express, SQLite, LangGraph, React 18, Vite, Tailwind, node:test.

---

## File Structure

后端：

- Modify: `packages/backend/src/types.ts` - 扩展 workflow node、state 相关类型。
- Modify: `packages/backend/src/repos/workflow-definitions.ts` - 新增 Superpowers 内置 definition、validator 支持、metadata 支持。
- Modify: `packages/backend/src/workflows/graph/state.ts` - 新增 Superpowers state schema。
- Modify: `packages/backend/src/workflows/graph/runtime.ts` - 新任务固定进入 Superpowers runtime。
- Create: `packages/backend/src/workflows/graph/superpowers-runtime.ts` - Superpowers runtime graph 构建。
- Create: `packages/backend/src/workflows/graph/superpowers-nodes.ts` - Superpowers 专属节点实现。
- Create: `packages/backend/src/workflows/graph/superpowers-gates.ts` - 门禁检查和状态更新纯函数。
- Create: `packages/backend/src/workflows/superpowers-skills.ts` - 内置 Superpowers skill 名称、阶段映射和 prompt 注入辅助。
- Modify: `packages/backend/src/workflows/prompts.ts` - 增加 Superpowers 阶段 prompt。
- Modify: `packages/backend/src/workflows/agent-provisioning.ts` - 将 Superpowers subagent 角色映射到当前房间智能体。
- Modify: `packages/backend/src/workflows/graph/coordinator-agents.ts` - 按 Superpowers prompt template 选择 implementer/reviewer。
- Modify: `packages/backend/src/routes.ts` - 禁用自定义 workflow CRUD 和默认 workflow 设置入口。
- Modify: `packages/backend/src/repos/settings.ts` - 新任务忽略 `default_workflow_definition_id`。
- Test: `packages/backend/src/repos/workflow-definitions.test.ts`
- Test: `packages/backend/src/workflow-definitions.routes.test.ts`
- Test: `packages/backend/src/repos/settings.test.ts`
- Test: `packages/backend/src/workflows/graph/runtime.test.ts`
- Test: `packages/backend/src/workflows/graph/state.test.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-gates.test.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`
- Test: `packages/backend/src/workflows/graph/coordinator-agents.test.ts`

前端：

- Modify: `packages/frontend/src/lib/types.ts` - 同步 workflow node 和 Superpowers state 类型。
- Modify: `packages/frontend/src/components/WorkflowTaskFlow.tsx` - 展示 Superpowers 阶段。
- Modify: `packages/frontend/src/components/WorkflowTaskBubble.tsx` - 展示 TDD/review/verification/finish branch 证据摘要。
- Modify: `packages/frontend/src/pages/WorkflowOverflowPage.tsx` - 移除自定义 workflow 管理入口，展示 Superpowers 只读说明。
- Modify: `packages/frontend/src/components/SettingsDialogs.tsx` - 移除默认 workflow 选择。
- Test: `packages/frontend/src/components/WorkflowTaskBubble.test.tsx`

文档：

- Modify: `docs/superpowers/specs/2026-05-20-Superpowers-C原生强门禁集成设计.md`
- Modify: `docs/superpowers/plans/2026-05-20-Superpowers-C原生强门禁集成实施计划.md`

## Task 1: 扩展 Workflow 类型和 Superpowers Definition

**Files:**
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/backend/src/repos/workflow-definitions.ts`
- Test: `packages/backend/src/repos/workflow-definitions.test.ts`

- [ ] **Step 1: Write failing backend tests for Superpowers definition**

Add tests that assert:

```ts
const superpowers = workflowDefinitionRepo.getBuiltInByKey('superpowers-development');
assert.ok(superpowers);
assert.equal(superpowers.name, 'Superpowers 开发闭环');
assert.ok(superpowers.definition.nodes.some((node) => node.type === 'brainstorming'));
assert.ok(superpowers.definition.nodes.some((node) => node.type === 'tdd_execute'));
assert.ok(superpowers.definition.nodes.some((node) => node.type === 'finish_branch'));
assert.equal(superpowers.status, 'published');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace packages/backend test -- workflow-definitions`

Expected: FAIL because `superpowers-development` does not exist and node types are invalid.

- [ ] **Step 3: Extend node type unions**

Update backend and frontend unions with:

```ts
| 'brainstorming'
| 'spec_review'
| 'worktree'
| 'writing_plans'
| 'plan_review'
| 'tdd_execute'
| 'spec_compliance_review'
| 'code_quality_review'
| 'finish_branch'
```

- [ ] **Step 4: Add optional metadata to definition types**

Add optional metadata fields:

```ts
metadata?: {
  runtime_profile?: 'superpowers';
  required_skill_names?: string[];
  gate_policy?: string;
} | null;
```

If existing style prefers narrower interfaces, define `WorkflowDefinitionNodeMetadata` and `WorkflowDefinitionGraphMetadata`.

- [ ] **Step 5: Add built-in Superpowers graph**

In `workflow-definitions.ts`, add `BUILTIN_SUPERPOWERS_KEY = 'superpowers-development'` and a `SUPERPOWERS_DEFINITION` graph containing the stages from the design doc.

- [ ] **Step 6: Ensure built-in definitions creates Superpowers definition**

Update `ensureBuiltInDefinitions()` to create Superpowers. Existing historical definitions may remain in the database, but new startup/default selection must use Superpowers.

- [ ] **Step 7: Run backend test to verify pass**

Run: `npm --workspace packages/backend test -- workflow-definitions`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/types.ts packages/frontend/src/lib/types.ts packages/backend/src/repos/workflow-definitions.ts packages/backend/src/repos/workflow-definitions.test.ts
git commit -m "feat(workflow): 新增Superpowers内置定义"
```

## Task 2: Add Superpowers State and Gate Helpers

**Files:**
- Modify: `packages/backend/src/workflows/graph/state.ts`
- Create: `packages/backend/src/workflows/graph/superpowers-gates.ts`
- Test: `packages/backend/src/workflows/graph/state.test.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-gates.test.ts`

- [ ] **Step 1: Write failing state parse test**

Add a test that serializes and parses state with:

```ts
runtimeProfile: 'superpowers',
superpowersPhase: 'brainstorming',
designDocPath: 'docs/superpowers/specs/example.md',
implementationPlanPath: null,
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace packages/backend test -- graph/state`

Expected: FAIL because schema strips or rejects Superpowers fields.

- [ ] **Step 3: Extend schema**

Add schemas for:

```ts
runtimeProfile: z.literal('superpowers').default('superpowers')
superpowersPhase: z.string().nullable().default(null)
designDocPath: z.string().nullable().default(null)
designReviewVerdict: z.enum(['pending', 'approved', 'changes_requested', 'failed']).nullable().default(null)
implementationPlanPath: z.string().nullable().default(null)
planReviewVerdict: z.enum(['pending', 'approved', 'changes_requested', 'failed']).nullable().default(null)
worktree: z.object({...}).nullable().default(null)
tddEvidence: z.array(...).default([])
specComplianceReview: z.object({...}).nullable().default(null)
codeQualityReview: z.object({...}).nullable().default(null)
verificationEvidence: z.array(...).default([])
finishBranchDecision: z.object({...}).nullable().default(null)
```

Keep fields minimal but typed.

- [ ] **Step 4: Write failing gate helper tests**

Create tests for:

```ts
assert.equal(canLeaveBrainstorming({ designDocPath: null }), false);
assert.equal(canLeaveBrainstorming({ designDocPath: 'docs/x.md', designReviewVerdict: 'approved' }), true);
assert.equal(canLeaveWritingPlans({ implementationPlanPath: null }), false);
assert.equal(canLeaveVerify({ verificationEvidence: [] }), false);
```

- [ ] **Step 5: Implement gate helpers**

Create pure functions in `superpowers-gates.ts`:

```ts
export function canLeaveBrainstorming(state: AgentWorkflowState): boolean;
export function canLeaveWritingPlans(state: AgentWorkflowState): boolean;
export function canLeaveTddExecute(state: AgentWorkflowState): boolean;
export function canLeaveVerify(state: AgentWorkflowState): boolean;
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm --workspace packages/backend test -- graph/state
npm --workspace packages/backend test -- superpowers-gates
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/workflows/graph/state.ts packages/backend/src/workflows/graph/state.test.ts packages/backend/src/workflows/graph/superpowers-gates.ts packages/backend/src/workflows/graph/superpowers-gates.test.ts
git commit -m "feat(workflow): 增加Superpowers门禁状态"
```

## Task 3: 固定 Superpowers Runtime 入口

**Files:**
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Create: `packages/backend/src/workflows/graph/superpowers-runtime.ts`
- Test: `packages/backend/src/workflows/graph/runtime.test.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`

- [ ] **Step 1: Write failing runtime entry test**

Add a test that starts a workflow without selecting any definition, then assert run snapshot uses `superpowers-development` and graph version/profile indicates Superpowers.

- [ ] **Step 2: Run test to verify fail**

Run: `npm --workspace packages/backend test -- graph/runtime`

Expected: FAIL because runtime still uses the current selected/default workflow definition path.

- [ ] **Step 3: Stop using supervisor for workflow definition selection**

Remove or bypass the `visible definitions -> supervisor decision -> selected definition` path for new workflow runs. Supervisor can remain for assignment/recovery, but not workflow selection.

- [ ] **Step 4: Always resolve Superpowers definition**

Update `resolveWorkflowDefinitionForTask()` or its replacement so it returns `superpowers-development` for every new implementation workflow.

- [ ] **Step 5: Add `buildSuperpowersRuntimeGraph` placeholder**

Create `superpowers-runtime.ts` that initially wires the same base nodes plus distinct Superpowers nodes as no-op completed steps where necessary. This task only proves routing/profile selection; later tasks add full gate behavior.

- [ ] **Step 6: Use Superpowers graph for new runs**

In `continueGraphWorkflow` or the graph construction point, call `buildSuperpowersRuntimeGraph()` for new runs. Historical run display is not changed in this task.

- [ ] **Step 7: Run tests**

Run: `npm --workspace packages/backend test -- graph/runtime superpowers-runtime`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/runtime.test.ts packages/backend/src/workflows/graph/superpowers-runtime.ts packages/backend/src/workflows/graph/superpowers-runtime.test.ts
git commit -m "feat(workflow): 固定使用Superpowers运行图"
```

## Task 4: 禁用自定义 Workflow 与默认选择

**Files:**
- Modify: `packages/backend/src/routes.ts`
- Modify: `packages/backend/src/repos/settings.ts`
- Modify: `packages/backend/src/repos/workflow-definitions.ts`
- Test: `packages/backend/src/workflow-definitions.routes.test.ts`
- Test: `packages/backend/src/repos/settings.test.ts`

- [ ] **Step 1: Write failing route tests**

Assert:

```ts
assert.equal((await request('/api/workflow-definitions', { method: 'POST', body })).status, 410);
assert.equal((await request(`/api/workflow-definitions/${id}/duplicate`, { method: 'POST' })).status, 410);
assert.equal((await request(`/api/workflow-definitions/${id}/publish`, { method: 'POST' })).status, 410);
assert.equal((await request(`/api/workflow-definitions/${id}/archive`, { method: 'POST' })).status, 410);
```

- [ ] **Step 2: Run test to verify fail**

Run: `npm --workspace packages/backend test -- workflow-definitions.routes settings`

Expected: FAIL because routes still allow custom workflow CRUD and settings still expose defaults.

- [ ] **Step 3: Disable custom workflow mutation routes**

Return `410 Gone` with message `custom workflow definitions have been replaced by Superpowers-C`.

- [ ] **Step 4: Restrict list routes**

For new selection APIs, return only `superpowers-development`. If an endpoint is used for history, document and keep it read-only.

- [ ] **Step 5: Ignore default workflow settings for new runs**

Keep the database field for migration safety, but make resolution return Superpowers for effective new workflow behavior.

- [ ] **Step 6: Run backend tests**

Run: `npm --workspace packages/backend test -- workflow-definitions.routes settings`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/routes.ts packages/backend/src/repos/settings.ts packages/backend/src/repos/workflow-definitions.ts packages/backend/src/workflow-definitions.routes.test.ts packages/backend/src/repos/settings.test.ts
git commit -m "feat(workflow): 禁用自定义工作流入口"
```

## Task 5: Superpowers Skills Mapping and Prompt Injection

**Files:**
- Create: `packages/backend/src/workflows/superpowers-skills.ts`
- Modify: `packages/backend/src/workflows/prompts.ts`
- Test: `packages/backend/src/workflows/prompts.test.ts`

- [ ] **Step 1: Write failing prompt test**

Assert Superpowers brainstorming prompt includes the active skill names `brainstorming` and `using-superpowers` when called for the brainstorming phase.

- [ ] **Step 2: Run test to verify fail**

Run: `npm --workspace packages/backend test -- workflows/prompts`

Expected: FAIL because prompt kind/stage does not exist.

- [ ] **Step 3: Add skill mapping**

Create:

```ts
export const SUPERPOWERS_CORE_SKILL_NAMES = [...]
export const SUPERPOWERS_PHASE_SKILLS: Record<string, string[]> = {
  brainstorming: ['using-superpowers', 'brainstorming'],
  worktree: ['using-git-worktrees'],
  writing_plans: ['writing-plans'],
  tdd_execute: ['test-driven-development', 'subagent-driven-development'],
  spec_compliance_review: ['requesting-code-review'],
  code_quality_review: ['requesting-code-review'],
  verify: ['verification-before-completion'],
  finish_branch: ['finishing-a-development-branch'],
}
```

- [ ] **Step 4: Add prompt builder support**

Extend prompt functions to support Superpowers phase prompts without breaking existing stage prompts.

- [ ] **Step 5: Run prompt tests**

Run: `npm --workspace packages/backend test -- workflows/prompts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/workflows/superpowers-skills.ts packages/backend/src/workflows/prompts.ts packages/backend/src/workflows/prompts.test.ts
git commit -m "feat(workflow): 接入Superpowers阶段技能提示"
```

## Task 6: Brainstorming and Planning Gate Nodes

**Files:**
- Create: `packages/backend/src/workflows/graph/superpowers-nodes.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-runtime.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`

- [ ] **Step 1: Write failing tests for phase steps**

Test that Superpowers run creates workflow steps with node names:

```ts
brainstorming
spec_review
worktree
writing_plans
plan_review
```

and blocks before dispatch when `implementationPlanPath` is missing.

- [ ] **Step 2: Run test to verify fail**

Run: `npm --workspace packages/backend test -- superpowers-runtime`

Expected: FAIL because nodes are placeholders or missing.

- [ ] **Step 3: Implement brainstorming node**

Create step, call planner/agent prompt as current planning node does, create design artifact or record blocked state if no design can be produced.

- [ ] **Step 4: Implement spec review node**

Use reviewer agent/prompt or deterministic self-review placeholder for first iteration. Record `designReviewVerdict`.

- [ ] **Step 5: Implement worktree node**

Record detected worktree status. Do not create destructive branch behavior in this task; record `skipped` with reason when environment handling is not implemented.

- [ ] **Step 6: Implement writing plans node**

Generate implementation plan artifact and set `implementationPlanPath` or block.

- [ ] **Step 7: Implement plan review node**

Record `planReviewVerdict` and gate dispatch.

- [ ] **Step 8: Run tests**

Run: `npm --workspace packages/backend test -- superpowers-runtime`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/backend/src/workflows/graph/superpowers-nodes.ts packages/backend/src/workflows/graph/superpowers-runtime.ts packages/backend/src/workflows/graph/superpowers-runtime.test.ts
git commit -m "feat(workflow): 实现Superpowers规划门禁"
```

## Task 7: TDD Execute and Two-Stage Review

**Files:**
- Modify: `packages/backend/src/workflows/graph/superpowers-nodes.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-runtime.ts`
- Modify: `packages/backend/src/workflows/agent-provisioning.ts`
- Modify: `packages/backend/src/workflows/graph/coordinator-agents.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`
- Test: `packages/backend/src/workflows/graph/coordinator-agents.test.ts`

- [ ] **Step 1: Write failing test for TDD evidence gate**

Assert Superpowers run cannot leave `tdd_execute` unless `tddEvidence` contains RED and GREEN records for implementation tasks, or an explicit exemption.

- [ ] **Step 2: Write failing subagent mapping test**

Assert Superpowers implementer/spec reviewer/code quality reviewer assignments use current room `RoomAgent` records and create normal child tasks / `agent_runs`; assert no independent Superpowers agent runtime or `superpowers:*` named agent is created.

- [ ] **Step 3: Run test to verify fail**

Run: `npm --workspace packages/backend test -- superpowers-runtime coordinator-agents`

Expected: FAIL because TDD gate and Superpowers subagent mapping do not exist.

- [ ] **Step 4: Implement tdd execute node**

Reuse current child task execution mechanics, but augment prompt and state updates so completed child tasks produce `tddEvidence` entries.

- [ ] **Step 5: Implement subagent mapping**

Map Superpowers subagent roles as:

```text
implementer -> current room executor RoomAgent
spec reviewer -> current room reviewer RoomAgent + spec-reviewer prompt template
code quality reviewer -> current room reviewer RoomAgent + code-reviewer prompt template
```

If required role is missing, call `ensureWorkflowAgentsForRun()` to add the existing built-in template agent. Store template path/version in workflow metadata.

- [ ] **Step 6: Implement spec compliance review node**

Review implementation against design and plan. If `changes_requested`, route back to `tdd_execute`.

- [ ] **Step 7: Implement code quality review node**

Review bug/regression/verification risk. Critical or important issues route back to `tdd_execute`.

- [ ] **Step 8: Update agent provisioning**

Ensure reviewer exists for Superpowers review stages. Reuse existing reviewer template and prompt templates; do not add `superpowers:code-reviewer`.

- [ ] **Step 9: Run tests**

Run: `npm --workspace packages/backend test -- superpowers-runtime coordinator-agents`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/backend/src/workflows/graph/superpowers-nodes.ts packages/backend/src/workflows/graph/superpowers-runtime.ts packages/backend/src/workflows/agent-provisioning.ts packages/backend/src/workflows/graph/coordinator-agents.ts packages/backend/src/workflows/graph/superpowers-runtime.test.ts packages/backend/src/workflows/graph/coordinator-agents.test.ts
git commit -m "feat(workflow): 增加TDD执行与双阶段审查"
```

## Task 8: Verification and Finish Branch Gates

**Files:**
- Modify: `packages/backend/src/workflows/graph/superpowers-nodes.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-runtime.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`
- Test: `packages/backend/src/workflows/graph/verification.test.ts`

- [ ] **Step 1: Write failing verification freshness test**

Assert Superpowers verify node records fresh command output in `verificationEvidence` and blocks when required verification fails.

- [ ] **Step 2: Run test to verify fail**

Run: `npm --workspace packages/backend test -- superpowers-runtime graph/verification`

Expected: FAIL because verification evidence is not Superpowers-aware.

- [ ] **Step 3: Implement verify evidence mapping**

Reuse existing `runVerificationCommand`; mirror results into `verificationEvidence`.

- [ ] **Step 4: Implement finish branch node**

Record available options:

```ts
['merge_local', 'create_pr', 'keep_branch', 'discard_work']
```

If no user decision support exists yet, default to `keep_branch` with reason `awaiting explicit closeout automation`.

- [ ] **Step 5: Route to acceptance only after finish branch decision**

Gate acceptance on `finishBranchDecision`.

- [ ] **Step 6: Run tests**

Run: `npm --workspace packages/backend test -- superpowers-runtime graph/verification`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/workflows/graph/superpowers-nodes.ts packages/backend/src/workflows/graph/superpowers-runtime.ts packages/backend/src/workflows/graph/superpowers-runtime.test.ts packages/backend/src/workflows/graph/verification.test.ts
git commit -m "feat(workflow): 增加验证与分支收口门禁"
```

## Task 9: Frontend Superpowers Visualization

**Files:**
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/components/WorkflowTaskFlow.tsx`
- Modify: `packages/frontend/src/components/WorkflowTaskBubble.tsx`
- Modify: `packages/frontend/src/pages/WorkflowOverflowPage.tsx`
- Modify: `packages/frontend/src/components/SettingsDialogs.tsx`
- Test: `packages/frontend/src/components/WorkflowTaskBubble.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Add assertions that a workflow bubble with Superpowers metadata renders:

- current gate name
- design doc path
- TDD evidence count
- review findings
- verification evidence
- finish branch decision

- [ ] **Step 2: Run test to verify fail**

Run: `npm --workspace packages/frontend test -- WorkflowTaskBubble`

Expected: FAIL because UI does not render Superpowers metadata.

- [ ] **Step 3: Sync frontend types**

Add Superpowers state/evidence types matching backend JSON shape.

- [ ] **Step 4: Render Superpowers evidence in task bubble**

Add compact sections using existing styling.

- [ ] **Step 5: Render Superpowers stages in task flow**

Ensure new node names map to labels and stages without layout breakage.

- [ ] **Step 6: Remove custom workflow and default selection UI**

Remove workflow builder actions, custom workflow mutation actions, and default workflow selectors from settings. Keep a read-only Superpowers process view and historical run display.

- [ ] **Step 7: Run frontend tests**

Run: `npm --workspace packages/frontend test -- WorkflowTaskBubble`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/lib/types.ts packages/frontend/src/components/WorkflowTaskFlow.tsx packages/frontend/src/components/WorkflowTaskBubble.tsx packages/frontend/src/pages/WorkflowOverflowPage.tsx packages/frontend/src/components/SettingsDialogs.tsx packages/frontend/src/components/WorkflowTaskBubble.test.tsx
git commit -m "feat(frontend): 展示Superpowers门禁状态"
```

## Task 10: Integration Verification and Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-05-20-Superpowers-C原生强门禁集成设计.md`
- Modify: `docs/superpowers/plans/2026-05-20-Superpowers-C原生强门禁集成实施计划.md`
- Create: `docs/superpowers/verification/2026-05-20-Superpowers-C原生强门禁集成验收.md`

- [ ] **Step 1: Run backend targeted tests**

Run:

```bash
npm --workspace packages/backend test -- workflow-definitions workflow-definitions.routes settings graph/state superpowers-gates superpowers-runtime graph/runtime graph/verification workflows/prompts coordinator-agents
```

Expected: PASS.

- [ ] **Step 2: Run frontend targeted tests**

Run:

```bash
npm --workspace packages/frontend test -- WorkflowTaskBubble
```

Expected: PASS.

- [ ] **Step 3: Run full build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Run full browser test**

After code implementation is finished, run a full browser test to verify:

- workflow page rendering
- task bubble rendering
- status transitions
- review / verification / finish branch display

Expected: PASS.

- [ ] **Step 5: Write verification doc**

Create verification report with command outputs, skipped checks, and residual risks.

- [ ] **Step 6: Update plan checkboxes**

Mark completed tasks in this plan.

- [ ] **Step 7: Final code review**

Use `superpowers:requesting-code-review` for the full implementation. Fix Critical and Important findings.

- [ ] **Step 8: Commit verification docs**

```bash
git add docs/superpowers/specs/2026-05-20-Superpowers-C原生强门禁集成设计.md docs/superpowers/plans/2026-05-20-Superpowers-C原生强门禁集成实施计划.md docs/superpowers/verification/2026-05-20-Superpowers-C原生强门禁集成验收.md
git commit -m "docs(superpowers): 补充原生强门禁验收"
```

## Execution Notes

- Use `superpowers:test-driven-development` for Tasks 1 through 8 because they change behavior.
- Use `superpowers:systematic-debugging` before fixing any failing test that is not immediately explained by the current task.
- Use `superpowers:verification-before-completion` before claiming completion.
- Do not overwrite unrelated dirty work in the current worktree.
- If implementation is split across agents, keep write scopes disjoint: backend types/definitions, backend runtime/nodes, frontend visualization, docs.
- Treat Superpowers subagents as OpenDeepSea room agents with Superpowers prompt templates. Do not create a separate Superpowers agent runtime or named `superpowers:*` agents.
