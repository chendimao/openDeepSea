import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, useI18n } from '../lib/i18n';
import {
  DesktopDataSectionView,
  GLOBAL_SESSION_PROMPT_LIMIT,
  buildGlobalSessionPromptCounterLabel,
  buildGlobalSessionPromptSaveValue,
  shouldShowDesktopDataSection,
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

test('desktop data section is only visible when Electron desktop API exists', () => {
  assert.equal(shouldShowDesktopDataSection(undefined), false);
  assert.equal(shouldShowDesktopDataSection({
    getDataDirectory: async () => ({
      activeDataDir: '/tmp/OpenDeepSea/data',
      defaultDataDir: '/tmp/OpenDeepSea/data',
      pendingDataDir: null,
      requiresRestart: false,
      canClearData: true,
    }),
  } as Window['openDeepSeaDesktop']), false);
  assert.equal(shouldShowDesktopDataSection({
    getDataDirectory: async () => ({
      activeDataDir: '/tmp/OpenDeepSea/data',
      defaultDataDir: '/tmp/OpenDeepSea/data',
      pendingDataDir: null,
      requiresRestart: false,
      canClearData: true,
    }),
    chooseDataDirectory: async () => ({
      canceled: true,
      state: {
        activeDataDir: '/tmp/OpenDeepSea/data',
        defaultDataDir: '/tmp/OpenDeepSea/data',
        pendingDataDir: null,
        requiresRestart: false,
        canClearData: true,
      },
    }),
    resetDataDirectory: async () => ({
      activeDataDir: '/tmp/OpenDeepSea/data',
      defaultDataDir: '/tmp/OpenDeepSea/data',
      pendingDataDir: null,
      requiresRestart: false,
      canClearData: true,
    }),
    clearData: async () => ({ ok: true }),
    restartApp: async () => ({ ok: true }),
  }), true);
});

test('desktop data section view renders directory state and clear action', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <DesktopDataSectionView
        state={{
          activeDataDir: '/Users/example/Library/Application Support/OpenDeepSea/data',
          defaultDataDir: '/Users/example/Library/Application Support/OpenDeepSea/data',
          pendingDataDir: '/Volumes/Work/OpenDeepSeaData',
          requiresRestart: true,
          canClearData: true,
        }}
        isBusy={false}
        onChoose={() => undefined}
        onReset={() => undefined}
        onRestart={() => undefined}
        onClear={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(html, /桌面数据/);
  assert.match(html, /当前目录/);
  assert.match(html, /重启后生效/);
  assert.match(html, /选择数据目录/);
  assert.match(html, /清除桌面数据/);
});

test('desktop data section view renders load errors and clear safety reason', () => {
  const loadingHtml = renderToStaticMarkup(
    <I18nProvider>
      <DesktopDataSectionView
        state={null}
        error="读取失败"
        isBusy={false}
        onChoose={() => undefined}
        onReset={() => undefined}
        onRestart={() => undefined}
        onClear={() => undefined}
      />
    </I18nProvider>,
  );
  const unsafeHtml = renderToStaticMarkup(
    <I18nProvider>
      <DesktopDataSectionView
        state={{
          activeDataDir: '/Users/example/Library/Application Support/OpenDeepSea/data',
          defaultDataDir: '/Users/example/Library/Application Support/OpenDeepSea/data',
          pendingDataDir: null,
          requiresRestart: false,
          canClearData: false,
        }}
        isBusy={false}
        onChoose={() => undefined}
        onReset={() => undefined}
        onRestart={() => undefined}
        onClear={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(loadingHtml, /读取失败/);
  assert.match(unsafeHtml, /暂不可清除/);
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
