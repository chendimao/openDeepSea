# OpenDeepSea 内置 Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 OpenDeepSea 增加自有 Skill Registry 与受控 prompt 注入，让 planner、model chat、workflow、memory/review 内部模型路径可使用项目内置 skills，同时默认不影响外部 ACP CLI skills。

**Architecture:** 后端新增 `skills` 聚合模块，负责 SQLite 持久化、Markdown skill 导入、frontmatter 解析、触发选择、prompt 格式化和 API。内部模型路径通过轻量 `skillContext` 参数或运行时 selector 注入 active skills；ACP CLI adapter 保持现状，不默认注入 OpenDeepSea skills。前端在系统设置中增加 Skills 分区，提供列表、导入、绑定和 preview。

**Tech Stack:** TypeScript、Node.js、Express、better-sqlite3、React 18、TanStack Query、Vite、Tailwind、node:test。

---

## 设计依据

- Spec: `docs/superpowers/specs/2026-05-18-OpenDeepSea内置Skills设计.md`
- 后端 DB 初始化: `packages/backend/src/db.ts`
- 后端 API 路由: `packages/backend/src/routes.ts`
- Planner 消息构造: `packages/backend/src/workflows/langchain-planner.ts`
- Model chat 消息构造: `packages/backend/src/chat-model.ts`
- Workflow graph tools/nodes: `packages/backend/src/workflows/graph/tools.ts`, `packages/backend/src/workflows/graph/nodes.ts`
- 前端 API/types/settings: `packages/frontend/src/lib/api.ts`, `packages/frontend/src/lib/types.ts`, `packages/frontend/src/components/SettingsDialogs.tsx`

## 文件结构

新增后端模块：

- Create: `packages/backend/src/skills/types.ts`
  - 定义 `Skill`、`SkillBinding`、`SkillRuntimeScope`、`SkillTriggerMode`、`SelectedSkill`、API input/output 类型。
- Create: `packages/backend/src/skills/repo.ts`
  - 封装 `skills`、`skill_bindings` CRUD、JSON 字段解析、scope 合并。
- Create: `packages/backend/src/skills/loader.ts`
  - 读取 `SKILL.md`，解析 YAML-like frontmatter，提取注入正文。
- Create: `packages/backend/src/skills/installer.ts`
  - 本地目录导入到 OpenDeepSea 管理目录；Git 导入可先返回 `501` 或在 Task 3 后实现。
- Create: `packages/backend/src/skills/selector.ts`
  - 根据 runtime scope、绑定、关键词和优先级选择 skills。
- Create: `packages/backend/src/skills/prompt.ts`
  - 格式化 prompt 注入文本和调试摘要。
- Create: `packages/backend/src/skills/routes.ts`
  - 独立 Express router，由 `routes.ts` 挂载到 `/skills`。
- Create: `packages/backend/src/skills/*.test.ts`
  - repo/loader/selector/prompt/routes 定向测试。

修改后端现有文件：

- Modify: `packages/backend/src/db.ts`
  - 新增 `skills`、`skill_bindings` 表和索引。
- Modify: `packages/backend/src/types.ts`
  - 导出 skill 相关公共类型，或从 `skills/types.ts` re-export。
- Modify: `packages/backend/src/routes.ts`
  - 挂载 skills router。
- Modify: `packages/backend/src/workflows/langchain-planner.ts`
  - `buildPlannerMessages` 支持注入 `planner` skill context。
- Modify: `packages/backend/src/workflows/orchestrator.ts`
  - legacy/orchestrator planner 路径调用 `generateLangChainPlan` 时也注入 `planner` skill context。
- Modify: `packages/backend/src/workflows/supervisor.ts`
  - Workflow supervisor 作为内部模型路径，支持注入 `workflow` skill context。
- Modify: `packages/backend/src/chat-model.ts`
  - `buildModelChatMessages` 支持注入 `model_chat` skill context。
- Modify: `packages/backend/src/memory/distill.ts`
  - 记忆蒸馏模型调用支持注入 `memory` skill context。
- Modify: `packages/backend/src/workflows/graph/tools.ts`
  - 为 workflow 节点提供按 scope 生成 skill prompt 的 helper。
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
  - 仅在内部模型路径接入 skill context；execute/review/acceptance 等 ACP agent prompt 默认不接入。

