# 记忆自动沉淀 + 跨聊天室共享

在智能体回复完成后和闭环任务验收后，自动调用 LLM 从对话中提炼记忆条目，并提供跨聊天室的记忆检索 API 与 project 级自动注入。

## 当前现状

- **记忆 scope 已有 `project`/`room`/`agent`/`task` 四级**，`project` 级记忆已自动注入所有聊天室的 agent prompt
- **任务验收时已有 `upsertTaskSummary`**，但仅存一条 `task_summary`，不提炼决策/经验/事实
- **无自动沉淀能力**：记忆只能手动创建或通过消息气泡"保存为记忆"
- **无跨聊天室检索 API**：`listForRoomContext` 仅返回当前 room 的记忆

---

## 改动计划

### Part A: 自动沉淀

#### A1. 回复级轻量提炼

**触发时机**：`respondAsAgent` 的 `finally` 块中，agent run 完成后异步调用

**逻辑**：
1. 在 `packages/backend/src/memory/distill.ts` 新建模块
2. 读取该 room 最近 N 条消息（含刚完成的回复），拼接为上下文
3. 通过 OpenClaw Gateway `chat.send` 调用 LLM，prompt 要求从对话中提取值得记忆的决策/经验/事实
4. LLM 以 JSON 格式返回 0~3 条候选记忆（type/title/content/scope）
5. 对候选去重（检查标题相似度 or source_id 唯一约束），写入 `memory_entries`
6. `source_type` 使用现有的 `'message'`，`source_id` 为触发消息 ID

**约束**：
- 异步执行，不阻塞 agent 响应
- 单独 session key `system:distill:room-{roomId}` 避免污染 agent 对话
- 可通过 room 或 project 级配置开关 `auto_distill_enabled`
- LLM 提炼 prompt 明确指示仅提取新信息、不重复已有记忆

#### A2. 任务级深度提炼

**触发时机**：`rememberAcceptedTask` 中扩展

**逻辑**：
1. 在现有 `upsertTaskSummary` 之后，读取该 task 关联的所有消息
2. 调用 LLM 深度总结，除了 `task_summary` 外，额外提取 `decision`/`lesson`/`fact` 类型条目
3. 写入 `memory_entries`，scope 使用 `task` 或提升为 `project`（由 LLM 判断适用范围）
4. `source_type` 为 `'workflow'`，`source_id` 为 workflow run ID

### Part B: 跨聊天室记忆共享

#### B1. 跨聊天室检索 API

新增 REST 端点：

```
GET /projects/:projectId/memories/search
  ?query=<关键词>
  &roomId=<可选，限定来源房间>
  &scope=<可选，project|room|task>
  &limit=20
```

**后端实现**：
1. `memoryRepo.search()` 方法，基于 SQLite `LIKE` 对 title+content 做关键词匹配（简单方案）
2. 支持按 `room_id`、`scope` 过滤
3. 返回结果附带 `room_name`（JOIN rooms 表），让前端知道记忆来源

#### B2. project 级记忆自动提升

**在 A1/A2 提炼过程中**：
- LLM prompt 要求对每条候选记忆判断适用范围
- 若 LLM 判断为"项目通用"（如架构决策、技术选型），自动写入 `scope = 'project'`
- project 级记忆已被 `listForRoomContext` 自动注入所有聊天室

#### B3. 前端跨聊天室记忆面板

1. MemoryPanel 增加"项目记忆"tab，展示所有 `scope = 'project'` 的记忆
2. 增加搜索框，调用 B1 的搜索 API，展示来自其他聊天室的记忆
3. 搜索结果标注来源聊天室名称
4. 允许用户将其他聊天室的 room 级记忆"提升"为 project 级

---

## 涉及文件

| 文件 | 改动 |
|------|------|
| `packages/backend/src/memory/distill.ts` | **新建**：LLM 提炼逻辑、prompt 模板、候选解析 |
| `packages/backend/src/dispatcher.ts` | A1：run 完成后异步触发 `distillFromConversation` |
| `packages/backend/src/workflows/orchestrator.ts` | A2：`rememberAcceptedTask` 中调用深度提炼 |
| `packages/backend/src/repos/memory.ts` | B1：新增 `search()` 方法 |
| `packages/backend/src/routes.ts` | B1：新增 `/projects/:projectId/memories/search` |
| `packages/backend/src/db.ts` | 可选：`settings` 表增加 `auto_distill_enabled` |
| `packages/frontend/src/lib/api.ts` | B3：新增 `searchMemories` API |
| `packages/frontend/src/components/MemoryPanel.tsx` | B3：搜索 + 项目记忆 tab + 来源标注 |
| `packages/frontend/src/lib/i18n.tsx` | 新增 i18n 键 |

## 风险与限制

- **LLM 调用成本**：回复级提炼会增加 API 调用，需要开关控制
- **提炼质量**：LLM 可能提取低质量或重复记忆，需要去重 + 人工审核（已有 archive 机制）
- **OpenClaw Gateway 可用性**：提炼依赖 gateway 连接，需 fallback 容错
- **SQLite LIKE 搜索性能**：数据量大时可能需要 FTS5 全文搜索，初期 LIKE 够用
