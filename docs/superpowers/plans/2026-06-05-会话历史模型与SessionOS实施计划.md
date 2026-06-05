# 会话历史模型与 Session OS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 OpenClaw 从项目群聊和任务列表硬切换为项目级 Agent Session OS，直接引入 `sessions` / `history_records` 新模型，并用独立 Session UI 取代旧 room/task 主工作台。

**Architecture:** 后端新增 session domain、SQLite schema、repos、services、runtime、API 和 WebSocket 事件流；旧 `rooms/tasks` 不再作为主状态源。前端新增 `session-ui/` 与 `session-os.css`，路由默认进入三栏 Session Operations Console，并通过 API DTO 驱动 History、Active Session、Inspector、Compact、Resume 和 Fork。

**Tech Stack:** Node.js、Express、better-sqlite3、TypeScript、ACP adapters、React 18、React Query、Vite、lucide-react、CSS variables、node:test、`npm run build`。

---

## 执行原则

- 本计划按硬切换执行：新 workflow 不保留旧 `rooms/tasks` 工作流兼容路径。
- 每个 task 完成后提交一次 commit，最终任务再跑完整 `npm run build`。
- 后端共享 schema、types、runtime、route 总入口默认串行处理。
- 前端组件可在后端 API contract 稳定后并行开发，但 `packages/frontend/src/lib/types.ts`、`packages/frontend/src/lib/api.ts` 和 `packages/frontend/src/main.tsx` 由整合者串行修改。
- UI 必须遵守 spec 中 `frontend-design` 与 `ui-ux-pro-max` 决策：Session Operations Console、独立 `session-os.css`、`session-` class 前缀、第一屏三栏、44px touch target、无旧 `shell-*` / `chat-*` / `task-*` / `workspace-*` 视觉依赖。

## 目标文件结构

### 后端新增

- `packages/backend/src/session-types.ts`：后端 session DTO、命令、status snapshot、context manifest、evidence payload 类型。
- `packages/backend/src/session-command.ts`：slash command 解析和命令输入归一化。
- `packages/backend/src/session-summary.ts`：history summary、resume brief、compact preview 的确定性摘要工具。
- `packages/backend/src/session-context.ts`：context manifest 组装、token 估算、source inclusion reason。
- `packages/backend/src/session-status.ts`：`/status` snapshot 生成。
- `packages/backend/src/session-runtime.ts`：调用 ACP adapter、写入 `session_runs`、流式更新、evidence event。
- `packages/backend/src/session.routes.ts`：sessions/history API。
- `packages/backend/src/repos/sessions.ts`：`sessions`、`session_messages`、`session_runs`、`session_plan_items` repo。
- `packages/backend/src/repos/session-context.ts`：`session_context_manifests`、`session_context_sources` repo。
- `packages/backend/src/repos/session-compactions.ts`：`session_compactions` repo。
- `packages/backend/src/repos/session-evidence.ts`：`session_evidence_events` repo。
- `packages/backend/src/repos/session-checkpoints.ts`：`session_checkpoints` repo。
- `packages/backend/src/repos/history-records.ts`：`history_records` repo。
- `packages/backend/src/*.test.ts`：每个新模块对应 node:test。

### 后端修改

- `packages/backend/src/db.ts`：新增 session/history schema、indexes、必要 triggers。
- `packages/backend/src/types.ts`：导出后端公共 session 类型和 WS event 类型。
- `packages/backend/src/routes.ts`：挂载 `sessionRouter`，旧 room/task routes 保留为非主入口 API。
- `packages/backend/src/server.ts`：WebSocket subscribe 支持 `sessionId`。
- `packages/backend/src/ws-hub.ts`：增加 session channel，避免继续以 room 为唯一广播域。

### 前端新增

- `packages/frontend/src/session-ui/SessionShell.tsx`
- `packages/frontend/src/session-ui/SessionCommandBar.tsx`
- `packages/frontend/src/session-ui/HistoryRecordsRail.tsx`
- `packages/frontend/src/session-ui/ActiveSessionSurface.tsx`
- `packages/frontend/src/session-ui/ObjectiveContract.tsx`
- `packages/frontend/src/session-ui/SessionTranscript.tsx`
- `packages/frontend/src/session-ui/SessionComposer.tsx`
- `packages/frontend/src/session-ui/InspectorPanel.tsx`
- `packages/frontend/src/session-ui/StatusInspector.tsx`
- `packages/frontend/src/session-ui/ContextInspector.tsx`
- `packages/frontend/src/session-ui/EvidenceTimeline.tsx`
- `packages/frontend/src/session-ui/FilesInspector.tsx`
- `packages/frontend/src/session-ui/ProviderInspector.tsx`
- `packages/frontend/src/session-ui/CompactPreviewSurface.tsx`
- `packages/frontend/src/session-ui/ResumeBriefPanel.tsx`
- `packages/frontend/src/session-ui/ForkSessionDialog.tsx`
- `packages/frontend/src/session-ui/session-ui-model.ts`
- `packages/frontend/src/session-ui/session-os.css`
- `packages/frontend/src/pages/SessionWorkspacePage.tsx`

### 前端修改

- `packages/frontend/src/lib/types.ts`：前端 session DTO。
- `packages/frontend/src/lib/api.ts`：sessions/history API client。
- `packages/frontend/src/lib/ws.ts`：session subscribe 和 session event merge。
- `packages/frontend/src/main.tsx`：项目路由进入 `SessionWorkspacePage`。
- `packages/frontend/src/components/AppShell.tsx`：主导航和项目菜单避免旧群聊暗示。
- `packages/frontend/src/index.css`：只保留基础 reset/theme，不承载新 Session OS 视觉 token。

## 数据 Contract

### Session status union

```ts
export type SessionMode = 'ask' | 'plan' | 'code' | 'debug' | 'review';
export type SessionPhase =
  | 'idle'
  | 'brainstorming'
  | 'planning'
  | 'implementing'
  | 'debugging'
  | 'reviewing'
  | 'verifying'
  | 'blocked'
  | 'completed'
  | 'archived';
export type SessionStatus = 'active' | 'blocked' | 'completed' | 'archived' | 'failed';
export type SessionRunStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
```

### API response shape

```ts
export interface SessionWorkspacePayload {
  project: Project;
  activeSession: SessionDetail;
  historyRecords: HistoryRecord[];
  status: StatusSnapshot;
  context: SessionContextManifest | null;
  evidence: SessionEvidenceEvent[];
}
```

### WebSocket session events

```ts
export type SessionWsServerEvent =
  | { type: 'session:updated'; sessionId: string; session: Session }
  | { type: 'session_message:new'; sessionId: string; message: SessionMessage }
  | { type: 'session_run:created'; sessionId: string; run: SessionRun }
  | { type: 'session_run:updated'; sessionId: string; run: SessionRun }
  | { type: 'session_run:stream'; sessionId: string; runId: string; chunk: string; channel: 'answer' | 'thinking' | 'tool' | 'command' | 'event'; done: boolean }
  | { type: 'session_evidence:new'; sessionId: string; event: SessionEvidenceEvent }
  | { type: 'history_record:new'; projectId: string; record: HistoryRecord };
```

## Task 1: 新 session 类型与数据库 schema

**Files:**
- Create: `packages/backend/src/session-types.ts`
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/backend/src/db.ts`
- Test: `packages/backend/src/session-types.test.ts`
- Test: `packages/backend/src/repos/sessions.test.ts`

- [x] **Step 1: 新增后端 session 类型**

Create `packages/backend/src/session-types.ts` with:

```ts
import type { AcpBackend, AcpPermissionMode, Project } from './types.js';

export type SessionMode = 'ask' | 'plan' | 'code' | 'debug' | 'review';
export type SessionPhase =
  | 'idle'
  | 'brainstorming'
  | 'planning'
  | 'implementing'
  | 'debugging'
  | 'reviewing'
  | 'verifying'
  | 'blocked'
  | 'completed'
  | 'archived';
export type SessionStatus = 'active' | 'blocked' | 'completed' | 'archived' | 'failed';
export type SessionRunStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type SessionMessageRole = 'user' | 'assistant' | 'system';
export type SessionEvidenceType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'file_read'
  | 'file_diff'
  | 'test'
  | 'build'
  | 'browser_check'
  | 'review'
  | 'commit'
  | 'compact'
  | 'checkpoint'
  | 'blocker'
  | 'new'
  | 'resume'
  | 'fork'
  | 'status';
