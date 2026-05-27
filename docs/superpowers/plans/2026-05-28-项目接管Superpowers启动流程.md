# 项目接管 Superpowers 启动流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 OpenDeepSea 项目层完全接管 Superpowers 会话启动、bootstrap 注入和 workflow 入口判断，ACP provider 只负责执行，不再作为 Superpowers bootstrap 的 owner。

**Architecture:** 在 settings 中新增 `superpowers_bootstrap_owner`，默认值为 `project`，并把 `using-superpowers` bootstrap 注入决策集中到后端 `respondAsAgent()` 之前的项目层。ACP 适配层通过环境和能力声明尽量禁用 provider 侧 Superpowers 注入；若无法禁用，则项目层用强去重和 agent run 证据字段避免双重注入。前端只暴露一个全局/项目/房间可继承的启动策略设置，默认“项目接管”。

**Tech Stack:** TypeScript, Node.js, Express, SQLite, ACP adapters, React 18, Vite, Tailwind, node:test.

---

## Scope

本计划只解决 Superpowers 启动所有权和双重注入冲突，不重写 Superpowers workflow 节点，不修改 LLM 模型配置，不改 ACP 协议实现本身。

目标行为：

```text
用户消息进入房间
  -> OpenDeepSea 读取 settings.effective.superpowers_bootstrap_owner
  -> project 模式：项目层注入 using-superpowers bootstrap
  -> provider 模式：项目层不注入，仅记录 provider_owner
  -> disabled 模式：两侧都不应注入，项目层记录 disabled
  -> ACP provider 接收最终 prompt 并执行
```

默认策略：

```ts
type SuperpowersBootstrapOwner = 'project' | 'provider' | 'disabled';
const DEFAULT_SUPERPOWERS_BOOTSTRAP_OWNER: SuperpowersBootstrapOwner = 'project';
```

## File Structure

后端：

- Modify: `packages/backend/src/types.ts` - 新增 `SuperpowersBootstrapOwner`、settings 和 agent run 证据字段类型。
- Modify: `packages/backend/src/db.ts` - settings 增加 `superpowers_bootstrap_owner`；agent_runs 增加 bootstrap 证据字段；补 SQLite 迁移。
- Modify: `packages/backend/src/repos/settings.ts` - 读写、继承、默认值、校验 owner。
- Modify: `packages/backend/src/routes.ts` - settings API schema 支持 owner 字段。
- Modify: `packages/backend/src/superpowers-bootstrap.ts` - 从“单纯 prepend”升级为“决策 + 注入 + 证据”模块。
- Modify: `packages/backend/src/dispatcher.ts` - 使用 effective settings 决定是否注入，并把证据写入 agent_runs。
- Modify: `packages/backend/src/repos/agent-runs.ts` - create 支持保存 bootstrap 证据。
- Modify: `packages/backend/src/acp/types.ts` - adapter invoke 参数支持 `envOverrides?: Record<string, string>`。
- Modify: `packages/backend/src/acp/protocol-registry.ts` - 合并 provider 禁用 Superpowers 的环境变量。
- Modify: `packages/backend/src/acp/codex.ts`
- Modify: `packages/backend/src/acp/claudecode.ts`
- Modify: `packages/backend/src/acp/opencode.ts`
- Test: `packages/backend/src/superpowers-bootstrap.test.ts`
- Test: `packages/backend/src/dispatcher.test.ts`
- Test: `packages/backend/src/repos/settings.test.ts`
- Test: `packages/backend/src/settings.routes.test.ts`
- Test: `packages/backend/src/repos/agent-runs.test.ts`
- Test: `packages/backend/src/acp/protocol-registry.test.ts`

前端：

- Modify: `packages/frontend/src/lib/types.ts` - 同步 settings owner 类型。
- Modify: `packages/frontend/src/lib/api.ts` - settings patch 支持 owner。
- Modify: `packages/frontend/src/components/SettingsDialogs.tsx` 或实际 settings panel 组件 - 增加 Superpowers 启动策略控件。
- Modify: `packages/frontend/src/lib/i18n.tsx` - 增加中英文文案。
- Test: 现有 settings 相关测试文件，若没有对应组件测试，则补 `packages/frontend/src/components/SettingsDialogs.test.tsx`。

文档：

- Modify: `AGENTS.md` - 增加“OpenDeepSea 接管 Superpowers bootstrap，ACP provider 不作为 bootstrap owner”的经验规则。

## Task 1: Settings 类型与数据库字段

