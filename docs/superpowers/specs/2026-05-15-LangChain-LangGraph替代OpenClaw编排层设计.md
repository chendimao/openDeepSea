# LangChain/LangGraph 替代 OpenClaw 编排层设计

## 背景

OpenClaw Room 当前的产品层已经具备项目、房间、消息、任务、工作流、记忆和 ACP agent run 记录能力。OpenClaw 在系统中主要承担三类职责：

1. 读取本机 OpenClaw agents，作为添加房间 agent 的来源。
2. 作为未启用 ACP 的 agent 默认执行后端。
3. 通过 OpenClaw Gateway 提供 session、chat.send 和事件流。

目标方向是逐步降低 OpenClaw 的硬依赖：OpenClaw Room 保留产品和状态层；Claude Code、OpenCode、Codex 继续作为 ACP 执行层；LangChain/LangGraph 接管智能体规划、分配、审查、验收等编排职责。

## 总体目标

- 不依赖 OpenClaw Gateway，也能完成项目核心工作流。
- 支持 ACP-only 的多智能体协作开发任务。
- 第一阶段先引入 LangChain Planner，生成结构化计划，但保留现有 workflow orchestrator。
- 第二阶段引入 LangGraph，将任务工作流表达为可恢复、可审计、可人工介入的状态图。
- OpenClaw 保留为可选 provider，不再是核心编排层。

## 非目标

- 不在第一阶段移除 OpenClaw 相关代码。
- 不让 LangChain 直接执行任意 shell 或直接修改文件。
- 不用 Python sidecar 作为默认方案；本项目是 TypeScript/Node，优先采用 LangChain/LangGraph JS。
- 不在第一阶段实现并行写入开发；并行执行必须等文件范围和冲突控制成熟后再开放。
- 不替换现有 ACP adapters，Claude Code、OpenCode、Codex 继续作为执行后端。

## 推荐路线

采用两阶段路线：

1. **阶段 A：LangChain Planner**
   - 新增 Planner runtime。
   - 输入用户目标、项目上下文、房间 agents、记忆和最近消息。
   - 输出结构化计划 JSON。
   - 现有 `workflowOrchestrator` 继续创建 workflow steps、调用 ACP、记录状态。

2. **阶段 B：LangGraph Workflow Runtime**
   - 用 LangGraph 表达完整任务状态机。
   - LangGraph 节点调用 OpenClaw Room 内部 tools。
   - `workflow_runs` 和 `workflow_steps` 作为持久化、审计和 UI 展示来源。
   - 支持暂停、恢复、人工确认、重试、审查修复循环。

## 目标架构

```text
OpenClaw Room UI
  ↓
Backend API / WebSocket
  ↓
Room / Task / Message / Memory / AgentRun 状态层
  ↓
LangGraph Orchestration Runtime
  ↓
LangChain Planner / Reviewer / Router
  ↓
ACP Execution Tools
  ↓
Claude Code / OpenCode / Codex
```

职责边界：

- **OpenClaw Room**：产品界面、状态落库、消息广播、权限边界、审计。
- **LangChain**：结构化输出、planner/reviewer agent、tool calling。
- **LangGraph**：长任务状态机、节点调度、恢复、human-in-the-loop。
- **ACP**：真实编码执行、代码审查、测试修复、上下文续接。
- **OpenClaw**：可选的 agent provider 或 legacy runtime。

## 阶段 A：LangChain Planner

### 目标

阶段 A 只解决“自主规划与分配”的第一步：把用户开发任务转成系统可执行的结构化计划。

### 输入

Planner 输入由后端构造：

- 项目路径、项目描述。
- 当前房间 agents：
  - `agent_id`
  - `agent_name`
  - `agent_role`
  - `workflow_role`
  - `acp_enabled`
  - `acp_backend`
- 用户目标或任务内容。
- 最近消息摘要。
- 相关记忆。
- 当前仓库约束和验证命令。

### 输出协议

Planner 必须输出 JSON，并通过 zod 校验：

