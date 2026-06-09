import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, useI18n } from '../lib/i18n';
import type { SystemSettings } from '../lib/types';
import {
  DesktopDataSectionView,
  GLOBAL_SESSION_PROMPT_LIMIT,
  SystemSettingsForm,
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

test('system chat settings hide routing fallback and project takeover controls', () => {
  const html = renderSystemSettingsForm('chat');

  assert.match(html, /聊天设置/);
  assert.match(html, /交互策略/);
  assert.match(html, /自动记忆/);
  assert.match(html, /工作区排除目录/);
  assert.doesNotMatch(html, /只响应 @/);
  assert.doesNotMatch(html, /兜底回复/);
  assert.doesNotMatch(html, /兜底智能体/);
  assert.doesNotMatch(html, /项目接管/);
});

test('SettingsDialogs exposes knowledge embedding settings fields', () => {
  const source = readFileSync(new URL('./SettingsDialogs.tsx', import.meta.url), 'utf8');
  assert.match(source, /knowledge_embedding_provider/);
  assert.match(source, /knowledge_embedding_model/);
  assert.match(source, /api\.updateKnowledgeEmbeddingSettings/);
  assert.match(source, /OpenAI-compatible/);
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

function renderSystemSettingsForm(activeCategory: 'general' | 'sessionPrompt' | 'chat' | 'model'): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <SystemSettingsForm
          theme="apple-light"
          value={createSystemSettings()}
          aiConfigs={{ active_ai_config_id: null, items: [] }}
          providerConfigs={null}
          isProviderConfigsLoading={false}
          providerConfigsError={null}
          isSaving={false}
          activeCategory={activeCategory}
          hideCategoryNavigation
          onThemeChange={() => undefined}
          onSave={() => undefined}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function createSystemSettings(): SystemSettings {
  return {
    message_routing_mode: 'fallback_reply',
    fallback_agent_id: 'planner',
    interaction_mode: 'ask_user',
    auto_distill_enabled: true,
    default_workflow_definition_id: null,
    superpowers_bootstrap_owner: 'provider',
    workspace_excluded_dirs: ['node_modules'],
    session_planner_acp_backend: null,
    active_ai_config_id: null,
    ai_configs: [],
    langchain_planner_model: null,
    openai_base_url: null,
    openai_api_key_set: false,
    openai_api_key_preview: null,
    knowledge_embedding_provider: 'local-hash',
    knowledge_embedding_model: null,
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: null,
    knowledge_embedding_api_key_env_var: null,
    global_session_prompt: null,
  };
}
