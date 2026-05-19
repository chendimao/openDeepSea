# Workflow Coordinator 多智能体编排设计

## 背景

当前正式 workflow 的链路已经具备计划生成、子任务创建、智能体拉入、任务表格和智能体结果 tabs 的基础能力，但这些能力还没有收敛成一个清晰的多智能体编排模型。

理想流程是：

1. 用户在群聊发布需求。
2. 产品经理分析需求并生成可读计划。
3. 计划完成后，消息气泡中出现“正式 workflow”入口。
4. 用户点击正式 workflow 后，系统消费前序产品经理计划，而不是再次让产品经理重复分析。
5. Workflow Coordinator 将计划结构化成固定 JSON，分析全局智能体与群聊智能体，拉入缺失智能体。
6. 气泡中用表格展示子任务、智能体、并行/串行、依赖、进度等字段。
7. Coordinator 按依赖图和资源约束启动执行智能体，持续更新表格和各智能体 tabs。

## 社区方案借鉴

### OpenAI Agents SDK

OpenAI Agents SDK 将多智能体编排区分为 handoff 和 manager 调用专家两类模式。对 OpenDeepSea 更适合的是“代码确定性编排为主，LLM 只负责计划和判断”的 manager 模式。handoff 的输入可以携带结构化上下文，这适合用在子任务分派时传递任务摘要、验收标准、依赖、写入范围和优先级。

借鉴点：

- 明确区分调度控制权和专家执行权。
- 每次分派都携带结构化 handoff payload。
- LLM 可以参与判断，但不能成为唯一状态源。

参考：

- https://openai.github.io/openai-agents-python/multi_agent/
- https://openai.github.io/openai-agents-python/handoffs/

### LangGraph Supervisor

LangGraph Supervisor 采用中心 supervisor 协调多个专家 agent 的模式。它强调由中心节点决定下一步调用哪个 agent，而不是让群聊自然发散。

借鉴点：

- 中心协调器负责路由。
- 专家 agent 只处理局部任务。
- graph state 是恢复和路由的核心。

OpenDeepSea 已经有 LangGraph runtime，因此不需要引入新的多智能体框架，而应在现有 graph runtime 中加入 Coordinator 层。

参考：

- https://reference.langchain.com/javascript/modules/_langchain_langgraph-supervisor.html

### CrewAI Flow

CrewAI 将 Flow 定位为状态和流程管理，Crew/Agents 负责具体执行。这个职责划分与 OpenDeepSea 的目标相符：Workflow Coordinator 管流程，executor/reviewer/acceptor 管局部工作。

借鉴点：

- Flow 是确定性的流程骨架。
- Agent 输出沉淀为状态和 artifact。
- 状态流转比聊天上下文更重要。

参考：

- https://docs.crewai.com/en/introduction

### Microsoft Agent Framework Group Chat

Microsoft Group Chat Orchestration 使用中心 orchestrator 选择发言者、控制轮次和终止条件。它适合提醒 OpenDeepSea：群聊可以是展示界面，但不应该是执行调度的事实来源。

借鉴点：

- 群聊 UI 不等于调度器。
- speaker selection 应由中心组件决定。
- 需要明确终止条件和最大轮次。

参考：

- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat

## 当前差距

### 产品经理职责过宽

当前从 planner 消息点击正式 workflow 后，后端会创建 Task 并启动 graph workflow。graph 的 planning 节点会重新调用 planner 生成 `ParsedPlan`，这会导致用户感知为“产品经理分析完又继续分析”。

目标行为是：产品经理第一次分析完成后，正式 workflow 启动时由 Coordinator 消费已有计划，做结构化和调度，不再重复做需求分析。

### workflowPlan 不是唯一执行事实源

当前 `workflowPlan` 已经存在于 graph state 和 plan artifact metadata 中，前端也有 `WorkflowTaskBubble`、`WorkflowTaskTable`、`WorkflowAgentTabs`。但执行节点仍主要围绕 child tasks 和 workflow steps 运行，`workflowPlan` 更像展示同步数据。

目标行为是：`workflowPlan` 成为 Coordinator 的权威执行计划，child tasks、workflow steps、agent runs 和 artifacts 都是它的执行投影。

### 并行字段不等于并行调度

当前 `mode: parallel | serial` 可以展示，但执行节点按 runnable child 循环处理，更接近串行执行。

目标行为是：Coordinator 按 DAG 调度 ready tasks，允许无依赖、无写入冲突、不同 agent 的任务并行启动。

### 智能体匹配能力有限

当前主要在群聊智能体中选择，缺少时拉入内置 executor/reviewer/acceptor。它没有完整扫描全局智能体库，也没有综合能力、运行边界、ACP 状态和 busy 状态评分。

目标行为是：Coordinator 先从群聊智能体和全局智能体库生成候选集，再按任务能力和运行约束评分，必要时拉入群聊。

### 聊天气泡缺少完整 workflow 面板

