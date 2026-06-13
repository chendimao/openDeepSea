# 全流程 Workflow-first 多意图路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 session 用户消息统一纳入 planner 控制的 Superpowers workflow-first 多意图路由，并补齐 answer、analysis、lightweight、standard、debug、review、assignment、worktree、finish branch 的可执行闭环。

**Architecture:** 先扩展 graph 类型、state 和 artifact 协议，再把 `superpowers-stage-registry.ts` 编译为 executable route graph。随后将 session 入口从 risk gate 分流改为全 workflow intake，并逐步接入 answer、analysis、lightweight、标准开发、debug、review-only、agent assignment、change request、worktree 和 finish branch。

**Tech Stack:** TypeScript, Node.js `node --import tsx --test`, Express routes, SQLite repositories, React 18, Vite, existing OpenDeepSea workflow graph runtime.

---

## File Structure

### Backend Workflow Core

- Modify: `packages/backend/src/types.ts`
  - Extend workflow node types and artifact version types.
  - Add session view types for workflow controller and agent assignment display.
- Modify: `packages/backend/src/workflows/graph/state.ts`
  - Add route graph state fields: selected intent, selected path, routing artifact, analysis artifact, assignment artifact, change request, worktree decision.
  - Add graph node names for `intake`, `route_skills`, `answer`, `analysis_plan`, `lightweight_plan`, `agent_assignment`, `debug_plan_confirm`, `systematic_debugging`, `review_plan`, `reviewer_assignment`.
- Modify: `packages/backend/src/workflows/superpowers-stage-registry.ts`
  - Keep registry as canonical stage source.
  - Add helper functions for stage-to-node conversion and allowed route conditions.
- Create: `packages/backend/src/workflows/graph/superpowers-route-compiler.ts`
  - Compile stage registry into executable `WorkflowDefinitionGraph`.
  - Keep standard path and alternate paths declarative.
- Create: `packages/backend/src/workflows/graph/superpowers-routing-nodes.ts`
  - Implement `intake`, `route_skills`, `answer`, `analysis_plan`, `lightweight_plan`, `debug_plan`, `review_plan`, `agent_assignment` node behavior.
- Modify: `packages/backend/src/workflows/graph/superpowers-runtime.ts`
  - Use compiled route graph instead of the current linear definition.
  - Register new route node groups.
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
  - Support new Superpowers node names in `WorkflowRouteNode`, route mapping, and resume dispatch.
  - Route by `selectedIntent` and selected path instead of hardcoded linear path.
- Modify: `packages/backend/src/workflows/graph/superpowers-nodes.ts`
  - Keep existing brainstorming/writing_plans/review/finish logic.
  - Replace placeholder worktree and finish-branch decisions in later tasks.

### Backend Session Entry And Artifacts

- Modify: `packages/backend/src/session-message-dispatch.ts`
  - Route all normal session messages into workflow-first intake.
  - Keep confirmation and artifact change request handling before intake.
  - Remove `riskGate.applies` as the primary execution gate.
- Modify: `packages/backend/src/workflows/session-workflow-intake.ts`
  - Initialize new state fields and start at `intake`.
  - Preserve file refs and skill refs in state or routing context.
- Modify: `packages/backend/src/session.routes.ts`
  - Expose workflow controller state and assignment artifact in session payload.
  - Approve assignment artifacts if the final design keeps assignment confirmation separate from plan confirmation.
- Modify: `packages/backend/src/repos/workflows.ts`
  - Reuse existing artifact version repo methods.
  - Add helper queries only if tests show repeated artifact filtering logic.

### Backend Agent Assignment And Change Requests

- Modify: `packages/backend/src/workflows/agent-assignment.ts`
  - Convert global agents and room agents into explicit assignment decisions.
  - Keep fullstack fallback for executor only.
- Modify: `packages/backend/src/workflows/agent-provisioning.ts`
  - Ensure `fullstack-engineer` executor fallback remains available.
  - Do not provision fullstack as reviewer/verifier fallback.
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
  - Freeze approved assignment snapshot at dispatch.
  - Detect worker scope/plan change request events and pause execution.
- Modify: `packages/backend/src/workflows/graph/agent-events.ts`
  - Normalize structured `scope_change_request` and `plan_change_request` events.

### Frontend

- Modify: `packages/frontend/src/lib/types.ts`
  - Mirror backend workflow artifact types, controller state, assignment view types.
- Modify: `packages/frontend/src/session-ui/SessionShellView.tsx`
  - Add Workflow Controller Panel.
  - Add Agent Assignment Table.
  - Add Change Request Panel.
  - Keep spec/plan/lightweight_plan read-only.
- Modify: `packages/frontend/src/session-ui/session-os.css`
  - Style compact operational panels.
- Modify: `packages/frontend/src/pages/SessionWorkspacePage.tsx`
  - Wire approve/request-change mutations and optimistic updates for new views.

### Tests

- Modify/Create backend tests:
  - `packages/backend/src/workflows/graph/state.test.ts`
  - `packages/backend/src/workflows/superpowers-stage-registry.test.ts`
  - `packages/backend/src/workflows/graph/superpowers-route-compiler.test.ts`
  - `packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts`
  - `packages/backend/src/workflows/session-workflow-intake.test.ts`
  - `packages/backend/src/session-message-dispatch.test.ts`
  - `packages/backend/src/workflows/graph/runtime.test.ts`
  - `packages/backend/src/session.routes.test.ts`
- Modify/Create frontend tests:
  - `packages/frontend/src/session-ui/SessionShell.test.tsx`
  - `packages/frontend/src/pages/SessionWorkspacePage.test.tsx`

---

## Task 1: Route State, Node Types, And Artifact Types

**Files:**
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/backend/src/workflows/graph/state.ts`
- Test: `packages/backend/src/workflows/graph/state.test.ts`

- [x] **Step 1: Write failing backend state schema test**

Add this test to `packages/backend/src/workflows/graph/state.test.ts`:

```ts
test('agentWorkflowStateSchema preserves Superpowers routing fields', () => {
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-route-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '解释这个模块',
    projectPath: '/tmp/project',
  });

  const parsed = parseGraphState(serializeGraphState({
    ...state,
    currentNode: 'route_skills',
    selectedIntent: 'answer',
    selectedPath: ['intake', 'route_skills', 'answer'],
    routingArtifactVersionId: 'artifact-routing-1',
    analysisArtifactVersionId: 'artifact-analysis-1',
    agentAssignmentArtifactVersionId: 'artifact-assignment-1',
    approvedAgentAssignmentArtifactVersionId: 'artifact-assignment-approved-1',
    activeChangeRequestId: 'change-request-1',
    worktreeDecision: {
      action: 'skip',
      path: null,
      branchName: null,
      reason: '用户要求在当前工作区执行',
    },
  }));

  assert.equal(parsed?.currentNode, 'route_skills');
  assert.equal(parsed?.selectedIntent, 'answer');
  assert.deepEqual(parsed?.selectedPath, ['intake', 'route_skills', 'answer']);
  assert.equal(parsed?.routingArtifactVersionId, 'artifact-routing-1');
  assert.equal(parsed?.worktreeDecision?.action, 'skip');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/state.test.ts
```

Expected: FAIL with a Zod enum or property mismatch for `route_skills`, `selectedIntent`, or `worktreeDecision`.

- [x] **Step 3: Extend backend workflow node and artifact types**

In `packages/backend/src/types.ts`, extend `WorkflowDefinitionNodeType`:

```ts
export type WorkflowDefinitionNodeType =
  | 'context'
  | 'intake'
  | 'route_skills'
  | 'answer'
  | 'analysis_plan'
  | 'lightweight_plan'
  | 'debug_plan'
  | 'debug_plan_confirm'
  | 'systematic_debugging'
  | 'review_plan'
  | 'reviewer_assignment'
  | 'agent_assignment'
  | 'planning'
  | 'brainstorming'
  | 'spec_review'
  | 'worktree'
  | 'writing_plans'
  | 'plan_review'
  | 'approval_gate'
  | 'dispatch'
  | 'execute'
  | 'tdd_execute'
  | 'review'
  | 'spec_compliance_review'
  | 'code_quality_review'
  | 'repair_decision'
  | 'verify'
  | 'finish_branch'
  | 'acceptance'
  | 'memory';
```

Also extend `WorkflowArtifactVersionType`:

```ts
export type WorkflowArtifactVersionType =
  | 'intent_routing'
  | 'analysis'
  | 'spec'
  | 'plan'
  | 'lightweight_plan'
  | 'agent_assignment'
  | 'change_request'
  | 'review'
  | 'verification'
  | 'finish_branch_decision';
