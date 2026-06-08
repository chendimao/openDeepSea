# 知识库 Phase 2 Agent RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 room agent 和 session agent 能通过只读 `openclaw:knowledge` 工具主动检索项目知识，并记录 citation/usage evidence。

**Architecture:** 新增后端 `knowledge-rag` 服务封装 search/read/list/summary、scope 校验、Focused/Full Context 和 usage ref 记录；新增 CLI `knowledge-cli.ts` 暴露 `npm run openclaw:knowledge`；在 room agent dispatcher 和 session runtime prompt 中注入工具说明，并把当前 run/session 环境变量传给 ACP adapter。

**Tech Stack:** TypeScript, Node.js CLI, SQLite/better-sqlite3, existing `knowledgeRepo`, node:test, ACP adapter env overrides.

---

## File Structure

- Create: `packages/backend/src/knowledge-rag.ts` - Agent RAG 服务、响应格式、scope 校验、citation 和 usage ref 记录。
- Create: `packages/backend/src/knowledge-rag.test.ts` - 覆盖 search/read/source-summary/list-sources、跨项目边界、usage refs。
- Create: `packages/backend/src/knowledge-cli.ts` - `openclaw:knowledge` CLI parser 和 JSON 输出。
- Create: `packages/backend/src/knowledge-cli.test.ts` - 覆盖 CLI 命令参数、错误输出和 usage env。
- Modify: `packages/backend/src/knowledge-types.ts` - 扩展 `KnowledgeUsageRefInput.ref_type`。
- Modify: `packages/backend/src/dispatcher.ts` - 注入 room agent 知识工具 prompt，传递 agent run env。
- Modify: `packages/backend/src/dispatcher.test.ts` - 覆盖 room agent prompt 和 env overrides。
- Modify: `packages/backend/src/session-message-dispatch.ts` - session prompt 增加知识工具说明。
- Modify: `packages/backend/src/session-runtime.ts` - adapter invoke 增加 knowledge env overrides。
- Modify: `packages/backend/src/session-message-dispatch.test.ts` / `packages/backend/src/session-runtime.test.ts` - 覆盖 session prompt 和 env。
- Modify: `package.json` / `packages/backend/package.json` - 增加 `openclaw:knowledge` scripts。
- Create: `docs/superpowers/verification/2026-06-08-知识库Phase2-Agent-RAG验收.md` - 验证记录。

## Task 1: Knowledge RAG Service Tests

**Files:**
- Create: `packages/backend/src/knowledge-rag.test.ts`
- Read: `packages/backend/src/knowledge.routes.test.ts`
- Read: `packages/backend/src/repos/knowledge.test.ts`

- [x] **Step 1: Write failing tests for search/list/read/summary**

Create `knowledge-rag.test.ts` with an isolated DB. Test cases:

1. `searchKnowledgeForAgent` returns focused chunks with citation keys and records `agent_run` usage refs.
2. `readKnowledgeChunkForAgent` rejects chunks outside the project scope.
3. `readKnowledgeSourceSummaryForAgent` returns full context only for short extraction and downgrades long extraction to summary with warning.
4. `listKnowledgeSourcesForAgent` returns safe fields and no `storage_path`.

- [x] **Step 2: Run RED**

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-rag.test.ts
```

Expected: fail because `knowledge-rag.ts` does not exist.

- [x] **Step 3: Implement `knowledge-rag.ts`**

Implement exported functions:

```ts
searchKnowledgeForAgent(input)
readKnowledgeChunkForAgent(input)
readKnowledgeSourceSummaryForAgent(input)
listKnowledgeSourcesForAgent(input)
buildKnowledgeAgentToolPrompt(input)
```

Each result includes `source`, `scope`, `generated_at`, `retrieval_mode`, `results`, `citations`, `warnings`.

- [x] **Step 4: Run GREEN**

Run the same command. Expected: pass.

## Task 2: Knowledge CLI

**Files:**
- Create: `packages/backend/src/knowledge-cli.ts`
- Create: `packages/backend/src/knowledge-cli.test.ts`
- Modify: `package.json`
- Modify: `packages/backend/package.json`

- [x] **Step 1: Write failing CLI tests**

Cover:

- `search --project p --query q --limit 3`
- `read-chunk --project p --chunk c`
- `source-summary --project p --source s --mode auto`
- unknown command returns error

- [x] **Step 2: Run RED**

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-cli.test.ts
```

Expected: fail because `knowledge-cli.ts` does not exist.

- [x] **Step 3: Implement CLI and scripts**

Add root script:

```json
"openclaw:knowledge": "npm run openclaw:knowledge -w @openclaw-room/backend --"
```

Add backend script:

```json
"openclaw:knowledge": "node --import tsx src/knowledge-cli.ts"
```

