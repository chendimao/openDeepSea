# LangChain Planner 阶段 A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 LangChain Planner 作为 OpenClaw 编排替代路线的阶段 A，让系统在 ACP-only 模式下生成结构化计划，并继续复用现有 workflow orchestrator 执行。

**Architecture:** 阶段 A 不替换整个工作流状态机，只新增 planner schema/service，并把 planning 阶段的输出收敛为稳定 JSON artifact。LangChain 只负责规划和结构化输出；OpenClaw Room 仍负责状态落库、消息广播、审批和 ACP 执行。

**Tech Stack:** TypeScript, Node.js, Express, SQLite, zod, LangChain JS, ACP adapters, React/Vite.

---

## Scope Check

本计划只实现阶段 A：LangChain Planner。阶段 B 的 LangGraph runtime、checkpoint、graph state 和完整节点迁移不在本计划内，只在文末保留后续里程碑。

## Command Convention

除非步骤明确写出 workspace 参数，后端单文件测试命令都在 `packages/backend` 目录执行；根目录执行的命令会显式使用 `-w @openclaw-room/backend` 或 `-w @openclaw-room/frontend`。

## File Structure

- Modify: `packages/backend/package.json`
  - 增加阶段 A 所需 LangChain 依赖。
- Modify: `packages/backend/src/workflows/plan-parser.ts`
  - 扩展计划 schema，兼容旧 plan 格式并支持 LangChain Planner 的 `goal/summary/steps/verification/risks/needsApproval`。
- Modify: `packages/backend/src/workflows/plan-parser.test.ts`
  - 覆盖新 plan schema、旧 plan 兼容、非法 plan 拒绝。
- Create: `packages/backend/src/workflows/langchain-planner.ts`
  - 负责构造 planner 输入、调用 LangChain、校验输出、返回可落库计划。
- Create: `packages/backend/src/workflows/langchain-planner.test.ts`
  - 用 fake model 或 fake invoke function 测试 planner service，不调用真实外部模型。
- Modify: `packages/backend/src/workflows/prompts.ts`
  - 增强 planning prompt，使 ACP planner 和 LangChain planner 使用同一结构化计划协议。
- Modify: `packages/backend/src/workflows/orchestrator.ts`
  - 在 planning 阶段优先尝试 LangChain Planner；未配置模型时回退现有 ACP planning。
- Modify: `packages/backend/src/workflows/orchestrator.test.ts`
  - 若当前无该文件，则新建，用 fake planner 验证 planning artifact 落库和 approval 状态。
- Modify: `packages/backend/src/db.ts`
  - 增加 room agent 能力字段和默认 runtime 字段；既有 agent 默认保持 `openclaw`，ACP 模板显式写入 `acp`。
- Modify: `packages/backend/src/types.ts`
  - 增加 `AgentDefaultRuntime`、`capabilities`、`default_runtime` 等类型。
- Modify: `packages/backend/src/repos/rooms.ts`
  - 读写新增 room agent 字段。
- Modify: `packages/backend/src/routes.ts`
  - 新增内置 agent 模板接口，并支持添加模板 agent。
- Modify: `packages/frontend/src/lib/types.ts`
  - 同步新增 agent 字段和模板类型。
- Modify: `packages/frontend/src/lib/api.ts`
  - 增加模板接口。
- Modify: `packages/frontend/src/components/AddAgentDialog.tsx`
  - OpenClaw agents 不再是唯一入口，优先展示内置 ACP agent 模板。

## Task 1: Install LangChain Dependencies and Config Surface

**Files:**
- Modify: `packages/backend/package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

- [ ] **Step 1: Add failing dependency expectation test**

Create a lightweight test that verifies planner configuration can be read without importing LangChain yet.

Create: `packages/backend/src/workflows/langchain-planner.test.ts`

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { getLangChainPlannerConfig } from './langchain-planner.js';

test('getLangChainPlannerConfig returns disabled config when no model is configured', () => {
  const config = getLangChainPlannerConfig({
    LANGCHAIN_PLANNER_MODEL: '',
    OPENAI_API_KEY: '',
  });

  assert.equal(config.enabled, false);
  assert.equal(config.model, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --import tsx --test src/workflows/langchain-planner.test.ts
```

Expected: FAIL because `./langchain-planner.js` does not exist.

- [ ] **Step 3: Add dependencies**

Run from repo root:

```bash
npm install -w @openclaw-room/backend langchain @langchain/openai @langchain/core
```

Expected: `packages/backend/package.json` contains `langchain`, `@langchain/openai`, and `@langchain/core`; `package-lock.json` updates; install exits 0.

- [ ] **Step 4: Create minimal planner config module**

Create `packages/backend/src/workflows/langchain-planner.ts`:

```ts
export interface LangChainPlannerConfig {
  enabled: boolean;
  model: string | null;
}

export function getLangChainPlannerConfig(
  env: Pick<NodeJS.ProcessEnv, 'LANGCHAIN_PLANNER_MODEL' | 'OPENAI_API_KEY'> = process.env,
): LangChainPlannerConfig {
  const model = env.LANGCHAIN_PLANNER_MODEL?.trim() || '';
  const hasApiKey = Boolean(env.OPENAI_API_KEY?.trim());
  return {
    enabled: Boolean(model && hasApiKey),
    model: model || null,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --import tsx --test src/workflows/langchain-planner.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 6: Document configuration**

Modify `README.md`, add a short optional configuration block under prerequisites or quick start:

```md
### Optional: LangChain Planner

LangChain Planner is optional in phase A. When disabled, workflow planning falls back to the existing ACP planner stage.

```bash
LANGCHAIN_PLANNER_MODEL=gpt-4.1-mini
OPENAI_API_KEY=<your-api-key>
```
```

- [ ] **Step 7: Commit**

```bash
git add packages/backend/package.json package-lock.json packages/backend/src/workflows/langchain-planner.ts packages/backend/src/workflows/langchain-planner.test.ts README.md
git commit -m "feat(workflows): 添加 LangChain Planner 配置"
```

## Task 2: Define LangChain Plan Schema and Backward-Compatible Parser

**Files:**
- Modify: `packages/backend/src/workflows/plan-parser.ts`
- Modify: `packages/backend/src/workflows/plan-parser.test.ts`

- [ ] **Step 1: Write failing tests for new plan schema**

Append to `packages/backend/src/workflows/plan-parser.test.ts`:

```ts
test('parsePlanArtifact parses LangChain planner plan shape', () => {
  const plan = parsePlanArtifact(`
\`\`\`json
{
  "goal": "修复 OpenCode 空消息",
  "summary": "收紧 stdout 解析并处理空输出",
  "assumptions": ["ACP adapter 已存在"],
  "steps": [
    {
      "title": "补充解析测试",
      "intent": "覆盖 OpenCode text event",
      "assigneeRole": "executor",
      "preferredBackend": "codex",
      "scopeRead": ["packages/backend/src/acp/claudecode.ts"],
      "scopeWrite": ["packages/backend/src/acp/claudecode.test.ts"],
      "acceptance": ["测试先失败再通过"],
      "dependsOn": []
    }
  ],
  "risks": ["误收用户回显"],
  "verification": [
    {"command": "npm run test -w @openclaw-room/backend", "reason": "后端回归", "required": true}
  ],
  "needsApproval": false
}
\`\`\`
  `);

  assert.equal(plan.summary, '收紧 stdout 解析并处理空输出');
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0]?.title, '补充解析测试');
  assert.equal(plan.tasks[0]?.suggestedRole, 'executor');
  assert.equal(plan.tasks[0]?.priority, 'normal');
  assert.deepEqual(plan.tasks[0]?.scopeWrite, ['packages/backend/src/acp/claudecode.test.ts']);
  assert.equal(plan.needsApproval, false);
});