export type SessionEvidenceSeverity = 'info' | 'warning' | 'error' | 'critical';
export type SessionContextSourceType =
  | 'agents'
  | 'rtk'
  | 'compact'
  | 'history'
  | 'memory'
  | 'file'
  | 'diff'
  | 'user_message'
  | 'system'
  | 'tool_result';

export interface Session {
  id: string;
  project_id: string;
  title: string;
  current_goal: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  status: SessionStatus;
  provider: AcpBackend | null;
  model: string | null;
  workspace_path: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  forked_from_session_id: string | null;
  forked_from_history_record_id: string | null;
  latest_compaction_id: string | null;
  latest_context_manifest_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface SessionMessage {
  id: string;
  session_id: string;
  role: SessionMessageRole;
  sender_id: string;
  sender_name: string | null;
  content: string;
  message_type: 'text' | 'system' | 'agent_stream';
  status: 'queued' | 'streaming' | 'completed' | 'failed';
  metadata: string | null;
  created_at: number;
}

export interface SessionRun {
  id: string;
  session_id: string;
  provider: AcpBackend;
  model: string | null;
  status: SessionRunStatus;
  mode: SessionMode;
  phase: SessionPhase | null;
  prompt: string;
  stdout: string;
  stderr: string;
  activity_log: string;
  error: string | null;
  acp_session_id: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SessionPlanItem {
  id: string;
  session_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed' | 'skipped';
  priority: number;
  source: string | null;
  evidence_event_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SessionContextManifest {
  id: string;
  session_id: string;
  run_id: string | null;
  total_token_estimate: number;
  prompt_hash: string | null;
  created_at: number;
  sources: SessionContextSource[];
}

export interface SessionContextSource {
  id: string;
  manifest_id: string;
  session_id: string;
  source_type: SessionContextSourceType;
  source_ref: string | null;
  title: string;
  included: 0 | 1;
  priority: number;
  token_estimate: number;
  reason: string | null;
  content_hash: string | null;
  excerpt: string | null;
  metadata: string | null;
  created_at: number;
}

export interface SessionCompaction {
  id: string;
  session_id: string;
  strategy: 'manual' | 'focus' | 'aggressive' | 'conservative' | 'auto_suggested';
  focus_prompt: string | null;
  preview_summary: string;
  applied_summary: string | null;
  retained_refs: string;
  dropped_refs: string;
  risk_notes: string | null;
  user_edited: 0 | 1;
  status: 'previewed' | 'applied' | 'superseded' | 'discarded' | 'failed';
  created_at: number;
  applied_at: number | null;
}

export interface SessionEvidenceEvent {
  id: string;
  session_id: string;
  seq: number;
  event_type: SessionEvidenceType;
  severity: SessionEvidenceSeverity;
  source_run_id: string | null;
  source_message_id: string | null;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  created_at: number;
}

export interface SessionCheckpoint {
  id: string;
  session_id: string;
  title: string;
  description: string | null;
  git_head: string | null;
  branch_name: string | null;
  diff_summary: string | null;
  evidence_event_id: string | null;
  created_at: number;
}

export interface HistoryRecord {
  id: string;
  project_id: string;
  session_id: string;
  title: string;
  summary: string;
  status: 'completed' | 'blocked' | 'failed' | 'archived';
  mode: SessionMode;
  started_at: number;
  ended_at: number;
  key_decisions: string[];
  changed_files: string[];
  verification_summary: string | null;
  commit_refs: string[];
  resume_brief: string;
  compact_count: number;
  fork_count: number;
  created_at: number;
  updated_at: number;
}

export interface SessionDetail {
  session: Session;
  messages: SessionMessage[];
  runs: SessionRun[];
  planItems: SessionPlanItem[];
  compactions: SessionCompaction[];
  checkpoints: SessionCheckpoint[];
  evidence: SessionEvidenceEvent[];
}

export interface StatusSnapshot {
  goal: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  status: SessionStatus;
  context: {
    totalTokenEstimate: number;
    latestCompactionId: string | null;
    retainedRecentMessages: number;
    pressure: 'low' | 'medium' | 'high';
  };
  git: {
    branchName: string | null;
    changedFileCount: number;
    hasUncommittedDiff: boolean;
    conflictRisk: 'none' | 'low' | 'high';
  };
  verification: {
    lastCommand: string | null;
    status: 'passed' | 'failed' | 'unknown';
    completedAt: number | null;
  };
  blocker: {
    reason: string;
    since: number;
    requiredAction: string;
  } | null;
  nextAction: {
    label: string;
    command: string | null;
    reason: string;
  };
  provider: {
    backend: AcpBackend | null;
    model: string | null;
    permissionMode: AcpPermissionMode | null;
  };
}

export interface SessionWorkspacePayload {
  project: Project;
  activeSession: SessionDetail;
  historyRecords: HistoryRecord[];
  status: StatusSnapshot;
  context: SessionContextManifest | null;
  evidence: SessionEvidenceEvent[];
}
```

- [x] **Step 2: 在 `packages/backend/src/types.ts` 导出 session 类型和 WS event**

Append near existing type exports:

```ts
export type {
  Session,
  SessionMode,
  SessionPhase,
  SessionStatus,
  SessionRunStatus,
  SessionMessage,
  SessionRun,
  SessionPlanItem,
  SessionContextManifest,
  SessionContextSource,
  SessionCompaction,
  SessionEvidenceEvent,
  SessionCheckpoint,
  HistoryRecord,
  SessionDetail,
  StatusSnapshot,
  SessionWorkspacePayload,
} from './session-types.js';
```

Extend `WsServerEvent` and `WsClientEvent`:

```ts
  | { type: 'session:updated'; sessionId: string; session: import('./session-types.js').Session }
  | { type: 'session_message:new'; sessionId: string; message: import('./session-types.js').SessionMessage }
  | { type: 'session_run:created'; sessionId: string; run: import('./session-types.js').SessionRun }
  | { type: 'session_run:updated'; sessionId: string; run: import('./session-types.js').SessionRun }
  | { type: 'session_run:stream'; sessionId: string; runId: string; chunk: string; channel: 'answer' | 'thinking' | 'tool' | 'command' | 'event'; done: boolean }
  | { type: 'session_evidence:new'; sessionId: string; event: import('./session-types.js').SessionEvidenceEvent }
  | { type: 'history_record:new'; projectId: string; record: import('./session-types.js').HistoryRecord }
```

```ts
  | { type: 'session:subscribe'; sessionId: string }
  | { type: 'session:unsubscribe'; sessionId: string };
```

- [x] **Step 3: 新增 SQLite tables**

Modify `packages/backend/src/db.ts` after `agent_runs` indexes and before workflow tables. Use the schema from the spec, with these additional indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_runs_session ON session_runs(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_session_runs_status ON session_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_session_plan_items_session ON session_plan_items(session_id, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_session_context_sources_manifest ON session_context_sources(manifest_id, priority);
CREATE INDEX IF NOT EXISTS idx_session_compactions_session ON session_compactions(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_evidence_session ON session_evidence_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session ON session_checkpoints(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_history_project ON history_records(project_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_session ON history_records(session_id);
```

- [x] **Step 4: 写 schema smoke test**

Create `packages/backend/src/repos/sessions.test.ts` with an initial schema test:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-sessions-')), 'test.db');

const { db } = await import('../db.js');

test('session schema creates all new tables', () => {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'sessions',
        'session_messages',
        'session_runs',
        'session_plan_items',
        'session_context_manifests',
        'session_context_sources',
        'session_compactions',
        'session_evidence_events',
        'session_checkpoints',
        'history_records'
      )
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name), [
    'history_records',
    'session_checkpoints',
    'session_compactions',
    'session_context_manifests',
    'session_context_sources',
    'session_evidence_events',
    'session_messages',
    'session_plan_items',
    'session_runs',
    'sessions',
  ]);
});
```

- [x] **Step 5: 运行后端 schema test**

Run:

```bash
rtk node --import tsx --test packages/backend/src/repos/sessions.test.ts
```

Expected: PASS。

- [x] **Step 6: Commit**

```bash
rtk git add packages/backend/src/session-types.ts packages/backend/src/types.ts packages/backend/src/db.ts packages/backend/src/repos/sessions.test.ts
rtk git commit -m "feat(backend): 新增会话历史数据模型"
```

## Task 2: Session repos 与数据归一化

**Files:**
- Create: `packages/backend/src/repos/sessions.ts`
- Create: `packages/backend/src/repos/session-context.ts`
- Create: `packages/backend/src/repos/session-compactions.ts`
- Create: `packages/backend/src/repos/session-evidence.ts`
- Create: `packages/backend/src/repos/session-checkpoints.ts`
- Create: `packages/backend/src/repos/history-records.ts`
- Test: `packages/backend/src/repos/sessions.test.ts`
- Test: `packages/backend/src/repos/history-records.test.ts`

- [x] **Step 1: 实现 JSON parse helpers**

In `packages/backend/src/repos/sessions.ts`:

```ts
function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
```

- [x] **Step 2: 实现 `sessionRepo`**

In `packages/backend/src/repos/sessions.ts`, export:

```ts
export const sessionRepo = {
  create(input: {
    project_id: string;
    title?: string;
    current_goal?: string | null;
    mode?: SessionMode;
    provider?: AcpBackend | null;
    model?: string | null;
    workspace_path?: string | null;
    worktree_path?: string | null;
    branch_name?: string | null;
    forked_from_session_id?: string | null;
    forked_from_history_record_id?: string | null;
  }): Session {
    const timestamp = now();
    const id = nanoid(16);
    db.prepare(`
      INSERT INTO sessions (
        id, project_id, title, current_goal, mode, phase, status,
        provider, model, workspace_path, worktree_path, branch_name,
        forked_from_session_id, forked_from_history_record_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'idle', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.project_id,
      input.title?.trim() || 'New Session',
      input.current_goal ?? null,
      input.mode ?? 'ask',
      input.provider ?? null,
      input.model ?? null,
      input.workspace_path ?? null,
      input.worktree_path ?? null,
      input.branch_name ?? null,
      input.forked_from_session_id ?? null,
      input.forked_from_history_record_id ?? null,
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  },
  get(id: string): Session | undefined {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  },
  listByProject(projectId: string, input: { includeArchived?: boolean } = {}): Session[] {
    const archivedFilter = input.includeArchived ? '' : "AND status != 'archived'";
    return db.prepare(`
      SELECT * FROM sessions
      WHERE project_id = ? ${archivedFilter}
      ORDER BY updated_at DESC
    `).all(projectId) as Session[];
  },
};
```

- [x] **Step 3: 实现 message/run/plan repo 方法**

Add `sessionMessageRepo`, `sessionRunRepo`, `sessionPlanItemRepo` in the same file. Required methods:

```ts
sessionMessageRepo.create(input)
sessionMessageRepo.listBySession(sessionId, { limit?: number })
sessionRunRepo.create(input)
sessionRunRepo.appendStdout(runId, chunk)
sessionRunRepo.appendStderr(runId, chunk)
sessionRunRepo.appendActivity(runId, chunk)
sessionRunRepo.updateStatus(runId, status, patch?)
sessionRunRepo.listBySession(sessionId, { limit?: number })
sessionPlanItemRepo.upsertMany(sessionId, items)
sessionPlanItemRepo.listBySession(sessionId)
```

Implementation rules:

- `appendStdout` and `appendStderr` must update `updated_at`.
- `updateStatus` must set `completed_at` for terminal statuses.
- `listBySession` returns ascending chronological order.

- [x] **Step 4: 实现 evidence repo with append-only seq**

Create `packages/backend/src/repos/session-evidence.ts`:

```ts
export const sessionEvidenceRepo = {
  create(input: {
    session_id: string;
    event_type: SessionEvidenceType;
    severity?: SessionEvidenceSeverity;
    source_run_id?: string | null;
    source_message_id?: string | null;
    title: string;
    summary?: string | null;
    payload?: Record<string, unknown>;
  }): SessionEvidenceEvent {
    const insert = db.transaction(() => {
      const nextSeq = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_evidence_events WHERE session_id = ?',
      ).get(input.session_id) as { seq: number };
      const id = nanoid(16);
      db.prepare(`
        INSERT INTO session_evidence_events (
          id, session_id, seq, event_type, severity, source_run_id,
          source_message_id, title, summary, payload, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.session_id,
        nextSeq.seq,
        input.event_type,
        input.severity ?? 'info',
        input.source_run_id ?? null,
        input.source_message_id ?? null,
        input.title,
        input.summary ?? null,
        JSON.stringify(input.payload ?? {}),
        now(),
      );
      return id;
    });
    return this.get(insert())!;
  },
};
```

- [x] **Step 5: 实现 history repo**

Create `packages/backend/src/repos/history-records.ts` with:

```ts
export const historyRecordRepo = {
  create(input: {
    project_id: string;
    session_id: string;
    title: string;
    summary: string;
    status: 'completed' | 'blocked' | 'failed' | 'archived';
    mode: SessionMode;
    started_at: number;
    ended_at: number;
    key_decisions: string[];
    changed_files: string[];
    verification_summary?: string | null;
    commit_refs: string[];
    resume_brief: string;
    compact_count: number;
    fork_count?: number;
  }): HistoryRecord {
    const timestamp = now();
    const id = nanoid(16);
    db.prepare(`
      INSERT INTO history_records (
        id, project_id, session_id, title, summary, status, mode,
        started_at, ended_at, key_decisions, changed_files,
        verification_summary, commit_refs, resume_brief,
        compact_count, fork_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.project_id,
      input.session_id,
      input.title,
      input.summary,
      input.status,
      input.mode,
      input.started_at,
      input.ended_at,
      JSON.stringify(input.key_decisions),
      JSON.stringify(input.changed_files),
      input.verification_summary ?? null,
      JSON.stringify(input.commit_refs),
      input.resume_brief,
      input.compact_count,
      input.fork_count ?? 0,
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  },
};
```

- [x] **Step 6: 写 repo round-trip tests**

Extend `packages/backend/src/repos/sessions.test.ts`:

```ts
test('session repos create active session, message, run and evidence in order', () => {
  const project = projectRepo.create({ name: 'session project', path: mkdtempSync(join(tmpdir(), 'session-project-')) });
  const session = sessionRepo.create({ project_id: project.id, title: '实现会话模型', mode: 'code' });
  const message = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    content: '开始实现',
  });
  const run = sessionRunRepo.create({
    session_id: session.id,
    provider: 'codex',
    mode: 'code',
    prompt: '开始实现',
  });
  sessionEvidenceRepo.create({ session_id: session.id, event_type: 'message', source_message_id: message.id, title: '用户请求' });
  sessionEvidenceRepo.create({ session_id: session.id, event_type: 'status', source_run_id: run.id, title: '状态快照' });

  assert.equal(sessionMessageRepo.listBySession(session.id).length, 1);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 1);
  assert.deepEqual(sessionEvidenceRepo.listBySession(session.id).map((event) => event.seq), [1, 2]);
});
```

- [x] **Step 7: 运行 repo tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/repos/sessions.test.ts packages/backend/src/repos/history-records.test.ts
```

Expected: PASS。

- [x] **Step 8: Commit**

```bash
rtk git add packages/backend/src/repos/sessions.ts packages/backend/src/repos/session-context.ts packages/backend/src/repos/session-compactions.ts packages/backend/src/repos/session-evidence.ts packages/backend/src/repos/session-checkpoints.ts packages/backend/src/repos/history-records.ts packages/backend/src/repos/sessions.test.ts packages/backend/src/repos/history-records.test.ts
rtk git commit -m "feat(backend): 实现会话仓储层"
```

## Task 3: Slash commands、summary、status、context services

**Files:**
- Create: `packages/backend/src/session-command.ts`
- Create: `packages/backend/src/session-summary.ts`
- Create: `packages/backend/src/session-status.ts`
- Create: `packages/backend/src/session-context.ts`
- Test: `packages/backend/src/session-command.test.ts`
- Test: `packages/backend/src/session-summary.test.ts`
- Test: `packages/backend/src/session-status.test.ts`
- Test: `packages/backend/src/session-context.test.ts`

- [x] **Step 1: 实现 slash command parser**

Create `packages/backend/src/session-command.ts`:

```ts
export type SessionCommandKind = 'message' | 'new' | 'compact' | 'status' | 'context' | 'resume' | 'fork' | 'checkpoint';

export interface ParsedSessionCommand {
  kind: SessionCommandKind;
  raw: string;
  body: string;
  args: Record<string, string | true>;
}

export function parseSessionCommand(input: string): ParsedSessionCommand {
  const raw = input.trim();
  if (!raw.startsWith('/')) return { kind: 'message', raw, body: raw, args: {} };
  const [head = '', ...rest] = raw.split(/\s+/);
  const command = head.slice(1).toLowerCase();
  const body = rest.join(' ').trim();
  const kind = isSessionCommandKind(command) ? command : 'message';
  return { kind, raw, body, args: parseCommandArgs(body) };
}
```

`parseCommandArgs` must support:

```text
/new blank
/new title: 重构会话模型
/compact focus: 保留 UI 决策
/fork checkpoint:abc123
```

- [x] **Step 2: 写 command parser tests**

Create `packages/backend/src/session-command.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionCommand } from './session-command.js';

test('parseSessionCommand treats normal text as message', () => {
  assert.deepEqual(parseSessionCommand('继续实现'), {
    kind: 'message',
    raw: '继续实现',
    body: '继续实现',
    args: {},
  });
});

test('parseSessionCommand parses compact focus argument', () => {
  const parsed = parseSessionCommand('/compact focus: 保留 UI 决策和未完成 bug');
  assert.equal(parsed.kind, 'compact');
  assert.equal(parsed.args.focus, '保留 UI 决策和未完成 bug');
});
```

- [x] **Step 3: 实现 deterministic summary helpers**

Create `packages/backend/src/session-summary.ts`:

```ts
export function buildHistorySummary(input: {
  goal: string | null;
  messages: Array<{ role: string; content: string }>;
  changedFiles: string[];
  verificationSummary: string | null;
}): { title: string; summary: string; resumeBrief: string; keyDecisions: string[] } {
  const firstUser = input.messages.find((message) => message.role === 'user')?.content.trim() ?? '';
  const title = truncateLine(input.goal || firstUser || '未命名会话', 60);
  const changed = input.changedFiles.length > 0 ? `变更文件：${input.changedFiles.join(', ')}` : '变更文件：无';
  const verification = input.verificationSummary ?? '最近验证：未知';
  const summary = [truncateLine(firstUser, 180), changed, verification].filter(Boolean).join('\n');
  const resumeBrief = [
    `目标：${input.goal ?? title}`,
    `已完成：${summary}`,
    '未完成：请先运行 /status 对齐当前状态。',
    `优先读取文件：${input.changedFiles.slice(0, 8).join(', ') || '无'}`,
  ].join('\n');
  return { title, summary, resumeBrief, keyDecisions: [] };
}
```

- [x] **Step 4: 实现 `/status` snapshot builder**

Create `packages/backend/src/session-status.ts`:

```ts
export function buildStatusSnapshot(input: {
  session: Session;
  context: SessionContextManifest | null;
  latestVerification: SessionEvidenceEvent | null;
  latestBlocker: SessionEvidenceEvent | null;
  changedFileCount: number;
  permissionMode: AcpPermissionMode | null;
}): StatusSnapshot {
  const totalTokenEstimate = input.context?.total_token_estimate ?? 0;
  return {
    goal: input.session.current_goal,
    mode: input.session.mode,
    phase: input.session.phase,
    status: input.session.status,
    context: {
      totalTokenEstimate,
      latestCompactionId: input.session.latest_compaction_id,
      retainedRecentMessages: 20,
      pressure: totalTokenEstimate > 90_000 ? 'high' : totalTokenEstimate > 45_000 ? 'medium' : 'low',
    },
    git: {
      branchName: input.session.branch_name,
      changedFileCount: input.changedFileCount,
      hasUncommittedDiff: input.changedFileCount > 0,
      conflictRisk: input.session.worktree_path ? 'low' : 'none',
    },
    verification: {
      lastCommand: readPayloadString(input.latestVerification, 'command'),
      status: readVerificationStatus(input.latestVerification),
      completedAt: input.latestVerification?.created_at ?? null,
    },
    blocker: input.latestBlocker ? {
      reason: input.latestBlocker.summary ?? input.latestBlocker.title,
      since: input.latestBlocker.created_at,
      requiredAction: readPayloadString(input.latestBlocker, 'required_action') ?? '等待用户或运行下一步命令',
    } : null,
    nextAction: {
      label: input.latestBlocker ? '处理阻塞' : '继续会话',
      command: input.latestBlocker ? '/status' : null,
      reason: input.latestBlocker ? '当前存在 blocker evidence' : '没有终态阻塞',
    },
    provider: {
      backend: input.session.provider,
      model: input.session.model,
      permissionMode: input.permissionMode,
    },
  };
}
```

- [x] **Step 5: 实现 context manifest builder**

Create `packages/backend/src/session-context.ts`:

```ts
export interface ContextSourceDraft {
  source_type: SessionContextSourceType;
  source_ref: string | null;
  title: string;
  included: 0 | 1;
  priority: number;
  token_estimate: number;
  reason: string;
  excerpt: string;
  content_hash: string;
  metadata: Record<string, unknown>;
}

export interface ContextManifestDraft {
  totalTokenEstimate: number;
  sources: ContextSourceDraft[];
}

export function buildContextManifestDraft(input: {
  session: Session;
  agentsText: string | null;
  rtkText: string | null;
  compactSummary: string | null;
  historyBriefs: Array<{ id: string; title: string; resume_brief: string }>;
  recentMessages: SessionMessage[];
  explicitFiles: Array<{ path: string; excerpt: string }>;
  gitDiff: string | null;
}): ContextManifestDraft {
  const sources: ContextSourceDraft[] = [];
  pushSource(sources, 'agents', 'AGENTS.md', input.agentsText, '项目与个人 agent 规则');
  pushSource(sources, 'rtk', 'RTK.md', input.rtkText, '本机 RTK 命令约束');
  pushSource(sources, 'compact', 'Latest Compact', input.compactSummary, '当前 session 已应用 compact');
  for (const history of input.historyBriefs) {
    pushSource(sources, 'history', history.title, history.resume_brief, `恢复历史记录 ${history.id}`);
  }
  for (const message of input.recentMessages.slice(-20)) {
    pushSource(sources, 'user_message', `${message.role}:${message.id}`, message.content, '最近会话消息');
  }
  for (const file of input.explicitFiles) {
    pushSource(sources, 'file', file.path, file.excerpt, '用户显式引用文件');
  }
  pushSource(sources, 'diff', 'git diff', input.gitDiff, '当前未提交 diff');
  return {
    totalTokenEstimate: sources.reduce((sum, source) => sum + source.token_estimate, 0),
    sources,
  };
}
```

- [x] **Step 6: 运行 service tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/session-command.test.ts packages/backend/src/session-summary.test.ts packages/backend/src/session-status.test.ts packages/backend/src/session-context.test.ts
```

Expected: PASS。

- [x] **Step 7: Commit**

```bash
rtk git add packages/backend/src/session-command.ts packages/backend/src/session-command.test.ts packages/backend/src/session-summary.ts packages/backend/src/session-summary.test.ts packages/backend/src/session-status.ts packages/backend/src/session-status.test.ts packages/backend/src/session-context.ts packages/backend/src/session-context.test.ts
rtk git commit -m "feat(backend): 实现会话控制服务"
```

## Task 4: Session API 与硬切换后端入口

**Files:**
- Create: `packages/backend/src/session.routes.ts`
- Modify: `packages/backend/src/routes.ts`
- Test: `packages/backend/src/session.routes.test.ts`

- [x] **Step 1: 创建 session router**

Create `packages/backend/src/session.routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { projectRepo } from './repos/projects.js';
import { sessionRepo, sessionMessageRepo } from './repos/sessions.js';
import { historyRecordRepo } from './repos/history-records.js';
import { sessionEvidenceRepo } from './repos/session-evidence.js';
import { parseSessionCommand } from './session-command.js';

export const sessionRouter = Router();

sessionRouter.get('/projects/:projectId/session-workspace', (req, res) => {
  const project = projectRepo.get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const activeSession = sessionRepo.getOrCreateActiveForProject(project.id);
  res.json({
    project,
    activeSession: sessionRepo.detail(activeSession.id),
    historyRecords: historyRecordRepo.listByProject(project.id),
    status: sessionRepo.status(activeSession.id),
    context: sessionRepo.latestContext(activeSession.id),
    evidence: sessionEvidenceRepo.listBySession(activeSession.id, { limit: 100 }),
  });
});
```

- [x] **Step 2: 实现 session CRUD endpoints**

Add:

```ts
sessionRouter.get('/projects/:projectId/sessions', listProjectSessions);
sessionRouter.post('/projects/:projectId/sessions', createProjectSession);
sessionRouter.get('/sessions/:sessionId', getSessionDetail);
sessionRouter.patch('/sessions/:sessionId', updateSession);
sessionRouter.post('/sessions/:sessionId/messages', createSessionMessage);
sessionRouter.post('/sessions/:sessionId/new', runNewCommand);
sessionRouter.post('/sessions/:sessionId/compact/preview', previewSessionCompact);
sessionRouter.post('/sessions/:sessionId/compact/apply', applySessionCompact);
sessionRouter.get('/sessions/:sessionId/status', getSessionStatus);
sessionRouter.get('/sessions/:sessionId/context', getSessionContext);
sessionRouter.get('/sessions/:sessionId/evidence', listSessionEvidence);
sessionRouter.post('/sessions/:sessionId/checkpoints', createSessionCheckpoint);
sessionRouter.post('/sessions/:sessionId/fork', forkSession);
sessionRouter.get('/projects/:projectId/history-records', listProjectHistoryRecords);
sessionRouter.get('/history-records/:historyRecordId', getHistoryRecord);
sessionRouter.post('/history-records/:historyRecordId/resume', resumeHistoryRecord);
sessionRouter.post('/history-records/:historyRecordId/fork', forkHistoryRecord);
sessionRouter.post('/history-records/:historyRecordId/resume-brief/regenerate', regenerateResumeBrief);
sessionRouter.get('/history-records/:historyRecordId/export', exportHistoryRecord);
```

Each handler must validate project/session ownership before writing.

- [x] **Step 3: Message endpoint handles slash commands**

In `POST /sessions/:sessionId/messages`:

```ts
const parsed = z.object({
  content: z.string().min(1),
  sender_id: z.string().default('user'),
  sender_name: z.string().nullable().optional(),
  mode: z.enum(['ask', 'plan', 'code', 'debug', 'review']).optional(),
}).safeParse(req.body);

const command = parseSessionCommand(parsed.data.content);
if (command.kind === 'new') return handleNewCommand(req, res, session, command);
if (command.kind === 'compact') return handleCompactPreviewCommand(req, res, session, command);
if (command.kind === 'status') return res.json(sessionStatusService.get(session.id));
if (command.kind === 'context') return res.json(sessionContextService.latestOrBuild(session.id));
```

Normal message path writes `session_messages`, evidence `message`, and starts runtime in Task 5.

- [x] **Step 4: 挂载 route**

Modify `packages/backend/src/routes.ts`:

```ts
import { sessionRouter } from './session.routes.js';

router.use(sessionRouter);
```

Place this near `router.use('/skills', skillsRouter)` so session routes are not nested under old room routes.

- [x] **Step 5: 写 API tests**

Create `packages/backend/src/session.routes.test.ts` covering:

```ts
test('GET project session workspace creates an active session without creating a room or task', async () => {
  const project = projectRepo.create({ name: 'workspace', path: mkdtempSync(join(tmpdir(), 'session-workspace-')) });
  const response = await requestJson(`/projects/${project.id}/session-workspace`);
  assert.equal(response.project.id, project.id);
  assert.equal(response.activeSession.status, 'active');
  assert.deepEqual(roomRepo.listByProject(project.id), []);
  assert.deepEqual(taskRepo.listByProject(project.id), []);
});
```

- [x] **Step 6: 运行 API tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/session.routes.test.ts
```

Expected: PASS。

- [x] **Step 7: Commit**

```bash
rtk git add packages/backend/src/session.routes.ts packages/backend/src/routes.ts packages/backend/src/session.routes.test.ts
rtk git commit -m "feat(backend): 新增会话工作台API"
```

## Task 5: Session runtime、流式事件与 provider adapter 接入

**Files:**
- Create: `packages/backend/src/session-runtime.ts`
- Modify: `packages/backend/src/ws-hub.ts`
- Modify: `packages/backend/src/server.ts`
- Modify: `packages/backend/src/session.routes.ts`
- Test: `packages/backend/src/session-runtime.test.ts`
- Test: `packages/backend/src/ws-hub.test.ts`

- [x] **Step 1: 扩展 WebSocket hub**

Modify `packages/backend/src/ws-hub.ts`:

```ts
class WsHub {
  private roomSubscriptions = new Map<string, Set<WebSocket>>();
  private sessionSubscriptions = new Map<string, Set<WebSocket>>();

  subscribe(roomId: string, socket: WebSocket): void {
    this.add(this.roomSubscriptions, roomId, socket);
  }

  subscribeSession(sessionId: string, socket: WebSocket): void {
    this.add(this.sessionSubscriptions, sessionId, socket);
  }

  unsubscribeSession(sessionId: string, socket: WebSocket): void {
    this.sessionSubscriptions.get(sessionId)?.delete(socket);
  }

  broadcastSession(sessionId: string, event: WsServerEvent): void {
    this.broadcastTo(this.sessionSubscriptions, sessionId, event);
  }
}
```

- [x] **Step 2: 扩展 server subscribe handling**

Modify `packages/backend/src/server.ts`:

```ts
if (event.type === 'session:subscribe') wsHub.subscribeSession(event.sessionId, socket);
else if (event.type === 'session:unsubscribe') wsHub.unsubscribeSession(event.sessionId, socket);
```

Keep existing room subscribe handling for old pages that still exist outside the main workspace.

- [x] **Step 3: 实现 runtime**

Create `packages/backend/src/session-runtime.ts`:

```ts
export async function runSessionAgent(input: {
  sessionId: string;
  prompt: string;
  provider: AcpBackend;
  model?: string | null;
  permissionMode?: AcpPermissionMode | null;
  imagePaths?: string[];
}): Promise<SessionRun> {
  const session = requireSession(input.sessionId);
  const project = requireProject(session.project_id);
  const run = sessionRunRepo.create({
    session_id: session.id,
    provider: input.provider,
    model: input.model ?? null,
    mode: session.mode,
    phase: session.phase,
    prompt: input.prompt,
  });
  const controller = runRegistry.create(run.id);
  wsHub.broadcastSession(session.id, { type: 'session_run:created', sessionId: session.id, run });

  try {
    const result = await getAdapter(input.provider).invoke({
      projectPath: project.path,
      sessionId: run.acp_session_id,
      prompt: input.prompt,
      acpPermissionMode: input.permissionMode ?? 'read-only',
      imagePaths: input.imagePaths ?? [],
      onSession: (acpSessionId) => {
        const updated = sessionRunRepo.updateStatus(run.id, 'running', { acp_session_id: acpSessionId });
        if (updated) wsHub.broadcastSession(session.id, { type: 'session_run:updated', sessionId: session.id, run: updated });
      },
      onChunk: (chunk) => recordSessionChunk({ sessionId: session.id, runId: run.id, chunk }),
      signal: controller.signal,
    });
    return finishSessionRun(run.id, result.exitCode === 0 ? 'completed' : 'failed', result.stderr || null);
  } catch (err) {
    return finishSessionRun(run.id, controller.signal.aborted ? 'cancelled' : 'failed', (err as Error).message);
  } finally {
    runRegistry.remove(run.id);
  }
}
```

- [x] **Step 4: Map stream chunks to evidence**

`recordSessionChunk` must:

- append stdout/stderr/activity to `session_runs`;
- broadcast `session_run:stream`;
- create evidence `tool_call` / `tool_result` / `file_diff` / `status` when `chunk.event` exists;
- avoid writing raw stdout over 200 lines into compact evidence payload.

Use this payload shape:

```ts
{
  channel: chunk.channel ?? 'answer',
  rawType: chunk.rawType ?? null,
  text: chunk.text.slice(0, 8000),
  run_id: runId,
}
```

- [x] **Step 5: Hook runtime to message endpoint**

In `session.routes.ts`, after normal user message create:

```ts
void runSessionAgent({
  sessionId: session.id,
  prompt: buildPromptFromMessage(session, userMessage),
  provider: session.provider ?? 'codex',
  model: session.model,
}).catch((error) => {
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'blocker',
    severity: 'error',
    title: 'Session runtime failed',
    summary: (error as Error).message,
  });
});

