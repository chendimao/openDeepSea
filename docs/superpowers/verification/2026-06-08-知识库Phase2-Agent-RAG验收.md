# 知识库 Phase 2 Agent RAG 验收记录

- 日期：2026-06-08
- 范围：Agent RAG 最小闭环，包含只读知识库 CLI、citation、usage refs、room agent prompt/env、session agent prompt/env。
- 设计依据：`docs/superpowers/specs/2026-06-08-知识库Phase2-Agent-RAG设计.md`
- 实施计划：`docs/superpowers/plans/2026-06-08-知识库Phase2-Agent-RAG实施计划.md`

## 验收结果

- 通过：`openclaw:knowledge` 暴露 search、read-chunk、source-summary、list-sources。
- 通过：搜索和读取结果包含 `knowledge:<sourceId>` / `knowledge:<sourceId>#chunk:<chunkId>` citation key。
- 通过：跨项目 chunk/source 读取被拒绝，不返回 `storage_path` 或本机路径。
- 通过：room agent 普通 ACP prompt 注入当前 project/room 的知识库命令和 citation 规则。
- 通过：session agent runtime prompt 注入当前 project 的知识库命令和 citation 规则。
- 通过：room agent 和 session agent adapter invoke 均传递 usage env，可由 CLI 写入 `knowledge_usage_refs`。

## RED / GREEN 记录

1. `src/knowledge-rag.test.ts`
   - RED：`knowledge-rag.ts` 不存在。
   - GREEN：4/4 通过。
2. `src/knowledge-cli.test.ts`
   - RED：`knowledge-cli.ts` 不存在。
   - GREEN：4/4 通过。
3. `src/dispatcher.test.ts`
   - RED：2 个新增断言失败，分别为缺少 `OpenDeepSea 知识库工具` prompt 和 `OPENDEEPSEA_AGENT_RUN_ID` env。
   - GREEN：90/90 通过。
4. `src/session-message-dispatch.test.ts` / `src/session-runtime.test.ts`
   - RED：新增 session prompt/env 断言失败；同时发现旧上传文本上下文断言与现有契约不一致。
   - GREEN：34/34 通过，旧断言已同步为上传文本内容注入。

## 最终验证

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-rag.test.ts src/knowledge-cli.test.ts src/knowledge.routes.test.ts src/session-file-reference-context.test.ts src/session-message-dispatch.test.ts src/session-runtime.test.ts src/dispatcher.test.ts
```

结果：`139/139` 通过，退出码 0。

```bash
npm run build
```

结果：后端 `tsc -p tsconfig.json` 通过，前端 `tsc -b && vite build` 通过，退出码 0。Vite 输出仍包含既有 chunk size warning。

## 代码审查

- Scope safety：`readKnowledgeChunkForAgent` 通过 chunk 的 source 再校验 `source.project_id`，避免跨项目读取；`source-summary` 和 `list-sources` 均按 project/room scope 查询。
- 数据泄露：Agent RAG 返回对象不暴露 `storage_path`、SQLite 路径、上传目录或原始文件系统路径；测试覆盖 metadata 中的本机路径不出现在 JSON。
- Citation：search、read-chunk、source-summary、list-sources 均返回 citation key；prompt 明确要求回答引用工具返回的 citation key。
- Usage refs：CLI 根据 `OPENDEEPSEA_AGENT_RUN_ID` / `OPENDEEPSEA_SESSION_RUN_ID` 区分 `agent_run` 和 `session_run`；room/session runtime 均传入 project、room/session、agent metadata。
- Prompt 注入：room agent 沿用现有 `openclaw:context` 的普通 room chat 注入条件；session prompt 每轮注入 project 级知识库工具说明。
- 测试覆盖：覆盖工具返回、跨项目边界、full context 降级、CLI 参数、usage env、room prompt/env、session prompt/env 和现有知识库路由。

## 剩余风险

- 本阶段按设计不引入 embedding、向量库、rerank 或自动预检索，检索质量取决于现有 FTS 和 Agent 是否主动调用 CLI。
- room agent 的知识库 prompt 当前不注入 task/workflow/internal run；若后续要让任务执行 Agent 默认 RAG，需要在独立变更中放宽注入条件并补任务态测试。
- session evidence 依赖 ACP provider 对 shell/tool 调用的事件上报；即使 provider 不上报，`knowledge_usage_refs` 仍会记录实际 CLI 检索引用。