```

- [x] **Step 4: Mirror frontend types**

In `packages/frontend/src/lib/types.ts`, apply the same `WorkflowDefinitionNodeType` and `WorkflowArtifactVersionType` additions. Add these view types near `WorkflowGateView`:

```ts
export type SuperpowersSelectedIntent =
  | 'answer'
  | 'analysis'
  | 'lightweight_task'
  | 'standard_development'
  | 'debug'
  | 'review_only';

export interface WorkflowControllerView {
  workflow_run_id: string;
  selected_intent: SuperpowersSelectedIntent | null;
  active_stage: string | null;
  controller: 'planner' | 'worker' | 'reviewer' | 'verifier' | 'user' | null;
  blocker: string | null;
  next_action: string | null;
}

export interface WorkflowAgentAssignmentView {
  task_id: string;
  task_title: string;
  role: 'executor' | 'reviewer' | 'verifier' | 'acceptor';
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  backend: string | null;
  fallback_reason: string | null;
  execution_mode: 'serial' | 'parallel' | 'hybrid';
  scope_write: string[];
}
```

- [x] **Step 5: Extend graph state schema**

In `packages/backend/src/workflows/graph/state.ts`, extend `workflowGraphNodeNameSchema` with:

```ts
'intake',
'route_skills',
'answer',
'analysis_plan',
'lightweight_plan',
'debug_plan',
'debug_plan_confirm',
'systematic_debugging',
'review_plan',
'reviewer_assignment',
'agent_assignment',
```

Add schemas:

```ts
export const superpowersSelectedIntentSchema = z.enum([
  'answer',
  'analysis',
  'lightweight_task',
  'standard_development',
  'debug',
  'review_only',
]);

export const superpowersWorktreeDecisionSchema = z.object({
  action: z.enum(['reuse', 'create', 'skip']),
  path: z.string().nullable(),
  branchName: z.string().nullable(),
  reason: z.string(),
});
```

Add fields to `agentWorkflowStateSchema`:

```ts
selectedIntent: superpowersSelectedIntentSchema.nullable().default(null),
selectedPath: z.array(z.string()).default([]),
routingArtifactVersionId: z.string().nullable().default(null),
analysisArtifactVersionId: z.string().nullable().default(null),
agentAssignmentArtifactVersionId: z.string().nullable().default(null),
approvedAgentAssignmentArtifactVersionId: z.string().nullable().default(null),
activeChangeRequestId: z.string().nullable().default(null),
worktreeDecision: superpowersWorktreeDecisionSchema.nullable().default(null),
```

Add the same fields to the `AgentWorkflowState` override list and `emptyAgentWorkflowState()` defaults.

- [x] **Step 6: Run state tests**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/state.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 1**

```bash
git add packages/backend/src/types.ts packages/frontend/src/lib/types.ts packages/backend/src/workflows/graph/state.ts packages/backend/src/workflows/graph/state.test.ts
git commit -m "feat(workflow): 扩展多意图路由状态"
```

---

## Task 2: Stage Registry Compiler And Executable Route Graph

**Files:**
- Modify: `packages/backend/src/workflows/superpowers-stage-registry.ts`
- Create: `packages/backend/src/workflows/graph/superpowers-route-compiler.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-runtime.ts`
- Test: `packages/backend/src/workflows/superpowers-stage-registry.test.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-route-compiler.test.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`

- [x] **Step 1: Write failing route compiler test**

Create `packages/backend/src/workflows/graph/superpowers-route-compiler.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSuperpowersRouteDefinition } from './superpowers-route-compiler.js';

