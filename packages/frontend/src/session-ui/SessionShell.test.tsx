import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ActiveSessionSummary, ProjectUsedAgentsPayload, SessionAgentEvent, SessionWorkspacePayload } from '../lib/types';
import { I18nProvider } from '../lib/i18n';
import {
  SessionShellView,
  SESSION_SIDEBAR_PREFS_STORAGE_KEY,
  buildSessionSidebarModel,
  buildProjectReorderInput,
  buildTranscriptFollowKey,
  buildSessionRunTranscriptItems,
  getLatestUserMessageKey,
  getSessionRunThinkingDuration,
  isTranscriptNearBottom,
  shouldIgnoreProjectDragStart,
  sortSessionsForSidebar,
  syncExpandedProjectIds,
  writeSessionSidebarPrefs,
} from './SessionShellView';

const sessionOsCss = readFileSync(new URL('./session-os.css', import.meta.url), 'utf8');
const sessionShellViewSource = readFileSync(new URL('./SessionShellView.tsx', import.meta.url), 'utf8');
const localStorageValues = new Map<string, string>();

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    },
    clear: () => {
      localStorageValues.clear();
    },
  },
  configurable: true,
});

test('SessionShell renders Deepsea command center modules', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /Session Operations Console/);
  assert.match(html, /项目智能体/);
  assert.match(html, /设置会话规划智能体/);
  assert.match(html, /workspace/);
  assert.match(html, /OpenClaw/);
  assert.doesNotMatch(html, /Project command bar/);
  assert.doesNotMatch(html, /切换项目/);
  assert.doesNotMatch(html, /项目切换器/);
  assert.doesNotMatch(html, /选择一个工作区以继续您的任务/);
  assert.doesNotMatch(html, /deepsea-command-center/);
  assert.doesNotMatch(html, /quantum-core-engine/);
  assert.doesNotMatch(html, /nebula-ui-kit/);
  assert.doesNotMatch(html, /retry_handler\.py/);
  assert.doesNotMatch(html, /sync_service\.py/);
  assert.doesNotMatch(html, /1,242 tokens/);
  assert.doesNotMatch(html, /分析当前会话页面结构/);
  assert.doesNotMatch(html, /还原 Deepsea 三栏布局/);
  assert.doesNotMatch(html, /运行浏览器 smoke test/);
  assert.doesNotMatch(html, /当前激活/);
  assert.doesNotMatch(html, /deepsea-project-card--add/);
  assert.doesNotMatch(html, /管理所有工作区/);
  assert.match(html, /上下文压力/);
  assert.match(html, /Session status bar/);
  assert.doesNotMatch(html, /系统健康状态/);
  assert.doesNotMatch(html, /索引状态/);
  assert.match(html, /新建会话/);
  assert.doesNotMatch(html, /新建聊天/);
  assert.doesNotMatch(html, /deepsea-project-chat-section/);
  assert.doesNotMatch(html, /暂无聊天/);
  assert.match(html, /<span>项目<\/span>/);
  assert.match(html, /Project Sessions/);
  assert.doesNotMatch(html, /接口联调/);
  assert.match(html, /AnotherProject/);
  assert.doesNotMatch(html, /会话历史/);
  assert.match(html, /3. 对话记录/);
  assert.doesNotMatch(html, /prompt-area-container/);
  assert.match(html, /data-session-composer-textarea="true"/);
  assert.match(html, /粘贴文件会上传到项目文件库/);
  assert.match(html, /目标契约/);
  assert.match(html, /会话计划/);
  assert.match(html, /代理运行/);
  assert.match(html, /工具调用/);
  assert.match(html, /本次会话变更/);
  assert.match(html, /Session Changes/);
  assert.match(html, /本会话 1 个文件变更/);
  assert.match(html, /\+12 \/ -3/);
  assert.match(html, /立即应用/);
  assert.match(html, /data-command="\/compact"/);
  assert.match(html, /\/fork history:history-1/);
  assert.match(html, /Project Sessions/);
  assert.doesNotMatch(html, /task-workspace/);
  assert.doesNotMatch(html, /Deepsea Command/);
  assert.doesNotMatch(html, /deepsea-model-status/);
  assert.doesNotMatch(html, /当前状态/);
});

test('SessionShell renders current session token usage in the bottom status bar', () => {
  const payload = createPayload();
  payload.bottomStatus.tokenUsage = {
    input: 10_000,
    output: 2_345,
    total: 12_345,
  };

  const html = renderSessionShell(payload);

  assert.match(html, /Token 消耗/);
  assert.match(html, /12,345 tokens/);
  assert.doesNotMatch(html, /API 消耗/);
});

test('SessionShell renders tool rows as detail buttons', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /data-tool-row-button="true"/);
  assert.match(html, /aria-label="查看工具调用详情：packages\/frontend\/src\/session-ui\/SessionShell\.tsx"/);
});

test('SessionShell renders uploaded attachments on transcript messages', () => {
  const payload = createPayload();
  payload.activeSession.messages[0] = {
    ...payload.activeSession.messages[0]!,
    content: '分析这些附件',
    metadata: JSON.stringify({
      attachments: [
        {
          id: 'file-text-1',
          fileId: 'file-text-1',
          name: 'brief.txt',
          mimeType: 'text/plain',
          size: 1536,
          url: '/uploads/files/project-1/brief.txt',
          isImage: false,
        },
        {
          id: 'file-image-1',
          fileId: 'file-image-1',
          name: 'screen.png',
          mimeType: 'image/png',
          size: 2048,
          url: '/uploads/files/project-1/screen.png',
          isImage: true,
        },
      ],
    }),
  };

  const html = renderSessionShell(payload);

  assert.match(html, /deepsea-message-attachments/);
  assert.match(html, /brief\.txt/);
  assert.match(html, /screen\.png/);
  assert.match(html, /src="\/uploads\/files\/project-1\/screen\.png"/);
  assert.match(html, /aria-label="预览图片附件：screen\.png"/);
  assert.match(html, /1\.5 KB/);
  assert.match(html, /2\.0 KB/);
});

test('SessionShell renders active run as compact list row', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /deepsea-run-table/);
  assert.match(html, /1 条记录/);
  assert.match(html, /gpt-5\.5/);
  assert.match(html, /aria-label="运行状态：完成"/);
  assert.match(html, /aria-label="停止运行"/);
  assert.match(html, /aria-label="重新执行"/);
  assert.doesNotMatch(html, /deepsea-run-card/);
  assert.doesNotMatch(html, /运行耗时/);
});

test('SessionShell renders active run danger state without success semantics', () => {
  const payload = createPayload();
  payload.activeSession.runs[0] = {
    ...payload.activeSession.runs[0]!,
    status: 'failed',
    error: '执行失败',
  };

  const html = renderSessionShell(payload);

  assert.match(html, /data-tone="danger"/);
  assert.match(html, /aria-label="运行状态：失败"/);
  assert.match(html, /<strong>失败<\/strong>/);
  assert.doesNotMatch(html, /aria-label="运行状态：完成"/);
});

test('SessionShell renders tool row duration from the individual tool event', () => {
  const payload = createPayload();
  payload.toolRows[0] = {
    ...payload.toolRows[0]!,
    durationMs: 343,
    runDurationMs: 21_423,
  };

  const html = renderSessionShell(payload);

  assert.match(html, /0\.3s/);
  assert.doesNotMatch(html, /21\.4s/);
});

test('SessionShell renders tool row relative record time beside duration', () => {
  const payload = createPayload();
  payload.toolRows[0] = {
    ...payload.toolRows[0]!,
    durationMs: 343,
    runDurationMs: 21_423,
    created_at: Date.now(),
  };

  const html = renderSessionShell(payload);

  assert.match(html, /class="deepsea-tool-row-duration">0\.3s<\/span>/);
  assert.match(html, /class="deepsea-tool-row-time">刚刚<\/span>/);
});

test('SessionShell renders compact tool rows without ordinal numbers', () => {
  const html = renderSessionShell(createPayload());

  assert.doesNotMatch(html, /<span class="deepsea-tool-row-index">1<\/span>/);
  assert.match(html, /class="deepsea-tool-row-duration"/);
  assert.match(html, /class="deepsea-tool-row-time"/);
});

test('SessionShell renders failed tool rows with an X status icon', () => {
  const payload = createPayload();
  payload.toolRows[0] = {
    ...payload.toolRows[0]!,
    status: 'failed',
    severity: 'error',
  };

  const html = renderSessionShell(payload);

  assert.match(html, /data-tool-row-status="failed"/);
  assert.match(html, /aria-label="工具调用状态：失败"/);
  assert.match(html, /data-tool-row-status="failed"[^>]*><svg[^>]+lucide-x/s);
});

