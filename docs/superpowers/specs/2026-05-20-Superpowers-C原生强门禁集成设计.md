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

## 复核补充

再次核对 GitHub README、本地源码和 v5.1.0 release notes 后，需要补入以下范围：

1. **Bootstrap 不是普通 skill 注入。** Superpowers 通过 SessionStart hook 或 OpenCode message transform 把 `using-superpowers` 作为会话级 bootstrap 注入。OpenDeepSea 需要等价的 workflow/agent bootstrap，确保任务启动前就知道必须检查 skills。
2. **Skill 资产不止 `SKILL.md`。** `brainstorming` 包含 visual companion 的 `scripts/`、`visual-companion.md` 和浏览器事件协议；`requesting-code-review`、`writing-plans`、`subagent-driven-development` 包含 prompt template 文件。这些都应作为内置方法论资产同步和版本化。
3. **Spec/Plan review 以 inline self-review 为默认。** v5.0.6 后，brainstorming 和 writing-plans 的 spec/plan review loop 从子代理循环调整为 inline self-review。OpenDeepSea 可以保留 `spec_review`、`plan_review` 节点，但默认应执行自审清单；子代理审查作为可选加强，不是默认阻塞路径。
4. **没有 named `superpowers:code-reviewer` agent。** v5.1.0 已移除 named code-reviewer，审查应使用 `Task/general-purpose` 等价能力和 `skills/requesting-code-review/code-reviewer.md` 模板。OpenDeepSea 不应新增硬绑定的 `superpowers:code-reviewer` 特殊智能体。
5. **Worktree 行为有细节门禁。** `using-git-worktrees` 必须先检测现有隔离、优先 harness 原生 worktree、创建前征得用户同意；`finishing-a-development-branch` 必须处理 linked worktree、detached HEAD、provenance cleanup。
6. **旧 slash commands 已移除。** `/brainstorm`、`/write-plan`、`/execute-plan` 不是能力入口；系统应通过 skill/workflow 阶段触发，而不是复刻 slash command。
7. **测试不只单元测试。** Superpowers 自身用 transcript/行为测试验证 skill 是否真的触发、subagent 是否按顺序执行、review 是否独立检查。OpenDeepSea 需要增加等价的 workflow 行为测试。
8. **子代理是宿主能力抽象。** Superpowers 的 `subagent-driven-development` 不自带独立 agent runtime；在 OpenDeepSea 中应映射为当前项目/房间的 `RoomAgent`、child task 和 `agent_runs`。

## 决策

采用 C 级原生强门禁集成，并将 Superpowers-C 作为系统唯一开发工作流。Superpowers 不替代整个底层架构，也不要求重写 ACP、任务、agent_run 或 workflow_run 模型；它接管现有 workflow runtime 的新任务入口。

去掉默认/自定义工作流能力：

- 新任务只使用 `superpowers-development` 内置 workflow definition。
- `default-langgraph`、`analysis-document` 和既有自定义 workflow definition 仅用于历史运行记录展示，不再作为新任务候选。
- 不再支持创建、复制、编辑、发布、归档或选择自定义 workflow definition。

## 目标

1. 新增内置且唯一可用的 `Superpowers 开发闭环` workflow definition。
2. 扩展 workflow 类型、状态和运行时，使 Superpowers 专属节点可追踪、可门禁。
3. 内置导入 Superpowers 核心 skills，并按 runtime 阶段注入。
4. 用系统状态机强制执行 spec、plan、TDD、review、verification、finish branch 门禁。
5. 在 UI 中展示当前 skill gate、等待批准的 spec/plan、TDD 证据、review findings、verification results 和 finish branch 选项。
6. 移除默认/自定义工作流的前后端入口，同时不破坏历史运行记录。

## 非目标

1. 不把 workflow definition 改造成任意节点都可执行的通用 DSL。
2. 不物理删除历史 workflow definition 数据。
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

该 definition 是新任务唯一可选工作流。旧内置 definition 和用户自定义 definition 不再出现在新任务选择、默认设置或 supervisor 候选列表中。

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

- `runtime_profile`: `superpowers`
- 节点级 `required_skill_names`
- 节点级 `gate_policy`

