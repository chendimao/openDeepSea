import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Ban,
  Bell,
  Blocks,
  Check,
  ChevronDown,
  CircleHelp,
  FileText,
  FlaskConical,
  KeyRound,
  LockKeyhole,
  MessageSquare,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type {
  Agent,
  SystemSettings,
} from '../lib/types';
import { createThemeMode, getThemeStyle, getThemeTone, type ThemeMode } from '../lib/theme';
import { useI18n, type Locale } from '../lib/i18n';
import { cn } from '../lib/utils';
import {
  GLOBAL_SESSION_PROMPT_LIMIT,
  buildGlobalSessionPromptCounterLabel,
  buildGlobalSessionPromptSaveValue,
} from '../components/SettingsDialogs';
import './SystemSettingsPage.css';

type SettingsPatch = Parameters<typeof api.updateSystemSettings>[0];

type SettingsCategory =
  | 'general'
  | 'sessionPrompt'
  | 'chat'
  | 'model'
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

const DEFAULT_CHAT_PATCH: Pick<
  SystemSettings,
  'message_routing_mode' | 'fallback_agent_id' | 'interaction_mode' | 'auto_distill_enabled' | 'superpowers_bootstrap_owner'
> = {
  message_routing_mode: 'fallback_reply',
  fallback_agent_id: 'planner',
  interaction_mode: 'ask_user',
  auto_distill_enabled: true,
  superpowers_bootstrap_owner: 'provider',
};

const sidebarItems: Array<{
  value: SettingsCategory;
  label: string;
  description?: string;
  icon: LucideIcon;
}> = [
  { value: 'general', label: '通用设置', icon: Settings },
  { value: 'sessionPrompt', label: '会话提示词', icon: FileText },
  { value: 'chat', label: '聊天设置', description: '消息回复与协作默认行为', icon: MessageSquare },
  { value: 'model', label: '模型 / AI', icon: Sparkles },
  { value: 'tools', label: '工具与集成', icon: Blocks },
  { value: 'security', label: '安全与权限', icon: LockKeyhole },
  { value: 'notifications', label: '通知设置', icon: Bell },
  { value: 'experiments', label: '实验性功能', icon: FlaskConical },
];

