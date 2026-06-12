# 全流程 Workflow-first 多意图路由设计

日期：2026-06-13

## 背景

当前 `superpowers-workflow-v2` 已经把一部分 Superpowers 标准开发链路接入 OpenDeepSea，包括 artifact version、spec/plan 只读确认、planner 调用 `brainstorming` 与 `writing-plans`、approved plan gate、全栈工程师 fallback 和部分 review/verification 门禁。

但当前实现仍然不是完整的 workflow-first 系统：

1. session 用户消息仍可能通过 `startSessionPlannerRun` 绕过 workflow。
2. `superpowers-stage-registry.ts` 声明了 `route_skills`、`answer`、`analysis_plan`、`lightweight_plan`、`debug` 等阶段，但 runtime 的 executable graph 仍是标准开发线性链路。
3. `lightweight_plan` 没有完整生成、确认、修改、执行闭环。
4. `worktree` 与 `finish_branch` 仍是占位或默认决策。
5. agent assignment 的后端 trace 已存在，但没有作为用户确认前的显式门禁与 UI 表格。
6. worker/reviewer/verifier 的 scope change 和 plan change 回退协议没有完整闭环。

本设计目标是把 OpenDeepSea 改造成 planner 控制的 Superpowers workflow-first 编排系统，使 planner 统一掌控意图识别、路径选择、计划生成、子代理分配、执行门禁和收尾。

## 目标

1. 所有 session 用户消息统一进入 workflow-first intake，除确认回复和 artifact 修改请求外，不再直接启动旧 planner run。
2. planner 作为唯一 controller，负责 intent routing、Superpowers skill 路径选择、spec/plan/lightweight_plan 生成与修订、子代理分配、串并行策略和门禁推进。
3. runtime graph 支持普通问答、只读分析、轻量任务、标准开发、debug 和 review 等多路径。
4. spec、plan、lightweight_plan 都是不可直接编辑的 workflow artifact version，用户只能通过消息请求 planner 生成新版本。
5. 子代理从当前系统全局可用智能体 registry 中选择。找不到专业 executor 时使用 `fullstack-engineer`；reviewer/verifier 不默认由 fullstack 替代。
6. 用户确认前能看到 plan、子任务分配、fallback reason、并行/串行策略、scopeWrite 和验证方式。
7. worker/reviewer/verifier 不允许修改 approved artifact；发现计划或范围问题时只能提交 change request，由 planner 回退修订。
8. 每个关键阶段有可审计 evidence，完成前有 fresh verification。

## 非目标

1. 不把每个 CLI agent 改造成独立的完整 Superpowers controller。
2. 不让用户直接编辑 artifact JSON 或 markdown。
3. 不要求第一阶段实现所有 UI 美化；先保证状态、门禁和可观察性正确。
4. 不在本设计中改变 ACP provider 协议本身；只调整 OpenDeepSea 如何调用 provider 和管理工作流。
5. 不强制所有任务使用 TDD；轻量任务和只读任务允许有明确 skip reason，但必须经过 workflow-first。

## 核心架构

系统按四层职责划分：

1. `session-message-dispatch`：接收用户消息，只做消息持久化、确认回复识别、artifact 修改请求识别、workflow intake 创建。
2. `workflow runtime`：执行 `superpowers-v2` graph，负责任务状态、节点推进、门禁、恢复和阻塞。
3. `planner controller`：通过 ACP 调用 planner agent，执行 `using-superpowers`、`brainstorming`、`writing-plans` 等 controller 阶段。
4. `worker/reviewer/verifier agents`：通过 ACP 执行被分配的实现、debug、review 和 verification 阶段。

用户消息默认路径：

```text
user message
  -> session-message-dispatch
  -> create workflow run(superpowers-v2)
  -> intake
  -> route_skills
  -> selected path
```

旧 `startSessionPlannerRun` 只保留为内部兼容工具，不再作为普通用户消息入口。普通问答也必须成为 workflow 的 `answer` stage，这样 session 内所有 planner 行为都有统一 run、stage、evidence 和状态。