- [x] **Step 4: Run GREEN and smoke command**

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-cli.test.ts
cd ../..
npm run openclaw:knowledge -- help
```

Expected: tests pass; help prints command list.

## Task 3: Room Agent Prompt and Env

**Files:**
- Modify: `packages/backend/src/dispatcher.ts`
- Modify: `packages/backend/src/dispatcher.test.ts`

- [x] **Step 1: Write failing dispatcher tests**

Add tests that:

- capture ACP prompt for a normal room agent run and assert it includes `npm run openclaw:knowledge -- search --project <projectId>`, `--room <roomId>`, and citation instructions.
- capture adapter `envOverrides` and assert `OPENDEEPSEA_AGENT_RUN_ID`, `OPENDEEPSEA_PROJECT_ID`, `OPENDEEPSEA_ROOM_ID`, `OPENDEEPSEA_KNOWLEDGE_REF_TYPE=agent_run`.

- [x] **Step 2: Run RED**

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/dispatcher.test.ts
```

Expected: new assertions fail.

- [x] **Step 3: Implement prompt/env injection**

Use `buildKnowledgeAgentToolPrompt` in `respondAsAgent` when room/project are available and not internal. Merge knowledge env with existing Superpowers env.

- [x] **Step 4: Run GREEN**

Run the same command. Expected: pass.

## Task 4: Session Agent Prompt and Env

**Files:**
- Modify: `packages/backend/src/session-message-dispatch.ts`
- Modify: `packages/backend/src/session-runtime.ts`
- Modify: `packages/backend/src/session-message-dispatch.test.ts`
- Modify: `packages/backend/src/session-runtime.test.ts`

- [x] **Step 1: Write failing session tests**

Add tests that:

- dispatching a session message injects `openclaw:knowledge` prompt with current project id.
- `runSessionAgent` passes `OPENDEEPSEA_SESSION_RUN_ID`, `OPENDEEPSEA_SESSION_ID`, `OPENDEEPSEA_PROJECT_ID`, `OPENDEEPSEA_KNOWLEDGE_REF_TYPE=session_run` to adapter `envOverrides`.

- [x] **Step 2: Run RED**

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/session-message-dispatch.test.ts src/session-runtime.test.ts
```

Expected: new assertions fail.

- [x] **Step 3: Implement session prompt/env**

Inject `buildKnowledgeAgentToolPrompt({ projectId })` into runtime prompt and pass env overrides from `runSessionAgent`.

- [x] **Step 4: Run GREEN**

Run the same command. Expected: pass.

## Task 5: Verification, Review, Commit

**Files:**
- Create: `docs/superpowers/verification/2026-06-08-知识库Phase2-Agent-RAG验收.md`
- Modify: `docs/superpowers/plans/2026-06-08-知识库Phase2-Agent-RAG实施计划.md`

- [x] **Step 1: Run backend focused tests**

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-rag.test.ts src/knowledge-cli.test.ts src/knowledge.routes.test.ts src/session-file-reference-context.test.ts src/session-message-dispatch.test.ts src/session-runtime.test.ts src/dispatcher.test.ts
```

- [x] **Step 2: Run full build**

```bash
npm run build
```

- [x] **Step 3: Write verification note**

Record exact commands, pass/fail output, code review notes, and residual risks.

- [x] **Step 4: Code review**

Review against `docs/superpowers/specs/2026-06-08-知识库Phase2-Agent-RAG设计.md`, focusing on scope safety, no raw DB/file exposure, citation correctness, usage refs, prompt injection, and test coverage.

- [x] **Step 5: Commit**

Commit only Phase 2 files:

```bash
git add docs/superpowers/specs/2026-06-08-知识库Phase2-Agent-RAG设计.md docs/superpowers/plans/2026-06-08-知识库Phase2-Agent-RAG实施计划.md docs/superpowers/verification/2026-06-08-知识库Phase2-Agent-RAG验收.md packages/backend/src/knowledge-rag.ts packages/backend/src/knowledge-rag.test.ts packages/backend/src/knowledge-cli.ts packages/backend/src/knowledge-cli.test.ts packages/backend/src/knowledge-types.ts packages/backend/src/dispatcher.ts packages/backend/src/dispatcher.test.ts packages/backend/src/session-message-dispatch.ts packages/backend/src/session-message-dispatch.test.ts packages/backend/src/session-runtime.ts packages/backend/src/session-runtime.test.ts package.json packages/backend/package.json
git commit -m "feat: 接入知识库Agent RAG工具"
```

## 实际执行记录

- 2026-06-08：完成 `knowledge-rag.ts` 和 `knowledge-cli.ts`，提供 search/read-chunk/source-summary/list-sources 四类只读命令，返回 citation key，并通过 env 写入 `knowledge_usage_refs`。
- 2026-06-08：完成 room agent prompt/env 接入；普通 room ACP 运行会看到 `OpenDeepSea 知识库工具`，并带上 `OPENDEEPSEA_AGENT_RUN_ID`、project、room、agent 等 usage env。
- 2026-06-08：完成 session agent prompt/env 接入；Session runtime prompt 注入项目级知识库命令，并带上 `OPENDEEPSEA_SESSION_RUN_ID`、session、project、agent 等 usage env。
- 2026-06-08：同步修正 `session-message-dispatch.test.ts` 中上传文本文件上下文断言，使其与 `session-file-reference-context.test.ts` 的现有契约一致：上传文本内容会注入，图片通过 `imagePaths` 传递。
- 2026-06-08：聚焦测试通过 `139/139`，`npm run build` 通过；验收记录见 `docs/superpowers/verification/2026-06-08-知识库Phase2-Agent-RAG验收.md`。
