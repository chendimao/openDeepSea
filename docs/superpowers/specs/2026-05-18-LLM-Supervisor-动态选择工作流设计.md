# LLM Supervisor 动态选择工作流设计

## 目标

把当前“固定默认 workflow + deterministic resolver”的流程升级为混合模式：

1. LLM Supervisor / Manager 先根据任务选择合适的 workflow definition。
2. Supervisor 可以建议关键阶段的 agent assignment。
3. 系统校验 LLM 输出，非法或低置信度时回退到现有默认 workflow / deterministic resolver。
4. 第一阶段只从已有 published workflow definitions 中选择，不直接执行 LLM 临时生成的 workflow。

## 当前基础

现有系统已经具备：

- `workflow_definitions`：系统、项目、房间级 workflow definition。
- `default_workflow_definition_id`：设置体系中的默认 workflow。
- `startGraphWorkflow` / `createGraphWorkflowRun`：启动 graph workflow，并把 workflow definition snapshot 写入 run。
- `LangChain planner`：已有 LLM 配置、ChatOpenAI invoker、结构化 JSON 解析模式。
- `Workflow Role Resolver`：按 role、capabilities、ACP 可执行状态、scope 选择 agent。

因此新能力应该复用这些边界，而不是让 LLM 直接驱动 runtime。

## 推荐架构

### 1. Supervisor 决策层

新增 `workflow-supervisor` 模块，职责是：

- 读取任务、项目、房间、可见 workflow definitions、可用 agents。
- 调用 LLM 生成结构化决策。
- 解析并校验决策。

输出结构：

```json
{
  "mode": "select_existing_workflow",
  "workflowDefinitionId": "workflow-id",
  "confidence": 0.86,
  "reason": "任务涉及前后端改动，选择前后端协作闭环。",
  "assignments": [
    {
      "stage": "implementation",
      "role": "executor",
      "agentId": "frontend-executor",
      "reason": "scope includes packages/frontend"
    }
  ],
  "fallbackMode": "default_workflow"
}
```

第一阶段允许 `mode`：

- `select_existing_workflow`
- `use_default_workflow`
- `propose_temporary_workflow`

其中 `propose_temporary_workflow` 只记录建议，不执行。

### 2. Workflow 启动层

`createGraphWorkflowRun` 增加可选输入：

```ts
{
  workflowDefinitionId?: string | null;
  supervisorDecision?: WorkflowSupervisorDecision | null;
}
```

选择顺序：

1. 如果有合法 supervisor workflowDefinitionId，使用它。
2. 否则使用 room/project/system 默认 workflow。
3. 如果默认不可用，使用内置 workflow。

创建 run 时把 supervisor 决策写入 snapshot 或 metadata，方便后续审计。

### 3. Agent Assignment 层

Supervisor 可以建议 assignment，但不能直接绕过系统约束。

校验规则：

- agent 必须属于当前 room。
- agent 必须 ACP enabled 且有 backend。
- role/capabilities 不匹配时允许降级，但要记录原因。
- 校验失败时丢弃该 assignment，继续用 deterministic resolver。

第一阶段不新增复杂 assignment schema 到 workflow definition；只在 workflow 启动/dispatch 时作为 hint 输入。

### 4. Confidence Gate

推荐默认：

- `confidence >= 0.75`：自动启动 supervisor 选中的 workflow。
- `confidence < 0.75`：先使用默认 workflow，记录 supervisor 建议；后续可做确认卡片。
- LLM 调用失败、JSON 解析失败、workflow 不可见、agent 非法：使用默认 workflow。

这保证新能力不会让任务启动路径变脆。

## 用户体验

第一阶段 UI 可以很轻：

- 任务详情或 workflow timeline 显示：
  - Supervisor 选择的 workflow。
  - 选择理由。
  - confidence。
  - 是否使用 fallback。

后续阶段再加确认卡片：

- “Manager 建议使用 X workflow，置信度 0.62，是否确认？”

## 错误处理

必须避免 LLM 失败阻塞任务启动：

- 无 LLM 配置：跳过 supervisor，使用默认 workflow。
- LLM 输出非法：记录 warning，使用默认 workflow。
- workflowDefinitionId 不可见：使用默认 workflow。
- assignment agent 不可执行：丢弃 assignment，使用 resolver。

## 测试策略

### 后端单元测试

- supervisor prompt 包含 task、agents、visible workflow definitions。
- supervisor parser 接受合法 JSON。
- parser 拒绝不存在 workflow、不可见 workflow、非法 confidence。
- LLM 失败时 workflow 启动 fallback 到默认 definition。
- 高置信度合法选择写入 `workflow_definition_id`。
- 低置信度选择不覆盖默认 workflow。

### Graph runtime 测试

- `startGraphWorkflow` 使用 supervisor 选中的 workflow definition。
- supervisor assignment hint 合法时可影响 dispatch。
- 非法 assignment 不阻塞，fallback 到 deterministic resolver。

### Build 验证

- `npm run build`
- 定向 workflow supervisor tests
- 现有 graph runtime tests

## 非目标

第一阶段不做：

- LLM 直接生成并执行临时 workflow graph。
- UI 中完整编辑 supervisor 决策。
- 多轮 manager-agent 协商。
- 替换 deterministic resolver。

这些保留为第二阶段。

## 开放扩展

第二阶段可以加入：

- `propose_temporary_workflow` 生成 draft workflow definition。
- 用户确认后把 draft 发布为 room-scoped workflow。
- Supervisor 根据历史成功率学习 workflow selection。
- Manager 在执行中动态 re-route 未完成任务。