新增或修改前端文件：

- Modify: `packages/frontend/src/lib/types.ts`
  - 增加 skill API 类型。
- Modify: `packages/frontend/src/lib/api.ts`
  - 增加 skills API client。
- Create: `packages/frontend/src/components/SkillsSettingsPanel.tsx`
  - Skills 列表、导入、绑定、preview。
- Modify: `packages/frontend/src/components/SettingsDialogs.tsx`
  - 系统设置分类新增 `skills`，嵌入 `SkillsSettingsPanel`。
- Modify: `packages/frontend/src/lib/i18n.tsx`
  - 增加中英文文案。

## 并行策略

本实现可以在后端基础完成后并行：

- Task 1、2、3 有顺序依赖，串行完成。
- Task 4 依赖 Task 2 的 selector/prompt，但可与 Task 5 前端 UI 并行，写入文件不重叠。
- Task 5 依赖 Task 3 API shape，可在 API 类型稳定后独立进行。
- Task 6 统一整合验证，必须最后执行。

如使用子代理，推荐最多两个并行 worker：

- Worker A: Task 4 内部模型注入，写 `chat-model.ts`、`langchain-planner.ts`、`workflows/graph/*` 和对应测试。
- Worker B: Task 5 前端 UI，写 `frontend/src/*`。

禁止并行修改 `db.ts`、`routes.ts`、`skills/*`、`types.ts` 这类 shared contract 文件；这些由主线串行处理。

## 命令约定

仓库根脚本使用 npm workspace 包名，例如 `npm run test -w @openclaw-room/backend`。后端 `test` script 固定运行 `src/**/*.test.ts`，因此计划中的定向测试使用 Node test 直接命令：

```bash
cd packages/backend && node --import tsx --test src/path/to/file.test.ts
```

全量后端测试仍使用：

```bash
npm run test -w @openclaw-room/backend
```

---

### Task 1: 数据模型与 Repo

**Files:**
- Modify: `packages/backend/src/db.ts`
- Modify: `packages/backend/src/types.ts`
- Create: `packages/backend/src/skills/types.ts`
- Create: `packages/backend/src/skills/repo.ts`
- Create: `packages/backend/src/skills/repo.test.ts`

- [x] **Step 1: 写 repo 失败测试**

在 `packages/backend/src/skills/repo.test.ts` 覆盖：

- 创建 skill 后可读取。
- JSON 字段 `runtime_scopes`、`trigger_keywords` 正确序列化/反序列化。
- system/project/room/agent bindings 按窄 scope 覆盖宽 scope。
- binding `enabled=0` 可以禁用宽 scope 默认启用的 skill。

测试使用现有仓库测试风格，直接 import `db` 和 repo。必要时在测试内清理 `skills`、`skill_bindings`。

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
cd packages/backend && node --import tsx --test src/skills/repo.test.ts
```

Expected: FAIL，原因是 `skills/repo.ts` 或表不存在。

- [x] **Step 3: 增加 DB schema**

在 `packages/backend/src/db.ts` 主 `db.exec` 中增加：

```sql
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL,
  source_uri TEXT,
  install_path TEXT NOT NULL,
  manifest_path TEXT,
  runtime_scopes TEXT NOT NULL,
  trigger_mode TEXT NOT NULL,
  trigger_keywords TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  checksum TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled, priority, updated_at);