test('parsePlanArtifact rejects LangChain plan steps without acceptance criteria', () => {
  assert.throws(
    () =>
      parsePlanArtifact(`{"goal":"x","summary":"x","steps":[{"title":"x","intent":"x","assigneeRole":"executor","scopeRead":[],"scopeWrite":[],"dependsOn":[]}],"verification":[],"risks":[],"needsApproval":false}`),
    /acceptance/i,
  );
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import tsx --test src/workflows/plan-parser.test.ts
```

Expected: FAIL because `ParsedPlanTask` lacks `scopeWrite` and parser does not accept `steps`.

- [ ] **Step 3: Extend parser types and schemas**

Modify `packages/backend/src/workflows/plan-parser.ts`:

```ts
const workflowRoleSchema = z.enum(['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor']);
const acpBackendSchema = z.enum(['claudecode', 'opencode', 'codex']);

const verificationCommandSchema = z.object({
  command: z.string().min(1),
  reason: z.string().default(''),
  required: z.boolean().default(true),
});

const langChainPlanStepSchema = z.object({
  title: z.string().min(1),
  intent: z.string().min(1),
  assigneeRole: workflowRoleSchema.default('executor'),
  preferredBackend: acpBackendSchema.optional(),
  scopeRead: z.array(z.string()).default([]),
  scopeWrite: z.array(z.string()).default([]),
  acceptance: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string()).default([]),
});

const langChainPlanSchema = z.object({
  goal: z.string().min(1),
  summary: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  steps: z.array(langChainPlanStepSchema).min(1),
  risks: z.array(z.string()).default([]),
  verification: z.array(verificationCommandSchema).default([]),
  needsApproval: z.boolean().default(true),
});
```

Update `ParsedPlanTask`:

```ts
export interface ParsedPlanTask {
  title: string;
  description: string;
  suggestedRole: WorkflowRole;
  priority: TaskPriority;
  acceptance: string[];
  scopeRead: string[];
  scopeWrite: string[];
  preferredBackend?: 'claudecode' | 'opencode' | 'codex';
  dependsOn: string[];
}
```

Update `ParsedPlan`:

```ts
export interface ParsedPlan {
  goal: string | null;
  summary: string;
  tasks: ParsedPlanTask[];
  reviewFocus: string[];
  verification: string[];
  risks: string[];
  assumptions: string[];
  needsApproval: boolean;
}
```

Normalize old and new schemas:

```ts
export function parsePlanArtifact(output: string): ParsedPlan {
  const jsonText = extractJson(output);
  const parsed = JSON.parse(jsonText) as unknown;
  const modern = langChainPlanSchema.safeParse(parsed);
  if (modern.success) return normalizeLangChainPlan(modern.data);
  return normalizeLegacyPlan(planSchema.parse(parsed));
}
```

Add helpers:

```ts
function normalizeLangChainPlan(plan: z.infer<typeof langChainPlanSchema>): ParsedPlan {
  return {
    goal: plan.goal,
    summary: plan.summary,
    tasks: plan.steps.map((step) => ({
      title: step.title,
      description: step.intent,
      suggestedRole: step.assigneeRole,
      priority: 'normal',
      acceptance: step.acceptance,
      scopeRead: step.scopeRead,
      scopeWrite: step.scopeWrite,
      preferredBackend: step.preferredBackend,
      dependsOn: step.dependsOn,
    })),
    reviewFocus: [],
    verification: plan.verification.map((item) => item.command),
    risks: plan.risks,
    assumptions: plan.assumptions,
    needsApproval: plan.needsApproval,
  };
}

function normalizeLegacyPlan(plan: z.infer<typeof planSchema>): ParsedPlan {
  return {
    goal: null,
    summary: plan.summary,
    tasks: plan.tasks.map((task) => ({
      ...task,
      scopeRead: [],
      scopeWrite: [],
      dependsOn: [],
    })),
    reviewFocus: plan.reviewFocus,
    verification: plan.verification,
    risks: plan.risks,
    assumptions: [],
    needsApproval: true,
  };
}
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
node --import tsx --test src/workflows/plan-parser.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/workflows/plan-parser.ts packages/backend/src/workflows/plan-parser.test.ts
git commit -m "feat(workflows): 支持 LangChain 结构化计划"
```

## Task 3: Implement LangChain Planner Service with Test Double Support

**Files:**
- Modify: `packages/backend/src/workflows/langchain-planner.ts`
- Modify: `packages/backend/src/workflows/langchain-planner.test.ts`

- [ ] **Step 1: Write failing service test**

Append to `packages/backend/src/workflows/langchain-planner.test.ts`:

```ts
import type { Room, RoomAgent, Task } from '../types.js';

test('generateLangChainPlan validates model output into ParsedPlan', async () => {
  const plan = await generateLangChainPlan(
    {
      projectName: 'OpenClaw Room',
      projectPath: '/repo',
      room: fakeRoom(),
      task: fakeTask(),
      agents: [fakeAgent({ workflow_role: 'executor', acp_enabled: 1, acp_backend: 'codex' })],
      memories: ['偏好：先写测试'],
      recentMessages: ['用户：修复空消息'],
    },
    {
      invoke: async () => `\`\`\`json
{
  "goal": "修复空消息",
  "summary": "补测试并修复",
  "assumptions": [],
  "steps": [{
    "title": "补测试",
    "intent": "覆盖空输出",
    "assigneeRole": "executor",
    "scopeRead": [],
    "scopeWrite": ["packages/backend/src/dispatcher.test.ts"],
    "acceptance": ["测试失败后通过"],
    "dependsOn": []
  }],
  "risks": [],
  "verification": [{"command": "npm run test -w @openclaw-room/backend", "reason": "回归", "required": true}],
  "needsApproval": false
}
\`\`\``,
    },
  );

  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0]?.suggestedRole, 'executor');
});

function fakeRoom(): Room {
  return { id: 'room-1', project_id: 'project-1', name: 'Room', description: null, created_at: 1 };
}

function fakeTask(): Task {
  return {
    id: 'task-1',
    room_id: 'room-1',
    project_id: 'project-1',
    parent_task_id: null,
    title: '修复空消息',
    description: 'OpenCode 成功但消息为空',
    status: 'todo',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: null,
    source_message_id: null,
    created_from: 'manual',
    created_at: 1,
    updated_at: 1,
    completed_at: null,
  };
}