```ts
interface LangChainPlan {
  goal: string;
  summary: string;
  assumptions: string[];
  steps: PlannedStep[];
  risks: string[];
  verification: VerificationCommand[];
  needsApproval: boolean;
}

interface PlannedStep {
  title: string;
  intent: string;
  assigneeRole: 'planner' | 'executor' | 'reviewer' | 'acceptor';
  preferredBackend?: 'claudecode' | 'opencode' | 'codex';
  scopeRead: string[];
  scopeWrite: string[];
  acceptance: string[];
  dependsOn: string[];
}

interface VerificationCommand {
  command: string;
  reason: string;
  required: boolean;
}
```

### Planner 约束

- 不能输出未结构化自然语言作为唯一结果。
- `scopeWrite` 必须为空数组或明确列出目录/文件范围。
- 如果需要修改 shared contract、schema、根配置或依赖，必须标记 `needsApproval = true`。
- 如果没有可用 ACP executor，Planner 必须输出不可执行原因，而不是假设 OpenClaw 可用。
- 第一阶段默认串行执行，不生成并行任务。

### 阶段 A 数据流

1. 用户在房间中创建开发任务或发送触发工作流的消息。
2. 后端创建 `workflow_run`，状态为 `planning`。
3. LangChain Planner 生成计划 JSON。
4. 后端校验计划。
5. 校验失败时记录 planner error，并要求 Planner 重试一次。
6. 校验成功后将计划写入 workflow artifact 或 `workflow_steps`。
7. 若 `needsApproval = true`，进入人工确认。
8. 若无需确认，沿用当前 `workflowOrchestrator` 执行 steps。

### 阶段 A 验收标准

- 不启动 OpenClaw Gateway 也能生成任务计划。
- 手动创建的 ACP agents 能被 Planner 识别和分配。
- Planner 输出通过 zod 校验。
- 计划能落库并在 UI 中查看。
- 执行仍走现有 ACP adapters。

## 阶段 B：LangGraph Workflow Runtime

### 目标

阶段 B 将现有工作流主状态机迁移为 LangGraph 图，但保留数据库和 UI 展示模型。

### 图结构

```text
ContextNode
  ↓
PlanningNode
  ↓
ApprovalNode
  ↓
DispatchNode
  ↓
ExecuteNode
  ↓
ReviewNode
  ↓
RepairDecisionNode
  ├─ needs_fix → ExecuteNode
  └─ pass → VerifyNode
      ↓
AcceptanceNode
      ↓
MemoryNode
      ↓
Completed
```

### Graph State

```ts
interface AgentWorkflowState {
  workflowRunId: string;
  projectId: string;
  roomId: string;
  taskId: string | null;
  userGoal: string;
  projectPath: string;
  context: WorkflowContext;
  plan: LangChainPlan | null;
  currentStepId: string | null;
  stepResults: StepResult[];
  reviewFindings: ReviewFinding[];
  verificationResults: VerificationResult[];
  approval: 'not_required' | 'pending' | 'approved' | 'rejected';
  status: 'planning' | 'awaiting_approval' | 'executing' | 'reviewing' | 'verifying' | 'accepted' | 'failed';
}
```

### 节点职责

- **ContextNode**：读取项目、房间、任务、最近消息和记忆。
- **PlanningNode**：调用 LangChain Planner，生成结构化计划。
- **ApprovalNode**：根据风险和配置决定是否等待用户确认。
- **DispatchNode**：将 planned steps 映射到 room agents。
- **ExecuteNode**：通过 ACP tool 调用 executor agent。
- **ReviewNode**：通过 ACP tool 调用 reviewer agent。
- **RepairDecisionNode**：根据 review verdict 决定修复或继续。
- **VerifyNode**：运行允许的验证命令，记录结果。
- **AcceptanceNode**：自动或人工验收。
- **MemoryNode**：写入任务总结、决策和经验。

### LangGraph Tools

LangGraph 节点只能调用 OpenClaw Room 封装的安全 tools：

