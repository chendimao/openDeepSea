# OpenDeepSea 内置 Skills 验收记录

日期：2026-05-18

## 范围

- 后端 Skill Registry、导入、绑定、preview API。
- 内部模型路径 prompt 注入：planner、model_chat、workflow supervisor、memory distill。
- ACP CLI 默认隔离：Codex、Claude Code、OpenCode 参数与 graph execute/review/acceptance prompt 不默认注入 OpenDeepSea skills。
- 前端系统设置 Skills 面板：本地导入、列表、启用、system binding、编辑与 preview。

## 已执行验证

### 后端全量测试

命令：

```bash
npm run test -w @openclaw-room/backend
```

结果：未全绿。共 393 个测试，390 通过，3 失败。

失败项：

- `memory routes reject agent and task room mismatches`：`SQLITE_CONSTRAINT_UNIQUE`
- `workflowOrchestrator.start uses legacy runtime when graph disabled`：期望 `blocked`，实际 `running`
- `workflowOrchestrator.recoverOrphanedSteps recovers graph steps before legacy steps`：期望 `3`，实际 `4`

说明：这些失败属于本分支实施前已确认的基线失败范围；本次 Task 4/5 定向测试均已覆盖新增行为。

### ACP CLI 默认不受影响回归

命令：

```bash
cd packages/backend && node --import tsx --test src/acp/codex.test.ts src/acp/claudecode.test.ts src/acp/opencode.test.ts
```

结果：通过，23 个测试全部通过。

### 全量构建

命令：

```bash
npm run build
```

结果：通过。Vite 输出 chunk 大小 warning，未阻断构建。

### Task 4 定向测试

命令：

```bash
cd packages/backend && node --import tsx --test --test-concurrency=1 src/workflows/langchain-planner.test.ts src/workflows/orchestrator.test.ts src/workflows/supervisor.test.ts src/dispatcher.test.ts src/memory/distill.test.ts src/workflows/memory.test.ts src/workflows/graph/execute.test.ts src/workflows/graph/review.test.ts src/workflows/graph/recovery.test.ts src/workflows/graph/runtime.test.ts
```

结果：通过，88 个测试全部通过。

### Task 5 / DTO 脱敏验证

命令：

```bash
cd packages/backend && node --import tsx --test src/skills/routes.test.ts
npm run build -w @openclaw-room/frontend
```

结果：均通过。

## 手动 Smoke

未启动 `npm run dev` 做浏览器手动 smoke。本次以前端 build、后端 API routes 测试和 reviewer 审查覆盖首版功能。后续若进行人工验收，应补充截图与具体操作记录。

## Review 记录

- Task 4 reviewer 指出 legacy workflow `rememberAcceptedTask()` 未向 `distillFromTask()` 传入 memory skill context；已补实现与回归测试。
- Task 5 reviewer 指出 `source_uri` 会暴露本地导入源绝对路径；已从后端 DTO 和前端类型中移除，并补 routes 测试。
- Task 5 reviewer 指出的表单 state、priority 校验、i18n、preview 长文本与 manual skill preview 问题已修复。

## 未覆盖风险

- Git skill 导入仍按计划延后，接口返回 `501`。
- 前端面板目前只提供 system binding 快捷开关；project/room/agent 绑定保留 API 与类型，未做完整 UI。
- 后端全量测试仍有 3 个基线失败，需单独排期修复。