function fakeAgent(patch: Partial<RoomAgent>): RoomAgent {
  return {
    id: 'agent-1',
    room_id: 'room-1',
    agent_id: 'executor',
    agent_name: 'Executor',
    agent_role: null,
    workflow_role: null,
    joined_at: 1,
    acp_enabled: 0,
    acp_backend: null,
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
    memory_max_context_chars: null,
    ...patch,
  };
}
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --import tsx --test src/workflows/langchain-planner.test.ts
```

Expected: FAIL because `generateLangChainPlan` is not exported.

- [ ] **Step 3: Implement service interfaces and prompt construction**

Modify `packages/backend/src/workflows/langchain-planner.ts`:

```ts
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { parsePlanArtifact, type ParsedPlan } from './plan-parser.js';
import type { Room, RoomAgent, Task } from '../types.js';

export interface LangChainPlannerInput {
  projectName: string;
  projectPath: string;
  room: Room;
  task: Task;
  agents: RoomAgent[];
  memories: string[];
  recentMessages: string[];
}

export interface PlannerInvoker {
  invoke(messages: Array<SystemMessage | HumanMessage>): Promise<string>;
}

export async function generateLangChainPlan(
  input: LangChainPlannerInput,
  invoker = createDefaultPlannerInvoker(),
): Promise<ParsedPlan> {
  const output = await invoker.invoke(buildPlannerMessages(input));
  return parsePlanArtifact(output);
}

export function buildPlannerMessages(input: LangChainPlannerInput): Array<SystemMessage | HumanMessage> {
  return [
    new SystemMessage([
      '你是 OpenClaw Room 的 LangChain Planner。',
      '只负责生成结构化开发计划，不执行代码修改。',
      '必须输出 JSON 代码块，字段为 goal、summary、assumptions、steps、risks、verification、needsApproval。',
      'steps 每项必须包含 title、intent、assigneeRole、scopeRead、scopeWrite、acceptance、dependsOn。',
      '如果没有可执行 ACP agent，必须在 risks 中说明，并设置 needsApproval=true。',
    ].join('\n')),
    new HumanMessage(formatPlannerInput(input)),
  ];
}

function createDefaultPlannerInvoker(): PlannerInvoker {
  const config = getLangChainPlannerConfig();
  if (!config.enabled || !config.model) {
    throw new Error('LangChain Planner is not configured');
  }
  const model = new ChatOpenAI({ model: config.model, temperature: 0 });
  return {
    async invoke(messages) {
      const result = await model.invoke(messages);
      return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    },
  };
}

function formatPlannerInput(input: LangChainPlannerInput): string {
  return [
    `项目：${input.projectName}`,
    `路径：${input.projectPath}`,
    `聊天室：${input.room.name}`,
    `任务：${input.task.title}`,
    `描述：${input.task.description ?? '无'}`,
    '',
    '可用智能体：',
    input.agents.map(formatAgent).join('\n') || '无',
    '',
    '相关记忆：',
    input.memories.join('\n') || '无',
    '',
    '最近消息：',
    input.recentMessages.join('\n') || '无',
  ].join('\n');
}

function formatAgent(agent: RoomAgent): string {
  return [
    `- ${agent.agent_name} (${agent.agent_id})`,
    `workflow_role=${agent.workflow_role ?? '未设置'}`,
    `acp_enabled=${agent.acp_enabled ? 'true' : 'false'}`,
    `acp_backend=${agent.acp_backend ?? 'none'}`,
    `说明=${agent.agent_role ?? '无'}`,
  ].join('；');
}
```

- [ ] **Step 4: Run service tests**

Run:

```bash
node --import tsx --test src/workflows/langchain-planner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/workflows/langchain-planner.ts packages/backend/src/workflows/langchain-planner.test.ts
git commit -m "feat(workflows): 实现 LangChain Planner 服务"
```

## Task 4: Integrate Planner Service into Existing Orchestrator with Fallback

**Files:**
- Modify: `packages/backend/src/workflows/orchestrator.ts`
- Modify: `packages/backend/src/workflows/prompts.ts`
- Create or Modify: `packages/backend/src/workflows/orchestrator.test.ts`

- [ ] **Step 1: Write failing orchestrator-level helper test**

If `packages/backend/src/workflows/orchestrator.test.ts` does not exist, create it. Add:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseLangChainPlanner } from './orchestrator.js';

test('shouldUseLangChainPlanner requires planning stage and enabled config', () => {
  assert.equal(shouldUseLangChainPlanner('planning', { enabled: true, model: 'gpt-4.1-mini' }), true);
  assert.equal(shouldUseLangChainPlanner('analysis', { enabled: true, model: 'gpt-4.1-mini' }), false);
  assert.equal(shouldUseLangChainPlanner('planning', { enabled: false, model: null }), false);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --import tsx --test src/workflows/orchestrator.test.ts
```

Expected: FAIL because `shouldUseLangChainPlanner` is not exported.