res.status(202).json({ message: userMessage });
```

- [x] **Step 6: Write runtime test with fake adapter**

Create `packages/backend/src/session-runtime.test.ts`:

```ts
test('runSessionAgent writes run, stream output and evidence', async () => {
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ onChunk, onSession }) => {
      onSession?.('acp-1');
      onChunk({ stream: 'stdout', channel: 'answer', text: '完成\n' });
      onChunk({ stream: 'stdout', channel: 'tool', text: 'read package.json\n', rawType: 'tool_call' });
      return { exitCode: 0, sessionId: 'acp-1', stderr: '' };
    },
  });

  const run = await runSessionAgent({ sessionId: session.id, prompt: '继续', provider: 'codex' });
  assert.equal(run.status, 'completed');
  assert.match(sessionRunRepo.get(run.id)!.stdout, /完成/);
  assert.ok(sessionEvidenceRepo.listBySession(session.id).some((event) => event.event_type === 'tool_call'));
});
```

- [x] **Step 7: Run runtime tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/session-runtime.test.ts packages/backend/src/ws-hub.test.ts
```

Expected: PASS。

- [x] **Step 8: Commit**

```bash
rtk git add packages/backend/src/session-runtime.ts packages/backend/src/ws-hub.ts packages/backend/src/server.ts packages/backend/src/session.routes.ts packages/backend/src/session-runtime.test.ts packages/backend/src/ws-hub.test.ts
rtk git commit -m "feat(backend): 接入会话运行时与流式事件"
```

