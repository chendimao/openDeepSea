# 知识库 Phase 2 Agent RAG 设计

- 日期：2026-06-08
- 来源设计：`docs/superpowers/specs/2026-06-07-资源页升级知识库设计.md`
- 前置状态：Phase 1 已完成 `/knowledge` 真实数据、FTS 搜索、详情、chunks、显式引用和验收记录
- 实施范围：Phase 2 Agent RAG 的本地优先最小闭环

## 1. 目标

Phase 2 让 ACP 智能体能主动检索当前项目知识库，并在回答中携带可追溯 citation。

必须完成：

1. 给智能体暴露只读知识工具：搜索、读取 chunk、读取 source summary、列出项目 sources。
2. 默认 scope 绑定当前项目；room agent 额外绑定当前房间作为推荐过滤范围。
3. 工具返回结构化 JSON，包含 source、chunk、snippet、content、retrieval mode 和 citation key。
4. 工具调用写入 `knowledge_usage_refs`，能追踪 agent run 或 session run 使用了哪些 source/chunk。
5. Agent prompt 明确告诉智能体何时使用知识工具、如何引用 citation、不要读取数据库或任意文件路径。
6. 实现 Focused Retrieval / Full Context 的边界：搜索默认 Focused Retrieval；短 source 可读取 Full Context，长 source 返回摘要和 chunks 提示。
7. 不引入 embedding、向量库、rerank、GraphRAG 或跨项目知识共享。

## 2. 设计选择

推荐方案：沿用现有 `openclaw:context` 的命令式工具模式，新增 `openclaw:knowledge`。

原因：

- 当前 room agent 已通过 ACP shell/command 工具读取 `npm run openclaw:context` 输出，并能在同一轮回答中使用结果。
- Session runtime 的 XML tool bridge 当前是“回复结束后执行”，适合生成图片等副作用工具，不适合作为 RAG 检索结果再喂回模型。
- 命令式工具天然可审计：ACP timeline/session evidence 会记录 shell/tool 调用，`knowledge_usage_refs` 记录知识引用。
- 实现边界清晰，不需要依赖 provider 原生 tool calling 能力。

## 3. 工具命令

新增根脚本：

```bash
npm run openclaw:knowledge -- <command>
```

后端 workspace 脚本：

```bash
npm run openclaw:knowledge -w @openclaw-room/backend -- <command>
```

命令：

```bash
npm run openclaw:knowledge -- search --project <projectId> --query "<query>" [--room <roomId>] [--limit 5]
npm run openclaw:knowledge -- read-chunk --project <projectId> --chunk <chunkId>
npm run openclaw:knowledge -- source-summary --project <projectId> --source <sourceId> [--mode auto|full|summary]
npm run openclaw:knowledge -- list-sources --project <projectId> [--room <roomId>] [--limit 20]
```

安全约束：

- `--project` 必填，且所有 source/chunk 必须属于该 project。
- `--room` 只能过滤同项目 room。
- 不返回 `storage_path`、本机绝对路径、数据库路径或密钥。
- 不支持原始 SQL 和任意文件读取。
- 输出内容有字符上限，长内容必须带 `truncated: true`。

## 4. 返回结构

所有命令返回：

```ts
interface KnowledgeToolResponse<T> {
  source: string;
  scope: { project_id: string; room_id?: string };
  generated_at: number;
  retrieval_mode?: 'focused' | 'full_context' | 'summary';
  results: T;
  citations: Array<{
    key: string;
    source_id: string;
    chunk_id?: string | null;
    title: string;
    room_id?: string | null;
  }>;
  warnings?: string[];
}
```

Citation key 格式：

- source：`knowledge:<sourceId>`
- chunk：`knowledge:<sourceId>#chunk:<chunkId>`

## 5. Prompt 注入

Room agent prompt 增加“OpenDeepSea 知识库工具”说明：

- 当前 `projectId` 和 `roomId`。
- 推荐先用 `search`，再用 `read-chunk` 或 `source-summary` 读取需要引用的材料。
- 回答中引用工具返回的 citation key。
- 不要自行读取 SQLite、上传目录或本机绝对路径。

Session agent prompt 增加相同工具说明，但只绑定 `projectId`，不默认绑定 room。

## 6. Usage/Evidence

`knowledge_usage_refs` 扩展 `ref_type` 语义：

- `agent_run`：room agent 通过 `openclaw:knowledge` 检索。
- `session_run`：session agent 通过 `openclaw:knowledge` 检索。
- `retrieval_context`：后续自动 RAG 预检索预留。
- 保留 Phase 1 的 `manual_reference` 和 `session_message`。

工具命令通过环境变量识别调用方：

- `OPENDEEPSEA_AGENT_RUN_ID`
- `OPENDEEPSEA_SESSION_RUN_ID`
- `OPENDEEPSEA_SESSION_ID`
- `OPENDEEPSEA_ROOM_ID`
- `OPENDEEPSEA_PROJECT_ID`

若没有 run/session 环境变量，工具仍返回结果，但只写 metadata 警告，不记录 usage ref。

## 7. Focused / Full Context

第一版规则：

- `search` 固定为 `focused`，最多返回 TopK chunks，每个 chunk 内容截断到上限。
- `source-summary --mode summary` 返回 source 摘要、标签、chunk_count 和 latest extraction 信息。
- `source-summary --mode full` 仅当最新 extraction 内容低于上限时返回全文；超限时降级为 summary，并返回 `full_context_unavailable` warning。
- `source-summary --mode auto` 对短文档返回 full context，对长文档返回 summary。

## 8. 验收标准

1. `openclaw:knowledge search` 能搜索当前项目 ready/enabled chunks，并返回 citation。
2. 跨项目 source/chunk 读取被拒绝或返回 not found。
3. room agent prompt 包含 `openclaw:knowledge` 命令、当前 projectId/roomId 和 citation 规则。
4. session agent prompt 包含 `openclaw:knowledge` 命令和当前 projectId。
5. 执行 search/read/source-summary 时能写入 `knowledge_usage_refs`，记录 run id、source id、chunk id 和 retrieval metadata。
6. 全量构建通过；定向测试覆盖工具、prompt 注入、usage ref 和边界校验。