CREATE TABLE IF NOT EXISTS skill_bindings (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority_override INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  UNIQUE(skill_id, scope, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_bindings_scope ON skill_bindings(scope, scope_id, enabled);
```

- [x] **Step 4: 定义后端类型**

在 `packages/backend/src/skills/types.ts` 定义：

```ts
export type SkillRuntimeScope = 'planner' | 'model_chat' | 'workflow' | 'memory' | 'review';
export type SkillSourceType = 'local_directory' | 'git_repo' | 'manual';
export type SkillTriggerMode = 'manual' | 'keyword' | 'always_for_scope';
export type SkillBindingScope = 'system' | 'project' | 'room' | 'agent';

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  source_type: SkillSourceType;
  source_uri: string | null;
  install_path: string;
  manifest_path: string | null;
  runtime_scopes: SkillRuntimeScope[];
  trigger_mode: SkillTriggerMode;
  trigger_keywords: string[];
  enabled: 0 | 1;
  priority: number;
  checksum: string | null;
  created_at: number;
  updated_at: number;
}

export interface SkillBinding {
  id: string;
  skill_id: string;
  scope: SkillBindingScope;
  scope_id: string;
  enabled: 0 | 1;
  priority_override: number | null;
  created_at: number;
  updated_at: number;
}
```

在 `packages/backend/src/types.ts` re-export：

```ts
export type {
  Skill,
  SkillBinding,
  SkillBindingScope,
  SkillRuntimeScope,
  SkillSourceType,
  SkillTriggerMode,
} from './skills/types.js';
```

- [x] **Step 5: 实现 repo**

在 `packages/backend/src/skills/repo.ts` 实现：

- `listSkills()`
- `getSkill(id)`
- `createSkill(input)`
- `updateSkill(id, patch)`
- `deleteSkill(id)`
- `upsertBinding(input)`
- `deleteBinding(id)`
- `listBindings(filter?)`
- `resolveEffectiveBindings(input: { system?: true; projectId?: string; roomId?: string; agentId?: string })`

实现细节：

- JSON parse 失败时返回空数组，不抛出数据库级错误。
- `priority_override ?? skill.priority` 作为有效优先级。
- priority 数字越小优先级越高；默认 `100`，强规则可用 `80` 或更小。
- scope specificity 排序：agent=4、room=3、project=2、system=1。
- `scope='system'` 固定 `scope_id='default'`。

- [x] **Step 6: 运行 repo 测试确认通过**

Run:

```bash
cd packages/backend && node --import tsx --test src/skills/repo.test.ts
```

Expected: PASS。

- [x] **Step 7: 提交 Task 1**

```bash
git add packages/backend/src/db.ts packages/backend/src/types.ts packages/backend/src/skills/types.ts packages/backend/src/skills/repo.ts packages/backend/src/skills/repo.test.ts
git commit -m "feat(skills): 新增内置技能数据模型"
```

---

### Task 2: Loader、Selector 与 Prompt Formatter

**Files:**
- Create: `packages/backend/src/skills/loader.ts`
- Create: `packages/backend/src/skills/selector.ts`
- Create: `packages/backend/src/skills/prompt.ts`
- Create: `packages/backend/src/skills/loader.test.ts`
- Create: `packages/backend/src/skills/selector.test.ts`
- Create: `packages/backend/src/skills/prompt.test.ts`

- [x] **Step 1: 写 loader 失败测试**

覆盖：

- 有 frontmatter 的 `SKILL.md` 能解析 `name`、`description`、`runtime_scopes`、`trigger_keywords`、`priority`。
- 无 frontmatter 时 fallback 到目录名和正文首段。
- 非法 frontmatter 不导致服务崩溃，返回可诊断错误或 fallback。
- 正文超过限制时裁剪。

- [x] **Step 2: 写 selector 失败测试**

覆盖：

- `keyword` 模式只有关键词命中才选中。
- `always_for_scope` 在 scope 匹配时选中。
- `manual` 不自动选中，除非 request 显式传入 `skillIds`。
- 同名/同 id 去重，保留有效 priority 数字最小的结果。
- 最多 3 个 skill 和总字符上限生效。
- `always_for_scope` 每个 runtime scope 默认最多选中 1 个，避免全局规则膨胀。

- [x] **Step 3: 写 prompt formatter 失败测试**

断言输出包含：

- `OpenDeepSea active skills for this runtime`
- skill name
- reason
- instructions

并断言空列表返回空字符串。

- [x] **Step 4: 运行测试确认失败**

Run:

```bash
cd packages/backend && node --import tsx --test src/skills/loader.test.ts src/skills/selector.test.ts src/skills/prompt.test.ts
```

Expected: FAIL，原因是模块未实现。

- [x] **Step 5: 实现 loader**

不要新增 YAML 依赖；第一版实现简单 YAML-like parser：

- 只解析 `key: value`。
- 支持 array block：

```yaml
runtime_scopes:
  - planner
  - workflow
```

- 未识别字段忽略。
- 只允许 runtime scope 枚举内的值。
- 默认 `trigger_mode`：
  - 有 `trigger_keywords`：`keyword`
  - 否则：`manual`

- [x] **Step 6: 实现 selector**

接口建议：

```ts
export interface SkillSelectionInput {
  runtimeScopes: SkillRuntimeScope[];
  projectId?: string | null;
  roomId?: string | null;
  agentId?: string | null;
  message?: string;
  skillIds?: string[];
  maxSkills?: number;
  maxInstructionChars?: number;
}

export interface SelectedSkill {
  skill: Skill;
  effectivePriority: number;
  reasons: string[];
  instructions: string;
  truncated: boolean;
}
```

`selector` 从 repo 获取有效 skill，再调用 loader 读取正文。测试中可允许注入 fake repo/loader，避免真实文件 IO 过多。

- [x] **Step 7: 实现 prompt formatter**

输出必须稳定，方便测试断言。空列表返回 `''`。

- [x] **Step 8: 运行 Task 2 测试**

Run:

```bash
cd packages/backend && node --import tsx --test src/skills/loader.test.ts src/skills/selector.test.ts src/skills/prompt.test.ts
```

Expected: PASS。

- [x] **Step 9: 提交 Task 2**

```bash
git add packages/backend/src/skills/loader.ts packages/backend/src/skills/selector.ts packages/backend/src/skills/prompt.ts packages/backend/src/skills/loader.test.ts packages/backend/src/skills/selector.test.ts packages/backend/src/skills/prompt.test.ts
git commit -m "feat(skills): 实现技能选择与提示词注入"
```

---

### Task 3: 安装器与 API

**Files:**
- Create: `packages/backend/src/skills/installer.ts`
- Create: `packages/backend/src/skills/routes.ts`
- Create: `packages/backend/src/skills/routes.test.ts`
- Modify: `packages/backend/src/routes.ts`

- [x] **Step 1: 写 API 失败测试**

在 `routes.test.ts` 覆盖：

- `GET /api/skills` 返回列表。
- `GET /api/skills/:skillId` 返回详情，未知 ID 返回 404。
- `POST /api/skills/import/local` 导入临时目录中的 `SKILL.md`。
- `PATCH /api/skills/:skillId` 可禁用 skill 或修改 priority。
- `DELETE /api/skills/:skillId` 删除或禁用 skill，且只移除 OpenDeepSea 管理目录内副本。
- `GET /api/skills/bindings?scope=system&scopeId=default` 返回 bindings。
- `PUT /api/skills/bindings` 可创建/更新 binding。
- `DELETE /api/skills/bindings/:bindingId` 删除 binding。
- `POST /api/skills/preview-selection` 返回命中 reasons。
- `POST /api/skills/import/git` 第一阶段返回 `501` 和明确错误，除非本任务实现 Git clone。
- API 响应不暴露非必要本地绝对路径；列表 DTO 默认只返回 `install_path_set` 或脱敏路径，详情页如需路径也只返回管理目录相对路径。

- [ ] **Step 1.1: 写 installer 安全失败测试**

在 `routes.test.ts` 或独立 `installer.test.ts` 覆盖：

- 缺少 `SKILL.md` 时返回 400。
- local path 为空、相对路径逃逸或不存在时返回 400。
- 导入时跳过 `.git`、`node_modules`。
- symlink 指向导入目录外文件时不复制或返回安全错误。
- 删除 skill 不会删除用户原始目录。
- 物理删除只能作用于 `OPENDEEPSEA_SKILLS_DIR` 管理目录内路径。

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
cd packages/backend && node --import tsx --test src/skills/routes.test.ts
```

Expected: FAIL，原因是 routes/installer 未实现。

- [x] **Step 3: 实现本地安装器**

`installer.ts` 实现：

- 管理目录：`process.env.OPENDEEPSEA_SKILLS_DIR ?? join(homedir(), '.opendeepsea', 'skills')`。
- 导入本地目录时：
  - resolve 原路径。
  - 确认 `SKILL.md` 存在。
  - 创建 skill id，可用 `nanoid()`。
  - 复制目录到管理目录 `<id>`。
  - 跳过 `.git`、`node_modules`、大于合理上限的文件。
  - 计算 `SKILL.md` sha256 checksum。
  - 解析 metadata 后写 repo。
- 禁止读取或删除管理目录外文件。

Git 导入第一阶段可以返回：

```ts
throw new Error('Git skill import is not implemented yet');
```

由 route 映射为 `501`。

本计划将 Git 导入明确延后到阶段 2；Task 3 只保留 endpoint 占位和 `501` 回归测试，避免首版引入网络 clone 与额外安全边界。

- [x] **Step 4: 实现 skills router**

`routes.ts` 中挂载：

```ts
import { skillsRouter } from './skills/routes.js';
router.use('/skills', skillsRouter);
```

`skills/routes.ts` 使用 zod 校验：

- runtime scope enum
- binding scope enum
- trigger mode enum
- priority number
- local path string min(1)

所有对外响应通过 DTO mapper 输出，不直接 `res.json(skillRow)`。DTO 至少包含：

```ts
{
  id,
  name,
  description,
  source_type,
  source_uri,
  manifest_path,
  runtime_scopes,
  trigger_mode,
  trigger_keywords,
  enabled,
  priority,
  checksum,
  created_at,
  updated_at,
  install_path_set: Boolean(install_path)
}
```

- [x] **Step 5: 实现 preview-selection**

请求 body：

```ts
{
  runtimeScopes: ['planner'],
  projectId?: string,
  roomId?: string,
  agentId?: string,
  message?: string,
  skillIds?: string[]
}
```

响应：

```ts
{
  skills: [
    {
      id,
      name,
      reasons,
      effectivePriority,
      truncated
    }
  ],
  promptPreview
}
```

- [x] **Step 6: 运行 API 测试**

Run:

```bash
cd packages/backend && node --import tsx --test src/skills/routes.test.ts
```

Expected: PASS。

- [x] **Step 7: 确认 ACP CLI 参数测试仍通过**

Run:

```bash
cd packages/backend && node --import tsx --test src/acp/codex.test.ts src/acp/claudecode.test.ts src/acp/opencode.test.ts
```

Expected: PASS，证明默认不影响外部 ACP CLI skills。

- [x] **Step 8: 提交 Task 3**

```bash
git add packages/backend/src/skills/installer.ts packages/backend/src/skills/routes.ts packages/backend/src/skills/routes.test.ts packages/backend/src/routes.ts
git commit -m "feat(skills): 新增技能管理接口"
```

---

### Task 4: 内部模型路径 Prompt 注入

**Files:**
- Modify: `packages/backend/src/workflows/langchain-planner.ts`
- Modify: `packages/backend/src/workflows/langchain-planner.test.ts`
- Modify: `packages/backend/src/workflows/orchestrator.ts`
- Modify: `packages/backend/src/workflows/orchestrator.test.ts`
- Modify: `packages/backend/src/workflows/supervisor.ts`
- Modify: `packages/backend/src/workflows/supervisor.test.ts`
- Modify: `packages/backend/src/chat-model.ts`
- Modify: `packages/backend/src/dispatcher.test.ts`
- Modify: `packages/backend/src/memory/distill.ts`
- Modify: `packages/backend/src/memory/distill.test.ts`
- Modify: `packages/backend/src/workflows/graph/tools.ts`
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Modify: `packages/backend/src/workflows/graph/review.test.ts`
- Modify: `packages/backend/src/workflows/graph/recovery.test.ts`
- Modify: `packages/backend/src/workflows/graph/runtime.test.ts`

- [x] **Step 1: 写 planner 注入失败测试**

在 `langchain-planner.test.ts` 增加：

- 调用 `buildPlannerMessages(input, { skillContext: '...' })`。
- 断言 system message 包含 skill context。
- 断言 planner JSON schema 固定规则仍在 skill context 前面。

- [x] **Step 2: 写 model chat 注入失败测试**

在现有相关测试中增加：

- `buildModelChatMessages(input, { skillContext: '...' })`。
- 断言 system message 包含 skill context。
- 断言“不要声称已经修改文件”等基础规则仍存在。

- [x] **Step 3: 写 workflow prompt 注入失败测试**

覆盖内部模型路径，而不是 ACP agent prompt：

- graph `planningNode` 调用 `tools.generatePlan` 时传递 `planner/workflow` skill context。
- legacy `orchestrator.ts` 的 `startLangChainPlanningStage -> generateLangChainPlan` 路径也传递 `planner` skill context。
- `buildSupervisorMessages(input, { skillContext })` 支持 `workflow` skill context。
- memory distill 只请求 `memory` scope。
- execute ACP prompt 不默认注入 OpenDeepSea skills。
- review/acceptance 当前通过 `tools.runAcpAgent` 调用外部 ACP CLI，必须断言默认不注入 OpenDeepSea skills。

- [x] **Step 4: 运行测试确认失败**

Run:

```bash
cd packages/backend && node --import tsx --test src/workflows/langchain-planner.test.ts src/workflows/orchestrator.test.ts src/workflows/supervisor.test.ts src/dispatcher.test.ts src/memory/distill.test.ts src/workflows/graph/review.test.ts src/workflows/graph/recovery.test.ts src/workflows/graph/runtime.test.ts
```

Expected: FAIL，原因是函数签名或 helper 未实现。

- [x] **Step 5: 扩展 planner message 构造**

修改 `buildPlannerMessages` 签名：

```ts
export interface PlannerMessageOptions {
  skillContext?: string;
}

export function buildPlannerMessages(input: LangChainPlannerInput, options: PlannerMessageOptions = {}): PlannerMessage[]
```

system message 中基础规则后追加：

```ts
options.skillContext ? `\n\n${options.skillContext}` : null
```

`generateLangChainPlan` 增加 optional `skillContext` 参数，内部调用 `buildPlannerMessages(input, { skillContext })`。`graph tools` 和 `orchestrator.ts` 都负责在调用前解析 selector 并显式传入，便于测试和审计。

- [x] **Step 6: 扩展 model chat message 构造**

修改 `buildModelChatMessages(input, options = {})` 支持 `skillContext`。`generateModelChatReply` 可新增可选参数：

```ts
export interface ModelChatOptions {
  skillContext?: string;
}
```

dispatcher 中 model fallback 调用前使用 selector 获取 `model_chat` skill context。

- [x] **Step 7: 扩展 supervisor 与 memory 内部模型消息**

`supervisor.ts` 增加：

```ts
export interface SupervisorMessageOptions {
  skillContext?: string;
}

export function buildSupervisorMessages(input: WorkflowSupervisorInput, options: SupervisorMessageOptions = {}): PlannerMessage[]
```

`memory/distill.ts` 的 `distillFromConversation`、`distillFromTask` 增加可选 `skillContext`，在系统消息基础规则后追加。基础事实提取规则必须仍位于 skill context 前面。

- [x] **Step 8: 在 graph tools 中增加 skill context helper**

在 `GraphTools` 增加：

```ts
buildSkillContext(input: {
  runtimeScopes: SkillRuntimeScope[];
  projectId?: string;
  roomId?: string;
  agentId?: string;
  message?: string;
}): Promise<string>;
```

默认实现调用 `selectSkills` + `formatSkillPrompt`。测试中可注入 fake helper。

- [x] **Step 9: 接入内部模型路径**

接入范围：

- `planningNode` 调用 `tools.generatePlan` 前传入 `planner/workflow` skill context。
- `orchestrator.ts` 的 `startLangChainPlanningStage` 调用 `generateLangChainPlan` 前传入 `planner` skill context。
- `supervisor` 决策模型调用前传入 `workflow` skill context。
- `memoryNode` 调用 distill 前准备 `memory` skill context；如果现有 `distillTask` 无参数，则先扩展可选参数。
- `executeNode`、`reviewNode`、`acceptanceNode` 保持不注入，因为它们当前默认进入 `tools.runAcpAgent` 外部 ACP CLI。

- [x] **Step 10: 运行 Task 4 测试**

Run:

```bash
cd packages/backend && node --import tsx --test src/workflows/langchain-planner.test.ts src/workflows/orchestrator.test.ts src/workflows/supervisor.test.ts src/dispatcher.test.ts src/memory/distill.test.ts src/workflows/graph/review.test.ts src/workflows/graph/recovery.test.ts src/workflows/graph/runtime.test.ts
```

Expected: PASS。

- [x] **Step 11: 提交 Task 4**

```bash
git add packages/backend/src/workflows/langchain-planner.ts packages/backend/src/workflows/langchain-planner.test.ts packages/backend/src/workflows/orchestrator.ts packages/backend/src/workflows/orchestrator.test.ts packages/backend/src/workflows/supervisor.ts packages/backend/src/workflows/supervisor.test.ts packages/backend/src/chat-model.ts packages/backend/src/dispatcher.test.ts packages/backend/src/memory/distill.ts packages/backend/src/memory/distill.test.ts packages/backend/src/workflows/graph/tools.ts packages/backend/src/workflows/graph/nodes.ts packages/backend/src/workflows/graph/review.test.ts packages/backend/src/workflows/graph/recovery.test.ts packages/backend/src/workflows/graph/runtime.test.ts
git commit -m "feat(skills): 接入内部模型提示词"
```

---

### Task 5: 前端 Skills 设置面板

**Files:**
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/lib/api.ts`
- Create: `packages/frontend/src/components/SkillsSettingsPanel.tsx`
- Modify: `packages/frontend/src/components/SettingsDialogs.tsx`
- Modify: `packages/frontend/src/lib/i18n.tsx`

- [x] **Step 1: 定义前端类型**

在 `types.ts` 增加：

```ts
export type SkillRuntimeScope = 'planner' | 'model_chat' | 'workflow' | 'memory' | 'review';
export type SkillTriggerMode = 'manual' | 'keyword' | 'always_for_scope';
export type SkillBindingScope = 'system' | 'project' | 'room' | 'agent';
export interface Skill { ... }
export interface SkillBinding { ... }
export interface SkillPreviewResponse { ... }
```

字段与后端 API 保持一致。

- [x] **Step 2: 增加 API client**

在 `api.ts` 增加：

- `listSkills`
- `importLocalSkill`
- `updateSkill`
- `deleteSkill`
- `listSkillBindings`
- `upsertSkillBinding`
- `deleteSkillBinding`
- `previewSkillSelection`

- [x] **Step 2.1: 对齐前端 DTO 脱敏字段**

前端 `Skill` 类型必须匹配后端 DTO，不包含原始 `install_path` 本地绝对路径。使用：

```ts
export interface Skill {
  id: string;
  name: string;
  description: string | null;
  source_type: 'local_directory' | 'git_repo' | 'manual';
  source_uri: string | null;
  manifest_path: string | null;
  runtime_scopes: SkillRuntimeScope[];
  trigger_mode: SkillTriggerMode;
  trigger_keywords: string[];
  enabled: 0 | 1;
  priority: number;
  checksum: string | null;
  install_path_set: boolean;
  created_at: number;
  updated_at: number;
}
```

- [x] **Step 3: 创建 SkillsSettingsPanel**

第一版 UI 控件：

- Skills 列表：名称、描述、runtime scopes、trigger mode、priority、enabled。
- 本地导入：输入本地目录路径，按钮调用 API。
- Binding：system scope 默认开关；project/room/agent 绑定可先不在系统设置页完整实现，但保留 API 类型。
- Preview：runtime scope 多选、message textarea、按钮显示命中 reasons 和 prompt preview。

约束：

- 不做 marketplace。
- 不做 Git 导入 UI，或显示 disabled 状态“后续支持”。
- 不把外部 CLI skills 混入这个面板。

- [x] **Step 4: 接入系统设置分类**

`SettingsDialogs.tsx`：

- `SystemSettingsCategory` 增加 `'skills'`。
- 分类按钮加 `Sparkles` 或 `ShieldCheck` 图标。
- 在内容区渲染 `<SkillsSettingsPanel />`。

保持现有 general/chat/model 行为不变。

- [x] **Step 5: 增加 i18n 文案**

在 `i18n.tsx` 中增加中英文 key：

- `settings.skills`
- `settings.skillsDescription`
- `settings.skillsImportLocal`
- `settings.skillsPreview`
- `settings.skillsRuntimeScopes`
- `settings.skillsNoResults`
- 其他面板按钮与状态文案。

- [x] **Step 6: 前端类型检查/build**

Run:

```bash
npm run build -w @openclaw-room/frontend
```

Expected: PASS。

- [x] **Step 7: 提交 Task 5**

```bash
git add packages/frontend/src/lib/types.ts packages/frontend/src/lib/api.ts packages/frontend/src/components/SkillsSettingsPanel.tsx packages/frontend/src/components/SettingsDialogs.tsx packages/frontend/src/lib/i18n.tsx
git commit -m "feat(frontend): 新增内置技能设置面板"
```

---

### Task 6: 整合验证与文档收口

**Files:**
- Modify as needed: `docs/superpowers/plans/2026-05-18-OpenDeepSea内置Skills实施计划.md`
- Modify as needed: `docs/superpowers/specs/2026-05-18-OpenDeepSea内置Skills设计.md`
- Optional Create: `docs/superpowers/verification/YYYY-MM-DD-OpenDeepSea内置Skills验收.md`

- [ ] **Step 1: 全量后端测试**

Run:

```bash
npm run test -w @openclaw-room/backend
```

Expected: PASS。

- [ ] **Step 2: 全量构建**

Run:

```bash
npm run build
```

Expected: PASS。

- [ ] **Step 3: ACP CLI 默认不受影响回归**

确认以下测试仍通过：

```bash
cd packages/backend && node --import tsx --test src/acp/codex.test.ts src/acp/claudecode.test.ts src/acp/opencode.test.ts
```

Expected: PASS。

- [ ] **Step 3.1: 无 skills 兼容回归**

在空 `skills` / `skill_bindings` 状态下确认：

- planner/model chat/workflow 构造的核心 system prompt 仍包含原基础规则。
- `buildPlannerMessages(input)`、`buildModelChatMessages(input)`、`buildSupervisorMessages(input)` 不传 `skillContext` 时不出现 `OpenDeepSea active skills`。
- `executeNode`、`reviewNode`、`acceptanceNode` 发给 `runAcpAgent` 的 prompt 不包含 OpenDeepSea skill context。

- [ ] **Step 4: 手动 smoke**

启动开发服务：

```bash
npm run dev
```

手动验证：

- 打开系统设置，能看到 Skills 分区。
- 导入一个临时本地 skill 目录。
- skill 出现在列表中。
- preview 输入包含关键词时能命中 skill。
- 普通 Codex/Claude/OpenCode agent 调用未额外显示 OpenDeepSea skill 注入。

- [ ] **Step 5: 写验收记录**

如果执行了手动 smoke，记录到：

`docs/superpowers/verification/2026-05-18-OpenDeepSea内置Skills验收.md`

包含：

- 执行命令
- 结果
- 截图路径，如有
- 未覆盖风险

- [ ] **Step 6: 更新计划勾选状态**

把本计划中已完成步骤改为 `- [x]`。如果某步骤因范围调整未做，写明原因。

- [ ] **Step 7: 最终提交**

```bash
git add docs/superpowers/plans/2026-05-18-OpenDeepSea内置Skills实施计划.md docs/superpowers/specs/2026-05-18-OpenDeepSea内置Skills设计.md docs/superpowers/verification/2026-05-18-OpenDeepSea内置Skills验收.md
git commit -m "docs: 记录内置技能验收"
```

---

## 完成标准

- `skills` 与 `skill_bindings` 持久化可用。
- 本地 Markdown skill 可导入、列表展示、启用禁用和绑定。
- Preview API 能解释命中原因并返回 prompt preview。
- Planner、model chat、workflow 内部模型路径和 memory distill 能按 scope 注入 OpenDeepSea skills；execute/review/acceptance 的外部 ACP CLI prompt 默认不注入。
- Execute/ACP CLI 路径默认不注入 OpenDeepSea skills。
- 前端系统设置中可管理和预览 OpenDeepSea 内置 skills。
- `npm run test -w @openclaw-room/backend` 和 `npm run build` 通过。

## 风险提示

- 当前工作区已有未提交改动；实施时必须先确认哪些是用户改动，避免混入或覆盖。
- `routes.ts` 和 `db.ts` 是高冲突 shared 文件，禁止并行写。
- 如果 `tsconfig.tsbuildinfo` 因 build 改动，不应提交，除非项目明确要求。
- Git 导入第一阶段可先返回 `501`，避免把网络和安全边界放进首版。
- 不要引入 YAML 解析依赖，除非 repo 已有依赖或用户确认；简单 frontmatter 足够首版。
