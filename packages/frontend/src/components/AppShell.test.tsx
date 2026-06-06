import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../lib/i18n';
import { AppShell } from './AppShell';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
  configurable: true,
});

test('AppShell renders the shared Deepsea header with system settings entry', () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/projects/project-1']}>
          <AppShell theme="minimal-light" onThemeChange={() => undefined}>
            <div>content</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );

  assert.match(html, /deepsea-topbar app-header/);
  assert.match(html, /深海指挥中心/);
  assert.match(html, /蟹老板 AI 指挥官 Logo/);
  assert.match(html, /系统设置/);
  assert.match(html, /会话/);
  assert.match(html, /聊天/);
  assert.match(html, /智能体/);
  assert.match(html, /资源/);
  assert.doesNotMatch(html, /projects\/project-1\/rooms/);
});

test('AppShell does not open a global websocket without a concrete subscription', () => {
  const source = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /roomSocket\.connect\(/);
  assert.doesNotMatch(source, /roomSocket\.destroy\(/);
});
