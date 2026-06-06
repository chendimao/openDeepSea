# SessionShellView 路由保活 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `SessionShellView` 所在的新版 Session 工作台在当前浏览器 tab 内切换到其他页面再切回时保持原组件状态。

**Architecture:** 新增一个常驻的 Session keep-alive host，放在路由出口旁边而不是普通 route element 内。Session 路由激活时显示该 host，并把当前 URL 中的 `projectId/sessionId` 同步给 `SessionWorkspacePage`；非 Session 路由时隐藏 host 但不卸载，因此 `SessionWorkspacePage -> SessionShell -> SessionShellView` 的 React 本地状态、DOM ref、滚动容器和 WebSocket 状态继续存活。

**Tech Stack:** React 18、React Router v6、TypeScript、React Query、现有 `sessionSocket` WebSocket 客户端、Node `node:test` + `tsx` 定向测试、Vite build。

---

## Scope

本计划只覆盖新版 Session 工作台：

- `/`
- `/projects/:projectId`
- `/projects/:projectId/sessions/:sessionId`

本计划不删除、不重构、不迁移旧房间页或 `RoomWorkbench` 相关代码。刷新页面、关闭浏览器后恢复状态也不属于本次目标。

## File Structure

- Create: `packages/frontend/src/pages/sessionWorkspaceRoute.ts`
  - 负责识别当前 pathname 是否属于新版 Session 工作台，并解析 `projectId/sessionId`。
- Create: `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.tsx`
  - 常驻挂载 `SessionWorkspacePage`，根据当前 URL 显示或隐藏。
- Create: `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx`
  - 覆盖路由识别、host 初始可见/隐藏、切出后仍保留同一个 Session 页面实例。
- Modify: `packages/frontend/src/pages/SessionWorkspacePage.tsx`
  - 支持从 props 接收 keep-alive host 解析出的 `projectId/sessionId`，保留独立 route 使用能力。
- Modify: `packages/frontend/src/main.tsx`
  - 将 Session 工作台 route 从普通 `<Routes>` 中替换为常驻 host + 空 route 占位。

---

### Task 1: Session 路由识别 helper

**Files:**
- Create: `packages/frontend/src/pages/sessionWorkspaceRoute.ts`
- Test: `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx`

- [ ] **Step 1: Write the failing test**

在 `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx` 中先写 helper 测试：

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSessionWorkspaceRouteParams,
  isSessionWorkspacePath,
} from './sessionWorkspaceRoute';

test('isSessionWorkspacePath matches only new Session workspace routes', () => {
  assert.equal(isSessionWorkspacePath('/'), true);
  assert.equal(isSessionWorkspacePath('/projects/project-1'), true);
  assert.equal(isSessionWorkspacePath('/projects/project-1/'), true);
  assert.equal(isSessionWorkspacePath('/projects/project-1/sessions/session-1'), true);
  assert.equal(isSessionWorkspacePath('/projects/project-1/sessions/session-1/'), true);

  assert.equal(isSessionWorkspacePath('/chat'), false);
  assert.equal(isSessionWorkspacePath('/agents'), false);
  assert.equal(isSessionWorkspacePath('/skills'), false);
  assert.equal(isSessionWorkspacePath('/files'), false);
  assert.equal(isSessionWorkspacePath('/projects/project-1/files'), false);
  assert.equal(isSessionWorkspacePath('/projects/project-1/rooms/room-1'), false);
});

