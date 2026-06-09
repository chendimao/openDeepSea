import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Blocks,
  CircleHelp,
  FileText,
  FlaskConical,
  KeyRound,
  LockKeyhole,
  MessageSquare,
  Search,
  Settings,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type {
  Agent,
  SystemSettings,
} from '../lib/types';
import type { ThemeMode } from '../lib/theme';
import { cn } from '../lib/utils';
import {
  SystemSettingsForm,
  type SystemSettingsCategory,
} from '../components/SettingsDialogs';
import './SystemSettingsPage.css';

type SettingsCategory =
  | SystemSettingsCategory
  | 'tools'
  | 'security'
  | 'notifications'
  | 'experiments';

type FallbackAgentOption = {
  agent_id: string;
  agent_name: string;
};

const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  message_routing_mode: 'fallback_reply',
  fallback_agent_id: 'planner',
  interaction_mode: 'ask_user',
  auto_distill_enabled: true,
  default_workflow_definition_id: null,
  superpowers_bootstrap_owner: 'provider',
  workspace_excluded_dirs: [],
  session_planner_acp_backend: null,
  active_ai_config_id: null,
  ai_configs: [],
  langchain_planner_model: null,
  openai_base_url: null,
  openai_api_key_set: false,
  openai_api_key_preview: null,
  global_session_prompt: null,
};

const systemCategoryValues: readonly SystemSettingsCategory[] = ['general', 'sessionPrompt', 'chat', 'model'];

const sidebarItems: Array<{
  value: SettingsCategory;
  label: string;
  description?: string;
  icon: LucideIcon;
}> = [
  { value: 'general', label: '通用设置', description: '主题、明暗模式与语言', icon: Settings },
  { value: 'sessionPrompt', label: '会话提示词', description: '全局系统提示注入', icon: FileText },
  { value: 'chat', label: '聊天设置', description: '消息回复、排除目录与协作默认行为', icon: MessageSquare },
  { value: 'model', label: '模型 / AI', description: 'Provider、模型、Base URL 与 API Key', icon: Sparkles },
  { value: 'tools', label: '工具与集成', description: '预留扩展', icon: Blocks },
  { value: 'security', label: '安全与权限', description: '预留扩展', icon: LockKeyhole },
  { value: 'notifications', label: '通知设置', description: '预留扩展', icon: Bell },
  { value: 'experiments', label: '实验性功能', description: '预留扩展', icon: FlaskConical },
];

export function SystemSettingsPage({
  theme,
  onThemeChange,
}: {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): JSX.Element {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('chat');
  const [activeSystemCategory, setActiveSystemCategory] = useState<SystemSettingsCategory>('chat');
  const [searchText, setSearchText] = useState('');
  const queryClient = useQueryClient();
  const { data: settings = DEFAULT_SYSTEM_SETTINGS } = useQuery({
    queryKey: ['settings', 'system'],
    queryFn: api.getSystemSettings,
  });
  const { data: aiConfigs } = useQuery({
    queryKey: ['settings', 'ai-configs'],
    queryFn: api.listAiConfigs,
  });
  const {
    data: providerConfigs,
    isLoading: isProviderConfigsLoading,
    error: providerConfigsError,
  } = useQuery({
    queryKey: ['settings', 'provider-configs'],
    queryFn: api.getProviderConfigs,
  });
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: api.listAgents,
  });
  const fallbackOptions = useMemo(() => toGlobalFallbackOptions(agents), [agents]);
  const visibleSidebarItems = useMemo(
    () => sidebarItems.filter((item) => matchesSidebarItem(item, searchText)),
    [searchText],
  );
  const save = useMutation({
    mutationFn: api.updateSystemSettings,
    onSuccess: (next) => {
      queryClient.setQueryData(['settings', 'system'], next);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('系统设置已保存');
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const settingsFormKey = buildSettingsFormKey(settings, aiConfigs?.items.length ?? 0);
  const isSystemCategoryActive = isSystemSettingsCategory(activeCategory);

  useEffect(() => {
    if (visibleSidebarItems.length === 0) return;
    if (visibleSidebarItems.some((item) => item.value === activeCategory)) return;
    const nextCategory = visibleSidebarItems[0].value;
    setActiveCategory(nextCategory);
    if (isSystemSettingsCategory(nextCategory)) setActiveSystemCategory(nextCategory);
  }, [activeCategory, visibleSidebarItems]);

  const handleCategoryChange = (category: SettingsCategory) => {
    setActiveCategory(category);
    if (isSystemSettingsCategory(category)) setActiveSystemCategory(category);
  };

  return (
    <div className="system-settings-page">
      <SettingsHeader searchText={searchText} onSearchTextChange={setSearchText} />
      <div className="system-settings-layout">
        <SettingsSidebar
          activeCategory={activeCategory}
          items={visibleSidebarItems}
          searchText={searchText}
          onCategoryChange={handleCategoryChange}
        />
        <main className="system-settings-main system-settings-scrollbar">
          <div className="system-settings-content">
            <div className="system-settings-form-bridge" hidden={!isSystemCategoryActive}>
              <SystemSettingsForm
                key={settingsFormKey}
                theme={theme}
                value={settings}
                aiConfigs={aiConfigs ?? { active_ai_config_id: settings.active_ai_config_id, items: settings.ai_configs ?? [] }}
                providerConfigs={providerConfigs ?? null}
                isProviderConfigsLoading={isProviderConfigsLoading}
                providerConfigsError={providerConfigsError instanceof Error ? providerConfigsError.message : null}
                fallbackOptions={fallbackOptions}
                isSaving={save.isPending}
                activeCategory={activeSystemCategory}
                hideCategoryNavigation
                onActiveCategoryChange={(category) => handleCategoryChange(category)}
                onThemeChange={onThemeChange}
                onSave={(patch) => save.mutate(patch)}
              />
            </div>
            {!isSystemCategoryActive && (
              <AuxiliarySettingsPanel category={activeCategory} />
            )}
          </div>
        </main>
      </div>
      <SettingsFooter />
    </div>
  );
}

function SettingsHeader({
  searchText,
  onSearchTextChange,
}: {
  searchText: string;
  onSearchTextChange: (value: string) => void;
}): JSX.Element {
  return (
    <header className="system-settings-header">
      <div className="system-settings-brand">
        <div className="system-settings-brand__mark">K</div>
        <div className="system-settings-brand__copy">
          <span>系统设置</span>
          <small>管理全局行为与默认配置，项目内成员将遵循这些设置。</small>
        </div>
      </div>
      <div className="system-settings-header__actions">
        <label className="system-settings-search">
          <Search aria-hidden="true" />
          <input
            value={searchText}
            onChange={(event) => onSearchTextChange(event.currentTarget.value)}
            placeholder="搜索设置项"
            aria-label="搜索设置项"
          />
        </label>
        <button type="button" className="system-settings-icon-button" aria-label="帮助">
          <CircleHelp aria-hidden="true" />
        </button>
        <div className="system-settings-user" aria-label="当前用户">U</div>
      </div>
    </header>
  );
}

function SettingsSidebar({
  activeCategory,
  items,
  searchText,
  onCategoryChange,
}: {
  activeCategory: SettingsCategory;
  items: typeof sidebarItems;
  searchText: string;
  onCategoryChange: (category: SettingsCategory) => void;
}): JSX.Element {
  return (
    <aside className="system-settings-sidebar">
      <nav className="system-settings-sidebar__nav" aria-label="系统设置分类">
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.value === activeCategory;
          return (
            <button
              key={item.value}
              type="button"
              className={cn('system-settings-sidebar__item', active && 'is-active')}
              aria-current={active ? 'page' : undefined}
              onClick={() => onCategoryChange(item.value)}
            >
              <Icon aria-hidden="true" />
              <span>
                <strong>{item.label}</strong>
                {item.description && <small>{item.description}</small>}
              </span>
            </button>
          );
        })}
      </nav>
      {items.length === 0 && (
        <div className="system-settings-sidebar__empty">
          没有匹配“{searchText.trim()}”的设置项
        </div>
      )}
      <div className="system-settings-sidebar__hint">
        <strong>保存策略</strong>
        <small>系统设置在底部统一保存；模型与 Provider 配置按面板按钮单独保存。</small>
      </div>
    </aside>
  );
}

