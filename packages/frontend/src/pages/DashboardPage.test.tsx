import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, useI18n } from '../lib/i18n';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
  configurable: true,
});

test('dashboard project copy no longer exposes old room chat as the primary concept', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <DashboardCopyProbe />
    </I18nProvider>,
  );

  assert.match(html, /添加一个本地代码目录后，可以创建项目会话/);
  assert.match(html, /上下文 2/);
  assert.doesNotMatch(html, /创建群聊/);
  assert.doesNotMatch(html, /群聊 2/);
});

function DashboardCopyProbe(): React.ReactElement {
  const { t } = useI18n();
  return (
    <section>
      <p>{t('dashboard.emptyDescription')}</p>
      <span>{t('project.stats.rooms', { count: 2 })}</span>
    </section>
  );
}
