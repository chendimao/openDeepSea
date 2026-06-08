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

test('AppShell keeps profile avatar on non-session routes', () => {
  const html = renderAppShell('/agents');

  assert.match(html, /alt="Profile"/);
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
