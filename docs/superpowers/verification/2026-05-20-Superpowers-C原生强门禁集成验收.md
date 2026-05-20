# Superpowers C 原生强门禁集成验收

**日期：** 2026-05-20

**范围：** Superpowers-C 唯一工作流、review agent 门禁、TDD/verification/finish branch 状态、前端工作流页面与任务气泡展示。

## 验收结论

- 后端 Superpowers runtime 定向测试通过。
- 前端 WorkflowTaskBubble 定向测试通过。
- 全量 build 通过。
- 浏览器全功能测试通过，覆盖工作流页面、房间任务 UI、移动端横向溢出与控制台错误。

## 命令验证

```bash
node --import tsx --test packages/backend/src/workflows/graph/superpowers-runtime.test.ts packages/backend/src/workflows/graph/runtime.test.ts
```

结果：55/55 pass。

```bash
node --import tsx --test packages/frontend/src/components/WorkflowTaskBubble.test.tsx
```

结果：17/17 pass。

```bash
npm run build
```

结果：通过；Vite 仍提示主 bundle 超过 500 kB，这是既有体积警告，不影响本次功能验收。

## 浏览器验证

本次使用当前代码启动：

```bash
PORT=7331 npm run dev:backend
VITE_BACKEND_URL=http://localhost:7331 npm run dev -w @openclaw-room/frontend -- --port 5175
```

Playwright 验证结果写入：

- `docs/superpowers/verification/2026-05-20-superpowers-c-browser-test.json`

截图证据：

- `docs/superpowers/verification/screenshots/2026-05-20-superpowers-c-workflow-page-browser.png`
- `docs/superpowers/verification/screenshots/2026-05-20-superpowers-c-room-browser.png`
- `docs/superpowers/verification/screenshots/2026-05-20-superpowers-c-workflow-mobile-browser.png`

覆盖项：

- `/workflow` 只显示 Superpowers 只读目录，不显示创建、复制、发布、删除等自定义工作流入口。
- 项目房间页面可正常渲染 workflow/task 信号，无浏览器 console error。
- 移动端 `/workflow` 无横向溢出。

## 代码审查记录

审查发现并已修复：

- `runSuperpowersReview()` 创建 review step 后未在 agent 完成时回写 step status/result/agent_run_id，可能导致真实 UI 残留 running review step。
- 修复后新增断言：Superpowers review node 会将对应 `workflow_steps` 标记为 `completed`，并写入 `agent_run_id` 与 `result`。

## 残余风险

- 浏览器测试复用了本地 SQLite 中现有项目/房间数据，没有创建端到端新任务并真实驱动 ACP CLI 完整执行；本次行为闭环由后端 runtime 测试覆盖。
- Vite bundle size warning 仍存在，属于性能优化项，不在本次 Superpowers-C 门禁交付范围。