## Task 6: `/new`、compact、resume、fork、checkpoint 行为闭环

**Files:**
- Modify: `packages/backend/src/session.routes.ts`
- Modify: `packages/backend/src/session-summary.ts`
- Modify: `packages/backend/src/session-context.ts`
- Modify: `packages/backend/src/repos/session-compactions.ts`
- Modify: `packages/backend/src/repos/session-checkpoints.ts`
- Modify: `packages/backend/src/repos/history-records.ts`
- Test: `packages/backend/src/session.commands.integration.test.ts`

- [ ] **Step 1: Implement `/new` hard boundary**

`handleNewCommand` must:

```ts
const current = sessionRepo.detail(session.id);
const summary = buildHistorySummary({
  goal: current.current_goal,
  messages: current.messages,
  changedFiles: collectChangedFilesFromEvidence(current.evidence),
  verificationSummary: collectLatestVerification(current.evidence),
});
const record = historyRecordRepo.create({
  project_id: current.project_id,
  session_id: current.id,
  title: command.args.title?.toString() || summary.title,
  summary: summary.summary,
  status: current.status === 'failed' ? 'failed' : current.status === 'blocked' ? 'blocked' : 'archived',
  mode: current.mode,
  started_at: current.created_at,
  ended_at: now(),
  key_decisions: summary.keyDecisions,
  changed_files: collectChangedFilesFromEvidence(current.evidence),
  verification_summary: collectLatestVerification(current.evidence),
  commit_refs: collectCommitRefs(current.evidence),
  resume_brief: summary.resumeBrief,
  compact_count: current.compactions.length,
});
sessionRepo.archive(current.id);
const next = sessionRepo.create({
  project_id: current.project_id,
  title: command.args.blank ? 'New Session' : `继续：${record.title}`,
  current_goal: command.args.blank ? null : current.current_goal,
  mode: current.mode,
  provider: current.provider,
  model: current.model,
  workspace_path: current.workspace_path,
});
```