## 可执行 Graph

`superpowers-stage-registry.ts` 不再只是声明型 registry。新增 graph compiler，把 stage registry 编译成 executable definition，并允许 route 节点按 state 动态选择下一阶段。

标准节点：

```text
context
  -> intake
  -> route_skills
```

`route_skills` 根据 planner 的结构化 routing artifact 选择一个分支：

```text
answer
analysis_plan
lightweight_plan -> plan_confirm -> agent_assignment -> dispatch -> execute -> review -> verification -> finish_branch -> acceptance -> memory
brainstorming -> spec_review -> spec_confirm -> writing_plans -> plan_review -> plan_confirm -> agent_assignment -> worktree -> dispatch -> execute -> review -> verification -> finish_branch -> acceptance -> memory
debug -> debug_plan_confirm -> agent_assignment -> systematic_debugging -> verification -> finish_branch -> acceptance -> memory
review_only -> review_plan -> reviewer_assignment -> spec_compliance_review/code_quality_review -> verification -> acceptance -> memory
```

`route_skills` 不能只写 metadata；它必须更新 graph state：

```ts
selectedIntent: 'answer' | 'analysis' | 'lightweight_task' | 'standard_development' | 'debug' | 'review_only';
selectedPath: string[];
routingEvidenceArtifactVersionId: string;
activeSuperpowersStage: SuperpowersStageId;
```

## 阶段协议

### intake

controller：planner  
skill：`using-superpowers`

输入：

- 用户消息
- session mode
- file refs
- platform skill refs
- 最近消息摘要
- 当前 project/worktree 状态
- 当前是否有 active workflow

输出 artifact：`intent_routing`

结构：

```json
{
  "intent": "answer",
  "confidence": 0.9,
  "reason": "用户只是在询问架构解释，不要求改代码",
  "requiredSkills": [],
  "needsUserConfirmation": false,
  "riskLevel": "low"
}
```

### route_skills

controller：planner  
skill：`using-superpowers`

动作：

1. 读取 `intent_routing`。
2. 判断是否需要继续加载专项 skill。
3. 选择后续 path。
4. 记录 route evidence。

禁止行为：

- 不在 route 阶段直接实现代码。
- 不绕过 artifact gate 启动 worker。
- 不把实现类任务降级为 answer。

### answer

controller：planner  
skill：无或按需只读 skill

适用：

- 普通问答
- 架构解释
- 只需要读上下文但不生成计划的短答

输出：

- assistant message
- `answer` evidence

结束条件：

- workflow run 标记 completed
- 不创建 child tasks
- 不进入 todo 执行状态

### analysis_plan

controller：planner  
skill：`brainstorming` 或只读分析 prompt

适用：

- 用户要求“分析一下”
- 代码审查前置阅读
- 架构/调用链/阻塞原因分析

输出 artifact：`analysis`

内容：

- 结论
- 证据文件与行号
- 风险
- 后续建议

默认不需要用户确认。若 analysis 之后用户要求实现，创建新的 workflow run 或从该 run 派生标准开发路径。

### lightweight_plan

controller：planner  
skill：`using-superpowers`，必要时使用轻量 planning prompt

适用：

- 单文件或小范围明确改动
- 文案、配置、小测试、局部 bugfix
- 风险低且不需要完整 spec

输出 artifact：`lightweight_plan`

必须包含：

```json
{
  "goal": "修复某个局部行为",
  "skipFullSpecReason": "单文件低风险 bugfix，不需要完整 brainstorming/spec",
  "scopeRead": ["packages/backend/src/a.ts"],
  "scopeWrite": ["packages/backend/src/a.ts"],
  "steps": [
    {
      "title": "补最小回归测试",
      "role": "executor",
      "requiredCapabilities": ["backend", "testing"]
    }
  ],
  "verification": [
    {
      "command": "npm run build",
      "required": true,
      "reason": "TypeScript compile gate"
    }
  ],
  "risks": [],
  "assumptions": []
}
```

门禁：

