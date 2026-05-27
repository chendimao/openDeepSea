# Superpowers 工作流深度集成设计

## 目标

让当前项目的正式任务工作流默认以 Superpowers 为 runtime profile：会话先识别需要的 skill，再经过 brainstorming、writing-plans、执行、TDD、debugging、review、verification 和 finishing-a-development-branch 门禁。

## 边界

- 不改 vendored `packages/backend/src/superpowers/` 插件源码。
- 不引入新的数据库表。
- 复用现有 LangGraph workflow、内置 workflow definition、agent dispatch、artifact、step 和 graph_state。
- 保持无可执行 agent 的测试与本地最小流程兼容。

## 方案

采用“Superpowers runtime profile + 阶段证据协议”的方式集成。

1. `superpowers-development` 继续作为内置 workflow definition，并声明 required skills 与 gate policy。
2. runtime 按 definition 顺序推进：`context -> brainstorming -> spec_review -> worktree -> writing_plans -> plan_review -> approval -> dispatch -> tdd_execute -> reviews -> verify -> finish_branch -> acceptance -> memory`。
3. 每个 Superpowers 阶段 prompt 都明确要求激活对应 skills，并输出 `superpowers` JSON 证据块。
4. runtime 从 agent 输出、step result 或 verification result 中解析证据，写入 graph_state。
5. 门禁使用 graph_state 判断是否可继续：设计文档、计划文档、RED/GREEN TDD、review verdict、fresh verification、finish branch decision。

## 兼容策略

规划阶段如果没有可执行 planner/reviewer/coordinator agent，runtime 使用现有本地门禁默认值继续推进，避免已有自动化测试和无 ACP 配置环境失败。真实房间中一旦存在可执行 agent，阶段会实际派发 prompt。

## 验证方式

- 后端定向测试覆盖 prompt required skills、证据解析、runtime metadata 与 gates。
- `npm run test -w @openclaw-room/backend`
- `npm run build`
