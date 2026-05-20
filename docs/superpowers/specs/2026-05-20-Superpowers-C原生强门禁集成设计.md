# Superpowers C 原生强门禁集成设计

## 背景

Superpowers 不能只当作一批 `SKILL.md` 导入。要在 OpenDeepSea 中实现 Superpowers 的完整能力，应把它做成内置开发方法论包：

- skills 作为知识与提示词源。
- workflow definition 作为编排骨架和 UI 展示源。
- agent provisioning、review gates、verification gates 作为强制执行层。

已核对 Superpowers GitHub README 与本地源码 `/Users/chendimao/WWW/superpowers`。本地版本为 `5.1.0`，插件声明 skills 目录为 `./skills/`。官方主流程为：

```text
brainstorming
  -> using-git-worktrees
  -> writing-plans
  -> subagent-driven-development 或 executing-plans
  -> test-driven-development
  -> requesting-code-review
  -> finishing-a-development-branch
```

Superpowers 明确要求这些 workflow 是 mandatory workflows，而不是建议。

## 当前系统现状

OpenDeepSea 已具备以下基础设施：

1. `workflow definitions`：已有 `默认开发闭环` 和 `方案文档闭环`，节点为 `context/planning/approval/dispatch/execute/review/verify/acceptance/memory`。
2. `skills` 系统：已有 `runtime_scopes`、`trigger_mode`、bindings、selector 和 prompt 注入能力。
3. `workflow prompt`：已有分析、规划、执行、审查、验收提示词，但还不是 Superpowers 原生流程。
4. 子任务派发：已有 executor、reviewer、acceptor 角色与 child task 机制，但缺少 Superpowers 的两阶段 review 和强制 TDD 证据。
5. LangGraph runtime：真实执行图当前在后端硬编码，workflow definition 主要用于选择、展示和快照，不是完整可执行 DSL。

## 决策

采用 C 级原生强门禁集成。Superpowers 不替代整个底层架构，也不要求重写 ACP、任务、agent_run 或 workflow_run 模型。它作为新的 `runtime profile` 接入现有底座。

保留现有默认 runtime 和自定义 workflow definition 的兼容路径：

- `default-langgraph` 和既有自定义工作流继续使用当前兼容 runtime。
- 新增 `superpowers-development` 内置 workflow definition。
- 只有 `builtin_key = superpowers-development`，或后续显式标记 `runtime_profile = "superpowers"` 的 definition，才走 Superpowers 强门禁 runtime。

## 目标

1. 新增内置 `Superpowers 开发闭环` workflow definition。
2. 扩展 workflow 类型、状态和运行时，使 Superpowers 专属节点可追踪、可门禁。
3. 内置导入 Superpowers 核心 skills，并按 runtime 阶段注入。
4. 用系统状态机强制执行 spec、plan、TDD、review、verification、finish branch 门禁。
5. 在 UI 中展示当前 skill gate、等待批准的 spec/plan、TDD 证据、review findings、verification results 和 finish branch 选项。
6. 保持既有默认/自定义工作流可用，不破坏历史运行记录。

## 非目标

1. 不把 workflow definition 改造成任意节点都可执行的通用 DSL。
2. 不删除自定义 workflow 管理能力。
3. 不物理删除现有数据库字段或历史 definition。
4. 不改变 ACP provider 协议。
5. 不在第一阶段实现所有分支收口操作的真实 merge/PR 自动化；可以先记录选项和用户选择。

## Superpowers Workflow Definition

新增内置 definition：

- `builtin_key`: `superpowers-development`
- 名称：`Superpowers 开发闭环`
- scope：`system`
- status：`published`
- runtime profile：`superpowers`

阶段映射：

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

说明：

- 第一个 `spec_review` 审查 brainstorming 产出的设计文档。
- `spec_compliance_review` 审查实现是否符合 spec/plan。
- `code_quality_review` 审查代码质量、bug、回归风险和遗漏验证。
- `verify` 对应 `verification-before-completion`。
- `finish_branch` 对应 `finishing-a-development-branch`。

## 类型与元数据扩展

当前 `WorkflowDefinitionNodeType` 没有 Superpowers 节点。长期方案是扩展类型，而不是只用通用节点伪装。

新增节点类型：

- `brainstorming`
- `spec_review`
- `worktree`
- `writing_plans`
- `plan_review`
- `tdd_execute`
- `spec_compliance_review`
- `code_quality_review`
- `finish_branch`

新增或扩展 definition metadata：

- `runtime_profile`: `default | superpowers`
- 节点级 `required_skill_names`
- 节点级 `gate_policy`

如果短期不迁移数据库结构，可先把 metadata 放入 definition JSON。TypeScript 类型和 validator 必须能识别这些字段。

## Runtime 设计

### Profile 选择

后端启动 workflow 时先解析 selected workflow definition：

```text
definition.builtin_key == superpowers-development
  或 definition.metadata.runtime_profile == superpowers
    -> buildSuperpowersRuntimeGraph()
否则
    -> buildDefaultRuntimeGraph()
```

这保留默认/自定义工作流兼容路径，同时让 Superpowers 拥有独立强门禁执行图。

### Superpowers 状态

在 `AgentWorkflowState` 中新增可持久化字段：