- 用户必须确认。
- 用户请求修改时，回到 `lightweight_plan` 生成新版本。
- 不允许出现 `lightweight_plan_revision_not_implemented`。

### brainstorming

controller：planner  
skill：`brainstorming`

输出 artifact：`spec`

必须包含：

- 目标
- 非目标
- 范围
- 用户流程
- 数据流
- 错误处理
- 风险
- 验收标准

planner 通过 ACP 调用 CLI 的 Superpowers skill，并解析 required evidence。缺少 evidence 时 workflow blocked，原因是 `missing_required_evidence`。

### spec_review

controller：reviewer，找不到 reviewer 时允许 planner self-review，但必须标记  
skill：`brainstorming` review prompt

输出 artifact：`review`

review verdict：

- `approved`
- `changes_requested`
- `failed`

`changes_requested` 回到 `brainstorming`。

### spec_confirm

controller：user

前端展示只读 spec artifact。用户动作：

- 确认 spec
- 请求 planner 修改

确认后写入 `approvedSpecArtifactVersionId`。请求修改后生成新 draft，清空后续 plan、assignment、execution、review、verification。

### writing_plans

controller：planner  
skill：`writing-plans`

输出 artifact：`plan`

必须包含：

- steps/tasks
- 每个 task 的 role
- required capabilities
- scopeRead/scopeWrite
- dependencies
- serial/parallel strategy
- verification commands
- risk/assumption
- suggested agent assignment

plan 中不得有 TODO、占位或无法执行的自然语言空话。

### plan_review

controller：reviewer，找不到 reviewer 时允许 planner self-review，但必须标记  
skill：`writing-plans` self-review/review prompt

检查：

- 是否 2-5 分钟粒度
- 是否有明确命令
- 是否有预期输出
- 是否覆盖风险和验证
- 是否包含 agent assignment draft

### plan_confirm

controller：user

前端展示：

- plan artifact
- agent assignment table
- serial/parallel strategy
- fallback reason
- verification commands
- scopeWrite conflict warnings

用户动作：

- 确认 plan
- 请求 planner 修改

确认后写入 `approvedPlanArtifactVersionId` 或 `lightweightPlanArtifactVersionId`。

### agent_assignment

controller：planner

这是独立阶段，不再只埋在 dispatch 内部。

输入：

- approved plan/lightweight_plan
- 全局可用 agents
- room agents
- task required capabilities
- scopeWrite
- provider availability

选择规则：

1. executor 优先选择专业 agent。
2. 找不到专业 executor 时使用 `fullstack-engineer`。
3. 找不到 `fullstack-engineer` 时进入 `needs_agent_assignment`。
4. reviewer/verifier 默认不能与同一任务 executor 相同。
5. fullstack 不默认替代 reviewer/verifier。
6. 若只有 fullstack 可用且 plan 明确允许 self-review exemption，必须把 exemption 写入 assignment artifact；否则 blocked。

输出 artifact：`agent_assignment`

结构：

```json
{
  "assignments": [
    {
      "taskId": "task-1",
      "role": "executor",
      "assignedAgentId": "frontend-executor",
      "fallbackReason": null,
      "executionMode": "parallel",
      "scopeWrite": ["packages/frontend/src/A.tsx"]
    }
  ],
  "groups": [
    {
      "id": "group-1",
      "mode": "parallel",
      "taskIds": ["task-1", "task-2"]
    }
  ],
  "conflicts": []
}
```

### worktree

controller：planner/coordinator  
skill：`using-git-worktrees`

决策：

- 当前已在 worktree：记录 reuse evidence。
- 任务适合隔离：创建 worktree。
- 任务不适合隔离或用户明确要求当前工作区：记录 skip reason。

禁止：

- 不允许继续写 `branchName: not_available` 作为成功证据。
- 创建失败必须 blocked，并给出恢复建议。

### dispatch

controller：planner  
skill：`subagent-driven-development` 或 `executing-plans`

输入：

- approved plan/lightweight_plan
- approved assignment artifact
- worktree evidence 或 skip reason

动作：

