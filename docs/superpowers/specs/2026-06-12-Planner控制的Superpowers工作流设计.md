# Planner 控制的 Superpowers 工作流设计

## 背景

当前 OpenDeepSea 已经具备 session、workflow、task、agent run、ACP provider、全局智能体、项目智能体和 Superpowers runtime 的基础设施，但现有运行方式仍存在职责边界错位：

1. session planner 和 workflow graph 是两条分离路径，用户消息可能绕过 planner 直接启动 workflow。
2. workflow 内部的 planning 节点会再次调用规划 agent，导致 planner 既像会话回答者，又像 workflow 阶段 agent，但不是唯一流程控制者。
3. 低风险任务可被 `low_risk_auto` 自动启动，和“planner 先分析、用户确认后执行”的预期不一致。
4. 现有 `superpowers-v1` state 和测试已经包含 Superpowers 字段，但许多节点仍偏占位或模拟，并未真正通过 ACP 调用 Codex、Claude Code、OpenCode 的原生 Superpowers skills。

目标不是把 Superpowers 当作提示词片段注入，也不是让每个 CLI agent 自行接管完整流程，而是把 OpenDeepSea 改造成 **Planner 控制的 Superpowers workflow-first 编排系统**。

## 目标

1. 所有 session 用户消息统一进入 workflow-first 入口，由 workflow 创建运行记录并进入 planner intake。
2. planner 作为唯一 controller，负责用户意图识别、Superpowers 路径选择、spec/plan 生成与修订、子任务拆解、子代理分配、串并行策略和门禁推进。
3. Codex、Claude Code、OpenCode 通过 ACP 执行具体 Superpowers skill invocation，OpenDeepSea 负责状态机、门禁、产物、版本和用户确认。
4. spec 和 plan 不提供直接编辑入口。用户通过消息向 planner 提出修改要求，planner 生成新版本。
5. 子代理从当前系统全局可用智能体中选择。找不到专业子代理时，自动使用全局内置“全栈工程师”作为执行兜底。
6. 轻量任务允许跳过完整 brainstorming/writing-plans，但必须由 planner 给出最小可确认执行计划、记录跳过原因，并通过 workflow 门禁。
7. planning timeout、ACP 断连、缺少 evidence、子代理阻塞都必须落到可恢复状态，而不是产生不可解释的 blocked。

## 非目标

1. 不改变 ACP 协议本身。
2. 不让用户直接编辑 spec/plan 文档或 JSON 结构。
3. 不让 worker/reviewer 子代理修改已确认的 spec/plan。
4. 不在本设计中实现所有代码改动。
5. 不物理删除历史 workflow 数据、旧 definition 或旧 session run。
6. 不要求普通聊天回答一定进入开发执行链路。

## 核心决策

### Workflow-first

用户消息不再由 session 层直接决定“planner run 或 workflow run”。入口统一改为：

```text
用户消息
  -> create workflow_run
  -> planner intake
  -> intent routing
  -> Superpowers stage
```

不同意图走不同分支：

```text
普通问答：
intake -> answer -> completed

只读分析：
intake -> route_skills -> analysis_plan -> user_confirm -> analysis_execute -> completed

轻量实现：
intake -> route_skills -> lightweight_plan -> user_confirm -> dispatch -> execute -> review/verify

标准开发：
intake -> route_skills -> brainstorming -> spec_change_gate -> spec_confirm
       -> writing_plans -> plan_change_gate -> plan_confirm
       -> dispatch -> execute -> review -> verify -> finish_branch

异常排查：
intake -> route_skills -> systematic_debugging -> fix_plan_or_report -> verify
```

### Planner 是 controller

planner 拥有流程控制权：

- 判断用户意图。
- 决定是否需要完整 Superpowers 流程。
- 选择下一阶段 skill。
- 生成和修订 spec/plan。
- 拆解任务并分配子代理。
- 判断串行、并行或 hybrid。
- 处理 blocker、scope change、timeout recovery。
- 请求用户确认。
- 汇总最终状态和验收证据。

planner 不直接绕过以下门禁：

- 用户确认。
- spec/plan review。
- TDD 或调试根因证据。
- 代码审查。
- 完成前验证。