test('SessionShell keeps the tool call list height bounded with internal scrolling', () => {
  assert.match(sessionOsCss, /\.deepsea-tool-table\s*\{[^}]*max-height:\s*min\(320px,\s*36dvh\)/s);
  assert.match(sessionOsCss, /\.deepsea-tool-table\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(sessionOsCss, /\.deepsea-tool-table\s*\{[^}]*overscroll-behavior:\s*contain/s);
});

test('SessionShell keeps planner skill picker bounded with internal scrolling', () => {
  assert.match(sessionOsCss, /\.deepsea-skill-picker\s*\{[^}]*max-height:\s*min\(320px,\s*48vh\)/s);
  assert.match(sessionOsCss, /\.deepsea-skill-picker\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(sessionOsCss, /\.deepsea-skill-picker\s*\{[^}]*overscroll-behavior:\s*contain/s);
});

test('SessionShell renders upload and knowledge file buttons beside send', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /aria-label="上传文件"/);
  assert.match(html, /aria-label="从知识库选择文件"/);
  assert.match(html, /type="file"/);
  assert.match(sessionOsCss, /\.deepsea-composer__file-actions\s*\{[^}]*display:\s*flex/s);
  assert.match(sessionOsCss, /\.deepsea-composer__icon-button\s*\{[^}]*width:\s*30px/s);
});

test('SessionShell styles selected planner skill chips separately from attachments', () => {
  assert.match(sessionOsCss, /\.deepsea-composer-skill-chips\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(sessionOsCss, /\.deepsea-composer-skill-chip\s*\{[^}]*background:\s*rgba\(99,\s*102,\s*241,\s*0\.12\)/s);
  assert.match(sessionOsCss, /\.deepsea-composer-skill-chip\s*\{[^}]*color:\s*rgb\(49,\s*46,\s*129\)/s);
  assert.match(sessionOsCss, /\.deepsea-composer-skill-chip__name\s*\{[^}]*font-family:\s*var\(--deepsea-mono\)/s);
});

test('SessionShell includes project tree row pin and drag feedback styles', () => {
  assert.match(sessionOsCss, /\.deepsea-project-node__actions\s*\{[^}]*opacity:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__actions\s*\{[^}]*position:\s*absolute/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__actions\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(sessionOsCss, /\.deepsea-project-node:hover \.deepsea-project-node__button,[\s\S]*padding-right:\s*56px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node:hover \.deepsea-project-node__actions/s);
  assert.match(sessionOsCss, /\.deepsea-project-node:focus-within \.deepsea-project-node__actions/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__actions:has\(\.deepsea-project-node__icon-button\[aria-expanded="true"\]\)/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\s*\{[^}]*display:\s*grid/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\s*\{[^}]*grid-template-columns:\s*14px minmax\(0,\s*1fr\)/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-pin\s*\{[^}]*border:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-pin\s*\{[^}]*background:\s*transparent/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-pin\s*\{[^}]*opacity:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap:hover \.deepsea-project-session-pin/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-section\[data-drop-target="true"\]/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-section\[data-dragging="true"\]/s);
});

test('SessionShell project rail CSS keeps the reference-style compact hierarchy', () => {
  assert.match(sessionOsCss, /\.deepsea-main\s*\{[^}]*grid-template-columns:\s*292px minmax\(500px,\s*1fr\) 420px/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading\s*\{[^}]*margin-bottom:\s*12px/s);
  assert.match(
    sessionOsCss,
    /\.deepsea-project-tree-heading:hover,\s*\.deepsea-project-tree-heading:focus-within\s*\{\s*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s,
  );
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading > span\s*\{[^}]*font-size:\s*13px/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading > span\s*\{[^}]*line-height:\s*18px/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading button\s*\{[^}]*width:\s*22px/s);
  assert.match(sessionOsCss, /\.deepsea-project-tree-heading button\s*\{[^}]*height:\s*22px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node\s*\{[^}]*min-height:\s*30px/s);
  assert.match(
    sessionOsCss,
    /\.deepsea-project-node:hover,\s*\.deepsea-project-node:focus-within\s*\{\s*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s,
  );
  assert.doesNotMatch(
    sessionOsCss,
    /\.deepsea-project-tree-section\[data-active="true"\] \.deepsea-project-node,[\s\S]*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s,
  );
  assert.match(sessionOsCss, /\.deepsea-project-node__button\s*\{[^}]*padding:\s*3px 10px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__button svg\s*\{[^}]*width:\s*14px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__label strong\s*\{[^}]*font-size:\s*13px/s);
  assert.match(sessionOsCss, /\.deepsea-project-node__sessions\s*\{[^}]*margin:\s*4px 0 6px 0/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\s*\{[^}]*padding-left:\s*10px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-pin svg\s*\{[^}]*width:\s*14px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row\s*\{[^}]*min-height:\s*28px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row\s*\{[^}]*padding:\s*4px 8px 4px 4px/s);
  assert.match(
    sessionOsCss,
    /\.deepsea-project-session-row-wrap:hover,\s*\.deepsea-project-session-row-wrap:focus-within\s*\{\s*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s,
  );
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\[data-current="true"\]\s*\{[^}]*background:\s*rgba\(67,\s*70,\s*84,\s*0\.1\)/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row-wrap\[data-current="true"\]\s*\{[^}]*box-shadow:\s*none/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-project-session-row\[data-current="true"\]\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__title\s*\{[^}]*font-size:\s*13px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__time\s*\{[^}]*min-width:\s*46px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__time\s*\{[^}]*font-size:\s*12px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__time\s*\{[^}]*text-align:\s*right/s);
});

test('SessionShell styles sidebar organize menu and time rows', () => {
  assert.match(sessionOsCss, /\.deepsea-project-filter-menu\s*\{[^}]*z-index:\s*80/s);
  assert.match(sessionOsCss, /\.deepsea-project-filter-menu__item\s*\{[^}]*min-height:\s*28px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row--time\s*\{[^}]*min-height:\s*42px/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__stack\s*\{[^}]*display:\s*grid/s);
  assert.match(sessionOsCss, /\.deepsea-project-session-row__project\s*\{[^}]*font-size:\s*11px/s);
});

test('SessionShell renders current session when active sessions are absent from legacy payloads', () => {
  const { activeSessions: _activeSessions, ...legacyPayload } = createPayload();

  const html = renderSessionShell(legacyPayload as unknown as SessionWorkspacePayload);

  assert.match(html, /新建会话/);
  assert.match(html, /<span>项目<\/span>/);
  assert.match(html, /SessionOS 迁移/);
});

test('SessionShell expands the current project by default and collapses other projects', () => {
  const payload = createPayload();
  payload.projectSwitcher.projects.push({
    id: 'project-empty',
    name: 'EmptyProject',
    path: '/workspace/empty',
    active: false,
    created_at: Date.now() - 10_000,
    updated_at: Date.now() - 10_000,
    pinned_at: null,
    sort_order: null,
    recentSessions: [],
  });

  const html = renderSessionShell(payload);

  assert.match(html, /新建会话/);
  assert.match(html, /<span>项目<\/span>/);
  assert.match(html, /OpenClaw/);
  assert.match(html, /AnotherProject/);
  assert.doesNotMatch(html, /EmptyProject/);
  assert.match(html, /SessionOS 迁移/);
  assert.doesNotMatch(html, /接口联调/);
  assert.doesNotMatch(html, /暂无活跃会话/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-sortable="true"[^>]*draggable="true"/);
  assert.match(html, /data-sortable="false"[^>]*draggable="false"[\s\S]*AnotherProject/);
  assert.match(html, /data-project-session-row="true"/);
});

test('SessionShell hides project-level actions for orphan fallback projects', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /aria-label="打开 OpenClaw 项目操作菜单"/);
  assert.match(html, /aria-label="新建 OpenClaw 会话"/);
  assert.doesNotMatch(html, /aria-label="打开 AnotherProject 项目操作菜单"/);
  assert.doesNotMatch(html, /aria-label="新建 AnotherProject 会话"/);
});

test('SessionShell uses Radix project action menu with only rename and remove items', () => {
  const html = renderSessionShell(createPayload());

  assert.match(sessionShellViewSource, /import \* as DropdownMenu from '@radix-ui\/react-dropdown-menu'/);
  assert.match(sessionShellViewSource, /<DropdownMenu\.Root/);
  assert.match(sessionShellViewSource, /<DropdownMenu\.Trigger asChild>/);
  assert.match(sessionShellViewSource, /<DropdownMenu\.Item/);
  assert.match(sessionShellViewSource, /编辑名称/);
  assert.match(sessionShellViewSource, /移除/);
  assert.doesNotMatch(html, /在“访达”中打开/);
  assert.doesNotMatch(html, /创建永久工作树/);
  assert.doesNotMatch(html, /归档聊天/);
  assert.doesNotMatch(sessionShellViewSource, /data-disabled="true"/);
  assert.doesNotMatch(sessionShellViewSource, /<div\s+className="deepsea-project-node__menu"/);
  assert.doesNotMatch(sessionShellViewSource, /aria-hidden={projectMenuOpen/);
  assert.doesNotMatch(sessionShellViewSource, /data-state={projectMenuOpen/);
  assert.doesNotMatch(sessionShellViewSource, /role="menuitem"/);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-project-node__menu\s*\{[^}]*position:\s*absolute/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-project-node__menu\s*\{[^}]*top:\s*30px/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-project-node__menu\s*\{[^}]*right:\s*8px/s);
});

test('SessionShell renders sidebar organize menu and create project action', () => {
  localStorageValues.clear();
  const html = renderSessionShell(createPayload());

  assert.match(html, /aria-label="筛选、排序和整理会话"/);
  assert.match(html, /aria-label="添加项目"/);
  assert.match(sessionShellViewSource, /整理/);
  assert.match(sessionShellViewSource, /按项目/);
  assert.match(sessionShellViewSource, /时间顺序列表/);
  assert.match(sessionShellViewSource, /排序条件/);
  assert.match(sessionShellViewSource, /已创建/);
  assert.match(sessionShellViewSource, /已更新/);
  assert.match(sessionShellViewSource, /所有聊天/);
  assert.match(sessionShellViewSource, /置顶/);
});

test('writeSessionSidebarPrefs ignores localStorage persistence failures', () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      setItem: () => {
        throw new Error('storage disabled');
      },
    },
    configurable: true,
  });

  try {
    assert.doesNotThrow(() => writeSessionSidebarPrefs({
      groupMode: 'time',
      sortMode: 'updated',
      visibility: 'all',
    }));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    });
  }
});