**Files:**
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/backend/src/db.ts`
- Test: `packages/backend/src/repos/settings.test.ts`

- [x] **Step 1: Write failing settings inheritance test**

Add a test to `packages/backend/src/repos/settings.test.ts`:

```ts
test('settings resolve superpowers bootstrap owner with project and room inheritance', () => {
  const project = projectRepo.create({ name: `superpowers-owner-${Date.now()}`, path: '/tmp/project' });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.superpowers_bootstrap_owner, 'project');

  settingsRepo.updateProject(project.id, { superpowers_bootstrap_owner: 'provider' });
  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.superpowers_bootstrap_owner, 'provider');

  settingsRepo.updateRoom(room.id, { superpowers_bootstrap_owner: 'disabled' });
  const resolution = settingsRepo.resolveForRoom(room.id);
  assert.equal(resolution?.effective.superpowers_bootstrap_owner, 'disabled');
  assert.equal(resolution?.sources.superpowers_bootstrap_owner, 'room');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
rtk node --import tsx --test packages/backend/src/repos/settings.test.ts --test-name-pattern "superpowers bootstrap owner"
```

Expected: FAIL because `superpowers_bootstrap_owner` is not defined.

- [x] **Step 3: Add backend type unions**

In `packages/backend/src/types.ts`, add:

```ts
export type SuperpowersBootstrapOwner = 'project' | 'provider' | 'disabled';
```

Extend `ScopedSettings`:

```ts
superpowers_bootstrap_owner: SuperpowersBootstrapOwner | null;
```

Extend `EffectiveSettings`:

```ts
superpowers_bootstrap_owner: SuperpowersBootstrapOwner;
```

Extend `SettingsResolution['sources']`:

```ts
superpowers_bootstrap_owner: SettingsScope;
```

- [x] **Step 4: Add SQLite columns and migration**

In `CREATE TABLE IF NOT EXISTS settings`, add:

```sql
superpowers_bootstrap_owner TEXT CHECK (
  superpowers_bootstrap_owner IN ('project', 'provider', 'disabled')
),
```

In the existing settings column migration section, add:

```ts
if (!settingsColumnNames.has('superpowers_bootstrap_owner')) {
  db.exec(`
    ALTER TABLE settings ADD COLUMN superpowers_bootstrap_owner TEXT
      CHECK (superpowers_bootstrap_owner IN ('project', 'provider', 'disabled'))
  `);
}
```

- [x] **Step 5: Run settings test to verify it still fails at repo layer**

Run:

```bash
rtk node --import tsx --test packages/backend/src/repos/settings.test.ts --test-name-pattern "superpowers bootstrap owner"
```

Expected: FAIL because repo normalization does not read/write the new column yet.

## Task 2: Settings repo and API support

**Files:**
- Modify: `packages/backend/src/repos/settings.ts`
- Modify: `packages/backend/src/routes.ts`
- Test: `packages/backend/src/repos/settings.test.ts`
- Test: `packages/backend/src/settings.routes.test.ts`

- [x] **Step 1: Write failing route test**

Add to `packages/backend/src/settings.routes.test.ts`:

```ts
test('settings routes persist superpowers bootstrap owner without affecting AI config secrets', async () => {
  const systemRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({
      superpowers_bootstrap_owner: 'project',
      openai_api_key: 'test-route-secret',
    }),
  });
  assert.equal(systemRes.status, 200);
  assert.equal(systemRes.body.superpowers_bootstrap_owner, 'project');
  assert.equal(systemRes.body.openai_api_key_set, true);
  assert.equal(systemRes.body.openai_api_key, undefined);

  const invalidRes = await request('/api/settings/system', {
    method: 'PATCH',
    body: JSON.stringify({ superpowers_bootstrap_owner: 'both' }),
  });
  assert.equal(invalidRes.status, 400);
});
```

- [x] **Step 2: Run route test to verify failure**

Run:

```bash
rtk node --import tsx --test packages/backend/src/settings.routes.test.ts --test-name-pattern "superpowers bootstrap owner"
```

Expected: FAIL because schema rejects or ignores the new field.

- [x] **Step 3: Update settings repo row types**

In `packages/backend/src/repos/settings.ts`, import `SuperpowersBootstrapOwner` and extend `DEFAULT_SETTINGS`:

```ts
const DEFAULT_SETTINGS: EffectiveSettings = {
  message_routing_mode: 'fallback_reply',
  fallback_agent_id: DEFAULT_FALLBACK_AGENT_ID,
  interaction_mode: 'ask_user',
  auto_distill_enabled: true,
  default_workflow_definition_id: null,
  superpowers_bootstrap_owner: 'project',
};
```

Extend `SystemSettingsRow` and `ScopedSettings` SELECT statements with:

```sql
superpowers_bootstrap_owner,
```

- [x] **Step 4: Add owner normalization helper**

Add:

```ts
function normalizeSuperpowersBootstrapOwner(
  value: SuperpowersBootstrapOwner | string | null | undefined,
): SuperpowersBootstrapOwner | null {
  if (value === 'project' || value === 'provider' || value === 'disabled') return value;
  return null;
}
```

- [x] **Step 5: Update upsertScoped patch**

Add to the `upsertScoped` patch type:

```ts
superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
```

Resolve value:

```ts
const superpowersBootstrapOwner =
  patch.superpowers_bootstrap_owner === undefined
    ? existing.superpowers_bootstrap_owner
    : normalizeSuperpowersBootstrapOwner(patch.superpowers_bootstrap_owner);
