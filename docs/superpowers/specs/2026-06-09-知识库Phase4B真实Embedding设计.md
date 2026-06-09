# 知识库 Phase 4B 真实 Embedding 设计

- 日期：2026-06-09
- 前置设计：`docs/superpowers/specs/2026-06-09-知识库后续能力Phase4A设计.md`
- 前置验收：`docs/superpowers/verification/2026-06-09-知识库Phase4A后续能力验收.md`
- 范围：Phase 4B.1，真实 embedding provider、批量重建索引、检索 provider 可观测、前端最小运维入口

## 1. 背景

Phase 4A 已完成 `KnowledgeEmbeddingProvider` 接口、本地 `local-hash-v1` provider、`knowledge_chunk_embeddings` 存储、`vector_preview` 和 `hybrid` 搜索骨架。这个闭环证明了索引、搜索、ranking、Agent RAG citation 和 UI 能跑通，但 `local-hash-v1` 不是语义 embedding，只能作为本地确定性基线。

Phase 4B.1 的目标是把这个骨架接到真实 OpenAI-compatible embedding provider，并让用户能安全地配置、测试、重建和观察索引状态。它仍然保持本地 SQLite 存储，不引入外部 vector DB，避免把 provider 接入、索引运维和存储架构迁移混在同一阶段。

## 2. 目标

1. 支持 `local-hash` 和 `openai-compatible` 两类 embedding provider。
2. 允许系统级配置当前知识库 embedding provider、model、base URL、API key env var 和 dimensions。
3. 默认继续使用 `local-hash`，保证未配置真实 provider 时现有功能不回退。
4. 支持按 project/source 批量重建 embeddings，并跳过内容 hash 未变化的 chunk。
5. `vector_preview` 和 `hybrid` 搜索使用当前有效 provider，不再在搜索服务中硬编码 `local-hash`。
6. Agent RAG usage metadata 记录 retrieval mode、provider、model 和 fallback 信息。
7. `/knowledge` 页面提供最小运维入口：当前 provider、索引覆盖率、过期数量、测试 provider、重建索引。

## 3. 非目标

1. 不接入外部 vector database。
2. 不实现 GraphRAG、实体图谱或自动 `retrieval_context` 注入。
3. 不实现 Docling、Unstructured、OCR、PDF layout 或 Office 解析 sidecar。
4. 不把真实 provider 配置做成多租户密钥管理系统；本阶段只复用系统设置和环境变量。
5. 不自动把所有历史数据迁移到真实 provider；用户或 API 触发重建。
6. 不在前端暴露 API key 明文。

## 4. 方案选择

### 方案 A：复用系统 AI config，新增知识库 embedding 轻量配置

系统已有 AI config 能保存 OpenAI-compatible base URL 和 API key。Phase 4B.1 复用它作为默认 credential source，同时新增知识库专用字段：

- `knowledge_embedding_provider`: `local-hash` 或 `openai-compatible`
- `knowledge_embedding_model`: 默认真实模型名
- `knowledge_embedding_dimensions`: 可选，未填写时由 provider 响应推断

优点是改动小、用户不用维护两套密钥；缺点是 planner model 和 embedding model 仍需分开配置。

### 方案 B：新增独立 embedding profile 表

新增 `knowledge_embedding_profiles`，完整管理多个 embedding profile。

优点是边界最清晰；缺点是 Phase 4B.1 会引入更多 CRUD、UI 和迁移成本，超出最小闭环。

### 方案 C：只读环境变量配置

只支持 `OPENDEEPSEA_KNOWLEDGE_EMBEDDING_*` 环境变量。

优点是实现最快；缺点是桌面和本地长期使用不友好，也无法在 UI 内测试和切换。

本阶段采用方案 A。方案 B 可以作为 Phase 4B.2，当需要多个 embedding profile 或外部 vector store 时再做。

## 5. 数据模型

### 5.1 settings 新增字段

在 `settings` 表增加系统级字段：

```sql
knowledge_embedding_provider TEXT
  CHECK (knowledge_embedding_provider IN ('local-hash', 'openai-compatible')),
knowledge_embedding_model TEXT,
knowledge_embedding_dimensions INTEGER,
knowledge_embedding_api_key_env_var TEXT,
knowledge_embedding_base_url TEXT
```

字段解析规则：