test('SessionShell renders time ordered sidebar rows from stored preferences', () => {
  localStorageValues.clear();
  localStorageValues.set(SESSION_SIDEBAR_PREFS_STORAGE_KEY, JSON.stringify({
    groupMode: 'time',
    sortMode: 'updated',
    visibility: 'all',
  }));
  const payload = createPayload();
  payload.projectSwitcher.projects.push({
    id: 'project-2',
    name: 'AnotherProject',
    path: '/workspace/another',
    active: false,
    created_at: Date.now() - 12_000,
    updated_at: Date.now() - 8_000,
    pinned_at: null,
    sort_order: null,
    recentSessions: [],
  });

  const html = renderSessionShell(payload);

  assert.match(html, /data-session-sidebar-mode="time"/);
  assert.match(html, /<span>聊天<\/span>/);
  assert.match(html, /data-session-sidebar-time-row="true"/);
  assert.match(html, /AnotherProject/);
  assert.doesNotMatch(html, /aria-label="切换 OpenClaw 项目展开状态"/);
});

test('SessionShell source wires project and session action callbacks', () => {
  assert.match(
    sessionShellViewSource,
    /<DropdownMenu\.Item[\s\S]*onSelect=\{\(\) => \{[\s\S]*if \(item\.label === '编辑名称'\) onRenameProject\?\.\(project\);[\s\S]*else onRemoveProject\?\.\(project\);[\s\S]*\}\}/,
  );
  assert.match(
    sessionShellViewSource,
    /onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*onToggleSessionPin\?\.\(session\);[\s\S]*\}\}/,
  );
  assert.match(
    sessionShellViewSource,
    /const input = buildProjectReorderInput\(projects, draggingProjectId, targetProject\.id\);[\s\S]*if \(input\) onReorderProjects\?\.\(input\);/,
  );
});

test('SessionShell renders project row without a collapse icon before the project name', () => {
  localStorageValues.clear();
  const html = renderSessionShell(createPayload());

  assert.doesNotMatch(html, /data-project-collapse-icon="true"/);
  assert.match(html, /lucide-folder-open/);
});

test('SessionShell renders session pin buttons independently from opening sessions', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /data-session-pin-button="true"/);
  assert.match(html, /aria-label="置顶会话：SessionOS 迁移"/);
  assert.match(html, /data-session-pin-button="true"[^>]*data-pinned="false"/);
});

test('buildProjectReorderInput returns same-layer reorder ids', () => {
  const now = Date.now();
  const projects = [
    { id: 'project-1', name: 'A', path: '/a', active: false, recentSessions: [], created_at: now - 3, pinned_at: null, sort_order: 1 },
    { id: 'project-2', name: 'B', path: '/b', active: false, recentSessions: [], created_at: now - 2, pinned_at: null, sort_order: 2 },
    { id: 'project-3', name: 'C', path: '/c', active: false, recentSessions: [], created_at: now - 1, pinned_at: null, sort_order: 3 },
  ];

  assert.deepEqual(buildProjectReorderInput(projects, 'project-3', 'project-1'), {
    ids: ['project-3', 'project-1', 'project-2'],
    pinned: false,
  });
});

test('buildProjectReorderInput ignores same item and cross-layer reorders', () => {
  const now = Date.now();
  const projects = [
    { id: 'project-1', name: 'A', path: '/a', active: false, recentSessions: [], created_at: now - 3, pinned_at: now - 10, sort_order: 1 },
    { id: 'project-2', name: 'B', path: '/b', active: false, recentSessions: [], created_at: now - 2, pinned_at: null, sort_order: 2 },
    { id: 'project-3', name: 'C', path: '/c', active: false, recentSessions: [], created_at: now - 1, pinned_at: null, sort_order: 3 },
  ];

  assert.equal(buildProjectReorderInput(projects, 'project-2', 'project-2'), null);
  assert.equal(buildProjectReorderInput(projects, 'project-1', 'project-2'), null);
  assert.equal(buildProjectReorderInput(projects, 'missing-project', 'project-2'), null);
  assert.equal(buildProjectReorderInput(projects, 'project-2', 'missing-project'), null);
  assert.equal(buildProjectReorderInput(projects, 'orphan:x', 'project-2'), null);
  assert.equal(buildProjectReorderInput([
    ...projects,
    { id: 'orphan:x', name: 'Orphan', path: '/orphan', active: false, recentSessions: [], created_at: now, pinned_at: null, sort_order: null },
  ], 'project-2', 'orphan:x'), null);
});

test('buildProjectReorderInput returns pinned layer ids for pinned same-layer reorder', () => {
  const now = Date.now();
  const projects = [
    { id: 'project-1', name: 'A', path: '/a', active: false, recentSessions: [], created_at: now - 3, pinned_at: now - 30, sort_order: 1 },
    { id: 'project-2', name: 'B', path: '/b', active: false, recentSessions: [], created_at: now - 2, pinned_at: now - 20, sort_order: 2 },
    { id: 'project-3', name: 'C', path: '/c', active: false, recentSessions: [], created_at: now - 1, pinned_at: null, sort_order: 3 },
  ];

  assert.deepEqual(buildProjectReorderInput(projects, 'project-2', 'project-1'), {
    ids: ['project-2', 'project-1'],
    pinned: true,
  });
});

test('sortSessionsForSidebar uses last viewed time before updated time', () => {
  const now = Date.now();
  const sessions = [
    createActiveSummary({
      id: 'updated-only',
      project_id: 'project-1',
      title: '仅更新',
      updated_at: now - 1_000,
      last_viewed_at: null,
    }),
    createActiveSummary({
      id: 'viewed',
      project_id: 'project-1',
      title: '已查看',
      updated_at: now - 10_000,
      last_viewed_at: now,
    }),
    createActiveSummary({
      id: 'older',
      project_id: 'project-1',
      title: '更早',
      updated_at: now - 20_000,
      last_viewed_at: null,
    }),
  ];

  assert.deepEqual(sortSessionsForSidebar(sessions, 'updated').map((session) => session.id), [
    'viewed',
    'updated-only',
    'older',
  ]);
});

test('sortSessionsForSidebar falls back to id when timestamps and titles tie', () => {
  const now = Date.now();
  const sessions = [
    createActiveSummary({ id: 'session-b', project_id: 'project-1', title: '重复标题', created_at: now, updated_at: now }),
    createActiveSummary({ id: 'session-a', project_id: 'project-1', title: '重复标题', created_at: now, updated_at: now }),
  ];

  assert.deepEqual(sortSessionsForSidebar(sessions, 'updated').map((session) => session.id), [
    'session-a',
    'session-b',
  ]);
});