```

Insert/update `superpowers_bootstrap_owner` in the SQL.

- [x] **Step 6: Update system update**

Add to `updateSystem()` patch type:

```ts
superpowers_bootstrap_owner?: SuperpowersBootstrapOwner;
```

Resolve value:

```ts
const superpowersBootstrapOwner =
  patch.superpowers_bootstrap_owner === undefined
    ? normalizeSuperpowersBootstrapOwner(existing?.superpowers_bootstrap_owner)
    : normalizeSuperpowersBootstrapOwner(patch.superpowers_bootstrap_owner);
```

Insert/update the column in system settings SQL.

- [x] **Step 7: Update resolution sources**

In the settings resolution function, source priority must match existing scoped settings behavior:

```ts
const superpowersBootstrapOwner =
  normalizeSuperpowersBootstrapOwner(room?.superpowers_bootstrap_owner)
  ?? normalizeSuperpowersBootstrapOwner(project?.superpowers_bootstrap_owner)
  ?? normalizeSuperpowersBootstrapOwner(system?.superpowers_bootstrap_owner)
  ?? DEFAULT_SETTINGS.superpowers_bootstrap_owner;
```

Set source:

```ts
superpowers_bootstrap_owner: room?.superpowers_bootstrap_owner
  ? 'room'
  : project?.superpowers_bootstrap_owner
    ? 'project'
    : system?.superpowers_bootstrap_owner
      ? 'system'
      : 'system',
```

- [x] **Step 8: Update route schemas**

In `packages/backend/src/routes.ts`, extend `settingsPatchShape`:

```ts
superpowers_bootstrap_owner: z.enum(['project', 'provider', 'disabled']).nullable().optional(),
```

Pass it into `settingsRepo.updateSystem`, `settingsRepo.updateProject`, and `settingsRepo.updateRoom`.

- [x] **Step 9: Run focused tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/repos/settings.test.ts --test-name-pattern "superpowers bootstrap owner"
rtk node --import tsx --test packages/backend/src/settings.routes.test.ts --test-name-pattern "superpowers bootstrap owner"
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
rtk git add packages/backend/src/types.ts packages/backend/src/db.ts packages/backend/src/repos/settings.ts packages/backend/src/routes.ts packages/backend/src/repos/settings.test.ts packages/backend/src/settings.routes.test.ts
rtk git commit -m "feat(settings): 增加superpowers启动所有权"
```

## Task 3: Bootstrap 决策模块

**Files:**
- Modify: `packages/backend/src/superpowers-bootstrap.ts`
- Test: `packages/backend/src/superpowers-bootstrap.test.ts`

- [x] **Step 1: Write failing tests for owner decisions**

Add tests:

```ts
test('applySuperpowersBootstrap injects when owner is project', () => {
  const result = applySuperpowersBootstrap({
    prompt: '当前用户请求：\nhi',
    owner: 'project',
    workflowRunId: null,
  });

  assert.equal(result.injected, true);
  assert.equal(result.source, 'project');
  assert.equal(result.skill, 'superpowers:using-superpowers');
  assert.match(result.prompt, /You have superpowers\./);
});

test('applySuperpowersBootstrap skips when owner is provider', () => {
  const result = applySuperpowersBootstrap({
    prompt: '当前用户请求：\nhi',
    owner: 'provider',
    workflowRunId: null,
  });

  assert.equal(result.injected, false);
  assert.equal(result.source, 'provider');
  assert.equal(result.skipReason, 'provider_owner');
  assert.equal(result.prompt, '当前用户请求：\nhi');
});

test('applySuperpowersBootstrap skips workflow runs', () => {
  const result = applySuperpowersBootstrap({
    prompt: '当前用户请求：\nhi',
    owner: 'project',
    workflowRunId: 'workflow-1',
  });

  assert.equal(result.injected, false);
  assert.equal(result.skipReason, 'workflow_run');
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
rtk node --import tsx --test packages/backend/src/superpowers-bootstrap.test.ts
```

