# AI Task Operating System — 总体架构设计

- 状态：草案（master 架构文档，待评审）
- 日期：2026-05-30
- 分支：`feat/ai-task-os-architecture`
- 范围：定义 openclaw-room 演进为 "AI Task Operating System" 的总纲、目标架构与 milestone 路线
- 非范围：不展开任一 milestone 的实现细节；每个 milestone 后续各自走 brainstorming→writing-plans→实现

---

## 1. 定位与北极星

本文档不是某个功能的 spec，而是 openclaw-room 演进为 **AI Task Operating System** 的总纲。它定义目标架构、把愿景映射到现有代码、再分解为有序 milestone。

**北极星（一句话）**：

> 把"执行、上下文、事件"三件事，从绑定在 **Room/Agent** 上，迁移到绑定在 **Task** 上。聊天降级为命令入口，Task 升级为系统本体。

核心理念（源自需求文档）：

```txt
聊天只是 UI
任务才是系统本体

群聊 = 工作空间（Workspace）
任务 = 长生命周期对象
消息 = 对任务的操作
```

**关键前提（已通过现状分析确认）**：这份愿景不是"从零造系统"。现有代码已实现一大半——Task 已是一等对象、多 Agent 调度与双引擎 Workflow 成熟、ACP runtime 与 room 级 WebSocket 齐全。真正缺的是：(1) 前端三栏 + 激活任务体验，(2) Task Router 的语义/自动建任务，(3) Event Sourcing 化的 TaskEvent 流，(4) 执行上下文按 Task 隔离。

---

## 2. 四条架构原则

贯穿全文，作为后续每个 milestone 的验收准绳。

1. **Task 是聚合根** — 执行会话、上下文、事件、产物都挂在 Task 下，而非 Room。
2. **消息显式分层** — Chat / Activity / Timeline / Runtime / Diff 五层，各有独立语义与投影，不再全塞进 `message.metadata`。
3. **事件可回放** — 关键状态变化进 append-only 事件流，支撑回放 / 恢复 / 自动总结。
4. **Room = Workspace 容器** — Room 提供共享知识与全局聊天，Task 提供隔离上下文。

**渐进演进底线**：地基保持 SQLite / ACP / LangGraph / Express / React 不变。需求文档推荐的 Postgres / pgvector / Temporal / BullMQ / OpenHands 仅作末尾"未来演进"附录，不进主线。

---

## 3. 现状 vs 目标 架构全景

### 3.1 现状（as-is）—— 重心在 Room

```txt
Project
 └── Room ──────────────── WebSocket 广播（room 级）
      ├── RoomAgent ── ACP Session（绑在 agent 上）
      ├── Message[]  ── metadata 里塞 trace / task_event / diff（隐式分层）
      ├── Task[]     ── 一等对象，但执行不绑它
      └── WorkflowRun ── 双引擎(LangChain/LangGraph)，绑 task 但偏后台
```

现状映射（来自代码分析）：

| 愿景组件 | 现状落点 | 完成度 |
|---|---|---|
| Task = 长生命周期对象 | `tasks` 表、`repos/tasks.ts`、状态机 todo→in_progress→review→done→failed | 100% |
| Workspace = Room | `Room`（`types.ts`）、Project→Room→RoomAgent 层级 | 95% |
| 多 Agent 调度 + Planner | `dispatcher.ts` + `workflows/`（LangChain + LangGraph + recovery） | 已实现 |
| Agent Runtime | ACP（claudecode / opencode / codex）会话 + handoff + 权限模式 | 已实现 |
| WebSocket 实时 | `ws-hub.ts`，room 级广播，按实体粒度 | 100% |
| 消息分层 | 隐式塞在 `message.metadata.trace` | 40% |
| Task Router | @mention / planner / fallback 有；语义 + 自动建缺 | 50% |
| 按 Task 隔离上下文 | memory 按 task 分；执行仍绑 room | 20% |
| Event Sourcing | `TaskEventType` 仅存于 message metadata；无独立事件表 | 30% |
| 前端三栏布局 | 现为 2 栏（聊天 + 可选侧栏） | 20% |

### 3.2 目标（to-be）—— 重心迁到 Task

```txt
Workspace (= Room 增强)
 ├── Global Chat            ← 不属于任何 task 的消息
 ├── Shared Knowledge       ← memory(scope=room/project)，全 task 可读
 ├── Activity Feed          ← 所有 task 的高层事件汇总
 │
 └── Task (聚合根)
      ├── TaskContext        ← 隔离的会话 / 记忆 / 文件范围
      ├── TaskExecutor       ← 绑 task 的 ACP 会话（NEW：从 RoomAgent 解耦）
      ├── TaskEventLog        ← append-only 事件流（NEW）
      ├── Timeline           ← Runtime 层投影（已有 AgentTimelineEvent，提取出来）
      ├── Plan / Artifacts   ← 已有 task_artifacts
      └── File Changes(Diff)  ← 从 timeline 的 file_diff 聚合
```

### 3.3 关键解耦动作（全文最大的架构变化）

