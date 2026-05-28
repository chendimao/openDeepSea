# 项目内置Superpowers技能接管 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在 project-owned Superpowers 模式下，普通 ACP 聊天使用项目内置 `packages/backend/src/superpowers/skills` 的技能内容，不再依赖本机 `~/.agents/skills` 中的同名技能。

**Architecture:** 扩展 `superpowers-bootstrap`，让项目层 bootstrap 负责注入 `using-superpowers` 与按请求命中的项目内置 Superpowers 技能内容，并在 prompt 中明确禁止读取本机同名 skill。ACP provider 仍只负责普通工具执行与模型运行，`envOverrides` 继续禁用 provider 自己的 Superpowers bootstrap，避免双重接管。

**Tech Stack:** Node.js、TypeScript、SQLite agent run evidence、Node test runner、ACP protocol adapter。

---

### Task 1: 为项目内置 brainstorming 注入写失败测试

**Files:**
- Modify: `packages/backend/src/superpowers-bootstrap.test.ts`
- Modify: `packages/backend/src/dispatcher.test.ts`

- [x] **Step 1: 在 bootstrap 测试中断言 project owner 注入项目内置 brainstorming**

在 `packages/backend/src/superpowers-bootstrap.test.ts` 增加测试：当用户请求包含“新增设置项”和“brainstorming”时，`applySuperpowersBootstrap()` 返回的 prompt 必须包含项目内置技能来源、项目内置 `brainstorming/SKILL.md` 路径、`# Brainstorming Ideas Into Designs` 正文，并包含不要读取 `~/.agents/skills` 的约束。

- [x] **Step 2: 在 dispatcher 测试中断言普通 ACP planner chat 传入项目 skill 内容**

在 `packages/backend/src/dispatcher.test.ts` 增加测试：模拟规划师收到“新增一个很小的设置项，请先按 using-superpowers 判断是否需要进入 workflow，并做简短 brainstorming 澄清，不要修改代码”，捕获 adapter prompt，断言 prompt 包含项目内置 brainstorming，且 `SUPERPOWERS_BOOTSTRAP_DISABLED=1` 仍然存在。

- [x] **Step 3: 运行失败测试**

Run: `rtk node --import tsx --test packages/backend/src/superpowers-bootstrap.test.ts packages/backend/src/dispatcher.test.ts`

Expected: 新增断言失败，因为当前只注入 `using-superpowers`，后续 `brainstorming` 仍依赖 provider/native skill discovery。

### Task 2: 实现 project-owned Superpowers skill 注入

**Files:**
- Modify: `packages/backend/src/superpowers-bootstrap.ts`

- [x] **Step 1: 增加项目内置 skill 路径解析**

在 `superpowers-bootstrap.ts` 中新增 `resolveProjectSuperpowersSkillPath(skillName)`，候选只指向仓库内置路径：

```ts
join(moduleDir, 'superpowers', 'skills', skillName, 'SKILL.md')
join(moduleDir, '..', 'src', 'superpowers', 'skills', skillName, 'SKILL.md')
join(process.cwd(), 'packages', 'backend', 'src', 'superpowers', 'skills', skillName, 'SKILL.md')
join(process.cwd(), 'src', 'superpowers', 'skills', skillName, 'SKILL.md')
```

- [x] **Step 2: 增加请求到技能的轻量选择器**

实现 `selectProjectSuperpowersSkills(prompt)`：

```ts
const selected = ['using-superpowers'];
if (/brainstorming|头脑风暴|新增|添加|设置项|功能|需求|workflow/i.test(prompt)) {
  selected.push('brainstorming');
}
```

只注入存在的项目内置 skill；缺失时保持现有 `skill_missing` 行为。

- [x] **Step 3: 格式化 project-owned skill block**

在 bootstrap 中加入醒目约束：

```text
OpenDeepSea project-owned Superpowers skills are loaded below.
Use these project-builtin skill instructions as the source of truth.
Do not read or invoke same-name skills from ~/.agents/skills, ~/.codex/skills, or ~/.codex/superpowers.
ACP filesystem/search/shell tools remain available according to the agent runtime permission policy.
```

每个技能 block 记录：

```text
Skill: superpowers:<name>
Source: project-builtin
Path: <absolute project builtin path>
Instructions:
<SKILL.md content>
```

- [x] **Step 4: 保持 provider owner 与 workflow run 行为不变**

`owner='provider'`、`owner='disabled'`、`workflowRunId` 仍不注入 project-owned skill 内容；`respondAsAgent()` 仍给 project owner 设置 `SUPERPOWERS_BOOTSTRAP_DISABLED=1`。

### Task 3: 验证与提交

**Files:**
- Test: `packages/backend/src/superpowers-bootstrap.test.ts`
- Test: `packages/backend/src/dispatcher.test.ts`
- Test: `packages/backend/src/acp/codex.test.ts`

- [x] **Step 1: 运行目标测试**

Run: `rtk node --import tsx --test packages/backend/src/superpowers-bootstrap.test.ts packages/backend/src/dispatcher.test.ts`

Expected: PASS，新增 project-builtin skill 断言通过。

- [x] **Step 2: 运行 ACP 回归测试**

Run: `rtk node --import tsx --test packages/backend/src/acp/codex.test.ts`

Expected: PASS，证明 ACP provider 普通工具/协议路径未被破坏。

- [x] **Step 3: 运行后端 build**

Run: `rtk npm run build -w @openclaw-room/backend`

Expected: TypeScript 编译通过。

- [x] **Step 4: 选择性暂存并提交**

只暂存本次文件：

```bash
git add docs/superpowers/plans/2026-05-28-项目内置Superpowers技能接管实施计划.md \
  packages/backend/src/superpowers-bootstrap.ts \
  packages/backend/src/superpowers-bootstrap.test.ts \
  packages/backend/src/dispatcher.test.ts
git commit -m "feat(superpowers): 接管项目内置技能来源"
```