test('buildSuperpowersRouteDefinition exposes all intent branches', () => {
  const definition = buildSuperpowersRouteDefinition();
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const edgeIds = new Set(definition.edges.map((edge) => `${edge.from}->${edge.to}:${edge.condition ?? ''}`));

  for (const id of [
    'context',
    'intake',
    'route_skills',
    'answer',
    'analysis_plan',
    'lightweight_plan',
    'brainstorming',
    'debug_plan',
    'systematic_debugging',
    'review_plan',
    'agent_assignment',
    'dispatch',
    'verification',
    'finish_branch',
    'acceptance',
    'memory',
  ]) {
    assert.equal(nodeIds.has(id), true, `missing node ${id}`);
  }

  assert.equal(edgeIds.has('context->intake:'), true);
  assert.equal(edgeIds.has('intake->route_skills:'), true);
  assert.equal(edgeIds.has('route_skills->answer:answer'), true);
  assert.equal(edgeIds.has('route_skills->analysis_plan:analysis'), true);
  assert.equal(edgeIds.has('route_skills->lightweight_plan:lightweight_task'), true);
  assert.equal(edgeIds.has('route_skills->brainstorming:standard_development'), true);
  assert.equal(edgeIds.has('route_skills->debug_plan:debug'), true);
  assert.equal(edgeIds.has('route_skills->review_plan:review_only'), true);
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/superpowers-route-compiler.test.ts
```

Expected: FAIL because `superpowers-route-compiler.ts` does not exist.

- [x] **Step 3: Add route compiler**

Create `packages/backend/src/workflows/graph/superpowers-route-compiler.ts`:

```ts
import type { WorkflowDefinitionGraph, WorkflowDefinitionNode, WorkflowDefinitionNodeType } from '../../types.js';
import { listSuperpowersStages, type SuperpowersStageDefinition, type SuperpowersStageId } from '../superpowers-stage-registry.js';
import { SUPERPOWERS_RUNTIME_PROFILE, SUPERPOWERS_WORKFLOW_DEFINITION_KEY } from './superpowers-runtime.js';

const ROUTE_EDGE_CONDITIONS: Partial<Record<SuperpowersStageId, Array<{ to: SuperpowersStageId; condition?: string }>>> = {
  route_skills: [
    { to: 'answer', condition: 'answer' },
    { to: 'analysis_plan', condition: 'analysis' },
    { to: 'lightweight_plan', condition: 'lightweight_task' },
    { to: 'brainstorming', condition: 'standard_development' },
    { to: 'debug_plan', condition: 'debug' },
    { to: 'review_plan', condition: 'review_only' },
  ],
};

const NODE_TYPE_BY_STAGE: Record<SuperpowersStageId, WorkflowDefinitionNodeType> = {
  intake: 'intake',
  route_skills: 'route_skills',
  answer: 'answer',
  analysis_plan: 'analysis_plan',
  lightweight_plan: 'lightweight_plan',
  brainstorming: 'brainstorming',
  spec_review: 'spec_review',
  spec_confirm: 'approval_gate',
  writing_plans: 'writing_plans',
  plan_review: 'plan_review',
  plan_confirm: 'approval_gate',
  worktree: 'worktree',
  dispatch: 'dispatch',
  execute: 'tdd_execute',
  debug_plan: 'debug_plan',
  debug_plan_confirm: 'approval_gate',
  systematic_debugging: 'systematic_debugging',
  review_plan: 'review_plan',
  reviewer_assignment: 'reviewer_assignment',
  debug: 'systematic_debugging',
  spec_compliance_review: 'spec_compliance_review',
  code_quality_review: 'code_quality_review',
  verification: 'verify',
  finish_branch: 'finish_branch',
  acceptance: 'acceptance',
  memory: 'memory',
  agent_assignment: 'agent_assignment',
};

const STAGE_LABELS: Partial<Record<SuperpowersStageId, string>> = {
  intake: 'Planner Intake',
  route_skills: 'Route Skills',
  answer: 'Answer',
  analysis_plan: 'Analysis Plan',
  lightweight_plan: 'Lightweight Plan',
  agent_assignment: 'Agent Assignment',
  systematic_debugging: 'Systematic Debugging',
};

export function buildSuperpowersRouteDefinition(): WorkflowDefinitionGraph {
  const stages = listSuperpowersStages();
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const ids = new Set<SuperpowersStageId>([
    'intake',
    'route_skills',
    'answer',
    'analysis_plan',
    'lightweight_plan',
    'brainstorming',
    'spec_review',
    'spec_confirm',
    'writing_plans',
    'plan_review',
    'plan_confirm',
    'agent_assignment',
    'worktree',
    'dispatch',
    'execute',
    'debug_plan',
    'debug_plan_confirm',
    'systematic_debugging',
    'review_plan',
    'reviewer_assignment',
    'spec_compliance_review',
    'code_quality_review',
    'verification',
    'finish_branch',
    'acceptance',
    'memory',
  ]);
  const nodes = Array.from(ids).map((id) => createRouteNode(id, stageById.get(id)));
  return {
    metadata: {
      runtime_profile: SUPERPOWERS_RUNTIME_PROFILE,
      gate_policy: SUPERPOWERS_WORKFLOW_DEFINITION_KEY,
    },
    nodes: [
      { id: 'context', type: 'context', label: '上下文', stage: 'analysis' },
      ...nodes,
    ],
    edges: [
      { from: 'context', to: 'intake' },
      { from: 'intake', to: 'route_skills' },
      ...routeEdges(),
    ],
  };
}

function createRouteNode(id: SuperpowersStageId, stage: SuperpowersStageDefinition | undefined): WorkflowDefinitionNode {
  return {
    id,
    type: NODE_TYPE_BY_STAGE[id],
    label: STAGE_LABELS[id] ?? stage?.id ?? id,
    stage: stage?.id === 'answer' ? 'acceptance' : inferWorkflowStage(id),
    role: stage?.controller === 'user' ? null : controllerToRole(stage?.controller),
    metadata: {
      runtime_profile: SUPERPOWERS_RUNTIME_PROFILE,
      required_skill_names: stage?.requiredSkills ?? [],
    },
  };
}

function routeEdges(): WorkflowDefinitionGraph['edges'] {
  return [
    ...ROUTE_EDGE_CONDITIONS.route_skills!.map((edge) => ({
      from: 'route_skills',
      to: edge.to,
      condition: edge.condition,
    })),
    { from: 'analysis_plan', to: 'memory', condition: 'completed' },
    { from: 'lightweight_plan', to: 'plan_confirm' },
    { from: 'brainstorming', to: 'spec_review' },
    { from: 'spec_review', to: 'spec_confirm' },
    { from: 'spec_confirm', to: 'writing_plans', condition: 'approved' },
    { from: 'writing_plans', to: 'plan_review' },
    { from: 'plan_review', to: 'plan_confirm' },
    { from: 'plan_confirm', to: 'agent_assignment', condition: 'approved' },
    { from: 'agent_assignment', to: 'worktree' },
    { from: 'worktree', to: 'dispatch' },
    { from: 'dispatch', to: 'execute' },
    { from: 'execute', to: 'execute', condition: 'has_runnable_child' },
    { from: 'execute', to: 'spec_compliance_review', condition: 'done' },
    { from: 'debug_plan', to: 'debug_plan_confirm' },
    { from: 'debug_plan_confirm', to: 'agent_assignment', condition: 'approved' },
    { from: 'agent_assignment', to: 'systematic_debugging', condition: 'debug' },
    { from: 'systematic_debugging', to: 'verification' },
    { from: 'review_plan', to: 'reviewer_assignment' },
    { from: 'reviewer_assignment', to: 'spec_compliance_review' },
    { from: 'spec_compliance_review', to: 'execute', condition: 'changes_requested' },
    { from: 'spec_compliance_review', to: 'code_quality_review', condition: 'pass' },
    { from: 'code_quality_review', to: 'execute', condition: 'changes_requested' },
    { from: 'code_quality_review', to: 'verification', condition: 'pass' },
    { from: 'verification', to: 'finish_branch' },
    { from: 'finish_branch', to: 'acceptance', condition: 'completed' },
    { from: 'acceptance', to: 'memory', condition: 'completed' },
  ];
}

function inferWorkflowStage(id: SuperpowersStageId) {
  if (id === 'intake' || id === 'route_skills' || id === 'analysis_plan') return 'analysis';
  if (id === 'agent_assignment' || id === 'reviewer_assignment') return 'assignment';
  if (id === 'execute' || id === 'systematic_debugging') return 'implementation';
  if (id.includes('review') || id === 'verification') return 'code_review';
  if (id === 'finish_branch' || id === 'acceptance' || id === 'memory') return 'acceptance';
  return 'planning';
}

function controllerToRole(controller: SuperpowersStageDefinition['controller'] | undefined) {
  if (controller === 'planner') return 'planner';
  if (controller === 'worker') return 'executor';
  if (controller === 'reviewer') return 'reviewer';
  if (controller === 'verifier') return 'reviewer';
  return null;
}
```

- [x] **Step 4: Extend stage registry ids**

In `packages/backend/src/workflows/superpowers-stage-registry.ts`, add missing stage ids to `SuperpowersStageId`:

```ts
| 'debug_plan'
| 'debug_plan_confirm'
| 'systematic_debugging'
| 'review_plan'
| 'reviewer_assignment'
| 'agent_assignment'
```

Add definitions to `STAGES`:

```ts
{ id: 'agent_assignment', controller: 'planner', requiredSkills: ['subagent-driven-development'], requiredInputs: ['approved_plan_version'], expectedArtifacts: ['agent_assignment'], gates: ['artifact_schema'], next: ['worktree', 'systematic_debugging'] },
{ id: 'debug_plan', controller: 'planner', requiredSkills: ['systematic-debugging'], requiredInputs: ['failure_context'], expectedArtifacts: ['debug_plan'], gates: ['artifact_schema'], next: ['debug_plan_confirm'] },
{ id: 'debug_plan_confirm', controller: 'user', requiredSkills: [], requiredInputs: ['debug_plan'], expectedArtifacts: ['approved_debug_plan'], gates: ['user_confirm'], next: ['agent_assignment'] },
{ id: 'systematic_debugging', controller: 'worker', requiredSkills: ['systematic-debugging'], requiredInputs: ['approved_debug_plan'], expectedArtifacts: ['debuggingEvidence'], gates: ['root_cause'], next: ['verification'] },
{ id: 'review_plan', controller: 'planner', requiredSkills: ['requesting-code-review'], requiredInputs: ['user_message'], expectedArtifacts: ['review_plan'], gates: ['artifact_schema'], next: ['reviewer_assignment'] },
{ id: 'reviewer_assignment', controller: 'planner', requiredSkills: ['requesting-code-review'], requiredInputs: ['review_plan'], expectedArtifacts: ['agent_assignment'], gates: ['agent_available'], next: ['spec_compliance_review'] },
```

- [x] **Step 5: Wire runtime graph to compiler**

In `packages/backend/src/workflows/graph/superpowers-runtime.ts`, import `buildSuperpowersRouteDefinition` and replace `SUPERPOWERS_EXECUTABLE_DEFINITION` usage:

```ts
import { buildSuperpowersRouteDefinition } from './superpowers-route-compiler.js';

const SUPERPOWERS_EXECUTABLE_DEFINITION: WorkflowDefinitionGraph = buildSuperpowersRouteDefinition();
```

If this creates a circular import with constants, move `SUPERPOWERS_RUNTIME_PROFILE` and `SUPERPOWERS_WORKFLOW_DEFINITION_KEY` to `packages/backend/src/workflows/graph/superpowers-runtime-constants.ts`, then import them from both files.

- [x] **Step 6: Run route compiler and runtime tests**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/superpowers-route-compiler.test.ts packages/backend/src/workflows/graph/superpowers-runtime.test.ts packages/backend/src/workflows/superpowers-stage-registry.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 2**

```bash
git add packages/backend/src/workflows/superpowers-stage-registry.ts packages/backend/src/workflows/superpowers-stage-registry.test.ts packages/backend/src/workflows/graph/superpowers-route-compiler.ts packages/backend/src/workflows/graph/superpowers-route-compiler.test.ts packages/backend/src/workflows/graph/superpowers-runtime.ts packages/backend/src/workflows/graph/superpowers-runtime.test.ts
git commit -m "feat(workflow): 编译Superpowers多意图路由图"
```

---

## Task 3: Runtime Support For Intake, Route, Answer, And Analysis

**Files:**
- Create: `packages/backend/src/workflows/graph/superpowers-routing-nodes.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-route-compiler.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Modify: `packages/backend/src/workflows/graph/tools.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts`
- Test: `packages/backend/src/workflows/graph/runtime.test.ts`

- [x] **Step 1: Write failing routing node tests**

Create `packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyAgentWorkflowState } from './state.js';
import { createSuperpowersRoutingNodes } from './superpowers-routing-nodes.js';

test('routeSkills records answer route and completes through answer node', async () => {
  const createdArtifacts: Array<{ artifact_type: string; structured_data: unknown }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-answer-1' };
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '这个项目是什么？',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills({
    ...intake,
    selectedIntent: 'answer',
  });
  const answered = await nodes.answer(routed);

  assert.equal(routed.selectedIntent, 'answer');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'answer']);
  assert.equal(answered.status, 'completed');
  assert.equal(answered.currentNode, 'answer');
  assert.equal(createdArtifacts.some((artifact) => artifact.artifact_type === 'intent_routing'), true);
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts
```

Expected: FAIL because `superpowers-routing-nodes.ts` does not exist.

- [x] **Step 3: Create routing node module**

Create `packages/backend/src/workflows/graph/superpowers-routing-nodes.ts`:

```ts
import type { WorkflowArtifactVersionType } from '../../types.js';
import type { AgentWorkflowState } from './state.js';

export interface SuperpowersRoutingNodeTools {
  createArtifactVersionDraft(input: {
    workflow_run_id: string;
    artifact_type: WorkflowArtifactVersionType;
    title: string;
    content: string;
    structured_data: Record<string, unknown>;
    created_by_agent_id: string;
  }): { id: string };
  createAssistantMessage(input: {
    workflowRunId: string;
    content: string;
  }): { id: string };
}

export function createSuperpowersRoutingNodes(tools: SuperpowersRoutingNodeTools) {
  return {
    async intake(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const intent = state.selectedIntent ?? inferIntentFromGoal(state.userGoal);
      const artifact = tools.createArtifactVersionDraft({
        workflow_run_id: state.workflowRunId,
        artifact_type: 'intent_routing',
        title: 'Intent Routing',
        content: formatJson({
          intent,
          confidence: intent === 'answer' ? 0.7 : 0.6,
          reason: '根据用户消息和 session mode 生成初始路由。',
        }),
        structured_data: {
          intent,
          confidence: intent === 'answer' ? 0.7 : 0.6,
          reason: '根据用户消息和 session mode 生成初始路由。',
        },
        created_by_agent_id: 'planner',
      });
      return {
        ...state,
        currentNode: 'intake',
        activeSuperpowersStage: 'intake',
        selectedIntent: intent,
        routingArtifactVersionId: artifact.id,
      };
    },
    async routeSkills(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const intent = state.selectedIntent ?? inferIntentFromGoal(state.userGoal);
      return {
        ...state,
        currentNode: 'route_skills',
        activeSuperpowersStage: 'route_skills',
        selectedIntent: intent,
        selectedPath: selectedPathForIntent(intent),
      };
    },
    async answer(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const message = tools.createAssistantMessage({
        workflowRunId: state.workflowRunId,
        content: `已通过 workflow-first answer 路径处理：${state.userGoal}`,
      });
      return {
        ...state,
        currentNode: 'answer',
        activeSuperpowersStage: 'answer',
        activeAgentRunId: null,
        status: 'completed',
        error: null,
        agentEvents: [
          ...state.agentEvents,
          {
            workflowRunId: state.workflowRunId,
            stepId: state.currentStepId ?? 'answer',
            agentRunId: message.id,
            type: 'completed',
            summary: 'Answer path completed',
            createdAt: Date.now(),
          },
        ],
      };
    },
    async analysisPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
      const artifact = tools.createArtifactVersionDraft({
        workflow_run_id: state.workflowRunId,
        artifact_type: 'analysis',
        title: 'Analysis',
        content: formatJson({
          conclusion: '已进入只读分析路径。',
          evidence: [],
          risks: [],
          recommendations: [],
        }),
        structured_data: {
          conclusion: '已进入只读分析路径。',
          evidence: [],
          risks: [],
          recommendations: [],
        },
        created_by_agent_id: 'planner',
      });
      return {
        ...state,
        currentNode: 'analysis_plan',
        activeSuperpowersStage: 'analysis_plan',
        analysisArtifactVersionId: artifact.id,
        status: 'completed',
        error: null,
      };
    },
  };
}

function inferIntentFromGoal(goal: string): AgentWorkflowState['selectedIntent'] {
  if (/分析|解释|为什么|原因|review|审查/u.test(goal)) return 'analysis';
  if (/修复|bug|报错|失败|debug/u.test(goal)) return 'debug';
  if (/实现|开发|改造|新增|修改/u.test(goal)) return 'standard_development';
  return 'answer';
}

function selectedPathForIntent(intent: NonNullable<AgentWorkflowState['selectedIntent']>): string[] {
  if (intent === 'answer') return ['intake', 'route_skills', 'answer'];
  if (intent === 'analysis') return ['intake', 'route_skills', 'analysis_plan'];
  if (intent === 'lightweight_task') return ['intake', 'route_skills', 'lightweight_plan'];
  if (intent === 'debug') return ['intake', 'route_skills', 'debug_plan'];
  if (intent === 'review_only') return ['intake', 'route_skills', 'review_plan'];
  return ['intake', 'route_skills', 'brainstorming'];
}

function formatJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
```

- [x] **Step 4: Wire runtime route node names**

In `packages/backend/src/workflows/graph/runtime.ts`:

1. Extend `WorkflowRouteNode`:

```ts
type SuperpowersRoutingNodeName =
  | 'intake'
  | 'route_skills'
  | 'answer'
  | 'analysis_plan'
  | 'lightweight_plan'
  | 'debug_plan'
  | 'debug_plan_confirm'
  | 'systematic_debugging'
  | 'review_plan'
  | 'reviewer_assignment'
  | 'agent_assignment';

type WorkflowRouteNode =
  | NonNullable<AgentWorkflowState['currentNode']>
  | SuperpowersRoutingNodeName
  | SuperpowersPlanningNodeName
  | SuperpowersExecutionNodeName;
```

2. Add mappings to `SUPERPOWERS_NODE_TYPE_TO_STATE_NODE`:

```ts
intake: 'intake',
route_skills: 'route_skills',
answer: 'answer',
analysis_plan: 'analysis_plan',
lightweight_plan: 'lightweight_plan',
debug_plan: 'debug_plan',
debug_plan_confirm: 'debug_plan_confirm',
systematic_debugging: 'systematic_debugging',
review_plan: 'review_plan',
reviewer_assignment: 'reviewer_assignment',
agent_assignment: 'agent_assignment',
```

3. Add `isSuperpowersRoutingRouteNode()`:

```ts
function isSuperpowersRoutingRouteNode(node: WorkflowRouteNode): node is SuperpowersRoutingNodeName {
  return node === 'intake'
    || node === 'route_skills'
    || node === 'answer'
    || node === 'analysis_plan'
    || node === 'lightweight_plan'
    || node === 'debug_plan'
    || node === 'debug_plan_confirm'
    || node === 'systematic_debugging'
    || node === 'review_plan'
    || node === 'reviewer_assignment'
    || node === 'agent_assignment';
}
```

- [x] **Step 5: Route by selectedIntent**

In `matchesRouteCondition()`, before generic defaults, add:

```ts
if (node === 'route_skills') {
  return condition === state.selectedIntent;
}
if (node === 'agent_assignment') {
  if (condition === 'debug') return state.selectedIntent === 'debug';
  return state.selectedIntent !== 'debug';
}
```

- [x] **Step 6: Add runtime execution dispatch for routing nodes**

In `resumeGraphWorkflowFromState()`, before planning node handling:

```ts
if (runtimeGraph && isSuperpowersRoutingRouteNode(nodeToRun)) {
  nextState = await runSuperpowersRoutingNode(nodeToRun, nextState, tools);
}
```

Add `runSuperpowersRoutingNode()` using `createSuperpowersRoutingNodes()` and real tools adapters:

```ts
async function runSuperpowersRoutingNode(
  nodeToRun: SuperpowersRoutingNodeName,
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
): Promise<AgentWorkflowState> {
  const context = tools.readWorkflowContext(state.workflowRunId);
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      return workflowArtifactVersionRepo.createDraft({
        workflow_run_id: input.workflow_run_id,
        artifact_type: input.artifact_type,
        title: input.title,
        content: input.content,
        structured_data: input.structured_data,
        created_by_agent_id: input.created_by_agent_id,
      });
    },
    createAssistantMessage(input) {
      return tools.createWorkflowMessage({
        roomId: context.room.id,
        workflowRunId: input.workflowRunId,
        role: 'assistant',
        content: input.content,
      });
    },
  });
  if (nodeToRun === 'intake') return nodes.intake(state);
  if (nodeToRun === 'route_skills') return nodes.routeSkills(state);
  if (nodeToRun === 'answer') return nodes.answer(state);
  if (nodeToRun === 'analysis_plan') return nodes.analysisPlan(state);
  return {
    ...state,
    currentNode: nodeToRun,
    activeSuperpowersStage: nodeToRun,
  };
}
```

If `GraphTools` lacks `createWorkflowMessage`, add it in `packages/backend/src/workflows/graph/tools.ts` with existing message repo and broadcast patterns.

- [x] **Step 7: Run routing tests**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts packages/backend/src/workflows/graph/runtime.test.ts
```

Expected: PASS after updating any existing runtime graph expectations to include `intake` and `route_skills`.

- [x] **Step 8: Commit Task 3**

```bash
git add packages/backend/src/workflows/graph/superpowers-routing-nodes.ts packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts packages/backend/src/workflows/graph/superpowers-route-compiler.ts packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/runtime.test.ts packages/backend/src/workflows/graph/tools.ts
git commit -m "feat(workflow): 执行Superpowers路由节点"
```

---

## Task 4: Session Entry Becomes Full Workflow-first

**Files:**
- Modify: `packages/backend/src/session-message-dispatch.ts`
- Modify: `packages/backend/src/workflows/session-workflow-intake.ts`
- Test: `packages/backend/src/session-message-dispatch.test.ts`
- Test: `packages/backend/src/workflows/session-workflow-intake.test.ts`

- [x] **Step 1: Write failing dispatch test**

In `packages/backend/src/session-message-dispatch.test.ts`, add:

```ts
test('dispatchSessionUserMessage routes ordinary chat through workflow intake instead of planner run', async () => {
  const fixture = createSessionDispatchFixture();
  const message = await dispatchSessionUserMessage({
    sessionId: fixture.session.id,
    content: '这个项目的 workflow 是怎么工作的？',
    mode: 'ask',
  });

  const tasks = taskRepo.listByProject(fixture.project.id).filter((task) => task.source_message_id === message.id);
  assert.equal(tasks.length, 1);
  const runs = workflowRepo.listByTask(tasks[0]!.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.graph_version, 'superpowers-v2');
  assert.doesNotMatch(JSON.stringify(message.metadata), /low_risk_auto/);
});
```

Use the existing fixture builder in that file. If the file has no shared fixture, extract setup from the closest existing session dispatch test into `createSessionDispatchFixture()`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/backend/src/session-message-dispatch.test.ts
```

Expected: FAIL because ordinary chat still calls `startSessionPlannerRun()`.

- [x] **Step 3: Refactor dispatch entry**

In `packages/backend/src/session-message-dispatch.ts`, replace the `riskGate.applies` branch with unconditional workflow intake:

```ts
const riskGate = assessSessionMessageRisk({
  sessionId: runtimeSession.id,
  sourceMessageId: message.id,
  content: input.content,
  workspaceFileRefs,
  platformSkillRefs,
});
startSessionWorkflowIntake({
  project,
  session: runtimeSession,
  sourceMessage: message,
  assessment: riskGate.assessment,
  contextContent: riskGate.contextContent,
  workspaceFileRefs,
  libraryFileRefs,
  platformSkillRefs,
});
return message;
```

Keep these paths before intake:

- approval decisions for existing pending approvals.
- workflow artifact change requests.
- invalid empty messages.

Do not delete `startSessionPlannerRun()` in this task; mark it as internal compatibility by moving it below workflow helpers and ensuring no ordinary dispatch path calls it.

- [x] **Step 4: Initialize route state in intake**

In `packages/backend/src/workflows/session-workflow-intake.ts`, when creating `pendingState`, set:

```ts
currentNode: 'context',
activeSuperpowersStage: 'intake',
selectedIntent: null,
selectedPath: [],
routingArtifactVersionId: null,
analysisArtifactVersionId: null,
```

When updating graph state after workflow creation, keep `workflowRunId` and preserve these fields.

- [x] **Step 5: Run dispatch and intake tests**

Run:

```bash
node --import tsx --test packages/backend/src/session-message-dispatch.test.ts packages/backend/src/workflows/session-workflow-intake.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit Task 4**

```bash
git add packages/backend/src/session-message-dispatch.ts packages/backend/src/session-message-dispatch.test.ts packages/backend/src/workflows/session-workflow-intake.ts packages/backend/src/workflows/session-workflow-intake.test.ts
git commit -m "feat(session): 统一消息进入workflow入口"
```

---

## Task 5: Lightweight, Debug, And Review-only Artifact Loops

**Files:**
- Modify: `packages/backend/src/workflows/graph/superpowers-routing-nodes.ts`
- Modify: `packages/backend/src/session-message-dispatch.ts`
- Modify: `packages/backend/src/session.routes.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts`
- Test: `packages/backend/src/session-message-dispatch.test.ts`

- [x] **Step 1: Write failing lightweight revision test**

Add to `packages/backend/src/session-message-dispatch.test.ts`:

```ts
test('workflow artifact change request for lightweight_plan re-enters lightweight plan instead of blocker', async () => {
  const fixture = createApprovedLightweightPlanFixture();
  const message = await dispatchSessionUserMessage({
    sessionId: fixture.session.id,
    content: '请把验证命令改成只跑后端测试',
    workflowArtifactChangeRequest: {
      workflowRunId: fixture.workflow.id,
      artifactVersionId: fixture.lightweightPlan.id,
      artifactType: 'lightweight_plan',
    },
  });

  const updated = workflowRepo.getRun(fixture.workflow.id)!;
  const state = parseGraphState(updated.graph_state)!;
  assert.equal(state.activeSuperpowersStage, 'lightweight_plan');
  assert.equal(state.lightweightPlanArtifactVersionId, null);
  const blockerEvents = sessionEvidenceRepo.listBySession(fixture.session.id).filter((event) =>
    JSON.stringify(event.payload).includes('lightweight_plan_revision_not_implemented')
  );
  assert.equal(blockerEvents.length, 0);
  assert.equal(message.role, 'user');
});
```

Implement `createApprovedLightweightPlanFixture()` in the test using existing repo helpers: create project, room, session, task, workflow run with `superpowers-v2`, approved lightweight artifact, and graph state with `lightweightPlanArtifactVersionId`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/backend/src/session-message-dispatch.test.ts
```

Expected: FAIL because current code records `lightweight_plan_revision_not_implemented`.

- [x] **Step 3: Implement lightweight/debug/review plan nodes**

In `packages/backend/src/workflows/graph/superpowers-routing-nodes.ts`, add:

```ts
async lightweightPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
  const plan = {
    goal: state.userGoal,
    skipFullSpecReason: '轻量任务走最小计划，但仍需用户确认。',
    scopeRead: [],
    scopeWrite: [],
    steps: [{
      title: '执行轻量任务',
      role: 'executor',
      requiredCapabilities: ['fullstack'],
    }],
    verification: [{
      command: 'npm run build',
      required: true,
      reason: 'TypeScript and bundle gate',
    }],
    risks: [],
    assumptions: [],
  };
  const artifact = tools.createArtifactVersionDraft({
    workflow_run_id: state.workflowRunId,
    artifact_type: 'lightweight_plan',
    title: 'Lightweight Plan',
    content: formatJson(plan),
    structured_data: plan,
    created_by_agent_id: 'planner',
  });
  return {
    ...state,
    currentNode: 'lightweight_plan',
    activeSuperpowersStage: 'lightweight_plan',
    draftPlanArtifactVersionId: null,
    lightweightPlanArtifactVersionId: artifact.id,
    status: 'blocked',
    error: 'Superpowers dispatch requires approved plan artifact version',
  };
}
```

Add similar methods:

```ts
async debugPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
  const plan = {
    goal: state.userGoal,
    mode: 'debug',
    scopeRead: [],
    scopeWrite: [],
    reproduction: [],
    verification: [{ command: 'npm run build', required: true, reason: 'post-debug verification' }],
  };
  const artifact = tools.createArtifactVersionDraft({
    workflow_run_id: state.workflowRunId,
    artifact_type: 'plan',
    title: 'Debug Plan',
    content: formatJson(plan),
    structured_data: plan,
    created_by_agent_id: 'planner',
  });
  return { ...state, currentNode: 'debug_plan', activeSuperpowersStage: 'debug_plan', draftPlanArtifactVersionId: artifact.id };
}

async reviewPlan(state: AgentWorkflowState): Promise<AgentWorkflowState> {
  const plan = {
    goal: state.userGoal,
    mode: 'review_only',
    reviewScope: [],
    verificationRequired: false,
  };
  const artifact = tools.createArtifactVersionDraft({
    workflow_run_id: state.workflowRunId,
    artifact_type: 'plan',
    title: 'Review Plan',
    content: formatJson(plan),
    structured_data: plan,
    created_by_agent_id: 'planner',
  });
  return { ...state, currentNode: 'review_plan', activeSuperpowersStage: 'review_plan', draftPlanArtifactVersionId: artifact.id };
}
```

- [x] **Step 4: Dispatch new routing nodes**

In `runSuperpowersRoutingNode()` from Task 3, route:

```ts
if (nodeToRun === 'lightweight_plan') return nodes.lightweightPlan(state);
if (nodeToRun === 'debug_plan') return nodes.debugPlan(state);
if (nodeToRun === 'review_plan') return nodes.reviewPlan(state);
```

- [x] **Step 5: Change lightweight artifact revision behavior**

In `packages/backend/src/session-message-dispatch.ts`, remove the special blocker branch:

```ts
if (artifact.artifact_type === 'lightweight_plan') {
  recordUnsupportedWorkflowArtifactChangeRequest(...);
  return true;
}
```

Update `buildWorkflowArtifactChangeRequestState()` for `lightweight_plan`:

```ts
return {
  ...input.state,
  ...common,
  currentNode: 'route_skills',
  selectedIntent: 'lightweight_task',
  selectedPath: ['intake', 'route_skills', 'lightweight_plan'],
  superpowersPhase: null,
  activeSuperpowersStage: 'lightweight_plan',
  draftPlanArtifactVersionId: null,
  approvedPlanArtifactVersionId: null,
  lightweightPlanArtifactVersionId: null,
  plan: null,
  workflowPlan: null,
  approval: 'pending',
};
```

Delete `recordUnsupportedWorkflowArtifactChangeRequest()` if it becomes unused.

- [x] **Step 6: Run tests**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts packages/backend/src/session-message-dispatch.test.ts packages/backend/src/session.routes.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 5**

```bash
git add packages/backend/src/workflows/graph/superpowers-routing-nodes.ts packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts packages/backend/src/session-message-dispatch.ts packages/backend/src/session-message-dispatch.test.ts packages/backend/src/session.routes.ts
git commit -m "feat(workflow): 补齐轻量调试审查计划闭环"
```

---

## Task 6: Explicit Agent Assignment Artifact And Gates

**Files:**
- Modify: `packages/backend/src/workflows/agent-assignment.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-routing-nodes.ts`
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Modify: `packages/backend/src/session.routes.ts`
- Test: `packages/backend/src/workflows/agent-assignment.test.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts`
- Test: `packages/backend/src/session.routes.test.ts`

- [x] **Step 1: Write failing assignment artifact test**

Add to `packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts`:

```ts
test('agentAssignment creates artifact with fullstack executor fallback and blocks missing reviewer', async () => {
  const artifacts: Array<{ artifact_type: string; structured_data: any }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      artifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${artifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-1' };
    },
    listAvailableWorkflowAgents() {
      return [{
        id: 'fullstack-engineer',
        name: '全栈工程师',
        provider: 'codex',
        capabilities: ['frontend', 'backend', 'testing'],
        workflowRoles: ['executor'],
        acpEnabled: true,
        available: true,
        fallback: true,
      }];
    },
  });
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-assignment-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '实现设置页',
    projectPath: '/tmp/project',
  });

  const next = await nodes.agentAssignment({
    ...state,
    selectedIntent: 'standard_development',
    plan: {
      goal: '实现设置页',
      summary: '实现设置页',
      assumptions: [],
      tasks: [{
        title: '实现设置页',
        description: '修改前端页面',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['页面可构建'],
        scopeRead: ['packages/frontend/src/pages'],
        scopeWrite: ['packages/frontend/src/pages/SettingsPage.tsx'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [{ command: 'npm run build', reason: 'build', required: true }],
      risks: [],
      needsApproval: true,
    },
  });

  assert.equal(next.agentAssignmentArtifactVersionId, 'artifact-1');
  assert.equal(artifacts[0]!.artifact_type, 'agent_assignment');
  assert.equal(artifacts[0]!.structured_data.assignments[0].assignedAgentId, 'fullstack-engineer');
  assert.match(artifacts[0]!.structured_data.assignments[0].fallbackReason, /全栈工程师/);
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts
```

Expected: FAIL because `agentAssignment()` is missing.

- [x] **Step 3: Extend routing tools for available agents**

In `SuperpowersRoutingNodeTools`, add:

```ts
listAvailableWorkflowAgents?(): AvailableWorkflowAgent[];
```

Import `assignPlanTaskAgent` and `AvailableWorkflowAgent`.

- [x] **Step 4: Implement `agentAssignment` node**

In `createSuperpowersRoutingNodes()`:

```ts
async agentAssignment(state: AgentWorkflowState): Promise<AgentWorkflowState> {
  const agents = tools.listAvailableWorkflowAgents?.() ?? [];
  const tasks = state.plan?.tasks ?? [];
  const assignments = tasks.map((task, index) => {
    const result = assignPlanTaskAgent({
      taskId: `task-${index + 1}`,
      title: task.title,
      requiredCapabilities: inferCapabilities(task),
      scopeWrite: task.scopeWrite,
      agents,
    });
    return {
      taskId: `task-${index + 1}`,
      taskTitle: task.title,
      role: task.suggestedRole === 'executor' ? 'executor' : task.suggestedRole,
      assignedAgentId: result.assignedAgentId,
      fallbackAgentIds: result.fallbackAgentIds,
      fallbackReason: result.fallbackReason,
      executionMode: result.executionMode,
      scopeWrite: result.scopeWrite,
    };
  });
  const missingExecutor = assignments.find((item) => item.role === 'executor' && !item.assignedAgentId);
  const artifact = tools.createArtifactVersionDraft({
    workflow_run_id: state.workflowRunId,
    artifact_type: 'agent_assignment',
    title: 'Agent Assignment',
    content: formatJson({ assignments }),
    structured_data: { assignments },
    created_by_agent_id: 'planner',
  });
  return {
    ...state,
    currentNode: 'agent_assignment',
    activeSuperpowersStage: 'agent_assignment',
    agentAssignmentArtifactVersionId: artifact.id,
    agentAssignments: assignments.map((item) => ({
      taskId: item.taskId,
      assignedAgentId: item.assignedAgentId,
      fallbackAgentIds: item.fallbackAgentIds,
      fallbackReason: item.fallbackReason,
      executionMode: item.executionMode,
      scopeWrite: item.scopeWrite,
    })),
    status: missingExecutor ? 'blocked' : state.status,
    error: missingExecutor ? 'needs_agent_assignment' : null,
  };
}
```

Add helper:

```ts
function inferCapabilities(task: { title: string; description: string; scopeRead: string[]; scopeWrite: string[] }): string[] {
  const text = [task.title, task.description, ...task.scopeRead, ...task.scopeWrite].join('\n').toLowerCase();
  const capabilities: string[] = [];
  if (/frontend|react|tsx|packages\/frontend|前端|页面|组件/u.test(text)) capabilities.push('frontend');
  if (/backend|express|sqlite|packages\/backend|后端|接口|数据库/u.test(text)) capabilities.push('backend');
  if (/test|测试/u.test(text)) capabilities.push('testing');
  return capabilities.length > 0 ? capabilities : ['fullstack'];
}
```

- [x] **Step 5: Freeze assignment at dispatch**

In `packages/backend/src/workflows/graph/nodes.ts`, before creating child tasks from plan, prefer `state.agentAssignments` when available:

```ts
const frozenAssignment = state.agentAssignments.find((item) => item.taskId === `task-${originalIndex + 1}`);
const assigned = frozenAssignment?.assignedAgentId
  ? assignmentAgents.find((agent) => agent.agent_id === frozenAssignment.assignedAgentId || agent.id === frozenAssignment.assignedAgentId) ?? resolved
  : resolved;
```

If `state.agentAssignments.length > 0` and a required executor assignment is missing, block with `needs_agent_assignment`.

- [x] **Step 6: Expose assignment in session payload**

In `packages/backend/src/session.routes.ts`, add `workflowController` and `workflowAgentAssignments` to `SessionDetail` assembly by parsing latest workflow run graph state:

```ts
workflowController: buildWorkflowControllerView(workflowRuns),
workflowAgentAssignments: buildWorkflowAgentAssignmentViews(workflowRuns),
```

Implement:

```ts
function buildWorkflowAgentAssignmentViews(runs: WorkflowRun[]): WorkflowAgentAssignmentView[] {
  return runs.flatMap((run) => {
    const state = parseGraphState(run.graph_state);
    return (state?.agentAssignments ?? []).map((assignment) => ({
      task_id: assignment.taskId,
      task_title: assignment.taskId,
      role: 'executor',
      assigned_agent_id: assignment.assignedAgentId,
      assigned_agent_name: assignment.assignedAgentId,
      backend: null,
      fallback_reason: assignment.fallbackReason,
      execution_mode: assignment.executionMode,
      scope_write: assignment.scopeWrite,
    }));
  });
}
```

- [x] **Step 7: Run assignment tests**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/agent-assignment.test.ts packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts packages/backend/src/session.routes.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit Task 6**

```bash
git add packages/backend/src/workflows/agent-assignment.ts packages/backend/src/workflows/agent-assignment.test.ts packages/backend/src/workflows/graph/superpowers-routing-nodes.ts packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts packages/backend/src/workflows/graph/nodes.ts packages/backend/src/session.routes.ts packages/backend/src/session.routes.test.ts
git commit -m "feat(workflow): 显式生成子代理分配门禁"
```

---

## Task 7: Scope And Plan Change Request Recovery

**Files:**
- Modify: `packages/backend/src/workflows/graph/agent-events.ts`
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Test: `packages/backend/src/workflows/graph/agent-events.test.ts`
- Test: `packages/backend/src/workflows/graph/runtime.test.ts`

- [x] **Step 1: Write failing structured event parser test**

In `packages/backend/src/workflows/graph/agent-events.test.ts`, add:

```ts
test('parseStructuredAgentEvent accepts scope_change_request payload', () => {
  const event = parseStructuredAgentEvent(JSON.stringify({
    workflowRunId: 'run-1',
    stepId: 'step-1',
    agentRunId: 'agent-run-1',
    type: 'scope_change_request',
    summary: '需要修改 shared type',
    detail: '新增字段会影响前后端契约',
    requestedScopeWrite: ['packages/backend/src/types.ts'],
    createdAt: 1,
  }));

  assert.equal(event?.type, 'scope_change_request');
  assert.deepEqual(event?.requestedScopeWrite, ['packages/backend/src/types.ts']);
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/agent-events.test.ts
```

Expected: FAIL if parser strips `requestedScopeWrite` or rejects passthrough.

- [x] **Step 3: Normalize change request events**

In `packages/backend/src/workflows/graph/agent-events.ts`, ensure structured event parsing preserves passthrough fields and add:

```ts
export function isWorkflowChangeRequestEvent(event: StructuredAgentEvent): boolean {
  return event.type === 'scope_change_request' || event.type === 'decision_request';
}
```

If `plan_change_request` is not in the enum, add it to `structuredAgentEventTypeSchema` and frontend mirror types.

- [x] **Step 4: Pause workflow on change request**

In `packages/backend/src/workflows/graph/nodes.ts`, after worker run output is parsed into structured events, detect:

```ts
const changeRequest = parsedEvents.find((event) =>
  event.type === 'scope_change_request' || event.type === 'plan_change_request'
);
if (changeRequest) {
  const nextState = recordStructuredAgentEvent({
    tools,
    context,
    state,
    event: changeRequest,
  });
  return {
    ...nextState,
    activeChangeRequestId: `${changeRequest.stepId}:${changeRequest.createdAt}`,
    status: 'blocked',
    error: changeRequest.type === 'scope_change_request'
      ? 'scope_change_request'
      : 'plan_change_request',
    currentNode: 'route_skills',
    activeSuperpowersStage: changeRequest.type === 'scope_change_request' ? 'writing_plans' : 'brainstorming',
    approvedPlanArtifactVersionId: null,
    lightweightPlanArtifactVersionId: null,
    agentAssignmentArtifactVersionId: null,
    approvedAgentAssignmentArtifactVersionId: null,
  };
}
```

- [x] **Step 5: Ensure user-visible blocker**

In runtime, when `error` is `scope_change_request` or `plan_change_request`, do not retry worker automatically. Keep run blocked until planner revision is requested or resumed by artifact change handling.

Add a guard:

```ts
if (state.error === 'scope_change_request' || state.error === 'plan_change_request') {
  return state;
}
```

inside `resumeGraphWorkflowFromState()` before calculating `nodeToRun`.

- [x] **Step 6: Run runtime tests**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/agent-events.test.ts packages/backend/src/workflows/graph/runtime.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 7**

```bash
git add packages/backend/src/workflows/graph/agent-events.ts packages/backend/src/workflows/graph/agent-events.test.ts packages/backend/src/workflows/graph/nodes.ts packages/backend/src/workflows/graph/runtime.ts packages/backend/src/workflows/graph/runtime.test.ts packages/frontend/src/lib/types.ts
git commit -m "feat(workflow): 接入范围和计划变更请求"
```

---

## Task 8: Worktree And Finish Branch Real Decisions

**Files:**
- Modify: `packages/backend/src/workflows/graph/superpowers-nodes.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-gates.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`

- [x] **Step 1: Write failing worktree evidence test**

In `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`, update or add:

```ts
test('worktree node records explicit skip decision instead of not_available placeholder', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-worktree-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '轻量修改',
    projectPath: '/tmp/project',
  });

  const next = await graph.nodes.worktree({
    ...state,
    approvedSpecArtifactVersionId: 'artifact-spec-1',
  });

  assert.notEqual(next.worktree?.branchName, 'not_available');
  assert.equal(next.worktreeDecision?.action, 'skip');
  assert.match(next.worktreeDecision?.reason ?? '', /当前工作区|skip/i);
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/superpowers-runtime.test.ts
```

Expected: FAIL because current worktree branchName is `not_available`.

- [x] **Step 3: Replace worktree placeholder**

In `packages/backend/src/workflows/graph/superpowers-nodes.ts`, replace worktree node with:

```ts
async worktree(state) {
  const decision = {
    action: 'skip' as const,
    path: state.projectPath,
    branchName: null,
    reason: '当前 runtime 复用 session workspace；执行隔离由后续 using-git-worktrees 集成创建。',
  };
  return {
    ...state,
    superpowersPhase: 'worktree',
    worktreeDecision: decision,
    worktree: {
      path: decision.path,
      branchName: 'current-workspace',
      baseRef: decision.reason,
    },
  };
}
```

This is still a skip, but it is explicit evidence rather than a fake unavailable success. A later implementation can replace `skip` with actual `reuse/create`.

- [x] **Step 4: Write failing finish branch decision test**

Add:

```ts
test('finishBranch blocks for user decision instead of silently choosing keep_branch', async () => {
  const graph = buildSuperpowersRuntimeGraph();
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-finish-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '完成任务',
    projectPath: '/tmp/project',
  });

  const next = await graph.nodes.finishBranch({
    ...state,
    verificationEvidence: [{ command: 'npm run build', status: 'passed', required: true, exitCode: 0, summary: 'ok', verifiedAt: Date.now() }],
  });

  assert.equal(next.status, 'awaiting_decision');
  assert.equal(next.finishBranchDecision?.decision, null);
  assert.deepEqual(next.finishBranchDecision?.options, ['merge_local', 'create_pr', 'keep_branch', 'discard_work']);
});
```

- [x] **Step 5: Replace default finish decision**

In `finishBranch(state)`, return:

```ts
finishBranchDecision: state.finishBranchDecision ?? {
  decision: null,
  options: SUPERPOWERS_FINISH_BRANCH_OPTIONS,
  reason: '等待用户选择分支收尾方式',
  decidedAt: null,
},
status: state.finishBranchDecision?.decision ? state.status : 'awaiting_decision',
error: null,
```

If `superpowersFinishBranchDecisionSchema` currently requires non-null decision/decidedAt, update it to allow:

```ts
decision: z.enum(['merge_local', 'create_pr', 'keep_branch', 'discard_work']).nullable(),
decidedAt: z.string().nullable(),
```

- [x] **Step 6: Run tests**

Run:

```bash
node --import tsx --test packages/backend/src/workflows/graph/superpowers-runtime.test.ts packages/backend/src/workflows/graph/state.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 8**

```bash
git add packages/backend/src/workflows/graph/superpowers-nodes.ts packages/backend/src/workflows/graph/superpowers-runtime.test.ts packages/backend/src/workflows/graph/state.ts packages/backend/src/workflows/graph/state.test.ts
git commit -m "feat(workflow): 明确worktree和分支收尾门禁"
```

---

## Task 9: Frontend Workflow Controller, Assignment, And Change Request Panels

**Files:**
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/session-ui/SessionShellView.tsx`
- Modify: `packages/frontend/src/session-ui/session-os.css`
- Modify: `packages/frontend/src/pages/SessionWorkspacePage.tsx`
- Test: `packages/frontend/src/session-ui/SessionShell.test.tsx`
- Test: `packages/frontend/src/pages/SessionWorkspacePage.test.tsx`

- [ ] **Step 1: Write failing SessionShell render test**

In `packages/frontend/src/session-ui/SessionShell.test.tsx`, add:

```ts
test('SessionShell renders workflow controller and agent assignment table', () => {
  const detail = buildSessionDetailFixture({
    workflowController: {
      workflow_run_id: 'workflow-1',
      selected_intent: 'standard_development',
      active_stage: 'agent_assignment',
      controller: 'planner',
      blocker: null,
      next_action: '等待用户确认计划',
    },
    workflowAgentAssignments: [{
      task_id: 'task-1',
      task_title: '实现设置页',
      role: 'executor',
      assigned_agent_id: 'fullstack-engineer',
      assigned_agent_name: '全栈工程师',
      backend: 'codex',
      fallback_reason: '未找到更匹配的专门子代理，使用全栈工程师兜底执行',
      execution_mode: 'serial',
      scope_write: ['packages/frontend/src/pages/SettingsPage.tsx'],
    }],
  });

  const html = renderSessionShell({ detail });
  assert.match(html, /data-workflow-controller-panel="true"/);
  assert.match(html, /standard_development/);
  assert.match(html, /data-agent-assignment-table="true"/);
  assert.match(html, /全栈工程师/);
  assert.match(html, /未找到更匹配/);
});
```

Use existing render helpers in the test file. If fixture helper names differ, adapt this test to the local helper patterns.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test packages/frontend/src/session-ui/SessionShell.test.tsx
```

Expected: FAIL because the new panels do not render.

- [ ] **Step 3: Add controller panel component**

In `packages/frontend/src/session-ui/SessionShellView.tsx`, add:

```tsx
function WorkflowControllerPanel({ controller }: { controller?: WorkflowControllerView | null }): JSX.Element | null {
  if (!controller) return null;
  return (
    <section className="deepsea-workflow-controller" data-workflow-controller-panel="true" aria-label="Workflow controller">
      <div>
        <span className="deepsea-status-chip" data-tone="info">Workflow</span>
        <strong>{controller.selected_intent ?? 'unrouted'}</strong>
      </div>
      <dl>
        <div><dt>Stage</dt><dd>{controller.active_stage ?? 'pending'}</dd></div>
        <div><dt>Controller</dt><dd>{controller.controller ?? 'planner'}</dd></div>
        <div><dt>Next</dt><dd>{controller.next_action ?? '等待推进'}</dd></div>
      </dl>
      {controller.blocker ? <p>{controller.blocker}</p> : null}
    </section>
  );
}
```

Render it near the existing workflow artifact panel:

```tsx
<WorkflowControllerPanel controller={detail.workflowController ?? null} />
```

- [ ] **Step 4: Add assignment table component**

In the same file:

```tsx
function WorkflowAgentAssignmentTable({ assignments }: { assignments?: WorkflowAgentAssignmentView[] }): JSX.Element | null {
  if (!assignments || assignments.length === 0) return null;
  return (
    <section className="deepsea-agent-assignment" data-agent-assignment-table="true" aria-label="子代理分配">
      <header>
        <span className="deepsea-status-chip" data-tone="info">Assignments</span>
        <strong>子代理分配</strong>
      </header>
      <div className="deepsea-agent-assignment__rows">
        {assignments.map((assignment) => (
          <article key={`${assignment.task_id}:${assignment.role}`}>
            <div>
              <strong>{assignment.task_title}</strong>
              <span>{assignment.role} · {assignment.execution_mode}</span>
            </div>
            <div>
              <span>{assignment.assigned_agent_name ?? assignment.assigned_agent_id ?? '未分配'}</span>
              {assignment.backend ? <small>{assignment.backend}</small> : null}
            </div>
            {assignment.fallback_reason ? <p>{assignment.fallback_reason}</p> : null}
            <code>{assignment.scope_write.join(', ') || 'scopeWrite 未声明'}</code>
          </article>
        ))}
      </div>
    </section>
  );
}
```

Render:

```tsx
<WorkflowAgentAssignmentTable assignments={detail.workflowAgentAssignments ?? []} />
```

- [ ] **Step 5: Add compact CSS**

In `packages/frontend/src/session-ui/session-os.css`, add:

```css
.deepsea-workflow-controller,
.deepsea-agent-assignment {
  border: 1px solid color-mix(in srgb, var(--deepsea-border) 80%, transparent);
  border-radius: 8px;
  background: var(--deepsea-surface);
  padding: 12px;
  display: grid;
  gap: 10px;
}

.deepsea-workflow-controller dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}

.deepsea-workflow-controller dt,
.deepsea-agent-assignment small {
  color: var(--deepsea-muted);
  font-size: 12px;
}

.deepsea-workflow-controller dd {
  margin: 0;
  font-size: 13px;
}

.deepsea-agent-assignment__rows {
  display: grid;
  gap: 8px;
}

.deepsea-agent-assignment__rows article {
  display: grid;
  gap: 6px;
  border: 1px solid color-mix(in srgb, var(--deepsea-border) 70%, transparent);
  border-radius: 8px;
  padding: 10px;
}

.deepsea-agent-assignment code {
  white-space: normal;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 6: Run frontend tests**

Run:

```bash
node --import tsx --test packages/frontend/src/session-ui/SessionShell.test.tsx packages/frontend/src/pages/SessionWorkspacePage.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 9**

```bash
git add packages/frontend/src/lib/types.ts packages/frontend/src/session-ui/SessionShellView.tsx packages/frontend/src/session-ui/session-os.css packages/frontend/src/pages/SessionWorkspacePage.tsx packages/frontend/src/session-ui/SessionShell.test.tsx packages/frontend/src/pages/SessionWorkspacePage.test.tsx
git commit -m "feat(frontend): 展示工作流控制和子代理分配"
```

---

## Task 10: Final Integration Verification And Completion Audit

**Files:**
- Modify: `docs/superpowers/plans/2026-06-13-全流程Workflow-first多意图路由实施计划.md`
- Test-only command execution.

- [ ] **Step 1: Run backend targeted workflow suite**

Run:

```bash
node --import tsx --test \
  packages/backend/src/workflows/graph/state.test.ts \
  packages/backend/src/workflows/superpowers-stage-registry.test.ts \
  packages/backend/src/workflows/graph/superpowers-route-compiler.test.ts \
  packages/backend/src/workflows/graph/superpowers-routing-nodes.test.ts \
  packages/backend/src/workflows/session-workflow-intake.test.ts \
  packages/backend/src/session-message-dispatch.test.ts \
  packages/backend/src/workflows/graph/runtime.test.ts \
  packages/backend/src/session.routes.test.ts
```

Expected: PASS. If a test fails, stop and fix the failing task before continuing.

- [ ] **Step 2: Run frontend targeted suite**

Run:

```bash
node --import tsx --test \
  packages/frontend/src/session-ui/SessionShell.test.tsx \
  packages/frontend/src/pages/SessionWorkspacePage.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS with backend TypeScript compile and frontend Vite build completing.

- [ ] **Step 4: Search for forbidden old routing behavior**

Run:

```bash
rg -n "if \\(riskGate\\.applies\\)|lightweight_plan_revision_not_implemented|branchName: 'not_available'|startSessionPlannerRun\\(" packages/backend/src
```

Expected:

- No `if (riskGate.applies)` in `session-message-dispatch.ts`.
- No `lightweight_plan_revision_not_implemented`.
- No `branchName: 'not_available'`.
- `startSessionPlannerRun(` may exist only as function definition or explicitly internal compatibility path, not in ordinary dispatch flow.

- [ ] **Step 5: Completion verification audit**

Manually verify the following against code and tests:

1. Ordinary session messages create `superpowers-v2` workflow runs.
2. Chat intent can route to `answer` and complete without child tasks.
3. Analysis intent can create analysis artifact.
4. Lightweight plan can be generated, approved, revised, and dispatched.
5. Standard development path still supports spec and plan confirmation.
6. Debug path routes through debug plan and systematic debugging.
7. Review-only path does not create executor child tasks.
8. Agent assignment artifact records fallback reason.
9. Fullstack fallback is executor-only.
10. Scope/plan change request pauses workflow and returns to planner revision.
11. Worktree node no longer records `not_available` placeholder as success.
12. Finish branch awaits explicit user decision.
13. Frontend renders controller panel and assignment table.

- [ ] **Step 6: Mark plan tasks completed as they are implemented**

When executing this plan, update this file's checkboxes for completed steps and include that update in the final task commit:

```bash
git add docs/superpowers/plans/2026-06-13-全流程Workflow-first多意图路由实施计划.md
git commit -m "docs(workflow): 更新多意图路由实施进度"
```

---

## Self-Review

Spec coverage:

1. 全 workflow-first 入口：Task 4。
2. 多意图 routing graph：Task 1、Task 2、Task 3。
3. answer / analysis / lightweight / standard / debug / review-only：Task 3、Task 5。
4. artifact 只读与修订闭环：Task 5，沿用已有 artifact gate，Task 9 扩展 UI。
5. agent assignment 显式化：Task 6、Task 9。
6. scope/plan change request：Task 7。
7. worktree 与 finish branch：Task 8。
8. frontend controller/assignment/change visibility：Task 9。
9. verification and audit：Task 10。

Placeholder scan:

- No `TBD`.
- No implementation placeholders.
- Where code is intentionally simplified, the plan gives exact minimum implementation and a later task for stricter behavior.

Type consistency:

- Backend and frontend both use `WorkflowArtifactVersionType` additions.
- New graph nodes are added to backend node type, frontend node type, and backend state enum.
- `agentAssignmentArtifactVersionId` and `approvedAgentAssignmentArtifactVersionId` are graph state fields and session view data derives from graph state.