test('buildSessionSidebarModel filters pinned sessions and hides empty projects', () => {
  const now = Date.now();
  const projects = [
    {
      id: 'project-a',
      name: 'Project A',
      path: '/workspace/a',
      active: false,
      created_at: now - 3_000,
      updated_at: now - 2_000,
      pinned_at: null,
      sort_order: null,
      recentSessions: [],
    },
    {
      id: 'project-empty',
      name: 'Empty Project',
      path: '/workspace/empty',
      active: false,
      created_at: now - 1_000,
      updated_at: now - 1_000,
      pinned_at: null,
      sort_order: null,
      recentSessions: [],
    },
  ];
  const sessions = [
    createActiveSummary({
      id: 'normal',
      project_id: 'project-a',
      title: '普通会话',
      pinned_at: null,
      created_at: now - 4_000,
      updated_at: now - 4_000,
    }),
    createActiveSummary({
      id: 'pinned',
      project_id: 'project-a',
      title: '置顶会话',
      pinned_at: now,
      created_at: now - 5_000,
      updated_at: now - 5_000,
    }),
  ];
  const model = buildSessionSidebarModel({
    projects,
    sessions,
    currentSession: {
      ...createPayload().activeSession.session,
      id: 'missing-current',
      status: 'archived',
      phase: 'archived',
      archived_at: now,
    },
    currentProjectId: 'project-a',
    currentProjectName: 'Project A',
    normalizedQuery: '',
    prefs: { groupMode: 'project', sortMode: 'updated', visibility: 'pinned' },
  });

  assert.equal(model.heading, '项目');
  assert.deepEqual(model.projects.map((project) => project.id), ['project-a']);
  assert.deepEqual(model.projects[0]?.sessions.map((session) => session.id), ['pinned']);
  assert.equal(model.emptyMessage, '暂无置顶会话。');
});

test('buildSessionSidebarModel keeps empty projects when the project itself matches search', () => {
  const now = Date.now();
  const model = buildSessionSidebarModel({
    projects: [{
      id: 'project-empty',
      name: 'Empty Project',
      path: '/workspace/empty',
      active: false,
      created_at: now - 1_000,
      updated_at: now,
      pinned_at: null,
      sort_order: null,
      recentSessions: [],
    }],
    sessions: [],
    currentSession: {
      ...createPayload().activeSession.session,
      id: 'archived-current',
      status: 'archived',
      phase: 'archived',
      archived_at: now,
    },
    currentProjectId: 'project-empty',
    currentProjectName: 'Empty Project',
    normalizedQuery: 'empty',
    prefs: { groupMode: 'project', sortMode: 'updated', visibility: 'all' },
  });

  assert.deepEqual(model.projects.map((project) => project.id), ['project-empty']);
  assert.deepEqual(model.projects[0]?.sessions, []);
});

test('buildSessionSidebarModel creates time ordered flat session rows', () => {
  const now = Date.now();
  const sessions = [
    createActiveSummary({
      id: 'old',
      project_id: 'project-a',
      project_name: 'Project A',
      title: '旧会话',
      created_at: now - 50_000,
      updated_at: now - 40_000,
      last_viewed_at: null,
    }),
    createActiveSummary({
      id: 'recent-view',
      project_id: 'project-b',
      project_name: 'Project B',
      title: '最近查看',
      created_at: now - 60_000,
      updated_at: now - 55_000,
      last_viewed_at: now - 1_000,
    }),
  ];
  const model = buildSessionSidebarModel({
    projects: [],
    sessions,
    currentSession: {
      ...createPayload().activeSession.session,
      id: 'archived-current',
      status: 'archived',
      phase: 'archived',
      archived_at: now,
    },
    currentProjectId: 'project-a',
    currentProjectName: 'Project A',
    normalizedQuery: '',
    prefs: { groupMode: 'time', sortMode: 'updated', visibility: 'all' },
  });

  assert.equal(model.heading, '聊天');
  assert.deepEqual(model.timeRows.map((session) => session.id), ['recent-view', 'old']);
  assert.deepEqual(model.projects, []);
});

test('syncExpandedProjectIds opens the current project without overwriting existing project state', () => {
  assert.deepEqual(
    syncExpandedProjectIds(
      { 'project-1': true, 'project-2': false, 'project-3': true },
      [{ id: 'project-1' }, { id: 'project-2' }, { id: 'project-3' }, { id: 'project-4' }],
      'project-2',
    ),
    {
      'project-1': true,
      'project-2': true,
      'project-3': true,
      'project-4': false,
    },
  );
});

test('shouldIgnoreProjectDragStart is SSR-safe and wired into project drag start', () => {
  const globalWithElement = globalThis as { Element?: unknown };
  const originalElement = globalWithElement.Element;

  assert.equal(shouldIgnoreProjectDragStart(null), false);
  assert.equal(shouldIgnoreProjectDragStart({} as EventTarget), false);
  class FakeElement {
    constructor(private readonly match: boolean) {}

    closest(): object | null {
      return this.match ? {} : null;
    }
  }
  globalWithElement.Element = FakeElement;
  try {
    assert.equal(shouldIgnoreProjectDragStart(new FakeElement(true) as unknown as EventTarget), true);
    assert.equal(shouldIgnoreProjectDragStart(new FakeElement(false) as unknown as EventTarget), false);
    assert.equal(shouldIgnoreProjectDragStart(null), false);
  } finally {
    if (originalElement === undefined) delete globalWithElement.Element;
    else globalWithElement.Element = originalElement;
  }
  assert.match(sessionShellViewSource, /shouldIgnoreProjectDragStart\(event\.target\)/);
});

test('SessionShell does not add an archived current session to the project tree fallback', () => {
  localStorageValues.clear();
  const payload = createPayload();
  payload.activeSessions = [];
  payload.activeSession.session.status = 'archived';
  payload.activeSession.session.phase = 'archived';
  payload.activeSession.session.archived_at = Date.now();

  const html = renderSessionShell(payload);

  assert.match(html, /新建会话/);
  assert.match(html, /<span>项目<\/span>/);
  assert.match(html, /没有匹配的会话。/);
  assert.doesNotMatch(html, /data-project-session-row="true"/);
});

test('SessionShell renders empty run state without fake run values', () => {
  const payload = createPayload();
  payload.activeSession.runs = [];

  const html = renderSessionShell(payload);

  assert.match(html, /暂无代理运行/);
  assert.doesNotMatch(html, /deepsea-run-card/);
  assert.doesNotMatch(html, /运行耗时/);
  assert.doesNotMatch(html, new RegExp(['02', '14', '05'].join(':')));
});

test('SessionShell renders agent thought above run output without leaking runtime prompt', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.prompt = '本轮 prompt 来源由 SessionOS Context Inspector 记录。\n\n## Context Sources\n### AGENTS.md\n内部运行时提示不应显示';
  run.status = 'running';
  run.stdout = '';
  run.stderr = '';
  run.activity_log = '分析用户问题，检查会话上下文，并准备简短回复。';

  const html = renderSessionShell(payload);
  const thoughtTag = getAgentThoughtTag(html);
  const thoughtIndex = html.indexOf('class="deepsea-agent-thought"');
  const runLogBodyIndex = html.indexOf('class="deepsea-run-log-body"');

  assert.doesNotMatch(html, /本轮 prompt 来源由 SessionOS Context Inspector 记录/);
  assert.match(html, /智能体思考过程/);
  assert.match(html, /分析用户问题，检查会话上下文，并准备简短回复。/);
  assert.match(html, /等待智能体输出/);
  assert.match(thoughtTag, /data-active="true"/);
  assert.match(thoughtTag, /\sopen=""/);
  assert.ok(thoughtIndex >= 0);
  assert.ok(runLogBodyIndex > thoughtIndex);
});

test('SessionShell collapses completed agent thought by default', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.activity_log = '完成态思考文本默认隐藏，用户需要时可展开查看。';

  const html = renderSessionShell(payload);
  const thoughtTag = getAgentThoughtTag(html);

  assert.match(thoughtTag, /data-active="false"/);
  assert.doesNotMatch(thoughtTag, /\sopen=""/);
  assert.match(html, /展开/);
  assert.match(html, /完成态思考文本默认隐藏，用户需要时可展开查看。/);
});

test('SessionShell keeps previous assistant replies in transcript timeline', () => {
  const payload = createPayload();
  const now = Date.now();
  const firstMessage = payload.activeSession.messages[0]!;
  const firstRun = payload.activeSession.runs[0]!;
  payload.activeSession.messages = [
    {
      ...firstMessage,
      id: 'message-older',
      content: '第一轮问题',
      created_at: now - 80_000,
    },
    {
      ...firstMessage,
      id: 'message-newer',
      content: '第二轮问题',
      created_at: now - 40_000,
    },
  ];
  payload.activeSession.runs = [
    {
      ...firstRun,
      id: 'run-older',
      stdout: '第一轮回复仍然可见',
      started_at: now - 70_000,
      updated_at: now - 65_000,
      completed_at: now - 65_000,
    },
    {
      ...firstRun,
      id: 'run-newer',
      stdout: '第二轮回复也可见',
      started_at: now - 30_000,
      updated_at: now - 25_000,
      completed_at: now - 25_000,
    },
  ];

  const html = renderSessionShell(payload);

  assert.match(html, /第一轮回复仍然可见/);
  assert.match(html, /第二轮回复也可见/);
  assert.ok(html.indexOf('第一轮问题') < html.indexOf('第一轮回复仍然可见'));
  assert.ok(html.indexOf('第一轮回复仍然可见') < html.indexOf('第二轮问题'));
  assert.ok(html.indexOf('第二轮问题') < html.indexOf('第二轮回复也可见'));
});