### 子代理是 worker/reviewer/verifier

子代理不继承 planner 的控制权。子代理只执行被分配的阶段或任务：

```text
worker:
  - 执行 assigned task
  - 遵循指定 Superpowers skill
  - 返回 DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED
  - 不修改 approved spec/plan

reviewer:
  - 检查 spec compliance 或 code quality
  - 不自行修代码
  - 不改 approved spec/plan

verifier:
  - 运行 fresh verification commands
  - 记录 evidence
  - 不用旧输出声称通过
```

worker 或 reviewer 如发现计划错误，只能提交 `scope_change_request` 或 `plan_change_request`，由 planner 决定是否回退到 plan 修订门禁。

## Superpowers Stage Registry

Superpowers 不作为普通 prompt，而是作为可执行阶段 registry：

```ts
type SuperpowersStage = {
  id: string;
  requiredSkills: string[];
  controller: 'planner' | 'worker' | 'reviewer' | 'verifier';
  allowedProviders: Array<'codex' | 'claudecode' | 'opencode'>;
  requiredInputs: string[];
  expectedArtifacts: string[];
  gates: string[];
  next: string[];
};
```

建议内置阶段：

| 阶段 | 执行者 | 使用 skill | 产物/门禁 |
|---|---|---|---|
| `intake` | planner | `using-superpowers` | intent routing、下一步 skill |
| `brainstorming` | planner | `brainstorming` | design spec draft |
| `spec_change_gate` | planner + user | `brainstorming` | 用户通过消息要求 planner 修订 spec |
| `spec_review` | reviewer 或 planner self-review | `brainstorming` reviewer prompt | spec review verdict |
| `spec_confirm` | user + planner | 无 | approved spec version |
| `writing_plans` | planner | `writing-plans` | implementation plan draft、任务拆解、agent assignment |
| `plan_change_gate` | planner + user | `writing-plans` | 用户通过消息要求 planner 修订 plan |
| `plan_review` | reviewer 或 planner self-review | `writing-plans` self-review | plan review verdict |
| `plan_confirm` | user + planner | 无 | approved plan version |
| `worktree` | planner/coordinator | `using-git-worktrees` | worktree evidence 或跳过原因 |
| `dispatch` | planner | `subagent-driven-development` / `executing-plans` | child tasks、agent assignments |
| `execute` | worker | `test-driven-development` 或任务指定 skill | diff、commit、TDD evidence |
| `debug` | debugger worker | `systematic-debugging` | root cause、hypothesis、fix、verification |
| `spec_compliance_review` | reviewer | `requesting-code-review` | spec compliance verdict |
| `code_quality_review` | reviewer | `requesting-code-review` | code quality verdict |
| `verification` | verifier | `verification-before-completion` | fresh verification evidence |
| `finish_branch` | planner/coordinator | `finishing-a-development-branch` | closeout options 和用户选择 |
| `acceptance` | planner + acceptor | completion checklist | final acceptance |

## ACP Skill Invocation

每个需要 agent 执行的阶段都创建一条 skill invocation：

```ts
type AcpSkillInvocation = {
  id: string;
  workflowRunId: string;
  workflowStepId: string;
  phase: string;
  provider: 'codex' | 'claudecode' | 'opencode';
  agentId: string;
  requiredSkills: string[];
  prompt: string;
  expectedEvidence: string[];
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'blocked';
  agentRunId?: string;
};
```

prompt 构造原则：

1. 明确“你正在执行哪个阶段”。
2. 明确“必须使用哪些 Superpowers skills”。
3. 明确“不能做什么”，例如 brainstorming 阶段不能改代码。
4. 注入当前 approved/draft artifact 的只读内容。
5. 子代理 prompt 只包含自身任务和必要上下文，不让子代理自行读取整份 plan 再自由解释。
6. 结束时必须输出 fenced JSON evidence。

示例 worker prompt 约束：

```text
你是 frontend implementer。
你不是 planner。
不要重新设计 workflow。
只执行 approved_plan_version 中分配给你的 Task 2。
必须遵循 test-driven-development。
如果需要修改 scope 或 plan，返回 NEEDS_CONTEXT 或 scope_change_request。
```