1. `knowledge_embedding_provider` 为空时视为 `local-hash`。
2. `knowledge_embedding_base_url` 为空时使用 active AI config 的 `openai_base_url`；仍为空则真实 provider 不可用。
3. `knowledge_embedding_api_key_env_var` 为空时使用 active AI config 的 API key；设置后从环境变量读取。
4. `knowledge_embedding_model` 对 `openai-compatible` 必填；对 `local-hash` 忽略并展示 `local-hash-v1`。
5. `knowledge_embedding_dimensions` 只作为期望维度和 UI 展示；实际写入以 provider 返回向量长度为准，除非配置了强制维度。

### 5.2 knowledge_chunk_embeddings 继续复用

现有表已包含 `provider`、`model`、`dimensions`、`vector_json` 和 `content_hash`，可以直接支持多 provider 数据。Phase 4B.1 不删除旧 provider 的 rows。搜索默认只读当前 provider/model 的 rows；重建当前 provider 时 upsert 同一 `chunk_id` 的 row。

当前表对 `chunk_id` 是唯一约束，因此一个 chunk 只能保留一份 embedding。这个限制符合 Phase 4B.1 的“当前 provider 单活”模型。Phase 4B.2 若要并行评测多个 provider，需要把唯一约束调整为 `(chunk_id, provider, model)`。

## 6. 后端设计

### 6.1 Provider 类型

扩展现有 `KnowledgeEmbeddingProvider`：

```ts
export interface KnowledgeEmbeddingProvider {
  id: string;
  model: string;
  dimensions: number | null;
  embed(text: string, options?: { signal?: AbortSignal }): Promise<number[]> | number[];
}
```

新增运行时配置：

```ts
export type KnowledgeEmbeddingProviderId = 'local-hash' | 'openai-compatible';

export interface KnowledgeEmbeddingRuntimeConfig {
  provider: KnowledgeEmbeddingProviderId;
  model: string;
  dimensions: number | null;
  baseUrl: string | null;
  apiKeySet: boolean;
  apiKeyEnvVar: string | null;
  source: 'settings' | 'active_ai_config' | 'default';
}
```

`local-hash` 继续同步返回向量。`openai-compatible` 使用 `POST /embeddings`，请求体：

```json
{
  "model": "text-embedding-3-small",
  "input": "chunk text"
}
```

响应读取 `data[0].embedding`，必须是 number array。错误信息必须脱敏，不能泄露 API key、Authorization header 或完整上游响应中的敏感内容。

### 6.2 Provider registry

新增 `knowledge-embedding-provider.ts`，负责：

1. 从 settings 解析当前有效 runtime config。
2. 构造 provider 实例。
3. 提供 `testKnowledgeEmbeddingProvider()`，用短文本请求一次 embedding。
4. 提供 `describeKnowledgeEmbeddingRuntime()`，返回安全摘要给 API/UI。

搜索服务和重建服务只依赖 registry，不直接读取 settings。

### 6.3 重建服务

新增 `knowledge-embedding-rebuild.ts`：

```ts
export interface KnowledgeEmbeddingRebuildResult {
  project_id: string;
  source_id?: string;
  provider: string;
  model: string;
  scanned_chunks: number;
  rebuilt_chunks: number;
  skipped_chunks: number;
  failed_chunks: Array<{ chunk_id: string; source_id: string; error: string }>;
}
```

重建规则：

1. 只处理 `ready` source 和 enabled chunk。
2. 按 project/source 过滤。
3. 读取现有 embedding，若 provider/model/dimensions/content_hash 均匹配则跳过。
4. 单个 chunk 失败不终止整批，记录 `failed_chunks`。
5. 每批最多处理 500 个 chunk，API 默认 limit 100，避免一次请求拖垮本地服务。
6. 返回统计，不默认后台异步队列。Phase 4B.2 再做长任务队列和进度推送。

### 6.4 Search 接入

`knowledge-search.ts` 改为异步或新增异步入口。为降低改动面，Phase 4B.1 推荐新增：

```ts
export async function searchKnowledgeAsync(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]>
```

同步 `searchKnowledge()` 保留给 legacy tests 和 local-hash 快速路径。API、CLI 和 Agent RAG 改用 async 入口。`vector_preview` 和 `hybrid` 会读取当前 provider/model 的 embedding rows；如果当前 provider 是 `openai-compatible` 且 query embedding 失败：

- API search 返回 400 或 503，并包含脱敏错误。
- Agent RAG search 返回 warning 并可降级 keyword，usage metadata 标记 `embedding_fallback: "keyword"`。
- 页面显示错误 toast，不伪造 vector score。

### 6.5 API

新增后端 API：

```http
GET /api/knowledge/embedding/status?projectId=...
POST /api/knowledge/embedding/test
POST /api/knowledge/embedding/rebuild
PATCH /api/settings/system/knowledge-embedding
```