test('SessionShell renders actual agent names for assistant transcript entries', () => {
  const payload = createPayload();
  const now = Date.now();
  const userMessage = payload.activeSession.messages[0]!;
  const run = payload.activeSession.runs[0]!;
  payload.activeSession.messages = [
    {
      ...userMessage,
      id: 'message-user',
      sender_id: 'user',
      sender_name: '大哥',
      role: 'user',
      content: '请修复群聊消息标签',
      created_at: now - 80_000,
    },
    {
      ...userMessage,
      id: 'message-agent',
      sender_id: 'frontend-executor',
      sender_name: '前端执行官',
      role: 'assistant',
      content: '我会更新消息标签。',
      created_at: now - 70_000,
    },
  ];
  payload.activeSession.runs = [{
    ...run,
    agent_id: 'frontend-executor',
    stdout: '已更新消息标签。',
    started_at: now - 60_000,
    updated_at: now - 55_000,
    completed_at: now - 55_000,
  }];

  const html = renderSessionShell(payload);

  assert.match(html, /前端执行官/);
  assert.ok(html.indexOf('前端执行官') < html.indexOf('我会更新消息标签。'));
  assert.ok(html.lastIndexOf('前端执行官') < html.indexOf('已更新消息标签。'));
  assert.doesNotMatch(html, /ASSISTANT/);
});

test('SessionShell resolves run labels from project agent names instead of ids', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  payload.activeSession.messages = [{
    ...payload.activeSession.messages[0]!,
    content: '请执行前端任务',
  }];
  payload.activeSession.runs = [{
    ...run,
    agent_id: 'frontend-executor',
    stdout: '已执行前端任务。',
  }];

  const html = renderSessionShell(payload, {
    projectAgents: createProjectUsedAgentsPayload({
      agent_id: 'frontend-executor',
      name: '前端执行官',
    }),
  });

  assert.match(html, /前端执行官/);
  assert.ok(html.indexOf('前端执行官') < html.indexOf('已执行前端任务。'));
  assert.doesNotMatch(html, /frontend-executor/);
  assert.doesNotMatch(html, /ASSISTANT/);
});

test('SessionShell keeps composer in layout flow below the transcript scroll area', () => {
  const html = renderSessionShell(createPayload());

  assert.match(html, /data-transcript-scroll="true"/);
  assert.match(html, /data-transcript-end="true"/);
  assert.match(sessionOsCss, /\.deepsea-transcript__scroll\s*\{[^}]*padding:\s*0/s);
  assert.match(sessionOsCss, /\.deepsea-composer-anchor\s*\{[^}]*position:\s*static/s);
  assert.doesNotMatch(sessionOsCss, /\.deepsea-composer-anchor\s*\{[^}]*position:\s*absolute/s);
  assert.match(sessionOsCss, /\.deepsea-transcript__end\s*\{[^}]*min-height:\s*1px/s);
});

test('isTranscriptNearBottom respects the transcript follow threshold', () => {
  assert.equal(isTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 780, clientHeight: 200 } as HTMLElement), true);
  assert.equal(isTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 } as HTMLElement), false);
});

test('buildTranscriptFollowKey changes when active run output streams in place', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  const firstKey = buildTranscriptFollowKey({
    runs: [{ ...run, id: 'run-streaming', stdout: '第一段', updated_at: 10 }],
    timelineEndKey: 'run:run-streaming',
  });
  const secondKey = buildTranscriptFollowKey({
    runs: [{ ...run, id: 'run-streaming', stdout: '第一段\n第二段', updated_at: 11 }],
    timelineEndKey: 'run:run-streaming',
  });

  assert.notEqual(firstKey, secondKey);
});

test('getLatestUserMessageKey ignores assistant messages', () => {
  const payload = createPayload();
  const base = payload.activeSession.messages[0]!;

  assert.equal(getLatestUserMessageKey([
    { ...base, id: 'assistant-message', role: 'assistant', created_at: 20 },
    { ...base, id: 'user-message', role: 'user', created_at: 10 },
  ]), 'user-message:10');
});

test('SessionShell renders markdown controls and thinking duration in transcript', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  payload.activeSession.messages[0] = {
    ...payload.activeSession.messages[0]!,
    content: '请检查 `packages/frontend` 的 Markdown 展示',
  };
  run.stdout = ['## 分析结果', '', '- 已读取消息区', '- 需要补齐源码切换'].join('\n');
  run.started_at = 1_000;
  run.updated_at = 19_000;
  run.completed_at = 19_000;

  const html = renderSessionShell(payload);

  assert.match(html, /deepsea-markdown-switch/);
  assert.match(html, /预览/);
  assert.match(html, /源码/);
  assert.match(html, /思考 18s/);
  assert.match(html, /markdown-preview/);
  assert.match(html, /分析结果/);
});

test('SessionShell renders run status beside thinking duration in transcript', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'running';
  run.stdout = '正在处理。';
  run.started_at = 1_000;
  run.updated_at = 19_000;
  run.completed_at = null;

  const runningHtml = renderSessionShell(payload);
  assert.match(runningHtml, /class="deepsea-run-status" data-tone="warn">运行中<\/span>/);

  run.status = 'failed';
  run.error = '执行失败';
  run.completed_at = 19_000;
  const failedHtml = renderSessionShell(payload);
  assert.match(failedHtml, /class="deepsea-run-status" data-tone="danger">失败<\/span>/);

  run.status = 'completed';
  run.error = null;
  const completedHtml = renderSessionShell(payload);
  assert.match(completedHtml, /class="deepsea-run-status" data-tone="ok">完成<\/span>/);

  run.status = 'cancelled';
  run.stdout = '';
  run.stderr = '';
  const cancelledHtml = renderSessionShell(payload);
  assert.match(cancelledHtml, /class="deepsea-run-status" data-tone="muted">已取消<\/span>/);
  assert.match(cancelledHtml, /<mark>CANCELLED<\/mark>/);
  assert.match(cancelledHtml, /运行已取消。/);
  assert.doesNotMatch(cancelledHtml, /<mark>RUNNING<\/mark>/);
  assert.doesNotMatch(cancelledHtml, /等待智能体输出/);
});

test('SessionShell hides ACP tool records from chat transcript', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.stdout = '我会先分析当前项目。找到入口和脚本。已完成。';
  run.started_at = 1_000;
  run.updated_at = 19_000;
  run.completed_at = 19_000;
  payload.activeSession.agentEvents = [
    createAgentEvent({ id: 'event-answer-1', seq: 1, channel: 'answer', event_type: 'agent_message_chunk', content: '我会先分析当前项目。', created_at: 19_000 }),
    createAgentEvent({ id: 'event-thinking', seq: 2, channel: 'thinking', event_type: 'reasoning_delta', content: '判断需要读取 package.json。' }),
    createAgentEvent({
      id: 'event-read',
      seq: 3,
      channel: 'tool',
      event_type: 'tool_call',
      content: '',
      payload_json: JSON.stringify({ rawEvent: { params: { update: { rawInput: { command: ['sed', '-n', '1,120p', 'package.json'] } } } } }),
    }),
    createAgentEvent({ id: 'event-answer-2', seq: 4, channel: 'answer', event_type: 'agent_message_chunk', content: '找到入口和脚本。' }),
    createAgentEvent({
      id: 'event-command',
      seq: 5,
      channel: 'tool',
      event_type: 'tool_call',
      content: '',
      payload_json: JSON.stringify({ rawEvent: { params: { update: { rawInput: { command: ['npm', 'run', 'build'] } } } } }),
    }),
    createAgentEvent({ id: 'event-answer-3', seq: 6, channel: 'answer', event_type: 'agent_message_chunk', content: '已完成。' }),
  ];

  const html = renderSessionShell(payload);
  const runLogIndex = html.indexOf('class="deepsea-run-log"');
  const runLogBodyIndex = html.indexOf('class="deepsea-run-log-body"');
  const thoughtTextIndex = html.indexOf('判断需要读取 package.json。');

  assert.match(html, /思考 18s/);
  assert.ok(runLogIndex < html.indexOf('我会先分析当前项目。'));
  assert.match(html, /找到入口和脚本。/);
  assert.match(html, /已完成。/);
  assert.doesNotMatch(html, /Thinking/);
  assert.doesNotMatch(html, /Read File/);
  assert.doesNotMatch(html, /Run Command/);
  assert.ok(thoughtTextIndex >= 0);
  assert.ok(thoughtTextIndex > runLogIndex);
  assert.ok(thoughtTextIndex < runLogBodyIndex);
  assert.ok(runLogIndex < html.indexOf('找到入口和脚本。'));
  assert.ok(html.indexOf('找到入口和脚本。') < html.indexOf('已完成。'));
});