如果短期不迁移数据库结构，可先把 metadata 放入 definition JSON。TypeScript 类型和 validator 必须能识别这些字段。

## Runtime 设计

### Runtime 选择

后端启动 workflow 时不再让 supervisor 选择 workflow definition。新任务直接使用 `superpowers-development` 并进入 `buildSuperpowersRuntimeGraph()`。

```text
task -> superpowers-development -> buildSuperpowersRuntimeGraph()
```

旧 workflow run 继续根据已保存的 `workflow_definition_snapshot` 做只读展示，但不参与新运行决策。

### Superpowers 状态

在 `AgentWorkflowState` 中新增可持久化字段：

- `runtimeProfile`: 固定为 `superpowers`
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
- `bootstrapInjected`
- `visualCompanion`
- `skillAssetVersions`

这些字段不替代现有 `plan`、`workflowPlan`、`reviewFindings`、`verificationResults`，而是增加 Superpowers 门禁语义。

### 强门禁

每个阶段必须满足门禁条件后才能进入下一阶段：

- `brainstorming`：必须产生 spec/design doc，并记录用户批准或明确的自动继续依据。
- `spec_review`：默认执行 inline self-review 清单，记录 approved 或 issues，并阻止有 critical issue 的 spec 进入 plan。
- `worktree`：必须记录已有隔离、新建隔离、用户明确跳过或环境不适用原因；创建 worktree 前需要用户同意，且优先原生 worktree 能力。
- `writing_plans`：必须产生计划文档，并能解析出可执行任务。
- `plan_review`：默认执行 inline self-review 清单，必须通过计划审查。
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
5. 同步 skill 目录时必须包含辅助文件，例如 prompt templates、`testing-anti-patterns.md`、systematic debugging references 和 brainstorming scripts。
6. 记录来源版本、revision、checksum，当前基线为 Superpowers `5.1.0`。

### Bootstrap 集成

OpenDeepSea 需要实现等价于 Superpowers SessionStart hook 的 bootstrap：

- 每个 workflow run 首个 agent prompt 必须包含 `using-superpowers` bootstrap。
- bootstrap 只注入一次，避免重复 token 膨胀。
- bootstrap 注入状态写入 `bootstrapInjected`，用于 UI 和测试断言。
- 对非 Superpowers-C 历史 run 不 retroactively 注入。

### Visual Companion

`brainstorming` 的 visual companion 属于完整功能范围：

- 支持启动本地 brainstorm server 或等价 OpenDeepSea 内置预览服务。
- 保存 `screen_dir`、`state_dir`、URL 和用户点击事件。
- `.superpowers/brainstorm/` 产物默认视为本地临时资产，不提交。
- 文本型问题继续走聊天；UI mockup、架构图、流程图、布局对比可走 visual companion。
- 第一阶段可把 visual companion 标记为 `not_available` 并记录原因，但最终完整功能需要实现。

## Agent Provisioning 与 Review

现有 executor/reviewer/acceptor 角色可以复用，但 Superpowers 需要更细分的 review 类型：

- spec reviewer：审查设计文档。
- plan reviewer：审查 implementation plan。
- spec compliance reviewer：审查实现是否符合 spec/plan。
- code quality reviewer：审查 bug、回归风险、边界和遗漏验证。

默认不要新增 named `superpowers:code-reviewer` agent。v5.1.0 已把 code reviewer 合并为 `skills/requesting-code-review/code-reviewer.md` prompt template。OpenDeepSea 应通过现有 reviewer/general-purpose agent 执行不同 prompt template，并在 metadata 中记录所用模板路径和版本。

### Subagent 映射

Superpowers 文档中的 subagent 是宿主环境能力抽象，不是 Superpowers 自带的智能体池。OpenDeepSea 中的映射规则如下：