function AuxiliarySettingsPanel({ category }: { category: SettingsCategory }): JSX.Element {
  const meta = sidebarItems.find((item) => item.value === category) ?? sidebarItems[0];
  const Icon = meta.icon;
  return (
    <>
      <section className="system-settings-section-title">
        <div className="system-settings-section-title__icon">
          <Icon aria-hidden="true" />
        </div>
        <div>
          <h1>{meta.label}</h1>
          <p>该分类是后续扩展入口；当前可编辑配置集中在通用、会话提示词、聊天设置和模型 / AI。</p>
        </div>
      </section>
      <section className="system-settings-card system-settings-aux-card">
        <div className="system-settings-placeholder">
          <KeyRound aria-hidden="true" />
          <strong>{meta.label}</strong>
          <span>这里暂不写入系统配置。需要修改模型、Provider、API Key 或排除目录时，请切换到已接入的配置分类。</span>
        </div>
      </section>
    </>
  );
}

function SettingsFooter(): JSX.Element {
  return (
    <footer className="system-settings-footer">
      <div>
        <span className="system-settings-dot" />
        <span>Service Operational</span>
        <span className="system-settings-footer__metrics">
          <span>Latency: <strong>45ms</strong></span>
          <span>Error Rate: <strong>0.0%</strong></span>
          <span>Response Time: <strong>1.2s</strong></span>
        </span>
      </div>
      <div>
        <span>Version 2.4.0-stable</span>
        <strong>MR. KRABS AI</strong>
      </div>
    </footer>
  );
}

function isSystemSettingsCategory(category: SettingsCategory): category is SystemSettingsCategory {
  return systemCategoryValues.includes(category as SystemSettingsCategory);
}

function matchesSidebarItem(item: (typeof sidebarItems)[number], searchText: string): boolean {
  const keyword = searchText.trim().toLocaleLowerCase();
  if (!keyword) return true;
  return [item.label, item.description ?? '', item.value]
    .some((value) => value.toLocaleLowerCase().includes(keyword));
}

function buildSettingsFormKey(settings: SystemSettings, aiConfigCount: number): string {
  return [
    settings.message_routing_mode,
    settings.fallback_agent_id ?? '',
    settings.interaction_mode,
    String(settings.auto_distill_enabled),
    settings.superpowers_bootstrap_owner,
    settings.active_ai_config_id ?? '',
    settings.global_session_prompt ?? '',
    settings.workspace_excluded_dirs.join(','),
    String(aiConfigCount),
  ].join(':');
}

function toGlobalFallbackOptions(agents: Agent[]): FallbackAgentOption[] {
  const options = agents
    .map((agent) => ({ agent_id: agent.agent_id, agent_name: agent.name }))
    .sort((a, b) => a.agent_name.localeCompare(b.agent_name))
    .filter((agent, index, list) => list.findIndex((item) => item.agent_id === agent.agent_id) === index);

  if (options.some((option) => option.agent_id === 'planner')) return options;
  return [{ agent_id: 'planner', agent_name: '规划师' }, ...options];
}