当前 workflow 表格和 tabs 主要挂在 workflow timeline / 详情视图，聊天事件气泡仍偏简单。

目标行为是：正式 workflow 启动后，聊天中出现可动态更新的 workflow 气泡，上半部分是子任务表格，下半部分按智能体展示执行结果。

## 目标架构

新增 Workflow Coordinator 作为正式 workflow 的确定性调度控制器。

```text
用户需求
  -> 产品经理 planner 消息
  -> task_readiness + 正式 workflow 入口
  -> Workflow Coordinator
      -> 结构化计划
      -> 匹配和拉入智能体
      -> 创建子任务和 workflowPlan
      -> 按 DAG 调度 agent runs
      -> 收集 artifacts
      -> 触发 review / verify / acceptance
      -> 写入 memory
```

职责边界：

- 产品经理：分析需求、生成可读计划、提出验收口径。
- Coordinator：结构化计划、分配智能体、调度执行、恢复和异常处理。
- Executor：只执行分配给自己的子任务。
- Reviewer：只审查实现结果。
- Acceptor：只做最终验收。
- 前端：展示 Coordinator 的状态，不自行推断调度状态。

## 状态模型

`WorkflowPlanJson` 升级为 Coordinator 的权威计划模型。

建议字段：

```ts
interface CoordinatorWorkflowPlan {
  workflow_name: string;
  source_message_id: string;
  planner_message_id: string | null;
  goal: string;
  summary: string;
  status: 'pending' | 'dispatching' | 'running' | 'reviewing' | 'verifying' | 'accepting' | 'completed' | 'blocked' | 'failed' | 'cancelled';
  tasks: CoordinatorTask[];
}

interface CoordinatorTask {
  id: string;
  title: string;
  description: string;
  role: 'executor' | 'reviewer' | 'acceptor';
  required_capabilities: string[];
  scope_read: string[];
  scope_write: string[];
  mode: 'parallel' | 'serial';
  depends_on: string[];
  assigned_agent_id: string | null;
  assignment_reason: string | null;
  child_task_id: string | null;
  workflow_step_id: string | null;
  agent_run_id: string | null;
  status: 'pending' | 'ready' | 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';
  progress: number;
  result_refs: string[];
  error: string | null;
}
```

数据库仍可先沿用 `workflow_runs.graph_state` 保存完整 JSON，后续如查询压力上升，再拆成 coordinator_tasks 表。

## 节点设计

建议将 graph runtime 拆成以下 Coordinator 节点：

1. `context`
   - 读取原始用户消息、产品经理计划、项目、群聊、文件、记忆。

2. `structure_plan`
   - 优先消费产品经理消息中的计划内容。
   - 将 md 或自然语言计划转成固定 JSON。
   - 如果已有结构化 `workflow_plan_json`，直接校验并复用。
   - 只在缺少可用计划时才调用 planner。

3. `assign_agents`
   - 为每个任务生成候选智能体。
   - 按能力、角色、ACP、运行边界、写权限、busy 状态评分。
   - 群聊缺少合适智能体时，从全局智能体库或内置模板拉入。
   - 写入 `assigned_agent_id` 和 `assignment_reason`。

4. `publish_workflow_bubble`
   - 创建或更新 workflow 气泡事件。
   - 前端通过 `workflow_run_id` 拉取 detail，并渲染任务表和 tabs。

5. `schedule_ready_tasks`
   - 计算 ready tasks。
   - 无未完成依赖、无写入冲突、agent 可用的任务可以并行启动。
   - 生成 workflow step 和 agent run。

6. `collect_results`
   - 监听或轮询 agent run 状态。
   - 将输出写入 artifact 和 context entry。
   - 更新任务状态、进度和 result refs。

7. `review`
   - 所有 executor 任务完成后触发。
   - reviewer 读取子任务结果和变更摘要。

8. `verify`
   - 执行计划中的验证命令。
   - 失败时进入 repair 或 blocked。

9. `acceptance`
   - acceptor 根据用户需求和验收标准判断是否完成。

10. `memory`
   - 写入任务总结和可复用经验。

## 调度规则

### Ready 条件

任务可启动需满足：

- status 是 `pending` 或 `ready`。
- 所有 `depends_on` 任务均已 `completed`。
- 已分配 agent。
- agent 当前没有冲突中的 active run。
- `scope_write` 与正在运行任务无冲突。
- workflow 未取消、未阻塞。

### 并行条件

多个任务可以并行启动需满足：

- 依赖图无前后关系。
- 写入范围不重叠。
- 不使用同一个单实例 agent，除非 agent 声明支持并发。
- 不修改共享高风险文件，如 package.json、lockfile、数据库迁移、全局配置、shared contract。

### 串行条件

以下情况强制串行：

- `depends_on` 非空。
- 写入范围冲突。
- 修改根配置、schema、shared types、CI、迁移。
- 任务明确指定 `mode: serial`。
- Coordinator 无法确认并行安全。

## 智能体匹配

候选来源：

