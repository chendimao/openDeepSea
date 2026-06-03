# Superpowers 自动推进与任务卡片覆盖入口设计

## 背景

当前群聊任务卡片直接展示四个并列动作：开始执行、头脑风暴、编写计划、子代理执行。这个交互把 Superpowers 的内部阶段暴露成主入口，用户需要自己判断下一步该点哪个按钮。实际运行中还存在两个问题：

1. `brainstorming`、`writing-plans` 本质上应由 planner 负责，而不是由前端、后端或测试执行者提前介入。
2. 当 ACP run 中断或缺少 evidence 时，任务动作可能停留在 `running`，卡片按钮持续转圈，用户难以判断是阶段未完成、路由错误，还是需要重试。

目标是把任务卡片从“手动选择阶段”改为“自动推进为主，人工覆盖为辅”。

## 目标

- 任务卡片默认只提供一个主入口：`自动推进`。
- `自动推进` 由 planner 先执行 `using-superpowers` 路由判断，决定下一步应调用哪个 Superpowers skill 或进入哪个执行阶段。
- `brainstorming` 与 `writing-plans` 仍由 planner 执行，并分别产出 `designDocPath` 与 `implementationPlanPath` evidence。
- 前端、后端、测试等执行类智能体只在执行、调试、验证阶段介入。
- 原四个动作降级为“更多”菜单中的人工覆盖、重试或调试入口。
- 所有阶段必须写入终态事件，避免按钮或阶段状态永久停留在 `running`。

## 非目标

- 不改变 Superpowers 原始 skill 的语义。
- 不让 `using-superpowers` 直接替代 `brainstorming`、`writing-plans` 或 `systematic-debugging`。
- 不让前端、后端执行者负责写主 spec 或主 plan。
- 不在第一版实现复杂的多 planner 投票或多 spec 合并。
- 不重新设计 ACP provider 的底层协议。

## 角色职责

### Planner

planner 是 Superpowers 流程的主控智能体，负责：

- 调用或遵循 `using-superpowers`，输出下一步 skill routing。
- 执行 `brainstorming`，澄清需求、设计方案，并写入 spec。
- 执行 `writing-plans`，基于 spec 写入 implementation plan。
- 根据 plan 和任务领域选择执行阶段的前端、后端、测试、审查或验收智能体。
- 汇总阶段 evidence，并把流程推进到下一阶段。

### 执行类智能体

前端、后端、测试、审查、验收智能体只在 planner 完成 spec/plan 之后介入：

- 前端执行者：实现前端任务、组件、交互、前端测试。
- 后端执行者：实现 API、仓储、状态机、ACP 接线、后端测试。
- 测试/调试智能体：在失败测试、异常行为或明确 bug 阶段执行 `systematic-debugging`。
- 审查智能体：执行代码审查与验收验证。

## 自动推进流程

任务卡片点击 `自动推进` 后，后端按以下顺序运行：

1. 记录 `task_action=auto_advance`，状态为 `running`。
2. planner 执行 skill routing prompt。
3. planner 输出机器可读 JSON：

```json
{
  "superpowers_routing": {
    "next_action": "brainstorming",
    "required_skill": "brainstorming",
    "reason": "任务是功能/行为变更，需要先澄清需求并产出 spec。",
    "recommended_agent_id": "planner",
    "expected_evidence": ["designDocPath"]
  }
}
```

4. 后端根据 `next_action` 调用现有 task action：
   - `brainstorming`
   - `writing_plans`
   - `subagent_execution`
   - `systematic_debugging`
   - `verification`
   - `finish_branch`
   - `blocked`
5. 被调用阶段完成后，写入对应 evidence。
6. 若阶段成功且存在后续阶段，卡片显示下一步可自动推进。
7. 若阶段失败、中断或缺少 evidence，卡片显示失败/阻塞，并提供重试入口。

## 阶段状态机

任务卡片展示状态从任务 `status` 和 task action evidence 派生，而不是只看按钮状态。

建议状态：