Expected: FAIL because `applySuperpowersBootstrap` does not exist.

- [x] **Step 3: Implement decision types**

In `packages/backend/src/superpowers-bootstrap.ts`, add:

```ts
import type { SuperpowersBootstrapOwner } from './types.js';

export interface SuperpowersBootstrapDecisionInput {
  prompt: string;
  owner: SuperpowersBootstrapOwner;
  workflowRunId?: string | null;
}

export interface SuperpowersBootstrapDecision {
  prompt: string;
  injected: boolean;
  source: SuperpowersBootstrapOwner;
  skill: 'superpowers:using-superpowers' | null;
  skipReason: 'workflow_run' | 'provider_owner' | 'disabled' | 'already_present' | 'skill_missing' | null;
}
```

- [x] **Step 4: Implement decision function**

Add:

```ts
export function applySuperpowersBootstrap(input: SuperpowersBootstrapDecisionInput): SuperpowersBootstrapDecision {
  if (input.workflowRunId) {
    return {
      prompt: input.prompt,
      injected: false,
      source: input.owner,
      skill: null,
      skipReason: 'workflow_run',
    };
  }

  if (input.owner === 'provider') {
    return {
      prompt: input.prompt,
      injected: false,
      source: 'provider',
      skill: null,
      skipReason: 'provider_owner',
    };
  }

  if (input.owner === 'disabled') {
    return {
      prompt: input.prompt,
      injected: false,
      source: 'disabled',
      skill: null,
      skipReason: 'disabled',
    };
  }

  if (input.prompt.includes('<EXTREMELY_IMPORTANT>\nYou have superpowers.')) {
    return {
      prompt: input.prompt,
      injected: false,
      source: 'project',
      skill: 'superpowers:using-superpowers',
      skipReason: 'already_present',
    };
  }

  const bootstrap = getSuperpowersSessionBootstrap();
  if (!bootstrap) {
    return {
      prompt: input.prompt,
      injected: false,
      source: 'project',
      skill: 'superpowers:using-superpowers',
      skipReason: 'skill_missing',
    };
  }

  return {
    prompt: [bootstrap, '', input.prompt].join('\n'),
    injected: true,
    source: 'project',
    skill: 'superpowers:using-superpowers',
    skipReason: null,
  };
}
```

- [x] **Step 5: Keep compatibility wrapper**

Keep `prependSuperpowersSessionBootstrap(prompt)` but implement it through the new function:

```ts
export function prependSuperpowersSessionBootstrap(prompt: string): string {
  return applySuperpowersBootstrap({
    prompt,
    owner: 'project',
    workflowRunId: null,
  }).prompt;
}
```

- [x] **Step 6: Run bootstrap tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/superpowers-bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/backend/src/superpowers-bootstrap.ts packages/backend/src/superpowers-bootstrap.test.ts
rtk git commit -m "refactor(superpowers): 集中启动注入决策"
```

## Task 4: Agent run 证据字段

**Files:**
- Modify: `packages/backend/src/db.ts`
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/backend/src/repos/agent-runs.ts`
- Test: `packages/backend/src/repos/agent-runs.test.ts`

- [x] **Step 1: Write failing repository test**

Create or extend `packages/backend/src/repos/agent-runs.test.ts`:

```ts
test('agentRunRepo persists superpowers bootstrap evidence', () => {
  const run = agentRunRepo.create({
    room_id: 'room-1',
    room_agent_id: 'agent-1',
    agent_id: 'planner',
    backend: 'codex',
    prompt: 'prompt',
    superpowers_bootstrap_owner: 'project',
    superpowers_bootstrap_injected: true,
    superpowers_bootstrap_skill: 'superpowers:using-superpowers',
    superpowers_bootstrap_skip_reason: null,
  });

  assert.equal(run.superpowers_bootstrap_owner, 'project');
  assert.equal(run.superpowers_bootstrap_injected, 1);
  assert.equal(run.superpowers_bootstrap_skill, 'superpowers:using-superpowers');
  assert.equal(run.superpowers_bootstrap_skip_reason, null);
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
rtk node --import tsx --test packages/backend/src/repos/agent-runs.test.ts --test-name-pattern "superpowers bootstrap evidence"
```

Expected: FAIL because columns and create input do not exist.

- [x] **Step 3: Add DB columns**

In `CREATE TABLE IF NOT EXISTS agent_runs`, add:

```sql
superpowers_bootstrap_owner TEXT,
superpowers_bootstrap_injected INTEGER NOT NULL DEFAULT 0 CHECK (superpowers_bootstrap_injected IN (0, 1)),
superpowers_bootstrap_skill TEXT,
superpowers_bootstrap_skip_reason TEXT,
```

Add migration:

```ts
if (!agentRunsColumnNames.has('superpowers_bootstrap_owner')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN superpowers_bootstrap_owner TEXT');
}
if (!agentRunsColumnNames.has('superpowers_bootstrap_injected')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN superpowers_bootstrap_injected INTEGER NOT NULL DEFAULT 0 CHECK (superpowers_bootstrap_injected IN (0, 1))');
}
if (!agentRunsColumnNames.has('superpowers_bootstrap_skill')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN superpowers_bootstrap_skill TEXT');
}
if (!agentRunsColumnNames.has('superpowers_bootstrap_skip_reason')) {
  db.exec('ALTER TABLE agent_runs ADD COLUMN superpowers_bootstrap_skip_reason TEXT');
}
```

- [x] **Step 4: Update AgentRun type**

In `packages/backend/src/types.ts`, extend `AgentRun`:

```ts
superpowers_bootstrap_owner: SuperpowersBootstrapOwner | null;
superpowers_bootstrap_injected: 0 | 1;
superpowers_bootstrap_skill: string | null;
superpowers_bootstrap_skip_reason: string | null;
```

- [x] **Step 5: Update repository create input and SQL**

In `agentRunRepo.create`, add input fields:

```ts
superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
superpowers_bootstrap_injected?: boolean;
superpowers_bootstrap_skill?: string | null;
superpowers_bootstrap_skip_reason?: string | null;
```

Insert values:

```ts
input.superpowers_bootstrap_owner ?? null,
input.superpowers_bootstrap_injected ? 1 : 0,
input.superpowers_bootstrap_skill ?? null,
input.superpowers_bootstrap_skip_reason ?? null,
```

- [x] **Step 6: Run repository test**

Run:

```bash
rtk node --import tsx --test packages/backend/src/repos/agent-runs.test.ts --test-name-pattern "superpowers bootstrap evidence"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/backend/src/db.ts packages/backend/src/types.ts packages/backend/src/repos/agent-runs.ts packages/backend/src/repos/agent-runs.test.ts
rtk git commit -m "feat(runs): 记录superpowers启动证据"
```

## Task 5: Dispatcher 使用项目层 owner

**Files:**
- Modify: `packages/backend/src/dispatcher.ts`
- Test: `packages/backend/src/dispatcher.test.ts`

- [x] **Step 1: Extend existing dispatcher bootstrap test**

Update the existing ordinary planner chat test so it also checks evidence:

```ts
const run = agentRunRepo.listByRoom(room.id, 1)[0];
assert.equal(run?.workflow_run_id, null);
assert.equal(run?.superpowers_bootstrap_owner, 'project');
assert.equal(run?.superpowers_bootstrap_injected, 1);
assert.equal(run?.superpowers_bootstrap_skill, 'superpowers:using-superpowers');
assert.equal(run?.superpowers_bootstrap_skip_reason, null);
assert.match(run?.prompt ?? '', /superpowers:using-superpowers/);
```

- [x] **Step 2: Add provider owner skip test**

Add:

```ts
test('respondAsAgent skips project bootstrap when settings owner is provider', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'openclaw-room-superpowers-provider-owner-'));
  const project = projectRepo.create({ name: `superpowers-provider-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  settingsRepo.updateRoom(room.id, { superpowers_bootstrap_owner: 'provider' });
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);

  const originalAdapter = adapters.codex;
  let capturedPrompt = '';
  adapters.codex = {
    ...originalAdapter,
    async invoke(args) {
      capturedPrompt = args.prompt;
      args.onChunk({ stream: 'stdout', text: 'done' });
      return { exitCode: 0, sessionId: null, stderr: '' };
    },
  } satisfies SessionAdapter;

  try {
    await respondAsAgent({
      agent: planner,
      projectPath,
      roomId: room.id,
      prompt: 'hi',
    });

    assert.doesNotMatch(capturedPrompt, /You have superpowers\./);
    const run = agentRunRepo.listByRoom(room.id, 1)[0];
    assert.equal(run?.superpowers_bootstrap_owner, 'provider');
    assert.equal(run?.superpowers_bootstrap_injected, 0);
    assert.equal(run?.superpowers_bootstrap_skip_reason, 'provider_owner');
  } finally {
    adapters.codex = originalAdapter;
    await rm(projectPath, { recursive: true, force: true });
  }
});
```

- [x] **Step 3: Run tests to verify failure**

Run:

```bash
rtk node --import tsx --test packages/backend/src/dispatcher.test.ts --test-name-pattern "superpowers"
```

Expected: FAIL because dispatcher does not read owner/evidence yet.

- [x] **Step 4: Update dispatcher prompt construction**

Replace direct `prependSuperpowersSessionBootstrap(promptWithMemory)` with:

```ts
const settings = room ? settingsRepo.resolveForRoom(roomId)?.effective : null;
const superpowersBootstrap = applySuperpowersBootstrap({
  prompt: promptWithMemory,
  owner: settings?.superpowers_bootstrap_owner ?? 'project',
  workflowRunId: args.workflowRunId,
});
const prompt = superpowersBootstrap.prompt;
```

- [x] **Step 5: Save evidence to agent run**

In `agentRunRepo.create`, pass:

```ts
superpowers_bootstrap_owner: superpowersBootstrap.source,
superpowers_bootstrap_injected: superpowersBootstrap.injected,
superpowers_bootstrap_skill: superpowersBootstrap.skill,
superpowers_bootstrap_skip_reason: superpowersBootstrap.skipReason,
```

- [x] **Step 6: Keep memory relevance clean**

Do not change this behavior:

```ts
loadRelevantEntries: () => memoryRepo.listRelevantForPrompt({
  projectId: room.project_id,
  roomId,
  prompt: promptWithRuntime,
}),
```

The Superpowers bootstrap must not pollute memory relevance search.

- [x] **Step 7: Run focused dispatcher tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/dispatcher.test.ts --test-name-pattern "superpowers"
```

Expected: Superpowers-specific tests PASS. If unrelated dispatcher tests fail, record them separately and do not hide the failure.

- [ ] **Step 8: Commit**

```bash
rtk git add packages/backend/src/dispatcher.ts packages/backend/src/dispatcher.test.ts
rtk git commit -m "fix(dispatcher): 按项目策略注入superpowers启动指令"
```

## Task 6: ACP provider 禁用与兼容层

**Files:**
- Modify: `packages/backend/src/acp/types.ts`
- Modify: `packages/backend/src/acp/protocol-registry.ts`
- Modify: `packages/backend/src/acp/codex.ts`
- Modify: `packages/backend/src/acp/claudecode.ts`
- Modify: `packages/backend/src/acp/opencode.ts`
- Test: `packages/backend/src/acp/protocol-registry.test.ts`
- Test: provider adapter tests if existing patterns allow cheap coverage.

- [x] **Step 1: Write failing protocol registry test**

Add to `packages/backend/src/acp/protocol-registry.test.ts`:

```ts
test('getAcpServerConfig includes project-owned superpowers disable env', () => {
  const config = getAcpServerConfig('opencode', {
    OPENCLAW_ACP_MODE: 'protocol',
    OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER: 'project',
  });

  assert.equal(config.env?.OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER, 'project');
  assert.equal(config.env?.SUPERPOWERS_BOOTSTRAP_DISABLED, '1');
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
rtk node --import tsx --test packages/backend/src/acp/protocol-registry.test.ts --test-name-pattern "superpowers"
```

Expected: FAIL because config does not expose env.

- [x] **Step 3: Extend SessionAdapter invoke args**

In `packages/backend/src/acp/types.ts`, add:

```ts
envOverrides?: Record<string, string>;
```

- [x] **Step 4: Add env builder**

In `protocol-registry.ts`, add:

```ts
function buildSuperpowersEnv(env: AcpProtocolEnv): Record<string, string> {
  const owner = env.OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER;
  if (owner === 'project' || owner === 'disabled') {
    return {
      OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER: owner,
      SUPERPOWERS_BOOTSTRAP_DISABLED: '1',
    };
  }
  if (owner === 'provider') {
    return {
      OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER: 'provider',
    };
  }
  return {};
}
```

Return it from `getAcpServerConfig`:

```ts
env: buildSuperpowersEnv(env),
```

- [x] **Step 5: Merge env overrides into protocol invocation**

Where adapters call `invokeProtocolSession`, pass merged env through the server config or invocation input according to existing `protocol-client.ts` structure.

The final child process env must include:

```ts
{
  ...process.env,
  ...server.env,
  ...args.envOverrides,
}
```

- [x] **Step 6: Set owner env from dispatcher**

When `respondAsAgent()` invokes an ACP adapter, pass:

```ts
envOverrides: {
  OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER: superpowersBootstrap.source,
}
```

If adapter-specific invoke args do not currently pass through extra keys, thread the field through all adapters without changing external behavior.