test('buildSessionRunTranscriptItems keeps only answer text in chat transcript', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({ id: 'answer-1', seq: 1, channel: 'answer', event_type: 'agent_message_chunk', content: '第一句。' }),
    createAgentEvent({ id: 'answer-2', seq: 2, channel: 'answer', event_type: 'agent_message_chunk', content: '第二句。' }),
    createAgentEvent({ id: 'thinking', seq: 3, channel: 'thinking', event_type: 'reasoning_delta', content: '准备搜索。' }),
    createAgentEvent({ id: 'answer-3', seq: 4, channel: 'answer', event_type: 'agent_message_chunk', content: '第三句。' }),
  ], 'fallback');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    '第一句。第二句。第三句。',
  ]);
});

test('buildSessionRunTranscriptItems drops ACP tool markers from chat transcript', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({ id: 'answer-1', seq: 1, channel: 'answer', event_type: 'agent_message_chunk', content: '准备修改。' }),
    createAgentEvent({
      id: 'edit',
      seq: 2,
      channel: 'event',
      event_type: 'tool_call',
      payload_json: JSON.stringify({ trace: { name: 'Edit' } }),
    }),
    createAgentEvent({ id: 'answer-2', seq: 3, channel: 'answer', event_type: 'agent_message_chunk', content: '修改完成。' }),
  ], 'fallback');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    '准备修改。修改完成。',
  ]);
});

test('buildSessionRunTranscriptItems keeps answer text without content sniffing', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({
      id: 'fallback',
      seq: 1,
      channel: 'answer',
      event_type: 'protocol_fallback',
      content: '[ACP fallback] codex protocol server unavailable, using legacy CLI.\n',
    }),
    createAgentEvent({
      id: 'command-start',
      seq: 2,
      channel: 'answer',
      event_type: 'item.started',
      content: "开始命令：/bin/zsh -lc 'rtk find .'\n",
      payload_json: JSON.stringify({ trace: null }),
    }),
    createAgentEvent({
      id: 'answer',
      seq: 3,
      channel: 'answer',
      event_type: 'item.completed',
      content: '✅ 结论：页面已分析。',
    }),
    createAgentEvent({
      id: 'command-completed',
      seq: 4,
      channel: 'answer',
      event_type: 'item.completed',
      content: "完成命令：/bin/zsh -lc 'rtk find .'\n",
      payload_json: JSON.stringify({ trace: null }),
    }),
  ], '[ACP fallback]\n开始命令：rtk find\n✅ 结论：页面已分析。\n完成命令：rtk find');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    "[ACP fallback] codex protocol server unavailable, using legacy CLI.\n开始命令：/bin/zsh -lc 'rtk find .'\n✅ 结论：页面已分析。完成命令：/bin/zsh -lc 'rtk find .'",
  ]);
});

test('buildSessionRunTranscriptItems keeps process-looking answer chunks before final answer', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({
      id: 'preface-1',
      seq: 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '我会按项目本地目录来核对：优先看当前仓库里的 `.agents/skills` / `.codex/skills`。',
    }),
    createAgentEvent({
      id: 'preface-2',
      seq: 2,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '当前仓库里只定位到 1 个项目级 skill 文件；`.codex/skills` 下没有项目共享 skill。接下来读一下它的元信息，避免只按目录名猜测。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 3,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '当前项目级安装的 skill 只有 1 个：\n\n- `impeccable`',
    }),
  ], [
    '我会按项目本地目录来核对：优先看当前仓库里的 `.agents/skills` / `.codex/skills`。',
    '当前仓库里只定位到 1 个项目级 skill 文件；`.codex/skills` 下没有项目共享 skill。接下来读一下它的元信息，避免只按目录名猜测。',
    '当前项目级安装的 skill 只有 1 个：\n\n- `impeccable`',
  ].join(''));

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    [
      '我会按项目本地目录来核对：优先看当前仓库里的 `.agents/skills` / `.codex/skills`。',
      '当前仓库里只定位到 1 个项目级 skill 文件；`.codex/skills` 下没有项目共享 skill。接下来读一下它的元信息，避免只按目录名猜测。',
      '当前项目级安装的 skill 只有 1 个：\n\n- `impeccable`',
    ].join(''),
  ]);
});

test('buildSessionRunTranscriptItems keeps follow-up answer chunks before global skills answer', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({
      id: 'preface-1',
      seq: 1,
      channel: 'answer',
      event_type: 'item.completed',
      content: '我会按“全局安装”先核对 `~/.codex/skills`，再单独标出 Superpowers 插件缓存里暴露的技能。',
    }),
    createAgentEvent({
      id: 'preface-2',
      seq: 2,
      channel: 'answer',
      event_type: 'item.completed',
      content: '刚才第一轮发现 `~/.codex/skills` 里有普通用户技能，也发现 Superpowers 有两份同名来源。现在补查隐藏目录和 `~/.agents/skills`，因为全局技能里有一部分放在这些位置。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 3,
      channel: 'answer',
      event_type: 'item.completed',
      content: '当前全局安装/暴露的 skills，按唯一名称去重后共 **28 个**。',
    }),
  ], '');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    [
      '我会按“全局安装”先核对 `~/.codex/skills`，再单独标出 Superpowers 插件缓存里暴露的技能。',
      '刚才第一轮发现 `~/.codex/skills` 里有普通用户技能，也发现 Superpowers 有两份同名来源。现在补查隐藏目录和 `~/.agents/skills`，因为全局技能里有一部分放在这些位置。',
      '当前全局安装/暴露的 skills，按唯一名称去重后共 **28 个**。',
    ].join(''),
  ]);
});

test('buildSessionRunTranscriptItems ignores structured non-answer channels', () => {
  const items = buildSessionRunTranscriptItems([
    createAgentEvent({
      id: 'activity',
      seq: 1,
      channel: 'activity',
      event_type: 'protocol_fallback',
      content: '[ACP fallback] using legacy CLI\n',
    }),
    createAgentEvent({
      id: 'thinking',
      seq: 2,
      channel: 'thinking',
      event_type: 'reasoning_delta',
      content: '我会先分析上下文。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 3,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '✅ 结论：截图展示的是工具调用列表。',
    }),
  ], 'fallback');

  assert.deepEqual(items.map((item) => item.type === 'text' ? item.text : `[${item.label}]`), [
    '✅ 结论：截图展示的是工具调用列表。',
  ]);
});

test('buildSessionRunTranscriptItems keeps tokenized answer text literally', () => {
  const text = [
    '我会先恢复现场：读取 Superpowers 入口要求和当前未提交改动。',
    '本轮使用 using-superpowers 做会话入口检查。',
    '若确认是前端实现/调整，会再按需加载前端相关 skill。',
    '当前现场只有一个前端 UI 文件被改动。',
    '我会继续把这块做完整。',
  ].join('');
  const items = buildSessionRunTranscriptItems(
    [...text].map((char, index) => createAgentEvent({
      id: `chunk-${index}`,
      seq: index + 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: char,
    })),
    text,
  );

  assert.deepEqual(items, [{ type: 'text', id: 'text-0', text }]);
});

test('SessionShell keeps process-looking answer text in run body', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '我会直接按上传文件读取图片，然后基于截图内容做结构化分析。✅ 结论：截图展示的是工具调用列表。';
  run.stderr = '';
  run.activity_log = '';
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'preface',
      seq: 1,
      channel: 'answer',
      event_type: 'item.completed',
      content: '我会直接按上传文件读取图片，然后基于截图内容做结构化分析。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 2,
      channel: 'answer',
      event_type: 'item.completed',
      content: '✅ 结论：截图展示的是工具调用列表。',
    }),
  ];

  const html = renderSessionShell(payload);
  const runLogIndex = html.indexOf('class="deepsea-run-log"');

  assert.ok(runLogIndex >= 0);
  assert.ok(html.indexOf('我会直接按上传文件读取图片') > runLogIndex);
  assert.match(html, /✅ 结论：截图展示的是工具调用列表。/);
});