- 创建 child tasks。
- 写入 frozen assignment snapshot。
- 生成 worker prompts。
- 按 dependency graph 决定串行/并行。

worker prompt 必须包含：

- approved artifact 只读内容
- scopeRead/scopeWrite
- 禁止修改 approved spec/plan
- scope/plan change request 协议
- required verification

### execute

controller：worker  
skill：`test-driven-development` 或明确 exemption

执行规则：

- 新功能、共享逻辑、高风险行为变更必须 TDD。
- 低风险轻量任务可用 exemption，但需写明原因。
- worker 只能修改自己 scopeWrite 内文件。
- 超出 scopeWrite 必须返回 `scope_change_request`。

输出 evidence：

- red/green/refactor 或 exemption
- changed files
- verification snippet
- blocker/change request

### debug

controller：debugger worker  
skill：`systematic-debugging`

debug 分支在进入 worker 前必须先由 planner 生成 `debug_plan`，并通过 `debug_plan_confirm` 让用户确认调试范围、复现方式和允许写入范围。若用户只要求定位原因且不允许修改代码，`debug_plan` 必须把 execution mode 标记为 read-only，并在 `systematic_debugging` 后直接进入 `analysis` 或 `verification`，不进入修复执行。

输出必须包含：

- observed failure
- root cause
- hypothesis
- minimal verification
- fix summary
- post-fix verification

禁止：

- 没有根因就修。
- 把 debug 任务直接走普通 execute。

### review_only

controller：planner -> reviewer  
skill：`requesting-code-review`

适用：

- 用户只要求代码审查。
- 用户要求检查某个 diff、文件或实现是否符合需求。
- 合并前的独立 review。

`review_plan` 由 planner 生成，必须包含审查范围、审查标准、输入 diff 或文件集合、是否需要 verification。`reviewer_assignment` 只选择 reviewer/verifier，不创建 executor child task。若没有合适 reviewer，workflow 进入 `needs_agent_assignment`。

### scope_change_request / plan_change_request

来源：worker/reviewer/verifier

结构：

```json
{
  "type": "scope_change_request",
  "taskId": "task-1",
  "reason": "需要修改 shared type，否则无法编译",
  "requestedScopeWrite": ["packages/backend/src/types.ts"],
  "impact": "影响后端和前端契约",
  "recommendedPlannerAction": "revise_plan"
}
```

runtime 行为：

1. 暂停当前 child task。
2. 取消相关 active agent run。
3. 标记 run blocked 或 awaiting_decision。
4. 通知 planner 回到 spec 或 plan 修订。
5. 修订后生成新 artifact version。
6. 用户重新确认后恢复执行。

### spec_compliance_review

controller：reviewer  
skill：`requesting-code-review`

检查实现是否符合 approved spec/plan。  
Critical/Important findings 必须回到 execute 或 planner revision。

### code_quality_review

controller：reviewer  
skill：`requesting-code-review`

检查：

- bug
- 回归风险
- 测试缺口
- 类型安全
- 安全问题
- 无关改动

### verification

controller：verifier  
skill：`verification-before-completion`

规则：

- 必须运行 fresh commands。
- 记录 command、exit code、stdout 摘要、required。
- required command 失败则 blocked。
- verifier 默认不能与 executor 相同。

### finish_branch

controller：planner  
skill：`finishing-a-development-branch`

不再默认 `keep_branch`。生成用户决策门禁：

1. merge local branch
2. create PR
3. keep branch/worktree
4. discard worktree

选择前必须展示：

- changed files
- verification summary
- review summary
- worktree path
- branch name

### acceptance

controller：planner

最终完成审计：

- artifact gates 已确认
- child tasks 完成
- review 通过
- verification 通过
- finish branch 决策已处理或用户选择保留

### memory

controller：planner

记录：

- 成功路径
- 阻塞原因
- 验证命令
- 可复用经验

## 数据模型

新增或扩展 graph state 字段：