test('getSessionWorkspaceRouteParams extracts project and session params', () => {
  assert.deepEqual(getSessionWorkspaceRouteParams('/'), {
    active: true,
    projectId: '',
    sessionId: undefined,
  });
  assert.deepEqual(getSessionWorkspaceRouteParams('/projects/project-1'), {
    active: true,
    projectId: 'project-1',
    sessionId: undefined,
  });
  assert.deepEqual(getSessionWorkspaceRouteParams('/projects/project-1/sessions/session-1'), {
    active: true,
    projectId: 'project-1',
    sessionId: 'session-1',
  });
  assert.deepEqual(getSessionWorkspaceRouteParams('/files'), {
    active: false,
    projectId: '',
    sessionId: undefined,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm exec -- node --import tsx --test packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx
```

Expected: FAIL，错误包含 `Cannot find module './sessionWorkspaceRoute'`。

- [ ] **Step 3: Write minimal implementation**

创建 `packages/frontend/src/pages/sessionWorkspaceRoute.ts`：

```ts
export type SessionWorkspaceRouteParams = {
  active: boolean;
  projectId: string;
  sessionId?: string;
};

export function isSessionWorkspacePath(pathname: string): boolean {
  return getSessionWorkspaceRouteParams(pathname).active;
}

export function getSessionWorkspaceRouteParams(pathname: string): SessionWorkspaceRouteParams {
  const normalized = normalizePathname(pathname);
  if (normalized === '/') {
    return { active: true, projectId: '', sessionId: undefined };
  }

  const projectMatch = normalized.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    return {
      active: true,
      projectId: decodeURIComponent(projectMatch[1]),
      sessionId: undefined,
    };
  }

  const sessionMatch = normalized.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    return {
      active: true,
      projectId: decodeURIComponent(sessionMatch[1]),
      sessionId: decodeURIComponent(sessionMatch[2]),
    };
  }

  return { active: false, projectId: '', sessionId: undefined };
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm exec -- node --import tsx --test packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx
```

Expected: PASS，2 个 helper 测试通过。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/pages/sessionWorkspaceRoute.ts packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx
git commit -m "test(frontend): 增加Session路由识别测试"
```

---

### Task 2: 让 SessionWorkspacePage 支持 host 参数

**Files:**
- Modify: `packages/frontend/src/pages/SessionWorkspacePage.tsx`
- Test: `packages/frontend/src/pages/SessionWorkspacePage.test.tsx`

- [ ] **Step 1: Write the failing test**

在 `packages/frontend/src/pages/SessionWorkspacePage.test.tsx` 增加一个 props 渲染测试，确认该组件不再只能依赖 `useParams()`：

```tsx
test('SessionWorkspacePage can render from keep-alive host route params', () => {
  const html = renderSessionWorkspaceWithProps({
    projectId: 'project-1',
    sessionId: 'session-1',
  });

  assert.match(html, /session-shell/);
  assert.match(html, /加载 Session/);
});
```

在同文件底部增加 helper：

```tsx
function renderSessionWorkspaceWithProps(input: { projectId: string; sessionId?: string }): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['projects'], [{ id: input.projectId, name: 'Project 1' }]);

  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/files']}>
          <SessionWorkspacePage
            projectIdOverride={input.projectId}
            sessionIdOverride={input.sessionId}
          />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm exec -- node --import tsx --test packages/frontend/src/pages/SessionWorkspacePage.test.tsx
```

Expected: FAIL，TypeScript/tsx 报告 `projectIdOverride` 或 `sessionIdOverride` 不是 `SessionWorkspacePage` 的有效 props。

- [ ] **Step 3: Write minimal implementation**

修改 `packages/frontend/src/pages/SessionWorkspacePage.tsx` 的组件签名和参数解析：

```tsx
type SessionWorkspacePageProps = {
  projectIdOverride?: string;
  sessionIdOverride?: string;
};

export function SessionWorkspacePage({
  projectIdOverride,
  sessionIdOverride,
}: SessionWorkspacePageProps = {}): JSX.Element {
  const routeParams = useParams();
  const projectId = projectIdOverride ?? routeParams.projectId ?? '';
  const sessionId = sessionIdOverride ?? routeParams.sessionId;
```

替换原有这行：

```tsx
const { projectId = '', sessionId } = useParams();
```

保留 `navigate`、`activeProjectId`、WebSocket 订阅和渲染逻辑不变。

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm exec -- node --import tsx --test packages/frontend/src/pages/SessionWorkspacePage.test.tsx
```

Expected: PASS，新增 props 测试和既有测试都通过。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/pages/SessionWorkspacePage.tsx packages/frontend/src/pages/SessionWorkspacePage.test.tsx
git commit -m "refactor(frontend): 支持Session页面外部路由参数"
```

---

### Task 3: 新增 KeepAlive host

**Files:**
- Create: `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.tsx`
- Modify: `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx`

- [ ] **Step 1: Write the failing test**

在 `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx` 追加 host SSR 测试：

```tsx
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import { SessionWorkspaceKeepAliveHost } from './SessionWorkspaceKeepAliveHost';

test('SessionWorkspaceKeepAliveHost is visible on Session workspace routes', () => {
  const html = renderKeepAliveHost('/projects/project-1/sessions/session-1');

  assert.match(html, /data-testid="session-workspace-keep-alive"/);
  assert.match(html, /data-active="true"/);
  assert.match(html, /加载 Session/);
});

test('SessionWorkspaceKeepAliveHost starts hidden on non-Session routes', () => {
  const html = renderKeepAliveHost('/files');

  assert.match(html, /data-testid="session-workspace-keep-alive"/);
  assert.match(html, /data-active="false"/);
  assert.doesNotMatch(html, /加载 Session/);
});

function renderKeepAliveHost(initialEntry: string): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['projects'], [{ id: 'project-1', name: 'Project 1' }]);

  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <SessionWorkspaceKeepAliveHost />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm exec -- node --import tsx --test packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx
```

Expected: FAIL，错误包含 `Cannot find module './SessionWorkspaceKeepAliveHost'`。

- [ ] **Step 3: Write minimal implementation**

创建 `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.tsx`：

```tsx
import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '../lib/utils';
import { SessionWorkspacePage } from './SessionWorkspacePage';
import {
  getSessionWorkspaceRouteParams,
  type SessionWorkspaceRouteParams,
} from './sessionWorkspaceRoute';

export function SessionWorkspaceKeepAliveHost(): JSX.Element {
  const location = useLocation();
  const routeParams = getSessionWorkspaceRouteParams(location.pathname);
  const [lastSessionRoute, setLastSessionRoute] = useState<SessionWorkspaceRouteParams | null>(
    routeParams.active ? routeParams : null,
  );

  useEffect(() => {
    if (routeParams.active) setLastSessionRoute(routeParams);
  }, [routeParams.active, routeParams.projectId, routeParams.sessionId]);

  const active = routeParams.active;
  const pageParams = active ? routeParams : lastSessionRoute;

  return (
    <div
      data-testid="session-workspace-keep-alive"
      data-active={active ? 'true' : 'false'}
      className={cn('h-full min-h-0', !active && 'hidden')}
      aria-hidden={active ? undefined : true}
    >
      {pageParams && (
        <SessionWorkspacePage
          projectIdOverride={pageParams.projectId}
          sessionIdOverride={pageParams.sessionId}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm exec -- node --import tsx --test packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx
```

Expected: PASS，helper 和 host SSR 测试都通过。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.tsx packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx
git commit -m "feat(frontend): 增加Session工作台保活宿主"
```

---

### Task 4: 接入应用路由

**Files:**
- Modify: `packages/frontend/src/main.tsx`
- Modify: `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx`

- [ ] **Step 1: Write the failing test**

在 `packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx` 增加一个静态源码测试，防止 Session route 被重新放回普通 route element：

```tsx
import { readFileSync } from 'node:fs';

test('main route tree mounts Session keep-alive host outside ordinary routes', () => {
  const source = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');

  assert.match(source, /<SessionWorkspaceKeepAliveHost \/>/);
  assert.doesNotMatch(source, /path="\/" element={<SessionWorkspacePage \/>}/);
  assert.doesNotMatch(source, /path="\/projects\/:projectId" element={<SessionWorkspacePage \/>}/);
  assert.doesNotMatch(source, /path="\/projects\/:projectId\/sessions\/:sessionId" element={<SessionWorkspacePage \/>}/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm exec -- node --import tsx --test packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx
```

Expected: FAIL，因为 `main.tsx` 尚未引入和挂载 `SessionWorkspaceKeepAliveHost`。

- [ ] **Step 3: Write minimal implementation**

修改 `packages/frontend/src/main.tsx` import：

```tsx
import { SessionWorkspaceKeepAliveHost } from './pages/SessionWorkspaceKeepAliveHost';
```

移除：

```tsx
import { SessionWorkspacePage } from './pages/SessionWorkspacePage';
```

在 `<ProviderSuperpowersStartupNotice />` 后挂载 host，并把 Session routes 改成空占位：

```tsx
<ProviderSuperpowersStartupNotice />
<SessionWorkspaceKeepAliveHost />
<Routes>
  <Route path="/" element={null} />
  <Route path="/chat" element={<GlobalChatPage />} />
  <Route path="/agents" element={<AgentsPage />} />
  <Route path="/files" element={<FilesPage />} />
  <Route path="/skills" element={<SkillsPage />} />
  <Route path="/test" element={<TestPage />} />
  <Route path="/projects/:projectId" element={null} />
  <Route path="/projects/:projectId/sessions/:sessionId" element={null} />
  <Route path="/projects/:projectId/files" element={<FilesPage />} />
  <Route path="*" element={<Navigate to="/" replace />} />
</Routes>
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm exec -- node --import tsx --test packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/main.tsx packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx
git commit -m "feat(frontend): 接入Session页面路由保活"
```

---

### Task 5: Final verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm exec -- node --import tsx --test packages/frontend/src/pages/SessionWorkspaceKeepAliveHost.test.tsx packages/frontend/src/pages/SessionWorkspacePage.test.tsx
```

Expected: PASS，所有 Session workspace 相关测试通过。

- [ ] **Step 2: Run frontend build**

Run:

```bash
npm run build -w @openclaw-room/frontend
```

Expected: PASS，TypeScript 编译和 Vite build 完成。

- [ ] **Step 3: Run full build**

Run:

```bash
npm run build
```

Expected: PASS，后端 TypeScript 编译和前端 build 完成。

- [ ] **Step 4: Manual smoke test in browser**

Run:

```bash
npm run dev
```

Manual steps:

1. 打开 `http://localhost:5173/projects/<projectId>/sessions/<sessionId>`。
2. 在 `SessionShellView` 中打开项目切换器或其他本地 UI 控件。
3. 切到 `/files`、`/agents` 或 `/skills`。
4. 切回原 Session URL。
5. 确认刚才打开的本地 UI 控件仍保持原状态，正在运行的 stream 或状态更新仍能继续显示。

Expected: Session 工作台切回后不是重新加载出来的空白状态，`SessionShellView` 的本地交互状态保留。

- [ ] **Step 5: Commit verification notes if docs changed during execution**

如果执行过程中更新了计划勾选状态或新增验收文档：

```bash
git add docs/superpowers/plans/2026-06-06-SessionShellView路由保活.md
git commit -m "docs: 更新Session保活执行计划"
```

---

## Self-Review

- Spec coverage: 本计划覆盖当前 tab 内 `SessionShellView` 路由切换保活；不覆盖刷新浏览器后的持久恢复；不包含 `RoomWorkbench` 删除。
- Placeholder scan: 未发现占位项、延后实现项或未定义函数名。每个代码改动步骤包含具体文件和代码片段。
- Type consistency: `SessionWorkspaceRouteParams`、`projectIdOverride`、`sessionIdOverride`、`SessionWorkspaceKeepAliveHost` 在任务之间命名一致。