- [ ] **Step 2: Implement compact preview/apply**

Preview endpoint creates:

```ts
sessionCompactionRepo.createPreview({
  session_id: session.id,
  strategy: readCompactStrategy(command),
  focus_prompt: typeof command.args.focus === 'string' ? command.args.focus : null,
  preview_summary: buildCompactPreview({ session, focus: command.args.focus }),
  retained_refs: collectRetainedRefs(session),
  dropped_refs: collectDroppedRefs(session),
  risk_notes: buildCompactRiskNotes(session),
});
```

Apply endpoint updates `applied_summary`, `user_edited`, `sessions.latest_compaction_id`, and writes evidence `compact`.

- [ ] **Step 3: Implement resume brief and resume**

`POST /history-records/:historyRecordId/resume` must:

- create a new active session for the same project;
- set `current_goal` from resume brief first line when possible;
- add system message containing resume brief;
- write evidence `resume`;
- return `SessionWorkspacePayload`.

System message content:

```text
这是从历史记录恢复的新会话。请先对齐目标、未完成项、关键文件和最近验证，再继续执行。

{resume_brief}
```

- [ ] **Step 4: Implement fork**

`POST /sessions/:sessionId/fork` and `POST /history-records/:historyRecordId/fork` must:

- create active session with `forked_from_session_id` or `forked_from_history_record_id`;
- copy latest applied compact as inherited context source;
- copy provider/model unless request overrides them;
- write evidence `fork` in source and fork session.