```ts
selectedIntent?: 'answer' | 'analysis' | 'lightweight_task' | 'standard_development' | 'debug' | 'review_only';
selectedPath?: SuperpowersStageId[];
routingArtifactVersionId?: string | null;
analysisArtifactVersionId?: string | null;
agentAssignmentArtifactVersionId?: string | null;
approvedAgentAssignmentArtifactVersionId?: string | null;
activeChangeRequestId?: string | null;
worktreeDecision?: {
  action: 'reuse' | 'create' | 'skip';
  path: string | null;
  branchName: string | null;
  reason: string;
};
finishBranchDecision?: {
  decision: 'merge_local' | 'create_pr' | 'keep_branch' | 'discard_work';
  reason: string;
  decidedAt: string;
};
```

新增 artifact types：

- `intent_routing`
- `analysis`
- `agent_assignment`
- `change_request`
- `finish_branch_decision`

保留现有：

- `spec`
- `plan`
- `lightweight_plan`
- `review`
- `verification`

## 前端设计

### Workflow Controller Panel

位置：session 主视图右侧或 artifact panel 上方。

显示：

- 当前 intent
- 当前 stage
- controller
- active agent
- blocker
- next required action

### Artifact Gate Panel

扩展现有只读 panel：

- 显示 artifact version history。
- 显示 superseded 状态。
- 显示 change request 来源消息。
- 对 `spec`、`plan`、`lightweight_plan` 保持只读。

### Agent Assignment Table

在 plan confirm 前展示：

- task title
- role
- assigned agent
- backend/provider
- fallback reason
- execution mode
- scopeWrite
- dependency group

如果 reviewer/verifier 不满足分离要求，显示 blocked state 和需要添加的 agent role。

### Change Request Panel

显示 worker/reviewer/verifier 提交的：

- 请求类型
- 原因
- 影响范围
- planner 下一步
- 需要用户确认的地方

## 迁移策略

1. 历史 workflow run 继续只读展示，不强制迁移。
2. 新 run 默认 `graph_version = superpowers-v2`，并启用 route graph。
3. 旧 `riskGate` 元数据保留展示兼容，但不再决定是否进入 workflow。
4. 若已有 active workflow，用户普通消息默认作为该 workflow 的输入；若消息明确开启新任务，则创建新 workflow。
5. 若 provider 自带 Superpowers bootstrap，仍由项目层 owner 控制注入，provider 不接管 controller。

## 实施分期

### Phase 1：入口统一与 answer 路径

1. 改造 `session-message-dispatch.ts`，所有普通消息创建 workflow intake。
2. 实现 `intake`、`route_skills`、`answer` executable nodes。
3. 普通问答完成后 workflow run completed，不进入执行态。
4. 增加测试：chat 消息不再调用旧 planner path。

### Phase 2：多意图 route graph

1. 实现 stage registry 到 executable graph 的 compiler。
2. 接入 `analysis_plan`、`lightweight_plan`、`brainstorming`、`debug` 分支。
3. route 节点根据 planner artifact 动态选择 path。
4. 增加 intent matrix 测试。

### Phase 3：artifact 修订闭环

1. spec 修改回到 `brainstorming`。
2. plan 修改回到 `writing_plans`。
3. lightweight_plan 修改回到 `lightweight_plan`。
4. 修改后清空下游 confirmation、assignment、execution、review、verification。

### Phase 4：agent assignment 显式化

1. 新增 `agent_assignment` stage。
2. 读取全局可用 agents。
3. fullstack 只做 executor fallback。
4. reviewer/verifier 分离不足时 blocked。
5. 前端展示 assignment table。

### Phase 5：执行回退协议

1. worker scopeWrite enforcement。
2. `scope_change_request` 与 `plan_change_request` 进入 planner 修订。
3. debug path 使用 `systematic-debugging`。
4. review findings 正确回 execute 或 planner revision。

### Phase 6：worktree、verification、finish branch 完整化

1. worktree 节点执行真实 reuse/create/skip。
2. verification 强制 fresh evidence。
3. finish branch 改成用户决策门禁。
4. acceptance 做 completion audit。

## 测试策略

后端测试：