- [ ] **Step 3: Export planner decision helper**

Modify `packages/backend/src/workflows/orchestrator.ts` imports:

```ts
import { formatMemoryContext } from '../memory/context.js';
import { memoryRepo } from '../repos/memory.js';
import {
  generateLangChainPlan,
  getLangChainPlannerConfig,
  type LangChainPlannerConfig,
} from './langchain-planner.js';
```

Add near helper functions:

```ts
export function shouldUseLangChainPlanner(stage: WorkflowStage, config: LangChainPlannerConfig): boolean {
  return stage === 'planning' && config.enabled;
}
```

- [ ] **Step 4: Run helper test**

Run:

```bash
node --import tsx --test src/workflows/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add async LangChain planning path**

Modify `startAgentStage` before selecting agent:

```ts
const plannerConfig = getLangChainPlannerConfig();
if (shouldUseLangChainPlanner(stage, plannerConfig)) {
  startLangChainPlanningStage(run, task);
  return;
}
```

Add function:

```ts
function startLangChainPlanningStage(run: WorkflowRun, task: Task): void {
  const context = getContext(run);
  const prompt = 'LangChain Planner 生成结构化计划。';
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'planning',
    status: 'running',
    prompt,
    sort_order: nextSortOrder(run.id),
  });
  broadcastStep('workflow_step:created', run.room_id, step);
  const updatedRun = workflowRepo.updateRun(run.id, { status: 'running', current_stage: 'planning', error: null });
  if (updatedRun) broadcastWorkflow('workflow:updated', updatedRun);

  void generateLangChainPlan({
    projectName: context.project.name,
    projectPath: context.project.path,
    room: context.room,
    task,
    agents: context.agents,
    memories: [buildPlannerMemoryContext(context.project.id, context.room.id, task.id)].filter(Boolean),
    recentMessages: context.artifacts.slice(-5).map((artifact) => `${artifact.title}\n${artifact.content}`),
  })
    .then((plan) => {
      const output = formatParsedPlanArtifact(plan);
      finishPlanning(run, step, output);
    })
    .catch((err) => {
      markStepFailed(run, step, (err as Error).message);
      block(run, (err as Error).message);
    });
}
```

Add planner memory helper so the LangChain planner can use project/room/task memory without requiring a concrete room agent id:

```ts
function buildPlannerMemoryContext(projectId: string, roomId: string, taskId: string): string {
  try {
    return formatMemoryContext(memoryRepo.listForRoomContext({
      projectId,
      roomId,
      taskId,
    }));
  } catch (err) {
    console.warn(`[memory] failed to load planner memory context: ${(err as Error).message}`);
    return '';
  }
}
```

Add formatter:

```ts
function formatParsedPlanArtifact(plan: ParsedPlan): string {
  return [
    '```json',
    JSON.stringify({
      goal: plan.goal ?? plan.summary,
      summary: plan.summary,
      assumptions: plan.assumptions,
      steps: plan.tasks.map((task) => ({
        title: task.title,
        intent: task.description,
        assigneeRole: task.suggestedRole,
        preferredBackend: task.preferredBackend,
        scopeRead: task.scopeRead,
        scopeWrite: task.scopeWrite,
        acceptance: task.acceptance,
        dependsOn: task.dependsOn,
      })),
      risks: plan.risks,
      verification: plan.verification.map((command) => ({ command, reason: '', required: true })),
      needsApproval: plan.needsApproval,
    }, null, 2),
    '```',
  ].join('\n');
}
```

Also import `type ParsedPlan` from `plan-parser.js`.

- [ ] **Step 6: Update planning prompt for ACP fallback**

Modify `buildPlanningPrompt` in `packages/backend/src/workflows/prompts.ts` so ACP fallback emits the same modern shape:

```ts
'必须输出一个 JSON 代码块，字段为 goal、summary、assumptions、steps、risks、verification、needsApproval。',
'steps 中每项必须包含 title、intent、assigneeRole、scopeRead、scopeWrite、acceptance、dependsOn。',
'assigneeRole 只能是 analyst、planner、coordinator、executor、reviewer、acceptor。',
```

- [ ] **Step 7: Run workflow tests**

Run:

```bash
node --import tsx --test src/workflows/plan-parser.test.ts src/workflows/langchain-planner.test.ts src/workflows/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/workflows/orchestrator.ts packages/backend/src/workflows/prompts.ts packages/backend/src/workflows/orchestrator.test.ts
git commit -m "feat(workflows): 接入 LangChain 规划阶段"
```

## Task 5: Add ACP-only Built-in Agent Templates

**Files:**
- Modify: `packages/backend/src/db.ts`
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/backend/src/repos/rooms.ts`
- Modify: `packages/backend/src/routes.ts`
- Modify: `packages/backend/src/workflows/langchain-planner.test.ts`
- Create: `packages/backend/src/agent-templates.ts`
- Create: `packages/backend/src/agent-templates.test.ts`