## Artifact Version 模型

spec/plan 是 workflow artifact version，不是用户可直接编辑的自由文档。

```ts
type WorkflowArtifactVersion = {
  id: string;
  workflowRunId: string;
  artifactType: 'spec' | 'plan' | 'lightweight_plan' | 'review' | 'verification';
  version: number;
  status: 'draft' | 'reviewing' | 'approved' | 'superseded' | 'rejected';
  content: string;
  structuredData: unknown;
  createdByAgentId: string;
  changeRequestMessageId?: string;
  supersedesArtifactVersionId?: string;
  createdAt: number;
};
```

用户不能直接修改 `content` 或 `structuredData`。用户通过消息提出修改，例如：

```text
把前端部分拆成 UI 组件和数据接入两个任务。
不要并行，先后端再前端。
验证命令增加 npm run build。
这个任务交给全栈工程师执行。
```

planner 处理流程：

```text
user change request
  -> planner 读取当前 draft 或 approved artifact
  -> planner 生成新版本
  -> 旧确认状态失效
  -> 重新 review
  -> 重新请求用户确认
```

硬规则：

```text
任何 spec/plan 修改请求都会使当前确认状态失效。
后续执行只能消费 approved artifact version。
worker/reviewer/verifier 不能修改 approved artifact。
```

## 用户确认模型

确认点：

1. `spec_confirm`：确认设计目标、范围、非目标、风险、验收标准。
2. `plan_confirm`：确认任务拆解、执行顺序、子代理分配、scope、验证命令。
3. `finish_branch`：确认 merge、PR、保留或丢弃等收口操作。

用户可以在确认前或确认后提出修改。确认后提出修改时，workflow 进入修订状态：

```text
approved_plan_version
  -> user asks planner to change plan
  -> plan status becomes superseded
  -> new draft version
  -> review
  -> user confirm
  -> new approved_plan_version
```

如果已经开始执行，planner 必须判断是否需要：

- 暂停未开始的 child tasks。
- 取消或等待正在运行的 child tasks。
- 创建 repair task。
- 重新生成 plan。

## 全局智能体选择

子代理只从当前系统全局可用智能体中选择，不在 workflow 内硬编码一组虚构 agent。

```ts
type GlobalAgent = {
  agentId: string;
  name: string;
  provider: 'codex' | 'claudecode' | 'opencode';
  capabilities: string[];
  workflowRoles: Array<'planner' | 'executor' | 'reviewer' | 'verifier' | 'designer' | 'debugger' | 'acceptor'>;
  acpEnabled: boolean;
  available: boolean;
  priority?: number;
};
```

planner 在 `writing_plans` 阶段读取全局智能体 registry，并为每个任务写入 assignment：

```ts
type PlanTaskAssignment = {
  taskId: string;
  requiredCapabilities: string[];
  preferredRole: string;
  assignedAgentId: string | null;
  fallbackAgentIds: string[];
  executionMode: 'serial' | 'parallel' | 'hybrid';
  dependsOn: string[];
  scopeRead: string[];
  scopeWrite: string[];
};
```

选择规则：

1. 只选择 `available && acpEnabled` 的智能体。
2. 优先匹配 capability、workflow role、provider 偏好和当前负载。
3. 并行组内禁止多个 worker 写同一 `scopeWrite`。
4. reviewer/verifier 默认不能与同一任务的 implementer 是同一个 agent。
5. 没有专业执行子代理时，使用全局“全栈工程师”兜底。
6. 找不到全栈工程师或全栈工程师也不可用时，workflow 进入 `needs_agent_assignment`。

## 全栈工程师兜底

系统必须提供一个全局内置“全栈工程师”智能体模板，并在初始化或全局智能体校验时保证可用。

```ts
const BUILTIN_FULLSTACK_ENGINEER = {
  agentId: 'fullstack-engineer',
  name: '全栈工程师',
  workflowRoles: ['executor'],
  capabilities: [
    'frontend',
    'backend',
    'typescript',
    'react',
    'node',
    'sqlite',
    'testing',
    'debugging',
    'integration'
  ],
  fallback: true
};
```

