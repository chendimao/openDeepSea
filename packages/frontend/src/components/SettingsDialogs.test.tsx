import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, useI18n } from '../lib/i18n';
import {
  GLOBAL_SESSION_PROMPT_LIMIT,
  buildGlobalSessionPromptCounterLabel,
  buildGlobalSessionPromptSaveValue,
} from './SettingsDialogs';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
  configurable: true,
});

test('global session prompt helpers trim clear and count values', () => {
  assert.equal(GLOBAL_SESSION_PROMPT_LIMIT, 12000);
  assert.equal(buildGlobalSessionPromptSaveValue('  先说明边界。\n'), '先说明边界。');
  assert.equal(buildGlobalSessionPromptSaveValue('   '), null);
  assert.equal(buildGlobalSessionPromptCounterLabel('abc'), '3 / 12000');
});

test('settings copy includes global session prompt category', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <SettingsPromptCopyProbe />
    </I18nProvider>,
  );

  assert.match(html, /会话提示词/);
  assert.match(html, /全局会话提示词/);
  assert.match(html, /未启用全局注入/);
});

function SettingsPromptCopyProbe(): React.ReactElement {
  const { t } = useI18n();
  return (
    <section>
      <h1>{t('settings.sessionPromptSettings')}</h1>
      <h2>{t('settings.globalSessionPrompt')}</h2>
      <p>{t('settings.globalSessionPromptEmpty')}</p>
    </section>
  );
}