```ts
readWorkflowContext(input)
createWorkflowSteps(input)
runAcpAgent(input)
requestUserApproval(input)
recordReviewFindings(input)
runVerification(input)
appendRoomMessage(input)
writeMemory(input)
updateWorkflowState(input)
```

禁止暴露通用 shell tool 给 LangChain。需要跑测试或 build 时，必须通过 `runVerification` 的 allowlist。

### 持久化策略

现有表继续作为主状态源：

- `workflow_runs`：工作流总状态。
- `workflow_steps`：计划步骤和节点状态。
- `agent_runs`：每次 ACP 调用。
- `messages`：用户和 agent 可见输出。
- `memory_entries`：长期记忆。

建议扩展字段：

```text
workflow_runs.graph_version TEXT
workflow_runs.graph_state TEXT
workflow_steps.node_name TEXT
workflow_steps.scope_read TEXT
workflow_steps.scope_write TEXT
workflow_steps.assigned_room_agent_id TEXT
room_agents.capabilities TEXT
room_agents.default_runtime TEXT
```

如果 LangGraph JS checkpoint 能直接接入自定义持久化，则以 `workflow_runs.graph_state` 作为同步快照；否则先由 OpenClaw Room 自己保存每个节点执行后的 state。

## ACP-only Agent Registry

为了不依赖 OpenClaw agents.list，需要提供内置 agent 模板。

### 默认模板

```text
Planner
  role: planner
  recommendedBackend: codex

Backend Executor
  role: executor
  recommendedBackend: codex

Frontend Executor
  role: executor
  recommendedBackend: codex

Reviewer
  role: reviewer
  recommendedBackend: codex

Acceptor
  role: acceptor
  recommendedBackend: codex
```

模板只创建 Room Agent，不直接保存密钥。每个可执行 agent 必须配置 ACP backend。

### Agent 能力模型

```ts
interface AgentCapabilities {
  roles: Array<'planner' | 'executor' | 'reviewer' | 'acceptor'>;
  domains: Array<'backend' | 'frontend' | 'testing' | 'docs' | 'architecture'>;
  canWrite: boolean;
  canReview: boolean;
  preferredBackend?: 'claudecode' | 'opencode' | 'codex';
}
```

Planner 分配任务时优先按 `workflow_role` 和 `capabilities` 匹配。

## UI 变化

### Agent 添加

- 默认展示“内置 Agent 模板”。
- OpenClaw agents 列表移动到“从 OpenClaw 导入”区域。
- OpenClaw 不在线时，不阻塞添加 agent。
- 可执行 agent 未配置 ACP 时，显示“不可执行，仅角色占位”。

### 工作流页面

- 显示 Planner 结构化计划。
- 显示每个 step 的 assignee、scopeRead、scopeWrite、acceptance。
- 显示审批状态、review verdict、verification results。
- 对 `needsApproval` 的计划提供确认和驳回入口。

### Gateway 状态

- OpenClaw Gateway 状态改为“可选集成”。
- 离线时不再暗示系统不可用。

## 错误处理

- Planner 输出非法 JSON：记录错误，自动重试一次；仍失败则 workflow failed。
- Planner 找不到可执行 agent：workflow 进入 awaiting_configuration，提示配置 ACP backend。
- ACP run 失败：step failed，允许 retry。
- Reviewer 返回 blocking finding：进入 repair loop。
- 验证命令失败：workflow failed 或 awaiting_fix，取决于是否还有修复次数。
- 后端重启：从 `workflow_runs`、`workflow_steps`、`agent_runs` 恢复可见状态；运行中的 ACP run 标记 interrupted。

## 安全与权限

- LangChain tools 只能调用项目内部函数。
- 文件写入范围由 `scopeWrite` 和 agent role 决定。
- 第一阶段不允许自动并行写入。
- 验证命令使用 allowlist，例如：
  - `npm run test -w @openclaw-room/backend`
  - `npm run build`
  - 项目配置中声明的安全命令