1. 当前群聊 active agents。
2. 全局智能体库。
3. 内置模板：frontend-executor、backend-executor、reviewer、acceptor。

评分维度：

- `workflow_role` 是否匹配。
- capabilities 是否覆盖 required capabilities。
- ACP 是否启用。
- ACP backend 是否可用。
- tool_policy 是否允许所需工具。
- workspace_policy.write 是否覆盖 `scope_write`。
- 当前是否 busy。
- 是否已经在群聊。
- 是否与任务领域匹配，例如 frontend/backend/docs/test。

Coordinator 选择分数最高且满足硬约束的 agent。如果所有候选都不满足，workflow 进入 blocked，并在气泡中展示阻塞原因和建议动作。

## 前端展示

正式 workflow 启动后，聊天里应出现一个 workflow 气泡。

气泡上半部分：

- workflow 名称和整体进度。
- 子任务表格：
  - 子任务
  - 角色
  - 智能体
  - 并行/串行
  - 依赖
  - 状态
  - 进度
  - 错误

气泡下半部分：

- 按智能体分组 tabs。
- 每个 tab 展示该智能体负责的任务、运行状态、输出 artifact、失败原因。
- reviewer 和 acceptor 结果也作为 tabs 或固定阶段结果展示。

状态更新：

- 后端通过 WebSocket 广播 workflow、step、artifact、agent run、task 更新。
- 前端收到事件后 invalidate workflow detail。
- 气泡只读取 workflow detail，不在本地推断任务状态。

## 迁移策略

第一阶段：Coordinator 壳层

- 保留当前 graph runtime。
- 新增 `structure_plan` 和 `assign_agents` 逻辑。
- 正式 workflow 启动时消费 planner 消息，不重复分析。
- `workflowPlan` 成为 graph state 中的权威展示状态。

第二阶段：DAG 调度

- 替换单一 `executeNode` 循环。
- 支持 ready queue。
- 支持多个 active agent runs。
- 增加 active run 与 task id 的严格绑定。

第三阶段：聊天 workflow 气泡

- 将 `WorkflowTaskBubble` 接入消息气泡。
- workflow started / assignment created 事件生成可展开的 workflow bubble。
- 表格和 tabs 动态更新。

第四阶段：全局智能体匹配

- 引入 candidate scoring。
- 支持从全局智能体库拉入群聊。
- 记录 assignment reason。

第五阶段：恢复和异常处理

- 增加 Coordinator recovery。
- 处理 active run orphan、running step without active run、child task failed 等事件。
- 支持按任务重试、换 agent、跳过非关键任务。

## 测试策略

后端测试：

- 点击正式 workflow 后复用 planner 消息，不重复调用 planner。
- md 计划可以结构化成固定 JSON。
- JSON 校验失败时 workflow blocked，并显示错误。
- assign_agents 可以从群聊选择合适 agent。
- 群聊缺少 agent 时从全局库或内置模板拉入。
- 无依赖且写入不冲突的任务并行启动多个 agent runs。
- 有依赖或写入冲突的任务串行启动。
- active run 只阻塞对应 task，不阻塞其他可并行 task。
- agent run 完成后更新 task、step、artifact、workflowPlan。
- 失败任务进入 blocked 或 repair，不触发无限循环。

前端测试：

- planner 气泡显示正式 workflow 入口。
- workflow 气泡显示任务表格。
- 表格显示子任务、智能体、并行/串行、依赖、进度。
- tabs 按智能体分组展示结果。
- WebSocket 事件后 workflow 气泡动态更新。
- blocked 状态显示错误和重试入口。

集成验收：

- 在真实浏览器中创建群聊。
- 输入“细化文件管理功能，比如有些是用户上传的文件，有些是智能体生成的 md 文档”。
- 产品经理生成计划。
- 点击正式 workflow。
- 验证 Coordinator 生成任务表、拉入 executor/reviewer/acceptor、启动执行、审查、验证、验收。

## 风险与约束

- 并行执行会放大写入冲突，需要保守判断 scope_write。
- 多 active agent runs 会影响现有 retry/cancel/recovery 逻辑。
- workflowPlan 成为权威状态后，child tasks 和 workflow steps 的同步必须单向、清晰。
- 全局智能体匹配不能只依赖名称，需要运行边界和工具权限作为硬约束。
- 前端气泡不应保存派生状态，否则容易和后端 graph_state 漂移。

## 决策

采用 OpenDeepSea 原生 Workflow Coordinator，不直接引入 CrewAI、AutoGen 或新的多智能体框架。

原因：

- 当前系统已有 LangGraph、workflow_runs、workflow_steps、agent_runs、task_artifacts、WebSocket。
- 原生 Coordinator 能最大化复用现有数据模型和 UI 组件。
- 外部框架会带来状态双写和调试复杂度。

最终目标是：产品经理负责计划，Coordinator 负责编排，执行智能体负责交付，用户在聊天气泡中看到一个可动态更新的正式工作流。
