# Superpowers 唯一工作流设计

> 状态：历史设计，核心决策已并入 `docs/superpowers/specs/2026-05-20-Superpowers-C原生强门禁集成设计.md`。最新决策是去掉默认/自定义工作流，只保留 Superpowers-C 原生强门禁方案。

## 背景

OpenDeepSea 当前已经具备工作流运行的核心底座：任务、子任务、智能体运行、工作流步骤、验证结果、上下文记忆、Skills 注入和前端工作流可视化。现有自定义工作流定义主要承担选择、展示和快照作用；真实运行路径由后端 LangGraph runtime 固定编排。

Superpowers 的目标不是增加一个可选模板，而是成为系统唯一的软件开发方法论。系统不再提供用户自定义工作流能力，所有新的开发任务统一进入 Superpowers 强门禁流程。

## 目标

1. 将 Superpowers C 方案作为唯一可执行开发闭环。
2. 去掉自定义工作流创建、编辑、复制、发布、归档、默认选择入口。
3. 保留现有 workflow 底层表和历史快照，避免破坏既有运行记录。
4. 将 Superpowers skills 从普通提示词资料升级为运行时门禁策略。
5. 让每个关键阶段都有系统可追踪的产物、状态和验证证据。

## 非目标

1. 不在本轮设计中物理删除数据库表或字段。
2. 不继续支持任意用户自定义节点图作为可执行流程。
3. 不把 Superpowers 仅作为 prompt 文本导入。
4. 不改变 ACP provider 的底层协议。
5. 不要求历史 workflow run 重新解释为 Superpowers run。

## 总体架构

系统保留当前 `workflow_runs`、`workflow_steps`、`tasks`、`agent_runs`、`workflow_context`、`settings` 等基础设施。新的运行逻辑由唯一 Superpowers runtime 接管：

```text
context
  -> brainstorming
  -> spec_review
  -> worktree
  -> writing_plans
  -> plan_review
  -> approval
  -> dispatch
  -> tdd_execute
  -> spec_compliance_review
  -> code_quality_review
  -> verify
  -> finish_branch
  -> acceptance
  -> memory
```

`workflow_definition_id`、`workflow_definition_snapshot` 可以继续写入内置 Superpowers definition，用于历史追踪和 UI 展示。系统设置、项目设置、房间设置中的默认工作流选择不再生效。

## 后端设计

### 内置唯一定义

新增内置 definition：

- `builtin_key`: `superpowers-development`
- 名称：`Superpowers 开发闭环`
- scope：`system`
- status：`published`

旧的 `default-langgraph` 与 `analysis-document` 不再作为新任务候选。可以保留在数据库中用于历史记录和兼容查询，但新任务启动时不再选择它们。

### 禁用自定义工作流

后端 API 调整：

- `GET /api/workflow-definitions`：返回唯一 Superpowers definition，或返回只读历史列表，具体以 UI 需求为准。
- `POST /api/workflow-definitions`：禁用，返回 410 或 400，说明自定义工作流已移除。
- `POST /api/workflow-definitions/:id/duplicate`：禁用。
- `POST /api/workflow-definitions/:id/publish`：禁用。
- `POST /api/workflow-definitions/:id/archive`：禁用。
- `DELETE /api/workflow-definitions/:id`：禁用。
- `GET /api/rooms/:roomId/workflow-definitions`：返回唯一 Superpowers definition。

repo 层保留历史方法，但新代码路径不再调用自定义 CRUD。相关测试改为断言自定义入口被禁用。

### 运行时选择

移除或绕过 supervisor 选择 workflow definition 的逻辑。新任务启动时直接使用 `superpowers-development`。

现有逻辑：

```text
visible definitions -> supervisor decision -> selected definition -> fallback
```

目标逻辑：

```text
task -> superpowers-development -> Superpowers runtime
```

保留 supervisor 用于任务分析、分配建议和恢复决策，但不再让它选择工作流定义。

### Superpowers 状态扩展

`AgentWorkflowState` 需要新增可持久化字段：

- `superpowersPhase`: 当前 Superpowers 阶段。
- `designDocPath`: brainstorming 产出的设计文档路径。
- `designReviewVerdict`: spec review 结果。
- `implementationPlanPath`: writing-plans 产出的计划文档路径。
- `planReviewVerdict`: plan review 结果。
- `worktree`: 工作区隔离状态、路径、分支、是否跳过。
- `tddEvidence`: 每个执行子任务的 RED/GREEN/REFACTOR 记录。
- `specComplianceReview`: 规格符合性审查结果。
- `codeQualityReview`: 代码质量审查结果。
- `verificationEvidence`: 完成前验证命令和输出摘要。
- `finishBranchDecision`: merge、PR、keep、discard 等收口选择。

这些字段不替代现有 `reviewFindings`、`verificationResults`，而是让 Superpowers 门禁有明确语义。

### 门禁规则

每个阶段必须满足前置条件后才能进入下一阶段：