- `待路由`：尚未运行 `auto_advance`。
- `路由完成`：已得到 `superpowers_routing`，但尚未执行阶段。
- `头脑风暴中`：`brainstorming` 正在运行。
- `Spec 已生成`：存在 completed `brainstorming` evidence，且包含 `designDocPath`。
- `编写计划中`：`writing_plans` 正在运行。
- `Plan 已生成`：存在 completed `writing_plans` evidence，且包含 `implementationPlanPath`。
- `执行中`：执行类智能体正在按 plan 运行。
- `调试中`：测试或异常触发 `systematic-debugging`。
- `验收中`：执行验证、审查或 completion gate。
- `完成`：任务完成并有最终验证 evidence。
- `失败`：阶段失败。
- `阻塞`：缺少前置证据、缺少可执行智能体、等待用户确认或运行中断。

## 任务卡片交互

### 主入口

卡片主按钮显示为：

```text
自动推进
```

按钮说明：

- 根据当前 evidence 和 planner routing 自动选择下一步。
- 不要求用户理解内部 Superpowers 阶段。
- 当前存在 active agent run 时禁用。

### 更多菜单

原四个按钮进入 `更多` 菜单，作为人工覆盖和重试入口：

```text
更多
  - 重新运行路由判断
  - 强制头脑风暴
  - 强制编写计划
  - 强制执行计划
  - 强制诊断/调试
```

菜单项行为：

- `重新运行路由判断`：只重新生成 `superpowers_routing`。
- `强制头脑风暴`：调用 planner 的 `brainstorming` phase。
- `强制编写计划`：要求已有 `designDocPath`，否则阻塞。
- `强制执行计划`：要求已有 `implementationPlanPath`，否则阻塞。
- `强制诊断/调试`：调用测试/调试智能体执行 `systematic-debugging`。

## Evidence 规则

`using-superpowers` 路由阶段必须输出：

```json
{
  "superpowers_routing": {
    "next_action": "brainstorming",
    "required_skill": "brainstorming",
    "reason": "非空字符串",
    "recommended_agent_id": "planner",
    "expected_evidence": ["designDocPath"]
  }
}
```

`brainstorming` 完成必须输出：

```json
{
  "superpowers": {
    "designDocPath": "docs/superpowers/specs/YYYY-MM-DD-topic-design.md",
    "designReviewVerdict": "approved"
  }
}
```

`writing-plans` 完成必须输出：

```json
{
  "superpowers": {
    "implementationPlanPath": "docs/superpowers/plans/YYYY-MM-DD-topic.md",
    "planReviewVerdict": "approved"
  }
}
```

执行阶段必须输出 TDD、调试、审查或验证 evidence。具体字段沿用现有 Superpowers phase evidence，不在本设计中重新定义。

## 后端设计

### 新增 TaskActionKind

新增或等价支持：

```ts
type TaskActionKind =
  | 'auto_advance'
  | 'route_skills'
  | 'brainstorming'
  | 'writing_plans'
  | 'subagent_execution'
  | 'systematic_debugging';
```

其中 `auto_advance` 是主入口；`route_skills` 可作为内部阶段或更多菜单入口。

### 新增 routing parser

新增 `superpowers-routing.ts`，负责：

- 从 planner 输出中提取 `superpowers_routing` JSON。
- 校验 `next_action`、`required_skill`、`recommended_agent_id`、`expected_evidence`。
- 把非法输出转换为 `blocked`，而不是继续猜测。

### 调度策略

`auto_advance` 的调度逻辑：

1. 如果已有 active run，返回 blocked。
2. 如果存在 running task action，返回 blocked 或提供 recovery。
3. 如果没有 `designDocPath`，优先 routing 到 `brainstorming`。
4. 如果有 `designDocPath` 但没有 `implementationPlanPath`，优先 routing 到 `writing_plans`。
5. 如果有 plan，进入 execution 或 debugging，具体由 routing 决定。
6. 如果 routing 输出 blocked，记录 blocked reason。