`status` 返回：

```ts
interface KnowledgeEmbeddingStatus {
  runtime: KnowledgeEmbeddingRuntimeConfig;
  project_id?: string;
  total_enabled_chunks: number;
  embedded_chunks: number;
  stale_chunks: number;
  missing_chunks: number;
  failed_sources: number;
}
```

`PATCH` 只允许安全字段，不接受 API key 明文。真实密钥继续通过 active AI config 或环境变量获得。

### 6.6 CLI 和 Agent RAG

`openclaw:knowledge search --mode hybrid` 输出中新增：

```json
{
  "retrieval_mode": "hybrid",
  "embedding_provider": "openai-compatible",
  "embedding_model": "text-embedding-3-small"
}
```

usage refs metadata 同步记录这些字段，便于后续追踪 RAG 质量。

## 7. 前端设计

`/knowledge` 页面新增一个轻量“索引状态”入口，放在现有操作栏或治理提示附近，不新增独立页面。

展示内容：

1. 当前 provider：`local-hash-v1` 或真实 provider/model。
2. 索引覆盖：`embedded_chunks / total_enabled_chunks`。
3. stale/missing 数量。
4. “测试 provider”按钮。
5. “重建当前项目索引”按钮。

交互规则：

1. 未选项目时只显示全局 provider 状态，不允许重建。
2. provider 不可用时显示 warning，并提示去系统设置配置 active AI config 或环境变量。
3. 重建成功显示 rebuilt/skipped/failed 统计。
4. failed chunks 只展示 chunk/source id 和脱敏错误，不展示原文内容。

系统设置可增加最小字段：

- provider 下拉：`local-hash`、`openai-compatible`
- embedding model 输入
- base URL 输入，可为空表示复用 active AI config
- API key env var 输入，可为空表示复用 active AI config
- dimensions 数字输入，可为空表示自动推断

## 8. 安全与隐私

1. API key 不通过知识库 API 返回。
2. 上游 provider 错误统一脱敏。
3. 不把 chunk 原文写入 logs。
4. `test` 接口使用固定短文本，不发送用户知识内容。
5. 重建接口需要 projectId/sourceId 校验，不支持跨项目批量全库重建。
6. 真实 provider 会把 chunk 内容发送到外部服务，UI 和 spec 必须明确提示。

## 9. 测试策略

### 后端

1. provider registry：默认 local-hash、active AI config fallback、env var override、缺失配置错误。
2. OpenAI-compatible provider：请求体、响应解析、维度推断、错误脱敏。
3. rebuild：跳过 unchanged chunk、重建 stale chunk、记录 failed chunk、project/source scope。
4. search async：当前 provider rows 查询、query embedding 失败路径、hybrid fallback。
5. routes：status/test/rebuild/patch schema 和安全响应。
6. Agent RAG：usage metadata 包含 provider/model/fallback。

### 前端

1. API helper 构造正确 endpoint 和 payload。
2. display helper 显示 provider、coverage、stale/missing。
3. KnowledgePage wire test 覆盖 status、test、rebuild 调用和 toast 分支。
4. build 验证 TypeScript 和 Vite 打包。

## 10. 验收标准

1. 未配置真实 provider 时，现有 keyword/vector_preview/hybrid 搜索仍可用，默认 `local-hash-v1`。
2. 配置 `openai-compatible` provider 后，`POST /api/knowledge/embedding/test` 能返回安全摘要和维度。
3. `POST /api/knowledge/embedding/rebuild` 能按 project 重建 embeddings，并返回 scanned/rebuilt/skipped/failed。
4. `GET /api/knowledge/search?mode=hybrid` 使用当前 provider 的 query embedding 和 chunk embeddings。
5. Agent RAG usage metadata 记录 retrieval mode、provider 和 model。
6. `/knowledge` 页面能展示索引覆盖率，并触发测试和重建。
7. provider 错误不会泄露 API key 或 Authorization header。
8. 后端聚焦测试、前端聚焦测试和 `npm run build` 通过。

## 11. 后续分期

- Phase 4B.2：支持多个 embedding profile 并行评测，调整 embedding 唯一约束为 `(chunk_id, provider, model)`。
- Phase 4B.3：评估外部 vector store，新增 vector id 和同步状态。
- Phase 4C：Docling/Unstructured sidecar、OCR、PDF layout、Office 和表格结构化解析。
- Phase 4D：检索评测集、自动 `retrieval_context`、GraphRAG/实体图谱。
