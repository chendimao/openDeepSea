# 知识库 Phase 4B 真实 Embedding 验收

- 日期：2026-06-09
- 范围：真实 embedding provider、批量重建、搜索 provider metadata、前端索引状态、系统设置入口
- 设计依据：`docs/superpowers/specs/2026-06-09-知识库Phase4B真实Embedding设计.md`
- 实施计划：`docs/superpowers/plans/2026-06-09-知识库Phase4B真实Embedding实施计划.md`

## 验证命令

后端聚焦测试：

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-embedding.test.ts src/knowledge-embedding-provider.test.ts src/knowledge-embedding-rebuild.test.ts src/knowledge-search.test.ts src/knowledge-rag.test.ts src/knowledge-cli.test.ts src/knowledge.routes.test.ts src/settings.routes.test.ts src/repos/settings.test.ts
```

结果：90 个测试通过，0 失败。

前端聚焦测试：

```bash
cd packages/frontend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/lib/api.test.ts src/lib/knowledgeDisplay.test.ts src/pages/KnowledgePage.test.tsx src/components/SettingsDialogs.test.tsx
```

结果：42 个测试通过，0 失败。

构建：

```bash
npm run build
```

结果：后端 TypeScript 编译和前端 Vite build 通过。Vite 输出既有 chunk-size warning。

## 浏览器验收

- URL：`http://127.0.0.1:5174/knowledge`
- 后端：复用本机 `http://localhost:7330`
- 断言：选中项目 `fsMwh7D-unbi` 后，Embedding 索引状态显示 `1 / 1`、`Local hash · local-hash-v1`、`索引可用`；`测试 provider` 和 `重建索引` 按钮均可用。
- API 复核：`GET /api/knowledge/embedding/status?projectId=fsMwh7D-unbi` 返回 `embedded_chunks: 1`、`missing_chunks: 0`。
- Console：0 errors；仅 React DevTools 与 React Router future flag warnings。
- 截图：`output/playwright/knowledge-phase4b-embedding-5174.png`

- URL：`http://127.0.0.1:5174/settings`
- 断言：模型分类展示 `知识库 Embedding`、`Local hash`、`OpenAI-compatible`、`Embedding 模型`、`Base URL`、`API key 环境变量` 和 `保存 Embedding 设置`。
- Console：0 errors；仅 React DevTools 与 React Router future flag warnings。
- 截图：`output/playwright/settings-phase4b-embedding-5174.png`

## 代码审查

审查重点：

- API key 不通过知识库 API 泄露。
- 上游 provider 错误已脱敏。
- 未配置真实 provider 时 local-hash 兼容。
- rebuild 按 project/source 限界，不跨项目。
- search/Agent RAG usage metadata 包含 provider/model。

审查结论：未发现 Critical/Important 问题。审查中补强了系统设置 UI 对真实 provider 的安全提示：启用 OpenAI-compatible 后，重建和搜索会将 chunk 内容发送到配置的 embedding 服务。

## 结论

Phase 4B.1 通过验收：真实 embedding provider 配置、状态观测、重建索引、搜索/RAG metadata、系统设置入口和浏览器 smoke 均已覆盖。