> 今天 ACP 会话绑在 `RoomAgent` 上（一个 agent 在一个 room 一个 session）。目标是引入 **TaskExecutor**：会话绑在 `(task, agent)` 上，使并发任务天然隔离、可独立 retry、可回放。这是"按 Task 隔离上下文"的技术核心，也是改动最敏感处（涉及 dispatcher + ACP override + handoff）。

兼容策略：保留 `RoomAgent.acp_session` 作为"无 task 的全局聊天会话"；task 执行走 TaskExecutor。二者并存，不强拆现有数据。

---

## 4. 五层消息模型

把现在隐式的 metadata 显式化为五层。五层不是五张表，而是一个判别字段（`MessageLayer`）+ 各自的 WebSocket 投影与前端视图。

| 层 | 内容 | 现状落点 | 目标落点 |
|---|---|---|---|
| **Chat** | 用户意图 / AI 总结 / 协调 | `message_type=text` | 不变，但标注 task_id 或 global |
| **Activity** | "Task#142 改了 3 个文件" 系统活动 | `message_type=system` | 独立 Activity 投影 |
| **Timeline** | read / edit / run 执行事件 | `metadata.trace.events` | 从 message 提取为 task 时间线 |
| **Runtime** | tool_call / 终端 / thinking / 日志 | `metadata.trace` | TaskEvent 流投影 |
| **Diff** | 文件 patch / git diff | timeline 里的 `file_diff` | 按 task 聚合的变更集 |

设计意图：Runtime 日志不进入 Chat 流（需求文档原则 4）；Chat 只放高层语义；Timeline / Runtime / Diff 供检查与回放，独立于聊天渲染。

---

## 5. Milestone 路线

总愿景拆成 5 个 milestone，按"地基 → 大脑 → 体验 → 隔离 → 可选演进"排序。每个都能独立交付价值，后者依赖前者。

```txt
M1 事件地基        M2 Task Router      M3 三栏体验       M4 上下文隔离      M5 未来演进
(Event Sourcing)   (智能路由)          (前端3栏)         (TaskExecutor)    (可选/附录)
     │                  │                  │                  │
  task_events 表     routeMessage()    Task侧栏           会话绑task         Postgres
  五层显式分层       @+激活+语义+建    激活任务面板       并发隔离/retry      pgvector
  WS 事件投影        自动建任务        Timeline/Diff视图  上下文预算          Temporal
     └──────────────────┴──── 数据/路由地基 ────┘                          OpenHands
```

| M | 名称 | 核心交付 | 依赖 | 风险 | 用户可感 |
|---|---|---|---|---|---|
| **M1** | 事件地基 | append-only `task_events` 表 + 五层 MessageLayer 显式化 + WS 按层投影 | 无 | 中（触碰 message/db） | 低（地基） |
| **M2** | Task Router | `routeMessage()`：显式 @ > 激活任务 > 语义匹配 > 自动建任务 | M1 | 中（触碰 dispatcher） | 高 |
| **M3** | 三栏体验 | 前端 Task 侧栏 \| 全局聊天 \| 激活任务面板(Plan/Timeline/Diff/Logs) | M1（读层） | 低（多为前端） | 最高 |
| **M4** | 上下文隔离 | TaskExecutor：ACP 会话从 RoomAgent 解耦到 (task,agent)，并发隔离 / 独立 retry | M1, M2 | 高（ACP/handoff 最敏感） | 中 |
| **M5** | 未来演进 | Postgres / pgvector / Temporal / OpenHands 迁移评估 | 全部 | — | 附录，不实施 |

**本分支起点建议**：
- 最快见效给人看 → M1 薄切片 + M3 一起（M3 需 M1 的读取接口）。
- 按地基稳扎稳打 → M1 → M2 → M3 → M4 顺序推进。
- M4 是全局最高风险（动 ACP 会话归属），建议放最后、单独分支、充分测试。

**边界声明**：本文档只定义路线与架构契约，不展开各 M 的实现细节。每个 milestone 后续各自跑 brainstorming→writing-plans→实现。本文档产出后，下一步是挑 M1（或指定）去写它的 spec。

---

## 6. 数据模型与接口契约

以下为总文档固化的关键契约，后续每个 milestone 的 spec 必须遵守；具体字段在各自 spec 阶段可微调。

### 6.1 TaskEventLog（M1 核心，NEW append-only 表）

```ts
interface TaskEvent {
  id: string;
  task_id: string;
  room_id: string;
  seq: number;            // task 内单调递增，保证回放顺序
  type: TaskEventType;    // 复用现有 union + 扩展
  layer: MessageLayer;    // 该事件投影到哪一层
  payload: unknown;       // JSON，按 type 区分
  source_run_id: string | null;  // 关联 agent_run
  created_at: number;
}
// 只 INSERT，不 UPDATE/DELETE。现有 tasks 表仍存当前态（CQRS 读模型）。
```

### 6.2 MessageLayer（M1，显式化今天隐式的分层）

```ts
type MessageLayer = 'chat' | 'activity' | 'timeline' | 'runtime' | 'diff';
// message 增加可空 layer 字段；旧数据默认 'chat'，迁移兼容。
// 五层不是五张表，是一个判别字段 + 各自的 WS 投影与前端视图。
```

