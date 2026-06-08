# 三种 CLI Resume Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 ACP 协议端不能 resume 已保存 session 时，Codex、Claude Code、OpenCode 都回退到各自 CLI resume，而不是静默创建新 ACP session。

**Architecture:** `invokeProtocolSession` 继续负责 ACP 协议调用，并在“存在旧 sessionId 但 provider capability 不支持 resume”时，在发送 prompt 前返回可安全 fallback 的结果。三个 adapter 读取这个标记后走既有 CLI resume 参数映射；协议已经产生副作用或协议强制模式时仍不 fallback。fake resume 留作后续上下文注入增强，本计划只确保真实 CLI resume 优先发生。

**Tech Stack:** Node.js、TypeScript、ACP SDK、node:test。

---

### Task 1: 标记 ACP Resume 不可用

**Files:**
- Modify: `packages/backend/src/acp/types.ts`
- Modify: `packages/backend/src/acp/protocol-client.ts`
- Test: `packages/backend/src/acp/protocol-client.test.ts`

- [x] **Step 1: Write failing test**

在 `protocol-client.test.ts` 中断言：当传入旧 `sessionId` 但 fake ACP 不声明 resume 时，返回值包含 `resumeUnavailable: true`、`fallbackSafe: true`。

- [x] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test packages/backend/src/acp/protocol-client.test.ts`
Expected: FAIL，因为 `resumeUnavailable` 尚未定义。

- [x] **Step 3: Implement minimal code**

在 `AcpInvokeResult` 增加 `resumeUnavailable?: boolean`。在 `invokeProtocolSession` 中，当 `args.sessionId` 存在且 capability 不支持 resume，在发送 prompt 前关闭协议子进程并返回 `resumeUnavailable: true`、`fallbackSafe: true`。

- [x] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test packages/backend/src/acp/protocol-client.test.ts`
Expected: PASS。

### Task 2: 三个 Adapter 回退 CLI Resume

**Files:**
- Modify: `packages/backend/src/acp/codex.ts`
- Modify: `packages/backend/src/acp/claudecode.ts`
- Modify: `packages/backend/src/acp/opencode.ts`
- Test: `packages/backend/src/acp/codex.test.ts`
- Test: `packages/backend/src/acp/claudecode.test.ts`
- Test: `packages/backend/src/acp/opencode.test.ts`

- [x] **Step 1: Write failing tests**

分别测试三种 adapter：`OPENCLAW_ACP_MODE=auto`、fake ACP 不支持 resume、传入旧 `sessionId` 时，adapter 应发出 `protocol_fallback` activity 并走 CLI resume 参数。测试通过替换 CLI command 为当前 Node 测试 helper，验证 argv 中包含：

- Codex: `resume <sessionId>`
- Claude Code: `--resume <sessionId>`
- OpenCode: `--session <sessionId>`

- [x] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test packages/backend/src/acp/codex.test.ts packages/backend/src/acp/claudecode.test.ts packages/backend/src/acp/opencode.test.ts`
Expected: FAIL，因为 adapter 目前把 protocol 成功结果直接返回。

- [x] **Step 3: Implement minimal code**

将三个 adapter 的协议结果判断改为：`exitCode === 0` 但 `resumeUnavailable === true` 且 `mode === auto` 时，允许 `emitProtocolFallback` 并进入既有 CLI resume 路径；`mode === protocol` 仍返回协议结果。

- [x] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test packages/backend/src/acp/codex.test.ts packages/backend/src/acp/claudecode.test.ts packages/backend/src/acp/opencode.test.ts`
Expected: PASS。

### Task 3: 验证和提交

**Files:**
- Verify only.

- [x] **Step 1: Run backend ACP tests**

Run: `node --import tsx --test packages/backend/src/acp/protocol-client.test.ts packages/backend/src/acp/codex.test.ts packages/backend/src/acp/claudecode.test.ts packages/backend/src/acp/opencode.test.ts`
Expected: PASS。

- [x] **Step 2: Run build**

Run: `npm run build`
Expected: PASS；若只有 Vite chunk size warning，可记录为非阻塞。

- [x] **Step 3: Review diff**

Run: `git diff -- packages/backend/src/acp docs/superpowers/plans/2026-06-07-三种-cli-resume-policy.md`
Expected: 只包含 resume policy、测试和计划文档改动。

- [x] **Step 4: Commit**

Run:
```bash
git add docs/superpowers/plans/2026-06-07-三种-cli-resume-policy.md packages/backend/src/acp
git commit -m "fix(backend): 支持三种 CLI 恢复会话"
```