### 中断收尾

任何 task-bound agent run 出现 `interrupted`、`failed`、`cancelled` 时，后端必须为关联 task action 写入 terminal event：

```json
{
  "task_action_status": "failed",
  "error": "Backend restarted before agent run completed"
}
```

如果能识别为后端重启恢复场景，也可以使用 `blocked`：

```json
{
  "task_action_status": "blocked",
  "blocked_reason": "运行被后端重启中断，请重试该阶段"
}
```

## 前端设计

### ChatTaskCard

卡片主区域保留任务摘要、进度、owner、priority、status、time。

底部动作区改为：

- 主按钮：`自动推进`
- 次按钮：`更多`

`更多` 菜单内放人工覆盖动作。第一版可复用现有按钮组件，但视觉上应从并列主按钮降级为菜单项。

### 状态派生

新增前端状态模型，例如：

```ts
type SuperpowersTaskStage =
  | 'unrouted'
  | 'routing'
  | 'routed'
  | 'brainstorming'
  | 'spec_ready'
  | 'planning'
  | 'plan_ready'
  | 'executing'
  | 'debugging'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'blocked';
```

状态从以下数据派生：

- task status
- task action events
- agent run status
- `designDocPath` evidence
- `implementationPlanPath` evidence
- active workflow/run 信息

### 按钮禁用规则

- 有 active run：禁用 `自动推进`。
- 当前阶段 running：主按钮显示当前阶段运行中。
- 缺少前置 evidence：对应强制动作显示阻塞提示。
- 终态 failed/blocked：主按钮文案显示 `重试自动推进`。

## 风险与权衡

- 自动推进可能误判下一步，因此需要保留 `更多` 菜单作为人工覆盖。
- planner 仍可能输出不完整 JSON，因此 routing parser 必须严格校验并安全阻塞。
- 如果 planner 权限是 read-only，无法完成 spec/plan 写入；完整流程要求 planner 具备写入 `docs/superpowers/specs/` 与 `docs/superpowers/plans/` 的权限。
- 多平台 ACP 行为不同，应优先使用 project-owned Superpowers 注入，减少 provider 自带插件差异。
- 中断恢复是独立但必要的可靠性修复，否则 UI 状态会继续出现永久转圈。

## 验收标准

- 任务卡片默认只展示 `自动推进` 主入口和 `更多` 菜单。
- 点击 `自动推进` 后，planner 先产出 `superpowers_routing` evidence。
- 功能变更任务在缺少 spec 时自动进入 planner 的 `brainstorming`。
- 已有 spec 但缺少 plan 时自动进入 planner 的 `writing-plans`。
- 已有 plan 时进入执行阶段，并按任务领域选择前端/后端/测试等执行类智能体。
- `brainstorming`、`writing-plans` 只由 planner 执行。
- 前端/后端/测试智能体只在执行、调试、验证阶段介入。
- 任何 failed、cancelled、interrupted run 都会写入终态 task action event。
- UI 不会因为缺少终态事件而永久显示转圈。

## 测试建议

- 后端单元测试：
  - `auto_advance` 缺少 spec 时路由到 `brainstorming`。
  - 已有 `designDocPath` 时路由到 `writing_plans`。
  - 已有 `implementationPlanPath` 时路由到 execution。
  - routing JSON 缺字段时记录 blocked。
  - interrupted run 补写 failed 或 blocked task action event。
- 前端单元测试：
  - 卡片默认渲染 `自动推进` 和 `更多`。
  - completed `brainstorming` evidence 显示 `Spec 已生成`。
  - running action 显示阶段运行中。
  - failed/blocked action 显示重试入口。
- 集成验证：
  - 在群聊创建新功能任务，点击 `自动推进`，观察 planner 执行 `brainstorming` 并写入 spec evidence。
  - 再次点击 `自动推进`，观察 planner 执行 `writing-plans` 并写入 plan evidence。
  - 模拟 ACP 中断，确认卡片不会永久转圈。