- [ ] **Step 5: Implement checkpoint**

`POST /sessions/:sessionId/checkpoints` must record:

```ts
{
  title,
  description,
  git_head: await readGitHead(project.path),
  branch_name: await readGitBranch(project.path),
  diff_summary: await readGitDiffSummary(project.path),
}
```

Use `node:child_process` `execFile` with `git` and fixed args only.

- [ ] **Step 6: Run command integration tests**

Run:

```bash
rtk node --import tsx --test packages/backend/src/session.commands.integration.test.ts
```

Expected:

- `/new` creates one `history_record`, archives source session, creates next session.
- compact preview does not update `latest_compaction_id`.
- compact apply updates `latest_compaction_id` and evidence.
- resume creates a new session and system resume message.
- fork records source relation.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/backend/src/session.routes.ts packages/backend/src/session-summary.ts packages/backend/src/session-context.ts packages/backend/src/repos/session-compactions.ts packages/backend/src/repos/session-checkpoints.ts packages/backend/src/repos/history-records.ts packages/backend/src/session.commands.integration.test.ts
rtk git commit -m "feat(backend): 完成会话控制命令"
```

## Task 7: 前端 session DTO、API client 与 WS client

**Files:**
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/lib/api.ts`
- Modify: `packages/frontend/src/lib/ws.ts`
- Test: `packages/frontend/src/lib/sessionTypes.test.ts`
- Test: `packages/frontend/src/lib/sessionApi.test.ts`

- [ ] **Step 1: Add frontend session DTOs**

Append to `packages/frontend/src/lib/types.ts`:

```ts
export type SessionMode = 'ask' | 'plan' | 'code' | 'debug' | 'review';
export type SessionPhase = 'idle' | 'brainstorming' | 'planning' | 'implementing' | 'debugging' | 'reviewing' | 'verifying' | 'blocked' | 'completed' | 'archived';
export type SessionStatus = 'active' | 'blocked' | 'completed' | 'archived' | 'failed';

export interface Session {
  id: string;
  project_id: string;
  title: string;
  current_goal: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  status: SessionStatus;
  provider: AcpBackend | null;
  model: string | null;
  workspace_path: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  forked_from_session_id: string | null;
  forked_from_history_record_id: string | null;
  latest_compaction_id: string | null;
  latest_context_manifest_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}
```

- [ ] **Step 2: Add API client methods**

Append to `api` in `packages/frontend/src/lib/api.ts`:

```ts
getSessionWorkspace: (projectId: string) =>
  request<SessionWorkspacePayload>(`/projects/${projectId}/session-workspace`),
listSessions: (projectId: string) =>
  request<Session[]>(`/projects/${projectId}/sessions`),
createSession: (projectId: string, input: { title?: string; mode?: SessionMode } = {}) =>
  request<Session>(`/projects/${projectId}/sessions`, { method: 'POST', body: JSON.stringify(input) }),
sendSessionMessage: (sessionId: string, input: { content: string; mode?: SessionMode }) =>
  request<{ message: SessionMessage } | SessionWorkspacePayload>(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
previewCompact: (sessionId: string, input: { focus?: string; strategy?: string } = {}) =>
  request<SessionCompaction>(`/sessions/${sessionId}/compact/preview`, { method: 'POST', body: JSON.stringify(input) }),
applyCompact: (sessionId: string, compactionId: string, input: { applied_summary: string }) =>
  request<SessionCompaction>(`/sessions/${sessionId}/compact/apply`, {
    method: 'POST',
    body: JSON.stringify({ compaction_id: compactionId, ...input }),
  }),
resumeHistoryRecord: (historyRecordId: string) =>
  request<SessionWorkspacePayload>(`/history-records/${historyRecordId}/resume`, { method: 'POST' }),
forkHistoryRecord: (historyRecordId: string, input: { provider?: AcpBackend | null; model?: string | null } = {}) =>
  request<SessionWorkspacePayload>(`/history-records/${historyRecordId}/fork`, { method: 'POST', body: JSON.stringify(input) }),
```

- [ ] **Step 3: Add session WS subscribe**

Modify `packages/frontend/src/lib/ws.ts`:

```ts
subscribeSession(sessionId: string): void {
  this.send({ type: 'session:subscribe', sessionId });
}

unsubscribeSession(sessionId: string): void {
  this.send({ type: 'session:unsubscribe', sessionId });
}
```

Expose a `sessionSocket` or extend existing `roomSocket` with neutral names. The UI must call `subscribeSession`, not `subscribe(roomId)`.

- [ ] **Step 4: Run frontend lib checks**

Run:

```bash
rtk node --import tsx --test packages/frontend/src/lib/sessionTypes.test.ts packages/frontend/src/lib/sessionApi.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
rtk git add packages/frontend/src/lib/types.ts packages/frontend/src/lib/api.ts packages/frontend/src/lib/ws.ts packages/frontend/src/lib/sessionTypes.test.ts packages/frontend/src/lib/sessionApi.test.ts
rtk git commit -m "feat(frontend): 新增会话API客户端"
```

## Task 8: Session OS 独立视觉系统与 UI model

**Files:**
- Create: `packages/frontend/src/session-ui/session-os.css`
- Create: `packages/frontend/src/session-ui/session-ui-model.ts`
- Test: `packages/frontend/src/session-ui/session-ui-model.test.ts`

- [ ] **Step 1: Create isolated CSS tokens**

Create `packages/frontend/src/session-ui/session-os.css`:

```css
:root {
  --session-bg: #f7f6f2;
  --session-panel: #ffffff;
  --session-panel-muted: #efede7;
  --session-ink: #171717;
  --session-muted: #6b6760;
  --session-rule: #d8d4ca;
  --session-accent: #00a6c8;
  --session-ok: #25835a;
  --session-warn: #b7791f;
  --session-danger: #b42318;
  --session-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --session-sans: "IBM Plex Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.session-shell {
  min-height: 100dvh;
  background: var(--session-bg);
  color: var(--session-ink);
  font-family: var(--session-sans);
  display: grid;
  grid-template-rows: auto 1fr;
}

.session-workspace-grid {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(520px, 1fr) minmax(360px, 440px);
  min-height: 0;
  border-top: 1px solid var(--session-rule);
}

.session-icon-button,
.session-command-button {
  min-height: 44px;
  min-width: 44px;
}

@media (max-width: 1024px) {
  .session-workspace-grid {
    grid-template-columns: 72px minmax(0, 1fr);
  }

  .session-inspector {
    position: fixed;
    inset: auto 0 0 0;
    max-height: 72dvh;
  }
}

@media (max-width: 720px) {
  .session-workspace-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

- [ ] **Step 2: Add UI model helpers**

Create `packages/frontend/src/session-ui/session-ui-model.ts`:

```ts
export function formatSessionAge(now: number, timestamp: number): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function contextPressureLabel(pressure: 'low' | 'medium' | 'high'): string {
  if (pressure === 'high') return '上下文压力高';
  if (pressure === 'medium') return '上下文压力中';
  return '上下文压力低';
}

export function evidenceTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    message: '消息',
    tool_call: '工具调用',
    tool_result: '工具结果',
    file_read: '文件读取',
    file_diff: '文件变更',
    test: '测试',
    build: '构建',
    browser_check: '浏览器验证',
    review: '审查',
    commit: '提交',
    compact: '压缩',
    checkpoint: '检查点',
    blocker: '阻塞',
    new: '新会话',
    resume: '恢复',
    fork: '分叉',
    status: '状态',
  };
  return labels[type] ?? type;
}
```

- [ ] **Step 3: Run UI model tests**

Run:

```bash
rtk node --import tsx --test packages/frontend/src/session-ui/session-ui-model.test.ts
```

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
rtk git add packages/frontend/src/session-ui/session-os.css packages/frontend/src/session-ui/session-ui-model.ts packages/frontend/src/session-ui/session-ui-model.test.ts
rtk git commit -m "feat(frontend): 新增SessionOS视觉基础"
```

## Task 9: Session OS 组件骨架

**Files:**
- Create all component files under `packages/frontend/src/session-ui/`
- Test: `packages/frontend/src/session-ui/SessionShell.test.tsx`
- Test: `packages/frontend/src/session-ui/InspectorPanel.test.tsx`

- [ ] **Step 1: Build `SessionShell`**

Create `SessionShell.tsx`:

```tsx
import './session-os.css';
import type { SessionWorkspacePayload } from '../lib/types';
import { SessionCommandBar } from './SessionCommandBar';
import { HistoryRecordsRail } from './HistoryRecordsRail';
import { ActiveSessionSurface } from './ActiveSessionSurface';
import { InspectorPanel } from './InspectorPanel';

export function SessionShell({
  payload,
  onSendMessage,
  onCommand,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (content: string) => void;
  onCommand: (command: string) => void;
}): JSX.Element {
  return (
    <section className="session-shell" aria-label="Session Operations Console">
      <SessionCommandBar payload={payload} onCommand={onCommand} />
      <div className="session-workspace-grid">
        <HistoryRecordsRail records={payload.historyRecords} activeSession={payload.activeSession.session} onCommand={onCommand} />
        <ActiveSessionSurface detail={payload.activeSession} onSendMessage={onSendMessage} />
        <InspectorPanel payload={payload} onCommand={onCommand} />
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Build Command Bar and History Rail**

`SessionCommandBar.tsx` must render:

- project name;
- active session title;
- provider/model/permission mode;
- buttons New, Compact, Fork, Resume, Status, Context;
- context pressure indicator.

`HistoryRecordsRail.tsx` must render dense rows with:

- title;
- summary two lines;
- status rail;
- mode pill;
- verification status;
- changed files count;
- Resume / Fork / Copy Brief actions.

- [ ] **Step 3: Build Active Session surface**

`ActiveSessionSurface.tsx` must render:

- `ObjectiveContract`;
- active run banner;
- `SessionTranscript`;
- plan items;
- `SessionComposer`.

`SessionTranscript.tsx` must group tool/run/evidence rows and collapse raw output by default.

- [ ] **Step 4: Build Inspector tabs**

`InspectorPanel.tsx` uses Radix Tabs or local buttons and renders:

- `StatusInspector`;
- `ContextInspector`;
- `EvidenceTimeline`;
- `FilesInspector`;
- `ProviderInspector`.

Default tab is Status.

- [ ] **Step 5: Build workflow surfaces**

Create:

- `CompactPreviewSurface.tsx` with Keep / Drop / Risks / editable summary / Apply / Discard.
- `ResumeBriefPanel.tsx` with resume brief sections and Copy / Resume / Fork.
- `ForkSessionDialog.tsx` with source relation and provider/model selectors.

- [ ] **Step 6: Render tests**

`SessionShell.test.tsx` must assert:

```ts
assert.match(html, /Session Operations Console/);
assert.match(html, /History Records/);
assert.match(html, /Active Session/);
assert.match(html, /Status/);
assert.match(html, /Context/);
assert.match(html, /Evidence/);
assert.doesNotMatch(html, /task-workspace/);
assert.doesNotMatch(html, /chat-panel/);
```

- [ ] **Step 7: Run component tests**

Run:

```bash
rtk node --import tsx --test packages/frontend/src/session-ui/SessionShell.test.tsx packages/frontend/src/session-ui/InspectorPanel.test.tsx
```

Expected: PASS。

- [ ] **Step 8: Commit**

```bash
rtk git add packages/frontend/src/session-ui
rtk git commit -m "feat(frontend): 实现SessionOS组件骨架"
```

## Task 10: Session workspace page 与路由硬切换

**Files:**
- Create: `packages/frontend/src/pages/SessionWorkspacePage.tsx`
- Modify: `packages/frontend/src/main.tsx`
- Modify: `packages/frontend/src/components/AppShell.tsx`
- Modify: `packages/frontend/src/index.css`
- Test: `packages/frontend/src/pages/SessionWorkspacePage.test.tsx`
- Test: `packages/frontend/src/components/AppShell.test.tsx`

- [ ] **Step 1: Create SessionWorkspacePage**

Create `packages/frontend/src/pages/SessionWorkspacePage.tsx`:

```tsx
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { sessionSocket } from '../lib/ws';
import { SessionShell } from '../session-ui/SessionShell';

export function SessionWorkspacePage(): JSX.Element {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const activeProjectId = projectId || projects[0]?.id || '';

  useEffect(() => {
    if (!projectId && activeProjectId) navigate(`/projects/${activeProjectId}`, { replace: true });
  }, [activeProjectId, navigate, projectId]);

  const workspace = useQuery({
    queryKey: ['session-workspace', activeProjectId],
    queryFn: () => api.getSessionWorkspace(activeProjectId),
    enabled: Boolean(activeProjectId),
  });

  useEffect(() => {
    const sessionId = workspace.data?.activeSession.session.id;
    if (!sessionId) return;
    sessionSocket.subscribeSession(sessionId);
    return () => sessionSocket.unsubscribeSession(sessionId);
  }, [workspace.data?.activeSession.session.id]);

  const sendMessage = useMutation({
    mutationFn: (content: string) => api.sendSessionMessage(workspace.data!.activeSession.session.id, { content }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] }),
    onError: (error) => toast.error((error as Error).message),
  });

  if (!activeProjectId) return <div className="session-shell"><div className="session-empty">创建项目后开始 Session</div></div>;
  if (!workspace.data) return <div className="session-shell"><div className="session-loading">加载 Session</div></div>;

  return (
    <SessionShell
      payload={workspace.data}
      onSendMessage={(content) => sendMessage.mutate(content)}
      onCommand={(command) => sendMessage.mutate(command)}
    />
  );
}
```

- [ ] **Step 2: Replace main routes**

Modify `packages/frontend/src/main.tsx`:

```tsx
import { SessionWorkspacePage } from './pages/SessionWorkspacePage';