1. `subagent-driven-development` 的 implementer、spec reviewer、code quality reviewer 都映射到当前项目/房间中的 `RoomAgent`。
2. 如果房间已有合适 workflow role 的智能体，优先使用已有智能体。
3. 如果缺少角色，使用 `ensureWorkflowAgentsForRun()` 自动拉入内置模板智能体。
4. Superpowers prompt template 作为任务说明注入给这些 OpenDeepSea 智能体。
5. 子任务、执行记录、review 结果写入现有 `tasks`、`agent_runs`、`workflow_steps` 和 Superpowers state。
6. 不引入独立的 Superpowers agent runtime，也不创建 `superpowers:*` named agent。

简化公式：

```text
Superpowers subagent
  = OpenDeepSea RoomAgent
  + Superpowers prompt template
  + workflow gate metadata
```

## UI 设计

Workflow 页面需要能展示 Superpowers run 的专属状态：

- 当前 skill gate。
- spec/design doc 路径和批准状态。
- plan doc 路径和批准状态。
- worktree 状态。
- visual companion URL、选择事件和是否启用。
- child task 的 TDD 证据。
- spec compliance review 和 code quality review findings。
- verification results。
- finish branch 选项和最终选择。

Workflow definition 管理能力移除：

- 移除新建、复制、编辑、发布、归档、删除入口。
- 移除系统、项目、房间设置中的默认工作流选择。
- 可以保留只读说明页，展示唯一的 `Superpowers 开发闭环` 和历史 workflow run 快照。

## 历史兼容

1. 历史 workflow run 不迁移。
2. 历史 run 的 `workflow_definition_snapshot` 继续只读展示。
3. 已存在的 default/custom workflow definition 不再作为新任务候选。
4. `settings.default_workflow_definition_id` 字段可暂时保留，但新任务启动时忽略。
5. supervisor 保留用于任务分析、分配和恢复决策，但不再选择 workflow definition。

## 分阶段落地

### 阶段 1：唯一入口与骨架

- 新增 Superpowers definition。
- 扩展类型和 validator。
- runtime 固定进入 Superpowers 图。
- 禁用自定义 workflow CRUD 和默认 workflow 设置入口。
- Skills 内置导入、辅助文件同步、版本记录和阶段 prompt 注入。
- 实现 using-superpowers bootstrap 注入。
- UI 只读展示 Superpowers definition 和历史运行记录。

### 阶段 2：核心门禁

- 实现 brainstorming、inline spec self-review、writing_plans、inline plan self-review。
- 实现 approval 与 dispatch 衔接。
- 实现 spec/plan artifact 记录。
- 为 visual companion 预留状态和 UI 展示；能实现时接入本地预览服务。

### 阶段 3：执行与审查

- 实现 tdd_execute 证据结构。
- 实现 spec_compliance_review 与 code_quality_review。
- 实现 review 失败回到执行修复。

### 阶段 4：验证与收口

- 实现 verification-before-completion 的新鲜验证门禁。
- 实现 finish_branch 选项与选择记录，覆盖 linked worktree、detached HEAD 和 keep/discard 等状态。
- UI 展示 verification 和 branch closeout。

### 阶段 5：行为测试与同步

- 增加 Superpowers workflow transcript/事件序列测试。
- 验证 bootstrap 只注入一次。
- 验证 spec self-review 和 plan self-review 不被跳过。
- 验证 code review 使用 prompt template，而不是 named agent。
- 验证 Superpowers subagent 映射到当前房间 `RoomAgent`，不创建独立 agent runtime。
- 验证 Superpowers skill 资产同步包含辅助文件。

## 验收标准

1. 系统中存在内置 `Superpowers 开发闭环` definition。
2. 新 workflow run 总是使用 Superpowers runtime。
3. 前端不再提供默认/自定义 workflow 创建、编辑或选择入口。
4. Superpowers run 能创建并展示专属阶段步骤。
5. 缺失 spec、plan、TDD、review 或 verification 证据时，runtime 不会错误跳过门禁。
6. Superpowers skills 能按阶段注入 prompt。
7. `using-superpowers` bootstrap 在新 run 中只注入一次。
8. Superpowers subagent 调度使用当前项目/房间智能体和现有 `agent_runs`。
9. UI 能展示 Superpowers gate 状态、visual companion 状态和关键证据。
10. 历史 workflow run 可只读查看。
11. `npm run build` 通过，相关后端、前端和行为测试通过。