- [x] **Step 7: Document provider limitation in code comment**

Add a short comment near `buildSuperpowersEnv`:

```ts
// Best-effort guard: provider CLIs may ignore this unless their Superpowers plugin
// honors SUPERPOWERS_BOOTSTRAP_DISABLED. Project prompt injection still has
// duplicate-bootstrap detection as the final guard.
```

- [x] **Step 8: Run protocol tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/acp/protocol-registry.test.ts --test-name-pattern "superpowers"
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
rtk git add packages/backend/src/acp/types.ts packages/backend/src/acp/protocol-registry.ts packages/backend/src/acp/codex.ts packages/backend/src/acp/claudecode.ts packages/backend/src/acp/opencode.ts packages/backend/src/acp/protocol-registry.test.ts
rtk git commit -m "feat(acp): 传递superpowers启动所有权"
```

## Task 7: 前端设置入口

**Files:**
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/lib/api.ts`
- Modify: `packages/frontend/src/components/SettingsDialogs.tsx` or actual settings component discovered during execution.
- Modify: `packages/frontend/src/lib/i18n.tsx`
- Test: frontend settings component test if available.

- [x] **Step 1: Add frontend types**

In `packages/frontend/src/lib/types.ts`, add:

```ts
export type SuperpowersBootstrapOwner = 'project' | 'provider' | 'disabled';
```

Extend `ScopedSettings`:

```ts
superpowers_bootstrap_owner: SuperpowersBootstrapOwner | null;
```

Extend `EffectiveSettings` and `SystemSettings` through inherited fields:

```ts
superpowers_bootstrap_owner: SuperpowersBootstrapOwner;
```

Extend `SettingsResolution['sources']`:

```ts
superpowers_bootstrap_owner: SettingsScope;
```

- [x] **Step 2: Update API patch types**

In `packages/frontend/src/lib/api.ts`, wherever settings patch input is typed inline, include:

```ts
superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
```

- [x] **Step 3: Add UI labels**

In `packages/frontend/src/lib/i18n.tsx`, add Simplified Chinese:

```ts
settingsSuperpowersBootstrapOwner: 'Superpowers 启动策略',
settingsSuperpowersBootstrapOwnerProject: '项目接管（推荐）',
settingsSuperpowersBootstrapOwnerProvider: 'ACP Provider 接管',
settingsSuperpowersBootstrapOwnerDisabled: '禁用 Superpowers 启动注入',
settingsSuperpowersBootstrapOwnerDescription: '控制 using-superpowers 会话启动指令由 OpenDeepSea 注入，还是交给 ACP 运行时。',
```

Add English equivalents if the file uses bilingual keys.

- [x] **Step 4: Add segmented control or select**

In the settings UI component, render a three-option control:

```tsx
<Select
  value={draft.superpowers_bootstrap_owner ?? ''}
  onValueChange={(value) => setDraft({
    ...draft,
    superpowers_bootstrap_owner: value === 'inherit' ? null : value as SuperpowersBootstrapOwner,
  })}
>
  <SelectItem value="inherit">继承</SelectItem>
  <SelectItem value="project">项目接管（推荐）</SelectItem>
  <SelectItem value="provider">ACP Provider 接管</SelectItem>
  <SelectItem value="disabled">禁用</SelectItem>
</Select>
```

Use the project’s existing select/segmented component instead of introducing a new UI primitive.

- [x] **Step 5: Save setting through existing patch call**

Ensure the save payload includes:

```ts
superpowers_bootstrap_owner: draft.superpowers_bootstrap_owner,
```

- [ ] **Step 6: Add focused frontend test if existing harness supports it**

Test behavior:

```ts
expect(screen.getByText('Superpowers 启动策略')).toBeInTheDocument();
await user.selectOptions(screen.getByLabelText('Superpowers 启动策略'), 'provider');
expect(savePayload.superpowers_bootstrap_owner).toBe('provider');
```

If existing tests do not cover this settings component, document the gap and rely on TypeScript build plus manual smoke in Task 9.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/frontend/src/lib/types.ts packages/frontend/src/lib/api.ts packages/frontend/src/components/SettingsDialogs.tsx packages/frontend/src/lib/i18n.tsx
rtk git commit -m "feat(frontend): 配置superpowers启动策略"
```

## Task 8: 文档与项目规则沉淀

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-05-28-项目接管Superpowers启动流程.md`

- [x] **Step 1: Add AGENTS learning**

Append a short rule under Superpowers/Skills section:

```md
### Superpowers Bootstrap Ownership

- OpenDeepSea 项目层是默认 Superpowers bootstrap owner。
- ACP provider 只作为执行 runtime，不应重复注入 `using-superpowers`。
- 如 provider 无法关闭自身 Superpowers 插件，必须使用 `superpowers_bootstrap_owner = provider` 或依赖项目层 duplicate guard，并在 agent run 证据字段中记录来源。
```

- [x] **Step 2: Mark completed plan tasks during execution**

As each implementation task completes, update this plan’s checkbox state.

- [ ] **Step 3: Commit docs**

```bash
rtk git add AGENTS.md docs/superpowers/plans/2026-05-28-项目接管Superpowers启动流程.md
rtk git commit -m "docs(superpowers): 记录启动所有权规则"
```

## Task 9: Final verification and room smoke test

**Files:**
- No source files expected unless verification finds a bug.

- [x] **Step 1: Run backend build**

Run:

```bash
rtk npm run build -w @openclaw-room/backend
```

Expected: exit 0.

- [x] **Step 2: Run frontend build**

Run:

```bash
rtk npm run build -w @openclaw-room/frontend
```

Expected: exit 0.

- [x] **Step 3: Run focused backend tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/superpowers-bootstrap.test.ts
rtk node --import tsx --test packages/backend/src/repos/settings.test.ts --test-name-pattern "superpowers bootstrap owner"
rtk node --import tsx --test packages/backend/src/settings.routes.test.ts --test-name-pattern "superpowers bootstrap owner"
rtk node --import tsx --test packages/backend/src/dispatcher.test.ts --test-name-pattern "superpowers"
rtk node --import tsx --test packages/backend/src/acp/protocol-registry.test.ts --test-name-pattern "superpowers"
```

Expected: all focused tests pass. If `dispatcher.test.ts` still has unrelated existing failures when run as a whole, report them separately.

- [ ] **Step 4: Run local room smoke test**

Use the same room path:

```text
http://localhost:5173/projects/ZwgdJRslFpih/rooms/pjBJuOB2zFuQ
```

Send a low-risk message:

```text
hi，测试 superpowers bootstrap owner
```

Then inspect latest agent run in SQLite and verify:

```json
{
  "workflow_run_id": null,
  "superpowers_bootstrap_owner": "project",
  "superpowers_bootstrap_injected": 1,
  "superpowers_bootstrap_skill": "superpowers:using-superpowers",
  "prompt_contains_using_superpowers": true
}
```

- [ ] **Step 5: Verify provider owner override**

Temporarily set room setting:

```json
{ "superpowers_bootstrap_owner": "provider" }
```

Send a low-risk message and verify:

```json
{
  "superpowers_bootstrap_owner": "provider",
  "superpowers_bootstrap_injected": 0,
  "superpowers_bootstrap_skip_reason": "provider_owner"
}
```

Restore the room setting to inherit or `project`.

- [ ] **Step 6: Final code review**

Review staged/uncommitted diff:

```bash
rtk git diff --stat
rtk git diff --check
```

Confirm:

- No API keys are printed or committed.
- Prompt contains only one `You have superpowers.` block in project owner mode.
- Workflow runs still skip bootstrap injection.
- Memory relevance still uses `promptWithRuntime`, not the injected bootstrap prompt.
- Existing unrelated dirty files are not included in commits.

- [ ] **Step 7: Final commit if verification fixes were needed**

If Task 9 required source fixes:

```bash
rtk git add <changed-files>
rtk git commit -m "fix(superpowers): 完成启动所有权验证"
```

## Risk Notes

- Provider CLIs may ignore `SUPERPOWERS_BOOTSTRAP_DISABLED`; project-level duplicate guard remains mandatory.
- If global Codex/Claude/OpenCode plugins inject outside OpenDeepSea’s process control, OpenDeepSea can record project injection evidence but cannot fully prevent external injection. The settings owner must make this visible.
- Adding columns to `settings` and `agent_runs` is backward-compatible, but tests must cover existing DB startup migration.
- Do not store raw prompts in new metadata beyond the existing `agent_runs.prompt`; evidence columns should be short categorical values only.

## Self-Review

- Spec coverage: covers project owner default, provider/disabled escape hatches, duplicate avoidance, agent run evidence, ACP env best-effort disable, frontend setting, smoke verification.
- Placeholder scan: no `TBD`, no empty “add tests later”; every task includes exact paths, commands, and expected outcomes.
- Type consistency: `SuperpowersBootstrapOwner` uses the same values across backend, frontend, settings, dispatcher, and ACP env mapping.
- Scope check: focused on bootstrap ownership. Workflow graph behavior and LLM model configuration are explicitly out of scope.