- [ ] **Step 1: Write failing template tests**

Create `packages/backend/src/agent-templates.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { listBuiltInAgentTemplates } from './agent-templates.js';

test('listBuiltInAgentTemplates includes planner executor reviewer acceptor', () => {
  const templates = listBuiltInAgentTemplates();
  const roles = templates.map((template) => template.workflow_role);

  assert.ok(roles.includes('planner'));
  assert.ok(roles.includes('executor'));
  assert.ok(roles.includes('reviewer'));
  assert.ok(roles.includes('acceptor'));
  assert.ok(templates.every((template) => template.acp_enabled === true));
  assert.ok(templates.every((template) => template.acp_backend === 'codex'));
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --import tsx --test src/agent-templates.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Create templates module**

Create `packages/backend/src/agent-templates.ts`:

```ts
import type { AcpBackend, WorkflowRole } from './types.js';

export interface BuiltInAgentTemplate {
  id: string;
  name: string;
  description: string;
  workflow_role: WorkflowRole;
  acp_enabled: true;
  acp_backend: AcpBackend;
  capabilities: string[];
}

export function listBuiltInAgentTemplates(): BuiltInAgentTemplate[] {
  return [
    {
      id: 'planner',
      name: 'Planner',
      description: '生成结构化计划和任务拆分。',
      workflow_role: 'planner',
      acp_enabled: true,
      acp_backend: 'codex',
      capabilities: ['planning', 'architecture'],
    },
    {
      id: 'backend-executor',
      name: 'Backend Executor',
      description: '执行后端代码修改和测试。',
      workflow_role: 'executor',
      acp_enabled: true,
      acp_backend: 'codex',
      capabilities: ['backend', 'testing'],
    },
    {
      id: 'frontend-executor',
      name: 'Frontend Executor',
      description: '执行前端代码修改和界面验证。',
      workflow_role: 'executor',
      acp_enabled: true,
      acp_backend: 'codex',
      capabilities: ['frontend', 'testing'],
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      description: '审查代码、风险和验证缺口。',
      workflow_role: 'reviewer',
      acp_enabled: true,
      acp_backend: 'codex',
      capabilities: ['review', 'quality'],
    },
    {
      id: 'acceptor',
      name: 'Acceptor',
      description: '根据验收标准判断任务是否完成。',
      workflow_role: 'acceptor',
      acp_enabled: true,
      acp_backend: 'codex',
      capabilities: ['acceptance'],
    },
  ];
}
```

- [ ] **Step 4: Add DB fields for capabilities and default runtime**

Modify `packages/backend/src/db.ts` room_agents schema and migrations:

```sql
capabilities TEXT NOT NULL DEFAULT '[]',
default_runtime TEXT NOT NULL DEFAULT 'openclaw',
```

Add migrations:

```ts
if (!roomAgentColumnNames.has('capabilities')) {
  db.exec("ALTER TABLE room_agents ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'");
}
if (!roomAgentColumnNames.has('default_runtime')) {
  db.exec("ALTER TABLE room_agents ADD COLUMN default_runtime TEXT NOT NULL DEFAULT 'openclaw'");
}
```

- [ ] **Step 5: Update types and repo mapping**

Modify `packages/backend/src/types.ts`:

```ts
export type AgentDefaultRuntime = 'acp' | 'openclaw' | 'none';