- `runtimeProfile`
- `superpowersPhase`
- `designDocPath`
- `designReviewVerdict`
- `implementationPlanPath`
- `planReviewVerdict`
- `worktree`
- `tddEvidence`
- `specComplianceReview`
- `codeQualityReview`
- `verificationEvidence`
- `finishBranchDecision`

这些字段不替代现有 `plan`、`workflowPlan`、`reviewFindings`、`verificationResults`，而是增加 Superpowers 门禁语义。

### 强门禁

每个阶段必须满足门禁条件后才能进入下一阶段：

- `brainstorming`：必须产生 spec/design doc，并记录用户批准或明确的自动继续依据。
- `spec_review`：必须记录 approved 或 issues，并阻止有 critical issue 的 spec 进入 plan。
- `worktree`：必须记录已有隔离、新建隔离、用户跳过或环境不适用原因。
- `writing_plans`：必须产生计划文档，并能解析出可执行任务。
- `plan_review`：必须通过计划审查。
- `approval`：如果 plan 要求人工批准，runtime 进入 `awaiting_approval`。
- `dispatch`：按 plan task 创建 child tasks，并选择合适 agent。
- `tdd_execute`：行为改动必须记录 RED、GREEN、REFACTOR；豁免必须写明原因。
- `spec_compliance_review`：实现不符合 spec/plan 时返回执行修复。
- `code_quality_review`：critical/important issue 阻塞继续。
- `verify`：必须运行新鲜验证命令并记录结果。
- `finish_branch`：必须展示 merge/PR/keep/discard 或系统支持的等价选项，并记录选择。
- `acceptance`：基于原始目标、spec、plan、review、verify 判断完成。

## Skills 集成

内置导入以下 Superpowers skills：

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

导入策略：

1. skills 作为内置安装源，可从本地 `/Users/chendimao/WWW/superpowers/skills` 或后续插件包同步。
2. Superpowers runtime 节点通过 `required_skill_names` 选取技能内容。
3. prompt 注入不是完成条件，门禁仍由 runtime 状态和产物检查执行。
4. 保留用户在 Skills 页面查看和更新这些 skills 的能力。

## Agent Provisioning 与 Review

现有 executor/reviewer/acceptor 角色可以复用，但 Superpowers 需要更细分的 review 角色：

- spec reviewer：审查设计文档。
- plan reviewer：审查 implementation plan。
- spec compliance reviewer：审查实现是否符合 spec/plan。
- code quality reviewer：审查 bug、回归风险、边界和遗漏验证。

第一阶段可复用现有 reviewer template，通过 prompt 区分审查类型；后续可新增内置 agent templates。

## UI 设计

Workflow 页面需要能展示 Superpowers run 的专属状态：

- 当前 skill gate。
- spec/design doc 路径和批准状态。
- plan doc 路径和批准状态。
- worktree 状态。
- child task 的 TDD 证据。
- spec compliance review 和 code quality review findings。
- verification results。
- finish branch 选项和最终选择。

Workflow definition 管理页继续保留：

- 默认/自定义 workflow 仍可管理。
- Superpowers 内置 definition 只读，不允许 archive/delete。
- 如果后续支持复制 Superpowers 模板，发布校验必须保证强制门禁节点完整；本设计第一阶段不要求实现复制 Superpowers 模板。

## 兼容性

1. 历史 workflow run 不迁移。
2. 现有 default/custom workflow 的运行路径不变。
3. 新 Superpowers runtime 只在选中 Superpowers definition 时启用。
4. settings 中的 default workflow 仍然有效，用户可以把默认 workflow 设置成 Superpowers，也可以继续使用旧默认工作流。
5. 如果 supervisor 选择 Superpowers definition，则运行 Superpowers runtime；如果选择其他 definition，则运行兼容 runtime。

## 分阶段落地

### 阶段 1：骨架与兼容

- 新增 Superpowers definition。
- 扩展类型和 validator。
- runtime 按 profile 分流。
- Skills 内置导入和阶段 prompt 注入。
- UI 可展示 Superpowers definition。

### 阶段 2：核心门禁

- 实现 brainstorming、spec_review、writing_plans、plan_review。
- 实现 approval 与 dispatch 衔接。
- 实现 spec/plan artifact 记录。

### 阶段 3：执行与审查

- 实现 tdd_execute 证据结构。
- 实现 spec_compliance_review 与 code_quality_review。
- 实现 review 失败回到执行修复。

### 阶段 4：验证与收口

- 实现 verification-before-completion 的新鲜验证门禁。
- 实现 finish_branch 选项与选择记录。
- UI 展示 verification 和 branch closeout。

## 验收标准

1. 系统中存在内置 `Superpowers 开发闭环` definition。
2. 选中 Superpowers definition 后，workflow run 使用 Superpowers runtime。
3. 选中默认/自定义 definition 后，旧 runtime 仍可运行。
4. Superpowers run 能创建并展示专属阶段步骤。
5. 缺失 spec、plan、TDD、review 或 verification 证据时，runtime 不会错误跳过门禁。
6. Superpowers skills 能按阶段注入 prompt。
7. UI 能展示 Superpowers gate 状态和关键证据。
8. `npm run build` 通过，相关后端和前端测试通过。