- Planner 不能自行新增依赖、修改 CI、删除文件或执行迁移；这些操作必须进入人工确认。

## 测试计划

### 阶段 A

- Planner schema 校验：
  - 合法计划通过。
  - 非 JSON 输出失败。
  - 缺少 `scopeWrite`、`acceptance` 等关键字段失败。
- Agent 匹配：
  - 根据 `workflow_role` 匹配 executor/reviewer。
  - 没有 ACP backend 时返回不可执行。
- Workflow 集成：
  - Planner plan 能落库。
  - `needsApproval` 正确进入审批状态。
  - 无需审批时沿用现有 orchestrator 执行。

### 阶段 B

- Graph 节点单测：
  - ContextNode、PlanningNode、DispatchNode、ReviewNode、VerifyNode。
- 恢复测试：
  - 中断后 workflow state 可恢复。
  - 运行中的 ACP run 标记 interrupted。
- 审查修复循环：
  - Reviewer blocking -> ExecuteNode retry。
  - Reviewer pass -> VerifyNode。
- 端到端：
  - 无 OpenClaw Gateway 情况下，ACP-only agents 完成一个开发任务。

## 验收标准

### 阶段 A 验收

- OpenClaw Gateway 离线时，仍可创建内置 ACP agents。
- 用户发起开发任务后，Planner 生成结构化计划。
- 计划写入 workflow，并能在 UI 查看。
- 当前 orchestrator 可根据计划调用 ACP executor。
- 后端测试和构建通过。

### 阶段 B 验收

- LangGraph 图接管 plan -> execute -> review -> verify -> accept 流程。
- workflow state 可落库和恢复。
- 人工审批节点可暂停和继续。
- Reviewer 能触发修复循环。
- 无 OpenClaw Gateway 时，ACP-only 协作开发闭环可完成。

## 迁移步骤

1. 新增 LangChain 依赖和 Planner schema。
2. 新增内置 Agent 模板和 ACP-only 添加流程。
3. 新增 Planner service，仅生成计划。
4. 将计划写入现有 workflow artifacts/steps。
5. 接入现有 orchestrator 执行阶段 A。
6. 增加 UI 计划预览和审批。
7. 引入 LangGraph runtime，先复刻串行工作流。
8. 将 workflow state 与数据库持久化对齐。
9. 增加 review/repair/verify loop。
10. 将 OpenClaw Gateway 标记为可选集成。

## 开放问题

- LangChain/LangGraph JS 版本是否满足当前 checkpoint 和 human-in-the-loop 需求；若不足，是否接受 Python sidecar。
- Planner 默认使用哪个 ACP backend 作为模型调用来源；可以先使用 Codex，也可以直接使用 LangChain provider。
- 内置 Agent 模板是否项目级共享，还是每个房间单独创建。
- 验证命令 allowlist 放在项目设置、仓库配置文件，还是系统设置中。

## 阶段 A 实施记录

- LangChain Planner 已作为可选 planning path 接入。
- 未配置 `LANGCHAIN_PLANNER_MODEL` 或 `OPENAI_API_KEY` 时，系统回退到现有 ACP planning stage。
- 内置 ACP agent 模板已支持无 OpenClaw Gateway 的 agent 创建。
- 阶段 B 仍保留为后续 LangGraph runtime 迁移工作。

## 阶段 B 实施计划记录

- 阶段 B 计划采用 feature flag `LANGGRAPH_WORKFLOW_ENABLED` 保守启用，默认仍保持现有 orchestrator 入口兼容。
- LangGraph runtime 先复刻串行开发闭环，不开放自动并行写入，也不引入通用 shell tool。
- `workflow_runs.graph_state` 作为 graph state 快照，现有 workflow runs、steps、artifacts、tasks 和 memory tables 继续作为 UI 与审计来源。
- 验证命令通过 allowlist 执行；无验证命令时记录 skipped 结果，避免测试和运行时依赖 OpenClaw Gateway。