export interface RoomAgent {
  capabilities: string[];
  default_runtime: AgentDefaultRuntime;
}
```

Modify `packages/backend/src/repos/rooms.ts` imports:

```ts
import type { AcpBackend, AcpPermissionMode, AgentDefaultRuntime, Room, RoomAgent, WorkflowRole } from '../types.js';
```

Then JSON parse/stringify `capabilities` the same way it handles `acp_writable_dirs`.

Update `RoomAgentRow`:

```ts
type RoomAgentRow = Omit<RoomAgent, 'acp_writable_dirs' | 'acp_permission_mode' | 'capabilities' | 'default_runtime'> & {
  acp_permission_mode?: string | null;
  acp_writable_dirs?: string | null;
  capabilities?: string | null;
  default_runtime?: string | null;
};
```

Add helpers:

```ts
const DEFAULT_RUNTIMES = new Set<AgentDefaultRuntime>(['acp', 'openclaw', 'none']);

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}
```

Replace `parseWritableDirs` calls with `parseStringArray`, and update `normalizeRoomAgent`:

```ts
function normalizeRoomAgent(row: RoomAgentRow): RoomAgent {
  const mode = row.acp_permission_mode;
  const runtime = row.default_runtime;
  return {
    ...row,
    acp_permission_mode: mode && ACP_PERMISSION_MODES.has(mode as AcpPermissionMode)
      ? (mode as AcpPermissionMode)
      : 'bypass',
    acp_writable_dirs: parseStringArray(row.acp_writable_dirs),
    capabilities: parseStringArray(row.capabilities),
    default_runtime: runtime && DEFAULT_RUNTIMES.has(runtime as AgentDefaultRuntime)
      ? (runtime as AgentDefaultRuntime)
      : 'openclaw',
  };
}
```

Add repo method:

```ts
setCapabilitiesAndRuntime(
  id: string,
  input: { capabilities: string[]; default_runtime: AgentDefaultRuntime },
): RoomAgent | undefined {
  db.prepare('UPDATE room_agents SET capabilities = ?, default_runtime = ? WHERE id = ?')
    .run(JSON.stringify(input.capabilities), input.default_runtime, id);
  return this.get(id);
}
```

Update the existing fake `RoomAgent` in `packages/backend/src/workflows/langchain-planner.test.ts` so it still satisfies the expanded interface:

```ts
function fakeAgent(patch: Partial<RoomAgent>): RoomAgent {
  return {
    id: 'agent-1',
    room_id: 'room-1',
    agent_id: 'executor',
    agent_name: 'Executor',
    agent_role: null,
    workflow_role: null,
    joined_at: 1,
    acp_enabled: 0,
    acp_backend: null,
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
    capabilities: [],
    default_runtime: 'acp',
    memory_max_context_chars: null,
    ...patch,
  };
}
```

- [ ] **Step 6: Add routes**

Modify `packages/backend/src/routes.ts`:

```ts
import { listBuiltInAgentTemplates } from './agent-templates.js';
```

Add route near gateway agents:

```ts
router.get('/agent-templates', (_req, res) => {
  res.json({ templates: listBuiltInAgentTemplates() });
});
```

Add route for adding template to room:

```ts
router.post('/rooms/:roomId/agents/from-template', (req, res) => {
  const schema = z.object({ template_id: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const template = listBuiltInAgentTemplates().find((item) => item.id === parsed.data.template_id);
  if (!template) return res.status(404).json({ error: 'template not found' });
  const agent = roomAgentRepo.add({
    room_id: req.params.roomId,
    agent_id: template.id,
    agent_name: template.name,
    agent_role: template.description,
  });
  const withRole = roomAgentRepo.setWorkflowRole(agent.id, template.workflow_role) ?? agent;
  const updated = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: template.acp_enabled,
    acp_backend: template.acp_backend,
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  const withCapabilities = roomAgentRepo.setCapabilitiesAndRuntime((updated ?? withRole).id, {
    capabilities: template.capabilities,
    default_runtime: 'acp',
  });
  const result = withCapabilities ?? updated ?? withRole;
  wsHub.broadcast(result.room_id, { type: 'room:agent_joined', roomId: result.room_id, agent: result });
  res.status(201).json(result);
});
```

- [ ] **Step 7: Run backend tests**

Run:

```bash
npm run test -w @openclaw-room/backend
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/db.ts packages/backend/src/types.ts packages/backend/src/repos/rooms.ts packages/backend/src/routes.ts packages/backend/src/workflows/langchain-planner.test.ts packages/backend/src/agent-templates.ts packages/backend/src/agent-templates.test.ts
git commit -m "feat(agents): 添加 ACP-only 内置智能体模板"
```

## Task 6: Frontend Template Agent Entry and OpenClaw Optional Messaging

**Files:**
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/lib/api.ts`
- Modify: `packages/frontend/src/components/AddAgentDialog.tsx`
- Modify: `packages/frontend/src/components/AppShell.tsx`
- Modify: `packages/frontend/src/lib/i18n.tsx`

- [ ] **Step 1: Update frontend types**

Modify `packages/frontend/src/lib/types.ts`:

```ts
export interface BuiltInAgentTemplate {
  id: string;
  name: string;
  description: string;
  workflow_role: WorkflowRole;
  acp_enabled: true;
  acp_backend: AcpBackend;
  capabilities: string[];
}
```

Extend `RoomAgent`:

```ts
capabilities: string[];
default_runtime: 'acp' | 'openclaw' | 'none';
```

- [ ] **Step 2: Update API client**

Modify `packages/frontend/src/lib/api.ts` imports and API:

```ts
import type { BuiltInAgentTemplate } from './types';
```

Add:

```ts
listAgentTemplates: () => request<{ templates: BuiltInAgentTemplate[] }>('/agent-templates'),
addRoomAgentFromTemplate: (roomId: string, template_id: string) =>
  request<RoomAgent>(`/rooms/${roomId}/agents/from-template`, {
    method: 'POST',
    body: JSON.stringify({ template_id }),
  }),
```

- [ ] **Step 3: Update AddAgentDialog to show templates first**

Modify `packages/frontend/src/components/AddAgentDialog.tsx`:

Add query:

```ts
const { data: templates, isLoading: templatesLoading } = useQuery({
  queryKey: ['agent-templates'],
  queryFn: api.listAgentTemplates,
  enabled: open,
});
```

Add mutation:

```ts
const addTemplate = useMutation({
  mutationFn: (templateId: string) => api.addRoomAgentFromTemplate(roomId, templateId),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
    toast.success(t('addAgent.success'));
    setOpen(false);
    resetForm();
  },
  onError: (err) => toast.error((err as Error).message),
});
```

Render templates above OpenClaw agents:

```tsx
<div>
  <Label className="mb-1.5 block">{t('addAgent.builtInTemplates')}</Label>
  <div className="space-y-1.5">
    {templatesLoading ? (
      <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
        {t('common.loading')}
      </div>
    ) : (
      templates?.templates.map((template) => (
        <button
          key={template.id}
          type="button"
          className="w-full surface-1 rounded-md px-3 py-2 text-left ease-ocean transition-all flex items-start gap-2"
          onClick={() => addTemplate.mutate(template.id)}
        >
          <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-display text-[13px]">{template.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-muted)]">
                ACP:{template.acp_backend}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-[var(--color-fg-muted)]">
              {template.description}
            </div>
          </div>
        </button>
      ))
    )}
  </div>
</div>
```

- [ ] **Step 4: Update OpenClaw Gateway messaging**

Modify `packages/frontend/src/components/AppShell.tsx` text usage so offline state is described as optional integration. Add i18n keys in `packages/frontend/src/lib/i18n.tsx`:

```ts
'gateway.optionalDescription': 'OpenClaw is optional. ACP-only agents can continue working when the gateway is offline.',
```

Render this sentence in the gateway dialog near `healthMessage`.

- [ ] **Step 5: Run frontend build**

Run:

```bash
npm run build -w @openclaw-room/frontend
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/lib/types.ts packages/frontend/src/lib/api.ts packages/frontend/src/components/AddAgentDialog.tsx packages/frontend/src/components/AppShell.tsx packages/frontend/src/lib/i18n.tsx
git commit -m "feat(frontend): 支持内置 ACP 智能体模板"
```

## Task 7: Final Verification and Phase B Prep Notes

**Files:**
- Modify: `docs/superpowers/specs/2026-05-15-LangChain-LangGraph替代OpenClaw编排层设计.md`

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run test -w @openclaw-room/backend
npm run build
```

Expected:

- Backend tests pass.
- Backend TypeScript build passes.
- Frontend build passes.
- Vite may print existing chunk size warning only.

- [ ] **Step 2: Update design doc with implementation notes**

Append to `docs/superpowers/specs/2026-05-15-LangChain-LangGraph替代OpenClaw编排层设计.md`:

```md
## 阶段 A 实施记录

- LangChain Planner 已作为可选 planning path 接入。
- 未配置 `LANGCHAIN_PLANNER_MODEL` 或 `OPENAI_API_KEY` 时，系统回退到现有 ACP planning stage。
- 内置 ACP agent 模板已支持无 OpenClaw Gateway 的 agent 创建。
- 阶段 B 仍保留为后续 LangGraph runtime 迁移工作。
```

- [ ] **Step 3: Commit docs note**

```bash
git add docs/superpowers/specs/2026-05-15-LangChain-LangGraph替代OpenClaw编排层设计.md
git commit -m "docs(architecture): 记录 LangChain 阶段 A 实施结果"
```

## Phase B Follow-up Milestone

阶段 B 单独开计划，不在本计划执行：

1. 增加 `@langchain/langgraph` 和 `@langchain/core`。
2. 新建 `packages/backend/src/workflows/graph/`。
3. 定义 `AgentWorkflowState`。
4. 实现 `ContextNode -> PlanningNode -> ApprovalNode -> DispatchNode -> ExecuteNode -> ReviewNode -> VerifyNode -> AcceptanceNode -> MemoryNode`。
5. 增加 `workflow_runs.graph_version` 和 `workflow_runs.graph_state`。
6. 将现有 `workflowOrchestrator.start/approvePlan/retryStep/cancel` 逐步代理到 graph runtime。
7. 完成恢复、人工确认、review repair loop 的端到端测试。

## Self-Review Checklist

- [x] 阶段 A 不移除 OpenClaw。
- [x] LangChain 只用于规划，不直接执行 shell 或写文件。
- [x] 未配置 LangChain 时保持现有 ACP planning 回退。
- [x] 结构化计划 schema 兼容旧 plan artifact。
- [x] 内置 agent 模板不依赖 OpenClaw Gateway。
- [x] 执行层仍使用 ACP adapters。
- [x] 阶段 B 被明确排除到后续里程碑。