兜底规则：

```text
planner 分配任务
  -> 查找专业子代理
  -> 找不到专业子代理
  -> 使用 fullstack-engineer
  -> fullstack-engineer 不可用
  -> needs_agent_assignment
```

限制：

- 全栈工程师只作为执行兜底 worker。
- 全栈工程师不替代 planner。
- 全栈工程师不替代独立 reviewer。
- 全栈工程师不默认替代 verifier，除非 plan 明确分配验证任务。
- 使用全栈工程师兜底时，planner 必须在 plan 中记录 fallback reason。
- 如果 fallback task 跨多个高冲突 scope，planner 默认改为串行执行。

## 轻量任务最短路径

允许轻量任务跳过完整 `brainstorming -> writing-plans`，但不能绕过 workflow-first。

轻量任务条件：

- 单文件或小范围修改。
- 需求明确。
- 风险低。
- scope 明确。
- 验证方式明确。
- 不涉及 schema、shared contract、根配置、迁移、依赖升级或大规模重构。

流程：

```text
intake
  -> route_skills
  -> lightweight_plan
  -> user_confirm
  -> dispatch
  -> execute
  -> review
  -> verification
```

`lightweight_plan` 必须包含：

- 目标。
- scopeRead/scopeWrite。
- 执行 agent。
- fallback agent。
- 串行/并行策略。
- 验证命令。
- `skip_planning_reason`。

如果用户提出修改，planner 生成新的 lightweight plan 版本并重新确认。

## 错误与恢复

### ACP timeout

planning timeout 不直接等同于 workflow 失败。状态应变为：

```text
awaiting_recovery
```

可选恢复动作：

- 重试同一 provider。
- 切换 provider。
- 缩短上下文后重试。
- 让用户补充修改要求后由 planner 生成新版本。
- 取消 workflow。

### 缺少 evidence

如果 agent 输出自然语言但没有 required JSON evidence：

```text
status = blocked
reason = missing_required_evidence
```

planner 可触发 evidence repair prompt，但不能猜测通过。

### 子代理 BLOCKED

worker 返回 `BLOCKED` 时，planner 处理：

1. 判断是否缺上下文。
2. 判断是否需要更强 agent 或全栈工程师兜底。
3. 判断是否需要拆小任务。
4. 判断是否需要回到 plan 修订。
5. 无法自动处理时请求用户决策。

### Scope change

worker 需要改出 `approved_plan.scopeWrite` 之外的文件时，必须返回 `scope_change_request`。planner 接收后：

- 风险低且在同一模块内：生成 plan patch 版本并请求用户确认。
- 风险高或跨模块：回到 plan_change_gate。

## 后端实现边界

建议新增或扩展模块：

- `workflows/superpowers-stage-registry.ts`
- `workflows/superpowers-invocation.ts`
- `workflows/artifact-versions.ts`
- `workflows/agent-assignment.ts`
- `workflows/fullstack-engineer.ts`
- `workflows/session-workflow-intake.ts`

现有模块应改造：

- `session-message-dispatch.ts`：废弃直接 `low_risk_auto` 启动，统一转 workflow-first intake。
- `workflows/graph/superpowers-runtime.ts`：升级为 `superpowers-v2`，用 stage registry 驱动。
- `workflows/graph/superpowers-nodes.ts`：从模拟节点改为真实 ACP skill invocation。
- `workflows/prompts.ts`：按 stage 构造 controller/worker/reviewer/verifier prompt。
- `platform-skills/service.ts`：确认 Codex、Claude Code、OpenCode 的 Superpowers skill 安装状态。
- `repos/workflows.ts`：支持 artifact version 查询、确认和 supersede。

## 前端交互

session 页面应展示：

- 当前 workflow 阶段。
- planner 产出的 spec/plan 当前版本。
- “请求修改”输入入口。
- “确认 spec” / “确认 plan”按钮。
- 子代理分配表。
- 串并行执行图。
- blocker 和恢复操作。
- review findings。
- verification evidence。

spec/plan 视图为只读，不提供直接编辑器。修改入口是对 planner 发送消息：

```text
请修改计划：把测试任务提前到后端实现之后。
```