test('SessionShell renders run thought inside assistant message area', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '我会按项目本地目录来核对。当前项目级安装的 skill 只有 1 个：impeccable';
  run.activity_log = '';
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'preface',
      seq: 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '我会按项目本地目录来核对。',
    }),
    createAgentEvent({
      id: 'final',
      seq: 2,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '当前项目级安装的 skill 只有 1 个：impeccable',
    }),
  ];

  const html = renderSessionShell(payload);
  const assistantIndex = html.indexOf('class="deepsea-message deepsea-message--agent-run" data-role="assistant"');
  const thoughtIndex = html.indexOf('class="deepsea-agent-thought"');
  const runLogIndex = html.indexOf('class="deepsea-run-log"');
  const runLogBodyIndex = html.indexOf('class="deepsea-run-log-body"');

  assert.ok(assistantIndex >= 0);
  assert.ok(thoughtIndex > assistantIndex);
  assert.ok(thoughtIndex > runLogIndex);
  assert.ok(thoughtIndex < runLogBodyIndex);
});

test('SessionShell renders stderr literally when stdout is empty', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '';
  run.stderr = '[ACP fallback] codex protocol server unavailable, using legacy CLI.\n开始命令：rtk find .\n';
  run.activity_log = '';
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'fallback',
      seq: 1,
      channel: 'answer',
      event_type: 'protocol_fallback',
      content: '[ACP fallback] codex protocol server unavailable, using legacy CLI.\n',
    }),
    createAgentEvent({
      id: 'command-start',
      seq: 2,
      channel: 'answer',
      event_type: 'item.started',
      content: '开始命令：rtk find .\n',
    }),
  ];

  const html = renderSessionShell(payload);

  assert.match(html, /ACP fallback/);
  assert.match(html, /开始命令：rtk find \./);
  assert.doesNotMatch(html, /未返回可展示回复。/);
});

test('SessionShell renders a concise active session title with the full title available', () => {
  const payload = createPayload();
  payload.activeSession.session.title = '用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出';
  payload.projectSwitcher.projects[0]!.recentSessions[0]!.title = payload.activeSession.session.title;

  const html = renderSessionShell(payload);

  assert.match(html, /title="用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出"/);
  assert.match(html, /用户在当前会话第一次发送消息的时候.../);
  assert.doesNotMatch(html, />用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出</);
});

test('getSessionRunThinkingDuration formats active and completed durations', () => {
  assert.deepEqual(getSessionRunThinkingDuration({
    status: 'running',
    started_at: 1_000,
    updated_at: 1_000,
    completed_at: null,
  }, [], 19_400), { label: '思考中 18s', active: true });

  assert.deepEqual(getSessionRunThinkingDuration({
    status: 'completed',
    started_at: 1_000,
    updated_at: 126_000,
    completed_at: 126_000,
  }, [], 200_000), { label: '思考 2m 5s', active: false });
});

test('getSessionRunThinkingDuration stops at the first answer event', () => {
  const run = {
    status: 'running' as const,
    started_at: 1_000,
    updated_at: 60_000,
    completed_at: null,
  };

  assert.deepEqual(getSessionRunThinkingDuration(run, [
    createAgentEvent({
      id: 'thinking-before-answer',
      seq: 1,
      channel: 'thinking',
      event_type: 'reasoning_delta',
      content: '分析中',
      created_at: 5_000,
    }),
    createAgentEvent({
      id: 'answer-first',
      seq: 2,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '开始回复。',
      created_at: 8_000,
    }),
    createAgentEvent({
      id: 'answer-second',
      seq: 3,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '继续回复。',
      created_at: 20_000,
    }),
  ], 90_000), { label: '思考 7s', active: false });
});

test('getSessionRunThinkingDuration does not keep paused runs active', () => {
  assert.deepEqual(getSessionRunThinkingDuration({
    status: 'paused',
    started_at: 1_000,
    updated_at: 12_000,
    completed_at: null,
  }, [], 90_000), { label: '思考 11s', active: false });
});

test('SessionShell renders a blinking cursor while a run is streaming', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'running';
  run.stdout = '开始回复。';
  run.started_at = 1_000;
  run.updated_at = 8_000;
  run.completed_at = null;
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'answer',
      seq: 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '开始回复。',
      created_at: 8_000,
    }),
  ];

  const html = renderSessionShell(payload);

  assert.match(html, /streaming-cursor/);
});

test('SessionShell hides the streaming cursor after a run completes', () => {
  const payload = createPayload();
  const run = payload.activeSession.runs[0]!;
  run.status = 'completed';
  run.stdout = '已完成。';
  run.started_at = 1_000;
  run.updated_at = 8_000;
  run.completed_at = 8_000;
  payload.activeSession.agentEvents = [
    createAgentEvent({
      id: 'answer',
      seq: 1,
      channel: 'answer',
      event_type: 'agent_message_chunk',
      content: '已完成。',
      created_at: 8_000,
    }),
  ];

  const html = renderSessionShell(payload);

  assert.doesNotMatch(html, /streaming-cursor/);
});