### 6.3 Task Router（M2 核心接口）

```ts
interface RouteResult {
  taskId: string | null;
  action: 'append_to_task' | 'switch_task' | 'create_task' | 'ask_user';
  confidence: number;     // 0..1，低于阈值降级为 ask_user
  reason: string;         // 可解释，进 activity 层
}
function routeMessage(roomId, message, activeTaskId?): Promise<RouteResult>;
// 优先级：① 显式@task ② 当前激活任务 ③ 语义匹配 ④ 创建新任务
```

### 6.4 TaskExecutor（M4 核心，从 RoomAgent 解耦）

```ts
interface TaskExecutor {
  taskId: string;
  agentId: string;
  acpSession: AcpSessionRef;   // 会话归属从 (room,agent) → (task,agent)
  status: 'idle' | 'running' | 'blocked' | 'failed';
}
// 兼容策略：保留 RoomAgent.acp_session 作为"无 task 的全局聊天会话"，
// task 执行走 TaskExecutor。二者并存，不强拆现有数据。
```

### 6.5 前端激活任务状态（M3）

```ts
interface RoomViewState {
  activeTaskId: string | null;   // null = 全局聊天模式
  taskListFilter: TaskStatus[];
  layerVisibility: Record<MessageLayer, boolean>;
}
// 激活任务 + @mention 路由共同决定消息落到哪个 task。
```

### 6.6 WebSocket 事件扩展（M1，复用现有 room 级广播）

```ts
// 新增，与现有 WsServerEvent 并存：
| { type: 'task_event:new'; roomId: string; event: TaskEvent }
| { type: 'task:activated'; roomId: string; taskId: string }
```

---

## 7. 跨切面：错误处理 / 一致性 / 测试

### 7.1 错误处理 / 一致性

- **事件流写入失败**：`task_events` 写入与 `tasks` 读模型更新放同一 SQLite 事务；事件写入失败则整体回滚，不产生"有读模型无事件"的孤儿态。
- **Router 低置信度**：`confidence < 阈值` 一律降级 `ask_user`，绝不静默猜错任务。降级理由进 activity 层，用户可见。
- **TaskExecutor 会话不可用**：复用现有 ACP handoff 机制（`acp_session_handoff_*`），按 task 构建上下文摘要恢复，而非 room。
- **回放 / 恢复**：`seq` 单调递增 + 幂等投影，重放事件流可重建任意 task 当前态（启动恢复、incident recovery 复用此能力）。

### 7.2 测试策略

对齐 AGENTS.md 测试分级 + 现状（`npm run build` 为最低门禁，无统一 runner）。

- **M1 事件地基、M2 Router**：Level 2 TDD —— 事件顺序 / 幂等、路由优先级与降级是高风险共享逻辑，先写测试。
- **M3 前端三栏**：Level 1 回归 —— 组件渲染 + 投影逻辑测试，视觉走 ui-ux 检查。
- **M4 TaskExecutor**：Level 2 TDD + 充分集成测试 —— 会话归属解耦最敏感，需并发隔离 / retry 用例。
- 全程：`npm run build` 作为 TS / 打包最低门禁，新增测试就近放 `*.test.ts`。

---

## 8. 兼容性铁律

呼应 AGENTS.md：历史字段、localStorage key、数据库字段、类型 union 保留作迁移兼容。

- 所有变更**向后兼容**：新增字段可空、旧数据有默认值、旧路由不删除。
- M1~M4 **不做破坏性 schema 迁移**。
- 现有 `WsServerEvent`、`MessageType`、`TaskEventType` union 只扩展不删减。
- ACP 会话归属解耦（M4）采用"并存"而非"替换"策略。

---

## 9. 附录：未来演进（不实施）

需求文档推荐的技术栈，作为长期可选演进记录，**当前不实施**，仅在现有栈触及瓶颈时重新评估：

| 维度 | 现有栈 | 文档推荐 | 触发评估的信号 |
|---|---|---|---|
| 数据层 | SQLite | Postgres | 并发写瓶颈 / 多实例部署 |
| 向量检索 | 无 / 内存 | pgvector | 语义路由召回质量不足 |
| 工作流编排 | LangGraph + 自研 | Temporal | 长事务 / 跨进程可靠性需求 |
| 任务队列 | 进程内 | BullMQ / Redis Streams | 高并发任务积压 |
| Agent 沙箱 | ACP 子进程 | OpenHands / Docker / Git Worktree | 强隔离 / 安全沙箱需求 |

---

## 10. 术语表

- **Workspace**：Room 的增强语义，承载全局聊天 + 共享知识 + 多 Task 容器。
- **Task**：长生命周期聚合根，承载执行、上下文、事件、产物。
- **MessageLayer**：消息的五层判别（chat / activity / timeline / runtime / diff）。
- **TaskExecutor**：绑定 `(task, agent)` 的执行会话抽象，从 RoomAgent 解耦。
- **TaskEvent**：append-only 事件流的单元，支撑回放与恢复。
- **TaskContext**：单个 Task 的隔离上下文（会话 / 记忆 / 文件范围）。