前端发送后，后端把该消息绑定为 artifact change request，planner 生成新版本。

## 测试策略

后端测试：

- session 用户消息总是创建 workflow-first run。
- 轻量任务不会触发 `low_risk_auto` 旁路。
- planner intake 输出 intent routing 后进入正确分支。
- brainstorming 产出 spec draft，用户确认后生成 approved spec version。
- 用户修改 spec/plan 会 supersede 旧版本并清空确认状态。
- writing_plans 从全局智能体 registry 分配 agent。
- 专业子代理缺失时分配 fullstack-engineer。
- fullstack-engineer 缺失时进入 `needs_agent_assignment`。
- worker 不能修改 approved spec/plan。
- 缺少 required evidence 时 blocked。
- ACP timeout 进入 recovery 状态。

前端测试：

- spec/plan 只读展示。
- 修改入口通过消息触发 planner change request。
- 确认按钮只在 review 通过时可用。
- 子代理分配表展示专业 agent 和 fullstack fallback reason。
- blocked 状态展示恢复动作。

集成测试：

- 标准开发任务完整走到 plan_confirm。
- 轻量任务走 lightweight_plan 并等待确认。
- 专业 agent 不可用时使用 fullstack-engineer。
- reviewer/verifier 与 implementer 分离。
- 验证证据缺失时不能完成。

## 分阶段落地

### Phase 1：入口统一与旁路移除

- 新 session 消息统一创建 workflow-first run。
- 禁用 `low_risk_auto` 自动执行。
- 保留普通问答分支，但也纳入 workflow 状态。

### Phase 2：artifact version 与确认门禁

- 新增 spec/plan artifact version。
- 实现用户通过消息请求 planner 修改。
- 实现 approved version 和 supersede。

### Phase 3：真实 ACP skill invocation

- 用 stage registry 调用 Codex/Claude Code/OpenCode 的 Superpowers。
- 解析 required evidence。
- 缺 evidence 阻塞并可恢复。

### Phase 4：全局智能体分配与全栈兜底

- 接入全局智能体 registry。
- 初始化内置 fullstack-engineer。
- 实现 specialist-first、fullstack-fallback 分配策略。

### Phase 5：执行、审查、验证闭环

- worker 按 approved plan 执行。
- reviewer 做 spec compliance 与 code quality。
- verifier 记录 fresh evidence。
- planner 做 acceptance 和 finish_branch。

## 风险与权衡

### 风险：planner 过载

planner 负责控制全局流程，但不应执行所有任务。通过 controller/worker 权限边界和子代理分配降低 planner 负载。

### 风险：用户不能直接编辑 spec/plan 降低效率

直接编辑会破坏 schema、依赖关系和门禁状态。通过 planner change request 保留自然语言修改能力，同时保证计划一致性。

### 风险：全栈工程师兜底掩盖专业能力缺失

兜底必须记录 fallback reason，并在高冲突 scope 下改为串行。UI 应展示兜底使用情况，便于用户补充专业 agent。

### 风险：ACP 原生 Superpowers 输出不可控

每个 invocation 必须声明 required evidence。没有 evidence 不推进，用 repair/retry 恢复，而不是猜测。

### 风险：历史 workflow 与新 workflow 混杂

新 run 使用 `superpowers-v2` 和 runtime profile 标记。历史 run 继续只读展示。

## 验收标准

1. 用户消息不会绕过 planner controller 直接启动执行 workflow。
2. planner 能基于意图选择普通问答、只读分析、轻量任务、标准开发或调试路径。
3. spec/plan 只读展示，用户只能通过消息请求 planner 修改。
4. 修改 spec/plan 会生成新版本并使旧确认失效。
5. plan 能从全局可用智能体中选择执行者。
6. 找不到专业子代理时，自动分配全局 fullstack-engineer。
7. worker/reviewer/verifier 不能修改 approved spec/plan。
8. ACP 调用必须产出阶段 required evidence，否则 workflow blocked。
9. timeout、缺 evidence、BLOCKED 和 scope change 都有可恢复状态。
10. 轻量任务可以跳过完整 spec/plan，但必须有最小计划、跳过原因和用户确认。