- `brainstorming`：必须产生设计文档，并记录用户批准或系统可追踪的批准事件。
- `spec_review`：必须通过自审或审查智能体审查。
- `worktree`：必须记录已隔离、用户选择跳过、或当前环境不适用的原因。
- `writing_plans`：必须产生实现计划文档。
- `plan_review`：必须通过计划审查。
- `approval`：需要用户批准的计划必须等待批准。
- `tdd_execute`：行为改动必须记录 RED、GREEN、REFACTOR；不适用 TDD 时必须记录豁免原因。
- `spec_compliance_review`：必须验证实现满足计划和设计。
- `code_quality_review`：必须检查 bug、回归风险和遗漏验证。
- `verify`：必须运行新鲜验证命令，不能使用过期结果。
- `finish_branch`：必须记录分支收口选项和最终选择。
- `acceptance`：基于原始目标、设计、计划、审查和验证结果进行验收。

## Skills 集成

内置导入 `/Users/chendimao/WWW/superpowers/skills` 中的核心 skills：

- `using-superpowers`
- `brainstorming`
- `using-git-worktrees`
- `writing-plans`
- `subagent-driven-development`
- `executing-plans`
- `test-driven-development`
- `requesting-code-review`
- `receiving-code-review`
- `finishing-a-development-branch`
- `systematic-debugging`
- `verification-before-completion`
- `dispatching-parallel-agents`
- `writing-skills`

导入后不只用于展示。每个 runtime 阶段应声明对应 `requiredSkillNames`，构建 prompt 时按阶段注入对应 skill 内容，并在状态机中强制检查产物。

## 前端设计

### 移除自定义入口

移除或隐藏：

- 工作流管理页中的新建、编辑、复制、发布、归档、删除。
- `WorkflowBuilderDialog` 入口。
- 系统设置、项目设置、房间设置中的默认工作流选择。
- 与默认工作流继承相关的提示。

### 保留只读工作流视图

可以保留一个只读页面展示：

- 当前唯一流程：`Superpowers 开发闭环`。
- 每个阶段的说明、状态、产物和阻塞原因。
- 当前 run 的 design doc、plan doc、review、verification、finish branch 证据。

该页面不再是工作流编辑器，而是 Superpowers 流程说明和运行观察面板。

## 兼容策略

1. 历史运行记录继续按原有快照展示。
2. 已存在的自定义 workflow definition 不再可编辑或被选为新任务默认流程。
3. `settings.default_workflow_definition_id` 字段保留，但新任务启动时忽略。
4. 如果历史设置指向旧 definition，前端不再显示为可配置项，后端不报错。
5. 后续确认稳定后，可以再设计物理清理迁移。

## 测试策略

### 后端测试

- 启动新 workflow 时总是选择 `superpowers-development`。
- 自定义 workflow CRUD 返回禁用状态。
- 设置接口不再允许更新默认 workflow，或更新后不影响实际运行。
- Superpowers 每个阶段会创建对应 `workflow_steps`。
- 未满足门禁时不会进入下一阶段。
- verify 阶段必须记录新鲜验证结果。

### 前端测试

- 设置弹窗不再出现默认工作流选择。
- 工作流页面不再出现新建、编辑、发布、归档入口。
- Superpowers 只读流程页能展示阶段和当前 run 证据。
- 历史 workflow run 仍可查看。

### 构建验证

- `npm run build`
- 相关后端 node test
- 相关前端组件测试

## 风险与处理

### 风险：旧测试大量依赖自定义 workflow CRUD

处理：测试分批改造。先把 route/repo 测试改为禁用行为，再调整 settings 和 runtime 测试。

### 风险：一次性实现全部门禁改动过大

处理：分阶段落地。第一阶段固定唯一 workflow 并移除自定义入口；第二阶段扩展 Superpowers runtime 节点；第三阶段强化 TDD、review、finish branch 证据。

### 风险：历史数据和新流程语义混杂

处理：新 run 统一写入 `superpowers-development`，历史 run 只读展示，不参与新流程决策。

### 风险：worktree 在当前部署环境不可用

处理：worktree 阶段必须记录环境检测结果；允许用户明确跳过，但跳过本身是可审计事件。

## 验收标准

1. 新任务启动时不再选择自定义 workflow definition。
2. 前端没有创建或编辑自定义工作流的入口。
3. 设置中没有默认工作流选择。
4. 系统内置且唯一使用 `Superpowers 开发闭环`。
5. Superpowers 阶段在 workflow timeline 中可追踪。
6. 未满足关键门禁时，runtime 不会继续推进。
7. 历史 workflow run 可查看，不因移除自定义入口而丢失。

## 后续实施顺序

1. 固定唯一 Superpowers definition，并禁用自定义 CRUD。
2. 移除前端自定义工作流管理和默认 workflow 设置入口。
3. 扩展 workflow state 与 Superpowers 阶段节点。
4. 接入 Superpowers skills 导入与阶段 prompt 注入。
5. 实现 spec、plan、TDD、review、verification、finish branch 门禁。
6. 补齐后端、前端和端到端验证。