1. 每条 session 普通用户消息都创建 workflow run。
2. chat intent 走 `answer` 并 completed。
3. analysis intent 生成 analysis artifact。
4. lightweight task 生成 lightweight_plan，确认后 dispatch。
5. lightweight_plan 修改请求生成新版本。
6. standard development 走 spec/plan 双确认。
7. debug intent 进入 systematic_debugging。
8. approved plan 缺失时 dispatch blocked。
9. assignment 找不到专业 executor 时使用 fullstack。
10. reviewer/verifier 与 executor 不分离时 blocked。
11. worker scope change request 回退 planner。
12. worktree 不再产出 `not_available` 成功证据。
13. finish_branch 不再默认自动 `keep_branch`。

前端测试：

1. Artifact Gate Panel 只读展示 spec/plan/lightweight_plan。
2. 请求修改按钮发送 artifact change request。
3. Assignment Table 显示 fallback reason。
4. Workflow Controller Panel 显示当前 intent/stage/blocker。
5. Change Request Panel 显示 worker scope change。
6. answer path 不显示执行中 todo 状态。

端到端 smoke：

1. 问答消息：用户问架构问题，workflow 完成且无 child task。
2. 轻量任务：用户要求小改动，确认 lightweight_plan 后执行。
3. 标准开发：用户要求新功能，确认 spec 和 plan 后执行、review、verify。
4. debug：用户报告失败，先 root cause，再修复验证。

## 验收标准

1. 用户消息不会绕过 planner controller 直接启动旧 planner run 或执行 workflow。
2. planner 能基于意图选择 answer、analysis_plan、lightweight_plan、standard_development、debug、review_only。
3. `superpowers-stage-registry.ts` 中的 route stages 与 runtime executable graph 一致。
4. spec/plan/lightweight_plan 只读展示，用户只能通过消息请求 planner 修改。
5. 修改 spec/plan/lightweight_plan 会生成新版本，并使下游确认和执行状态失效。
6. 轻量任务可以跳过完整 spec，但必须有最小计划、跳过原因和用户确认。
7. 用户确认 plan 前能看到结构化 agent assignment table。
8. 找不到专业 executor 时自动分配全局 `fullstack-engineer`。
9. 找不到合适 reviewer/verifier 时进入 `needs_agent_assignment`，不默认 self-review。
10. worker/reviewer/verifier 不能修改 approved artifact。
11. scope/plan change request 能回退 planner 修订并恢复执行。
12. worktree 节点记录真实 reuse/create/skip evidence。
13. finish_branch 需要用户决策，不默认自动 `keep_branch`。
14. required verification 必须有 fresh passed evidence。
15. answer path 不进入执行态，不持续触发开发任务 todo 状态。

## 风险与缓解

### 风险：所有消息进入 workflow 后开销增加

缓解：answer path 必须轻量完成，只创建最小 run、routing evidence 和 answer message，不创建 child task，不进入执行状态。

### 风险：route classifier 误判

缓解：planner 输出 confidence 和 reason；低置信度进入 `needs_user_clarification`，由用户确认路径。

### 风险：artifact gate 增加用户等待

缓解：lightweight_plan 保留最小确认，低风险任务不走完整 spec，但不能绕过 workflow-first。

### 风险：reviewer/verifier 不足导致任务阻塞

缓解：executor 可用 fullstack fallback；reviewer/verifier 不足时明确 blocked，并在 UI 告知需要添加对应全局 agent 或允许一次性 exemption。

### 风险：历史 run 与新 graph 混用

缓解：按 graph version 分支处理。历史 run 继续使用旧展示，新 run 使用 route graph。

## 决策

1. 采用全 workflow-first，普通问答也进入 workflow，但走轻量 answer path。
2. 先实现 route graph 和 lightweight_plan 闭环，再补 worktree、finish_branch 和 UI polish。
3. agent_assignment 独立成 stage 和 artifact，不再只作为 dispatch 内部 metadata。
4. fullstack-engineer 只作为 executor fallback，不默认替代 reviewer/verifier。
5. 用户不能直接编辑 spec/plan/lightweight_plan，只能请求 planner 修改并生成新版本。