test('SessionShell CSS makes only chat body text one size smaller and defines streaming cursor', () => {
  assert.match(sessionOsCss, /\.deepsea-message-body,[\s\S]*font-size:\s*13px/);
  assert.match(sessionOsCss, /\.deepsea-run-log-body,[\s\S]*line-height:\s*19px/);
  assert.match(sessionOsCss, /\.deepsea-message-body \.message-content,[\s\S]*font-size:\s*13px/);
  assert.match(sessionOsCss, /\.deepsea-message-body \.markdown-preview p,[\s\S]*font-size:\s*13px/);
  assert.match(sessionOsCss, /\.deepsea-run-log-body \.streaming-cursor\s*\{/);
  assert.match(sessionOsCss, /@keyframes deepsea-cursor-blink/);
});

test('SessionShell renders a concise active session title with the full title available', () => {
  const payload = createPayload();
  payload.activeSession.session.title = '用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出';
  payload.projectSwitcher.projects[0]!.recentSessions[0]!.title = payload.activeSession.session.title;

  const html = renderSessionShell(payload);

  assert.match(html, /title="用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出"/);
  assert.match(html, /用户在当前会话第一次发送消息的时候.../);
  assert.doesNotMatch(html, />用户在当前会话第一次发送消息的时候要同时修改当前会话名称并避免超长溢出</);
});

function getAgentThoughtTag(html: string): string {
  const match = html.match(/<details class="deepsea-agent-thought"[^>]*>/);
  assert.ok(match, 'expected an agent thought details element');
  return match[0];
}

function createAgentEvent(input: Partial<SessionAgentEvent> & Pick<SessionAgentEvent, 'id' | 'seq' | 'channel' | 'event_type'>): SessionAgentEvent {
  return {
    id: input.id,
    session_id: input.session_id ?? 'session-1',
    agent_id: input.agent_id ?? 'planner',
    run_id: input.run_id ?? 'run-1',
    seq: input.seq,
    channel: input.channel,
    event_type: input.event_type,
    content: input.content ?? '',
    payload_json: input.payload_json ?? null,
    created_at: input.created_at ?? Date.now(),
  };
}

export function createPayload(): SessionWorkspacePayload {
  const now = Date.now();
  return {
    project: {
      id: 'project-1',
      name: 'OpenClaw',
      path: '/workspace/openclaw',
      description: null,
      message_routing_mode: 'mentions_only',
      fallback_agent_id: null,
      created_at: now - 10_000,
      updated_at: now,
    },
    activeSession: {
      session: {
        id: 'session-1',
        project_id: 'project-1',
        title: 'SessionOS 迁移',
        current_goal: '把旧协作工作流切换为活跃会话模型',
        mode: 'code',
        phase: 'implementing',
        status: 'active',
        provider: 'codex',
        model: 'gpt-5.5',
        workspace_path: '/workspace/openclaw',
        worktree_path: null,
        branch_name: 'feat/session-os',
        forked_from_session_id: null,
        forked_from_history_record_id: null,
        latest_compaction_id: null,
        latest_context_manifest_id: 'context-1',
        closed_at: null,
        pinned_at: null,
        last_viewed_at: now - 120_000,
        created_at: now - 7_200_000,
        updated_at: now,
        archived_at: null,
      },
      messages: [{
        id: 'message-1',
        session_id: 'session-1',
        role: 'user',
        sender_id: 'user',
        sender_name: '大哥',
        content: '继续执行计划',
        message_type: 'text',
        status: 'completed',
        metadata: null,
        created_at: now - 60_000,
      }],
      runs: [{
        id: 'run-1',
        session_id: 'session-1',
        agent_id: 'planner',
        provider: 'codex',
        model: 'gpt-5.5',
        status: 'completed',
        mode: 'code',
        phase: 'implementing',
        prompt: '继续执行计划',
        stdout: 'done',
        stderr: '',
        activity_log: '',
        error: null,
        acp_session_id: 'acp-1',
        runtime_profile_snapshot: null,
        started_at: now - 50_000,
        updated_at: now - 40_000,
        completed_at: now - 40_000,
      }],
      agentEvents: [],
      planItems: [{
        id: 'plan-1',
        session_id: 'session-1',
        parent_id: null,
        title: '实现 SessionOS 组件',
        description: null,
        status: 'in_progress',
        priority: 1,
        source: 'plan',
        evidence_event_id: null,
        created_at: now - 100_000,
        updated_at: now - 50_000,
        completed_at: null,
      }],
      compactions: [],
      checkpoints: [],
      evidence: [{
        id: 'evidence-1',
        session_id: 'session-1',
        seq: 1,
        event_type: 'file_diff',
        severity: 'info',
        source_run_id: 'run-1',
        source_message_id: null,
        title: 'File diff',
        summary: 'Updated session UI',
        payload: { path: 'packages/frontend/src/session-ui/SessionShell.tsx' },
        created_at: now - 30_000,
      }],
    },
    activeSessions: [
      {
        id: 'session-2',
        project_id: 'project-2',
        project_name: 'AnotherProject',
        project_path: '/workspace/another',
        title: '接口联调',
        status: 'blocked',
        phase: 'blocked',
        provider: 'codex',
        model: 'gpt-5.3-codex',
        pinned_at: now - 4_000,
        created_at: now - 3_600_000,
        last_viewed_at: now - 6_000,
        updated_at: now - 8_000,
        unread_count: 2,
        active_run_count: 1,
        latest_event_summary: '等待后端 schema 决策',
      },
      {
        id: 'session-1',
        project_id: 'project-1',
        project_name: 'OpenClaw',
        project_path: '/workspace/openclaw',
        title: 'SessionOS 迁移',
        status: 'active',
        phase: 'implementing',
        provider: 'codex',
        model: 'gpt-5.5',
        pinned_at: null,
        created_at: now - 7_200_000,
        last_viewed_at: now - 120_000,
        updated_at: now,
        unread_count: 0,
        active_run_count: 0,
        latest_event_summary: 'Updated session UI',
      },
    ],
    historyRecords: [{
      id: 'history-1',
      project_id: 'project-1',
      session_id: 'old-session',
      title: '后端会话模型',
      summary: '完成 sessions/history_records schema 与 API',
      status: 'archived',
      mode: 'code',
      started_at: now - 86_400_000,
      ended_at: now - 3_600_000,
      key_decisions: [],
      changed_files: ['packages/backend/src/session.routes.ts'],
      verification_summary: 'backend build passed',
      commit_refs: ['abc123'],
      resume_brief: '目标：继续前端接入\n未完成：SessionOS UI',
      compact_count: 1,
      fork_count: 0,
      created_at: now - 3_600_000,
      updated_at: now - 3_600_000,
    }],
    status: {
      goal: '把旧协作工作流切换为活跃会话模型',
      mode: 'code',
      phase: 'implementing',
      status: 'active',
      context: {
        totalTokenEstimate: 3200,
        latestCompactionId: null,
        retainedRecentMessages: 20,
        pressure: 'low',
      },
      git: {
        branchName: 'feat/session-os',
        changedFileCount: 3,
        hasUncommittedDiff: true,
        conflictRisk: 'low',
      },
      verification: {
        lastCommand: 'npm run build',
        status: 'passed',
        completedAt: now - 20_000,
      },
      blocker: null,
      nextAction: {
        label: '继续会话',
        command: null,
        reason: '没有终态阻塞',
      },
      provider: {
        backend: 'codex',
        model: 'gpt-5.5',
        permissionMode: 'workspace-write',
      },
    },
    context: {
      id: 'context-1',
      session_id: 'session-1',
      run_id: null,
      total_token_estimate: 3200,
      prompt_hash: null,
      created_at: now,
      sources: [{
        id: 'source-1',
        manifest_id: 'context-1',
        session_id: 'session-1',
        source_type: 'agents',
        source_ref: 'AGENTS.md',
        title: 'AGENTS.md',
        included: 1,
        priority: 1,
        token_estimate: 1200,
        reason: '项目规则',
        content_hash: 'hash',
        excerpt: '默认使用 Superpowers',
        metadata: null,
        created_at: now,
      }],
    },
    evidence: [{
      id: 'evidence-1',
      session_id: 'session-1',
      seq: 1,
      event_type: 'file_diff',
      severity: 'info',
      source_run_id: 'run-1',
      source_message_id: null,
      title: 'File diff',
      summary: 'Updated session UI',
      payload: { path: 'packages/frontend/src/session-ui/SessionShell.tsx' },
      created_at: now - 30_000,
    }],
    projectSwitcher: {
      activeProjectId: 'project-1',
      projects: [{
        id: 'project-1',
        name: 'OpenClaw',
        path: '/workspace/openclaw',
        active: true,
        created_at: now - 86_400_000,
        updated_at: now - 2_000,
        pinned_at: null,
        sort_order: null,
        recentSessions: [{
          id: 'session-1',
          title: 'SessionOS 迁移',
          status: 'active',
          updated_at: now,
          href: '/projects/project-1/sessions/session-1',
          source: 'session',
        }],
      }],
    },
    bottomStatus: {
      health: 'ok',
      healthLabel: '良好',
      indexStatus: 'unknown',
      indexLabel: '未接入索引',
      lastResponseMs: 1000,
      errorRate: 0,
      networkLatencyMs: null,
      tokenUsage: null,
    },
    contract: {
      sessionId: 'session-1',
      objective: '把旧协作工作流切换为活跃会话模型',
      scope: '仅补齐 Session OS 后端接入',
      risks: ['retry 可能重复执行 prompt'],
      acceptanceCriteria: ['页面不显示静态 mock 数据'],
      updated_at: now,
    },
    toolRows: [{
      id: 'tool-1',
      action: 'edit',
      label: '文件变更',
      target: 'packages/frontend/src/session-ui/SessionShell.tsx',
      status: 'completed',
      durationMs: null,
      severity: 'info',
      eventId: 'evidence-1',
      created_at: now,
    }],
    diffRows: [{
      path: 'packages/frontend/src/session-ui/SessionShell.tsx',
      status: 'modified',
      additions: 12,
      deletions: 3,
      summary: 'M',
    }],
    historyFilters: { q: '', status: 'all', mode: 'all' },
  };
}

function createProjectUsedAgentsPayload(agent: { agent_id: string; name: string }): ProjectUsedAgentsPayload {
  return {
    planner: {
      kind: 'session_planner',
      agent_id: 'planner',
      name: 'Planner',
      effective_acp_backend: 'codex',
      project_override_acp_backend: null,
      backend_source: 'builtin',
      runtime_profile: {
        permission_mode: 'workspace-write',
        runtime_backend: 'acp',
        tool_policy: { allowed: [] },
        workspace_policy: { read: ['.'], write: ['.'] },
        memory_scope: 'project',
      },
    },
    agents: [{
      kind: 'room_agent',
      global_agent_id: null,
      agent_id: agent.agent_id,
      name: agent.name,
      acp_enabled: true,
      acp_backend: 'codex',
      room_bindings: [{
        room_id: 'room-1',
        room_name: 'Room One',
        room_agent_id: 'room-agent-1',
        acp_backend: 'codex',
        workflow_role: 'executor',
      }],
    }],
  };
}

function createActiveSummary(
  overrides: Partial<ActiveSessionSummary> & Pick<ActiveSessionSummary, 'id' | 'project_id' | 'title'>,
): ActiveSessionSummary {
  const now = Date.now();
  return {
    id: overrides.id,
    project_id: overrides.project_id,
    project_name: overrides.project_name ?? `Project ${overrides.project_id}`,
    project_path: overrides.project_path ?? `/workspace/${overrides.project_id}`,
    title: overrides.title,
    status: overrides.status ?? 'active',
    phase: overrides.phase ?? 'implementing',
    provider: overrides.provider ?? 'codex',
    model: overrides.model ?? 'gpt-5.5',
    pinned_at: overrides.pinned_at ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    last_viewed_at: overrides.last_viewed_at ?? null,
    unread_count: overrides.unread_count ?? 0,
    active_run_count: overrides.active_run_count ?? 0,
    latest_event_summary: overrides.latest_event_summary ?? null,
  };
}

function renderSessionShell(
  payload: SessionWorkspacePayload,
  options: { projectAgents?: ProjectUsedAgentsPayload } = {},
): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.projectAgents) {
    queryClient.setQueryData(['project-used-agents', payload.project.id], options.projectAgents);
  }
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <SessionShellView payload={payload} onSendMessage={() => undefined} onCommand={() => undefined} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}
