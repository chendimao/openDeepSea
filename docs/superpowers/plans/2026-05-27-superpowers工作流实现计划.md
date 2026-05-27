# Superpowers 工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Superpowers 作为当前项目正式开发任务的 workflow runtime。

**Architecture:** 复用已有 LangGraph runtime 和 workflow definition，补齐阶段 prompt、证据解析和门禁状态更新。保持无 agent 环境兼容，有 agent 时派发真实 Superpowers 阶段。

**Tech Stack:** Node.js, TypeScript, LangGraph, Express, SQLite, node:test.

---

### Task 1: 阶段 Prompt 协议

**Files:**
- Modify: `packages/backend/src/workflows/prompts.ts`
- Test: `packages/backend/src/workflows/prompts.test.ts`

- [x] 为 Superpowers 阶段 prompt 增加完整 workflow 顺序。
- [x] 为各阶段列出 required skills。
- [x] 要求输出 `superpowers` JSON 证据块。

### Task 2: 证据解析

**Files:**
- Create: `packages/backend/src/workflows/graph/superpowers-evidence.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-evidence.test.ts`

- [x] 支持 fenced JSON、裸 JSON 和 `superpowers` 包装对象。
- [x] 解析 design doc、plan doc、worktree、TDD、review、verification 和 finish branch evidence。
- [x] 合并证据到 `AgentWorkflowState`。

### Task 3: Runtime 节点集成

**Files:**
- Modify: `packages/backend/src/workflows/graph/runtime.ts`
- Modify: `packages/backend/src/workflows/graph/superpowers-nodes.ts`
- Modify: `packages/backend/src/workflows/graph/nodes.ts`
- Test: `packages/backend/src/workflows/graph/superpowers-runtime.test.ts`

- [x] Superpowers planning 节点在有可执行 agent 时派发阶段 prompt。
- [x] execution prompt 追加 `tdd_execute` 阶段协议。
- [x] 从 agent 输出中解析证据并更新 graph_state。
- [x] 保持无可执行 agent 时的兼容 fallback。

### Task 4: 验证与提交

**Files:**
- Run: `npm run test -w @openclaw-room/backend`
- Run: `npm run build`

- [x] 运行后端测试。
- [x] 运行全量构建。
- [x] 审查 diff。
- [x] 只提交本次 Superpowers workflow 集成相关文件。