<Route path="/" element={<SessionWorkspacePage />} />
<Route path="/projects/:projectId" element={<SessionWorkspacePage />} />
<Route path="/projects/:projectId/sessions/:sessionId" element={<SessionWorkspacePage />} />
```

Remove `/projects/:projectId/rooms/:roomId` from primary navigation. If kept temporarily for manual old-data inspection, it must not be linked by AppShell or project workspace.

- [ ] **Step 3: AppShell nav language**

Modify `AppShell.tsx` visible nav copy:

- development label becomes `Sessions`;
- header project menu links to `/projects/:projectId`;
- avoid new UI using `shell-*` visual classes inside Session OS;
- keep AppShell outer shell stable until full app shell redesign.

- [ ] **Step 4: `index.css` cleanup guard**

Do not move Session OS styles into `index.css`. Add only one import path through component import. Run grep:

```bash
rtk rg -n "session-shell|session-workspace-grid|session-history|session-inspector" packages/frontend/src/index.css
```

Expected: no output.

- [ ] **Step 5: Route render tests**

`SessionWorkspacePage.test.tsx` must assert project route renders Session shell and does not render old room UI strings.

- [ ] **Step 6: Run frontend page tests**

Run:

```bash
rtk node --import tsx --test packages/frontend/src/pages/SessionWorkspacePage.test.tsx packages/frontend/src/components/AppShell.test.tsx
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
rtk git add packages/frontend/src/pages/SessionWorkspacePage.tsx packages/frontend/src/main.tsx packages/frontend/src/components/AppShell.tsx packages/frontend/src/index.css packages/frontend/src/pages/SessionWorkspacePage.test.tsx packages/frontend/src/components/AppShell.test.tsx
rtk git commit -m "feat(frontend): 切换项目入口到SessionOS"
```

## Task 11: 旧主工作流移除与可见语义清理

**Files:**
- Modify: `packages/frontend/src/pages/DevelopmentWorkspacePage.tsx`
- Modify: `packages/frontend/src/components/room/RoomWorkbench.tsx`
- Modify: `packages/frontend/src/components/TaskWorkspacePanel.tsx`
- Modify: `packages/frontend/src/lib/i18n.tsx`
- Modify: `packages/backend/src/routes.ts`
- Test: `packages/frontend/src/pages/SessionWorkspacePage.test.tsx`
- Test: `packages/backend/src/session.routes.test.ts`

- [ ] **Step 1: Remove old workspace from active imports**

`SessionWorkspacePage` must not import:

```ts
import { RoomWorkbench } from '../components/room/RoomWorkbench';
import { TaskWorkspacePanel } from '../components/TaskWorkspacePanel';
import { RoomTabsBar } from '../components/RoomTabsBar';
```

Run:

```bash
rtk rg -n "RoomWorkbench|TaskWorkspacePanel|RoomTabsBar" packages/frontend/src/pages/SessionWorkspacePage.tsx packages/frontend/src/session-ui
```

Expected: no output.

- [ ] **Step 2: Hide create room path from UI**

Remove visible create-room controls from main workspace. Old `/projects/:projectId/rooms` API can remain until data cleanup task, but no current route or primary button should create a room from Session OS.

- [ ] **Step 3: Replace user-facing group-chat copy**

Search:

```bash
rtk rg -n "群聊|任务列表|任务工作区|新增群聊|项目群聊" packages/frontend/src/session-ui packages/frontend/src/pages packages/frontend/src/components/AppShell.tsx
```

Expected: matches only in old components not reachable from Session OS, or no matches in new Session UI.

- [ ] **Step 4: Backend guard against automatic old task creation in session path**

Assert session message endpoint never imports or calls:

```ts
createTaskWithConversation
dispatchUserMessage
routeMessage
taskRepo.create
```

Run:

```bash
rtk rg -n "createTaskWithConversation|dispatchUserMessage|routeMessage|taskRepo\\.create" packages/backend/src/session.routes.ts packages/backend/src/session-runtime.ts
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/frontend/src/pages/DevelopmentWorkspacePage.tsx packages/frontend/src/components/room/RoomWorkbench.tsx packages/frontend/src/components/TaskWorkspacePanel.tsx packages/frontend/src/lib/i18n.tsx packages/backend/src/routes.ts packages/frontend/src/pages/SessionWorkspacePage.test.tsx packages/backend/src/session.routes.test.ts
rtk git commit -m "refactor: 移除旧群聊任务主入口"
```

## Task 12: 集成验证、浏览器检查与文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-06-05-会话与历史记录新模型设计.md`
- Modify: `docs/superpowers/plans/2026-06-05-会话历史模型与SessionOS实施计划.md`

- [ ] **Step 1: Run targeted backend tests**

Run:

```bash
rtk npm run test -w @openclaw-room/backend -- --test-reporter=spec
```

Expected: all backend tests PASS.

- [ ] **Step 2: Run frontend targeted tests**

Run:

```bash
rtk node --import tsx --test packages/frontend/src/session-ui/session-ui-model.test.ts packages/frontend/src/session-ui/SessionShell.test.tsx packages/frontend/src/pages/SessionWorkspacePage.test.tsx
```

Expected: all targeted frontend tests PASS.

- [ ] **Step 3: Run full build**

Run:

```bash
rtk npm run build
```

Expected: backend TypeScript build and frontend Vite build complete with exit code 0. Existing Vite chunk-size warnings are acceptable only if the command exits 0.

- [ ] **Step 4: Browser smoke check**

Start dev server:

```bash
rtk npm run dev
```

Open:

```text
http://localhost:5173/projects/<projectId>
```

Manual smoke assertions:

- first viewport shows History Records, Active Session and Status Inspector;
- `/status` opens or refreshes Status Inspector;
- `/compact` opens Compact Preview and does not apply summary before user action;
- `/new` writes one history record and opens a new active session;
- History record Resume creates a new session with resume brief;
- Fork displays source relation in History rail;
- mobile viewport has no horizontal scroll and command buttons remain at least 44px high.

- [ ] **Step 5: Update plan checkboxes**

Mark completed steps in this plan file and add verification evidence under this section:

```markdown
## Final Verification Evidence

- Backend tests: command + result.
- Frontend targeted tests: command + result.
- Build: command + result.
- Browser smoke: URL + checked states.
```

- [ ] **Step 6: Commit final docs**

```bash
rtk git add docs/superpowers/specs/2026-06-05-会话与历史记录新模型设计.md docs/superpowers/plans/2026-06-05-会话历史模型与SessionOS实施计划.md
rtk git commit -m "docs: 更新会话系统实施验收"
```

## 并行建议

- Task 1 到 Task 6 串行执行，因为它们定义共享 schema、API contract 和 runtime 行为。
- Task 7 可以在 Task 4 的 API shape 稳定后开始。
- Task 8 可以在 Task 7 的前端 DTO 草案完成后开始。
- Task 9 可以与 Task 10 前半段并行，但 `SessionShell` props 与 `SessionWorkspacePayload` 必须由 Task 7 统一。
- Task 11 和 Task 12 必须串行收尾。

## 自审结论

- Spec coverage：本计划覆盖新数据模型、命令、Status、Context Inspector、Compact Preview、Resume Brief、Fork Session、Evidence Timeline、API、runtime、UI 独立样式、路由硬切换和验证。
- Scope check：这是一个主实施计划，允许按 task 分段提交；如果执行中需要外部 worktree，可按 Task 1-6 后端串行、Task 7-10 前端串行拆为两个 worktree，但共享 types/API 仍需统一整合。
- Compatibility check：计划明确不让新 session path 调用旧 `createTaskWithConversation`、`dispatchUserMessage`、`routeMessage` 或旧 task repo 创建逻辑。
- UI coverage：计划明确 `session-ui/`、`session-os.css`、`session-` class、三栏布局、44px touch target、移动降级和旧 CSS 隔离检查。
- Verification coverage：每个 task 都有定向验证命令，最终 task 运行 backend tests、frontend targeted tests、`npm run build` 和浏览器 smoke check。
