import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import { AppShell } from './AppShell';
import { rememberLastSessionWorkspaceRoute } from '../lib/sessionWorkspaceRouteMemory';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => key === 'opendeepsea.lastSessionWorkspaceHref.v1' ? storedHref : null,
    setItem: (key: string, value: string) => {
      if (key === 'opendeepsea.lastSessionWorkspaceHref.v1') storedHref = value;
    },
    removeItem: (key: string) => {
      if (key === 'opendeepsea.lastSessionWorkspaceHref.v1') storedHref = null;
    },
  },
  configurable: true,
});

let storedHref: string | null = null;

test('AppShell renders the shared Deepsea header with system settings entry', () => {
  const html = renderAppShell('/projects/project-1');

  assert.match(html, /deepsea-topbar app-header/);
  assert.match(html, /深海指挥中心/);
  assert.match(html, /蟹老板 AI 指挥官 Logo/);
  assert.match(html, /系统设置/);
  assert.match(html, /会话/);
  assert.match(html, /聊天/);
  assert.match(html, /智能体/);
  assert.match(html, /知识库/);
  assert.match(html, /图片/);
  assert.match(html, /资源/);
  assert.match(html, /aria-label="菜单"/);
  assert.match(html, /app-header-menu-button/);
  assert.doesNotMatch(html, /alt="Profile"/);
  assert.doesNotMatch(html, /projects\/project-1\/rooms/);
});

test('AppShell hides desktop window controls in web runtime', () => {
  deleteDesktopApi();

  const html = renderAppShell('/projects/project-1');

  assert.doesNotMatch(html, /desktop-window-controls/);
  assert.doesNotMatch(html, /最小化窗口/);
});

test('AppShell renders macOS window controls before brand identity', () => {
  installDesktopApi({ platform: 'darwin', isMaximized: false });

  const html = renderAppShell('/projects/project-1');

  assert.match(html, /desktop-window-controls desktop-window-controls--mac/);
  assert.match(html, /aria-label="最小化窗口"/);
  assert.match(html, /aria-label="最大化窗口"/);
  assert.ok(html.indexOf('aria-label="关闭窗口"') < html.indexOf('aria-label="最小化窗口"'));
  assert.ok(html.indexOf('aria-label="最小化窗口"') < html.indexOf('aria-label="最大化窗口"'));
  assert.ok(html.indexOf('desktop-window-controls--mac') < html.indexOf('deepsea-brand'));
});

test('AppShell renders Windows window controls after action icons', () => {
  installDesktopApi({ platform: 'win32', isMaximized: false });

  const html = renderAppShell('/projects/project-1');

  assert.match(html, /desktop-window-controls desktop-window-controls--system/);
  assert.match(html, /aria-label="最小化窗口"/);
  assert.match(html, /aria-label="最大化窗口"/);
  assert.match(html, /aria-label="关闭窗口"/);
  assert.ok(html.indexOf('aria-label="最小化窗口"') < html.indexOf('aria-label="最大化窗口"'));
  assert.ok(html.indexOf('aria-label="最大化窗口"') < html.indexOf('aria-label="关闭窗口"'));
  assert.ok(html.indexOf('deepsea-action-icons') < html.indexOf('desktop-window-controls--system'));
});

test('AppShell uses native window control glyph classes', () => {
  const source = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8');

  assert.match(source, /const maximizeKind = windowState\.isMaximized \? 'restore' : 'maximize'/);
  assert.match(source, /desktop-window-control__glyph/);
  assert.doesNotMatch(source, /\bCopy\b/);
  assert.doesNotMatch(source, /\bSquare\b/);
  assert.doesNotMatch(source, /\bMinus\b/);
});

test('AppShell omits profile avatar on non-session routes', () => {
  const html = renderAppShell('/agents');

  assert.doesNotMatch(html, /alt="Profile"/);
});

test('AppShell renders the shared header on knowledge routes', () => {
  const html = renderAppShell('/knowledge');

  assert.match(html, /deepsea-topbar app-header/);
  assert.match(html, /深海指挥中心/);
  assert.match(html, /知识库/);
  assert.match(html, /href="\/knowledge"/);
});

test('AppShell points Session nav to the last concrete session route', () => {
  storedHref = null;
  rememberLastSessionWorkspaceRoute({ active: true, projectId: 'project-1', sessionId: 'session-1' });

  const html = renderAppShell('/agents');

  assert.match(html, /href="\/projects\/project-1\/sessions\/session-1"/);
  assert.match(html, /href="\/projects\/project-1\/images"/);
});

test('AppShell highlights image workbench without activating resource nav', () => {
  const html = renderAppShell('/projects/project-1/images');

  assert.match(html, /<a(?=[^>]*href="\/projects\/project-1\/images")(?=[^>]*class="is-active")/);
  assert.match(html, /href="\/files"/);
  assert.doesNotMatch(html, /<a(?=[^>]*href="\/files")(?=[^>]*class="is-active")/);
});

test('AppShell keeps image nav safe without a project context', () => {
  storedHref = null;
  const html = renderAppShell('/chat');

  assert.match(html, /href="\/"/);
  assert.doesNotMatch(html, /href="\/projects\/undefined\/images"/);
});

test('AppShell does not open a global websocket without a concrete subscription', () => {
  const source = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /roomSocket\.connect\(/);
  assert.doesNotMatch(source, /roomSocket\.destroy\(/);
});

test('AppShell header menu reuses primary navigation and opens command search', () => {
  const source = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8');

  assert.match(source, /<HeaderMenu/);
  assert.match(source, /items={headerNavItems}/);
  assert.match(source, /onOpenCommandMenu=\{\(\) => setCommandOpen\(true\)\}/);
  assert.match(source, /className="deepsea-header-menu"/);
  assert.match(source, /commandLabel={t\('shell\.searchCommand'\)}/);
});

test('desktop window controls CSS defines drag and no-drag regions', () => {
  const css = readFileSync(new URL('../session-ui/session-os.css', import.meta.url), 'utf8');

  assert.match(css, /\.deepsea-topbar[\s\S]*-webkit-app-region: drag/);
  assert.match(css, /\.deepsea-topbar :where\([\s\S]*-webkit-app-region: no-drag/);
  assert.match(css, /\.desktop-window-controls[\s\S]*-webkit-app-region: no-drag/);
  assert.match(css, /\.desktop-window-control--close:hover/);
  assert.match(css, /\.desktop-window-controls--mac \.desktop-window-control--close[\s\S]*#ff5f57/);
  assert.match(css, /\.desktop-window-controls--mac \.desktop-window-control--close:hover[\s\S]*background: #ff5f57/);
  assert.match(css, /\.desktop-window-controls--system \.desktop-window-control--maximize/);
});

function installDesktopApi({
  platform,
  isMaximized,
}: {
  platform: string;
  isMaximized: boolean;
}): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      openDeepSeaDesktop: {
        platform,
        getWindowState: async () => ({ isMaximized, isFullScreen: false }),
        minimizeWindow: async () => ({ isMaximized, isFullScreen: false }),
        toggleMaximizeWindow: async () => ({ isMaximized: !isMaximized, isFullScreen: false }),
        closeWindow: async () => ({ ok: true }),
        onWindowStateChanged: () => () => undefined,
      },
    },
  });
}

function deleteDesktopApi(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });
}

function renderAppShell(initialEntry: string): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <AppShell theme="minimal-light" onThemeChange={() => undefined}>
            <div>content</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