export function SystemSettingsPage({
  theme,
  onThemeChange,
}: {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): JSX.Element {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('chat');
  const [draft, setDraft] = useState<SystemSettings>(DEFAULT_SYSTEM_SETTINGS);
  const [searchText, setSearchText] = useState('');
  const queryClient = useQueryClient();
  const { data: settings = DEFAULT_SYSTEM_SETTINGS } = useQuery({
    queryKey: ['settings', 'system'],
    queryFn: api.getSystemSettings,
  });
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: api.listAgents,
  });
  const fallbackOptions = useMemo(() => toGlobalFallbackOptions(agents), [agents]);
  const save = useMutation({
    mutationFn: api.updateSystemSettings,
    onSuccess: (next) => {
      setDraft((current) => ({ ...current, ...next }));
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('系统设置已保存');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const commit = (patch: SettingsPatch) => {
    const nextDraft = { ...draft, ...patch };
    setDraft(nextDraft);
    save.mutate(patch);
  };
  const resetChatSettings = () => {
    const fallbackAgentId = pickFallbackAgentId(DEFAULT_CHAT_PATCH.fallback_agent_id ?? 'planner', fallbackOptions);
    commit({
      message_routing_mode: DEFAULT_CHAT_PATCH.message_routing_mode,
      fallback_agent_id: fallbackAgentId || DEFAULT_CHAT_PATCH.fallback_agent_id,
      interaction_mode: DEFAULT_CHAT_PATCH.interaction_mode,
      auto_distill_enabled: DEFAULT_CHAT_PATCH.auto_distill_enabled,
      superpowers_bootstrap_owner: DEFAULT_CHAT_PATCH.superpowers_bootstrap_owner,
    });
  };

  return (
    <div className="system-settings-page">
      <SettingsHeader searchText={searchText} onSearchTextChange={setSearchText} />
      <div className="system-settings-layout">
        <SettingsSidebar
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
          onReset={resetChatSettings}
        />
        <main className="system-settings-main system-settings-scrollbar">
          <div className="system-settings-content">
            {activeCategory === 'chat' && (
              <ChatSettingsPanel
                settings={draft}
                fallbackOptions={fallbackOptions}
                saving={save.isPending}
                onCommit={commit}
              />
            )}
            {activeCategory === 'general' && (
              <GeneralSettingsPanel theme={theme} onThemeChange={onThemeChange} />
            )}
            {activeCategory === 'sessionPrompt' && (
              <SessionPromptPanel
                value={draft.global_session_prompt ?? ''}
                saving={save.isPending}
                onChange={(value) => setDraft((current) => ({ ...current, global_session_prompt: value }))}
                onSave={() => commit({ global_session_prompt: buildGlobalSessionPromptSaveValue(draft.global_session_prompt ?? '') })}
              />
            )}
            {activeCategory !== 'chat' && activeCategory !== 'general' && activeCategory !== 'sessionPrompt' && (
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
          <span>⌘K</span>
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
  onCategoryChange,
  onReset,
}: {
  activeCategory: SettingsCategory;
  onCategoryChange: (category: SettingsCategory) => void;
  onReset: () => void;
}): JSX.Element {
  return (
    <aside className="system-settings-sidebar">
      <nav className="system-settings-sidebar__nav" aria-label="系统设置分类">
        {sidebarItems.map((item) => {
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
      <button type="button" className="system-settings-reset" onClick={onReset}>
        <span>
          <RefreshCw aria-hidden="true" />
          <strong>恢复默认设置</strong>
        </span>
        <small>将所有设置恢复为系统默认值</small>
      </button>
    </aside>
  );
}

function ChatSettingsPanel({
  settings,
  fallbackOptions,
  saving,
  onCommit,
}: {
  settings: SystemSettings;
  fallbackOptions: FallbackAgentOption[];
  saving: boolean;
  onCommit: (patch: SettingsPatch) => void;
}): JSX.Element {
  const fallbackAgentId = pickFallbackAgentId(settings.fallback_agent_id ?? 'planner', fallbackOptions);
  const routeMentionsOnly = settings.message_routing_mode === 'mentions_only';
  const routeFallback = settings.message_routing_mode === 'fallback_reply';
  const askUser = settings.interaction_mode === 'ask_user';
  const autoRecommended = settings.interaction_mode === 'auto_recommended';
  const autoDistill = settings.auto_distill_enabled;

  return (
    <>
      <section className="system-settings-section-title">
        <div className="system-settings-section-title__icon">
          <MessageSquare aria-hidden="true" />
        </div>
        <div>
          <h1>聊天设置</h1>
          <p>配置消息回复、协作流程和智能体行为的默认策略。</p>
        </div>
      </section>

      <section className="system-settings-card system-settings-chat-card" aria-label="协作默认值">
        <div className="system-settings-card__heading">
          <div className="system-settings-card__heading-icon">
            <Archive aria-hidden="true" />
          </div>
          <div>
            <h2>协作默认值</h2>
            <p>定义消息路由、决策流程和智能体的默认处理方式。</p>
          </div>
        </div>

        <div className="system-settings-chat-stack">
          <ToggleRow
            title="只响应 @"
            description="没有明确 @ 智能体时保持安静，避免不必要的打扰。"
            checked={routeMentionsOnly}
            disabled={saving}
            onChange={() => onCommit({ message_routing_mode: 'mentions_only', fallback_agent_id: null })}
          />

          <div className="system-settings-route-card is-selected">
            <div className="system-settings-route-card__top">
              <div>
                <h3>兜底回复</h3>
                <p>没有 @ 时由 planner 兜底生成协作调度建议。</p>
              </div>
              <Switch
                checked={routeFallback}
                disabled={saving}
                ariaLabel="启用兜底回复"
                onChange={() => onCommit({ message_routing_mode: 'fallback_reply', fallback_agent_id: fallbackAgentId || 'planner' })}
              />
            </div>
            <label className="system-settings-select-label">
              <span>兜底智能体</span>
              <div className="system-settings-select">
                <select
                  value={fallbackAgentId}
                  disabled={saving || !routeFallback || fallbackOptions.length === 0}
                  onChange={(event) => onCommit({ fallback_agent_id: event.currentTarget.value })}
                >
                  {fallbackOptions.length === 0 ? (
                    <option value="">暂无可用智能体</option>
                  ) : (
                    fallbackOptions.map((agent) => (
                      <option key={agent.agent_id} value={agent.agent_id}>
                        {agent.agent_name} ({agent.agent_id})
                      </option>
                    ))
                  )}
                </select>
                <ChevronDown aria-hidden="true" />
              </div>
            </label>
          </div>

          <div className="system-settings-option-grid">
            <CompactToggleCard
              icon={CircleHelp}
              title="需要决策时询问我"
              description="工作流遇到阻塞决策时暂停，等待人工选择。"
              checked={askUser}
              disabled={saving}
              onChange={() => onCommit({ interaction_mode: 'ask_user' })}
            />
            <CompactToggleCard
              icon={Zap}
              title="使用推荐选项自动继续"
              description="工作流使用推荐选项自动继续，适合低风险任务。"
              checked={autoRecommended}
              muted={!autoRecommended}
              disabled={saving}
              onChange={() => onCommit({ interaction_mode: 'auto_recommended' })}
            />
            <CompactToggleCard
              icon={Sparkles}
              title="开启记忆提取"
              description="Agent 回复完成后自动提取可复用记忆，并允许跨上下文引用。"
              checked={autoDistill}
              disabled={saving}
              onChange={() => onCommit({ auto_distill_enabled: true })}
            />
            <CompactToggleCard
              icon={CircleHelp}
              title="关闭记忆沉淀"
              description="不再自动调用 LLM 沉淀记忆；手动保存和手动新建任务记忆仍可用。"
              checked={!autoDistill}
              muted={autoDistill}
              disabled={saving}
              onChange={() => onCommit({ auto_distill_enabled: false })}
            />
          </div>
        </div>
      </section>

      <section className="system-settings-owner-grid" aria-label="Superpowers 启动接管">
        <OwnerCard
          icon={Archive}
          title="项目接管"
          description="由 OpenDeepSea 在会话入口注入 using-superpowers，仅作为兼容回退使用。"
          active={settings.superpowers_bootstrap_owner === 'project'}
          disabled={saving}
          onClick={() => onCommit({ superpowers_bootstrap_owner: 'project' })}
        />
        <OwnerCard
          icon={Zap}
          title="Provider 接管"
          description="OpenDeepSea 不注入启动指令，交给 ACP provider 自身的 Superpowers 插件处理。"
          active={settings.superpowers_bootstrap_owner === 'provider'}
          disabled={saving}
          onClick={() => onCommit({ superpowers_bootstrap_owner: 'provider' })}
        />
        <OwnerCard
          icon={Ban}
          title="关闭注入"
          description="OpenDeepSea 和受控 ACP 环境都不主动注入 Superpowers 启动指令。"
          active={settings.superpowers_bootstrap_owner === 'disabled'}
          disabled={saving}
          onClick={() => onCommit({ superpowers_bootstrap_owner: 'disabled' })}
        />
      </section>
    </>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}): JSX.Element {
  return (
    <div className="system-settings-toggle-row">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} ariaLabel={title} onChange={onChange} />
    </div>
  );
}

function CompactToggleCard({
  icon: Icon,
  title,
  description,
  checked,
  muted = false,
  disabled,
  onChange,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  checked: boolean;
  muted?: boolean;
  disabled: boolean;
  onChange: () => void;
}): JSX.Element {
  return (
    <article className={cn('system-settings-mini-card', muted && 'is-muted')}>
      <Icon aria-hidden="true" />
      <div>
        <div className="system-settings-mini-card__title">
          <h3>{title}</h3>
          <Switch checked={checked} disabled={disabled} ariaLabel={title} onChange={onChange} />
        </div>
        <p>{description}</p>
      </div>
    </article>
  );
}

function OwnerCard({
  icon: Icon,
  title,
  description,
  active,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn('system-settings-owner-card', active && 'is-active', !active && 'is-muted')}
      disabled={disabled}
      onClick={onClick}
    >
      {active && (
        <span className="system-settings-owner-card__check">
          <Check aria-hidden="true" />
        </span>
      )}
      <span className="system-settings-owner-card__icon">
        <Icon aria-hidden="true" />
      </span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

function Switch({
  checked,
  disabled,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  ariaLabel: string;
  onChange: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn('system-settings-switch', checked && 'is-checked')}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

function GeneralSettingsPanel({
  theme,
  onThemeChange,
}: {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): JSX.Element {
  const { locale, setLocale } = useI18n();
  const style = getThemeStyle(theme);
  const tone = getThemeTone(theme);

  return (
    <>
      <section className="system-settings-section-title">
        <div className="system-settings-section-title__icon">
          <Settings aria-hidden="true" />
        </div>
        <div>
          <h1>通用设置</h1>
          <p>调整界面风格、明暗模式与本地语言偏好。</p>
        </div>
      </section>
      <section className="system-settings-card system-settings-aux-card">
        <SegmentedControls
          label="界面风格"
          options={[
            { value: 'apple', label: 'Apple Glass' },
            { value: 'minimal', label: '极简主题' },
          ]}
          value={style}
          onChange={(value) => onThemeChange(createThemeMode(value, tone))}
        />
        <SegmentedControls
          label="明暗模式"
          options={[
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
          ]}
          value={tone}
          onChange={(value) => onThemeChange(createThemeMode(style, value))}
        />
        <SegmentedControls
          label="语言"
          options={[
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' },
          ]}
          value={locale}
          onChange={(value) => setLocale(value as Locale)}
        />
      </section>
    </>
  );
}

function SessionPromptPanel({
  value,
  saving,
  onChange,
  onSave,
}: {
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}): JSX.Element {
  const isOverLimit = value.length > GLOBAL_SESSION_PROMPT_LIMIT;
  return (
    <>
      <section className="system-settings-section-title">
        <div className="system-settings-section-title__icon">
          <FileText aria-hidden="true" />
        </div>
        <div>
          <h1>会话提示词</h1>
          <p>配置每次项目会话运行前注入的全局系统提示。</p>
        </div>
      </section>
      <section className="system-settings-card system-settings-aux-card">
        <label className="system-settings-textarea-label">
          <span>全局会话提示词</span>
          <textarea
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder="例如：始终先说明执行边界、风险和验证方式。"
          />
        </label>
        <div className="system-settings-prompt-footer">
          <span className={isOverLimit ? 'is-danger' : ''}>{buildGlobalSessionPromptCounterLabel(value)}</span>
          <button type="button" disabled={saving || isOverLimit} onClick={onSave}>
            保存提示词
          </button>
        </div>
      </section>
    </>
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
          <p>高密度设置页框架已接入，当前分类沿用后续配置中心扩展。</p>
        </div>
      </section>
      <section className="system-settings-card system-settings-aux-card">
        <div className="system-settings-placeholder">
          <KeyRound aria-hidden="true" />
          <strong>{meta.label}</strong>
          <span>请从聊天设置、通用设置或会话提示词中调整当前可用系统配置。</span>
        </div>
      </section>
    </>
  );
}

function SegmentedControls<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="system-settings-segmented">
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? 'is-active' : ''}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
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

function toGlobalFallbackOptions(agents: Agent[]): FallbackAgentOption[] {
  const options = agents
    .map((agent) => ({ agent_id: agent.agent_id, agent_name: agent.name }))
    .sort((a, b) => a.agent_name.localeCompare(b.agent_name))
    .filter((agent, index, list) => list.findIndex((item) => item.agent_id === agent.agent_id) === index);

  if (options.some((option) => option.agent_id === 'planner')) return options;
  return [{ agent_id: 'planner', agent_name: '规划师' }, ...options];
}

function pickFallbackAgentId(value: string, options: FallbackAgentOption[]): string {
  if (options.length === 0) return '';
  if (options.some((agent) => agent.agent_id === value)) return value;
  return options.find((agent) => agent.agent_id === 'planner')?.agent_id ?? options[0].agent_id;
}
