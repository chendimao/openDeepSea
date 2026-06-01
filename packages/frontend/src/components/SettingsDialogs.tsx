import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CheckCircle2,
  Circle,
  KeyRound,
  Pencil,
  Plus,
  Globe2,
  Moon,
  PanelTop,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  SwatchBook,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n, type Locale, type MessageKey } from '../lib/i18n';
import { SkillsSettingsPanel } from './SkillsSettingsPanel';
import {
  createThemeMode,
  getThemeStyle,
  getThemeTone,
  THEME_STYLES,
  THEME_TONES,
  type ThemeMode,
  type ThemeStyle,
  type ThemeTone,
} from '../lib/theme';
import {
  type Agent,
  type AiConfig,
  type EffectiveSettings,
  type MessageRoutingMode,
  type Project,
  type Room,
  type RoomAgent,
  type SettingsResolution,
  type SuperpowersBootstrapOwner,
  type SystemSettings,
  type TaskInteractionMode,
} from '../lib/types';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input, Label } from './ui/Input';

type SettingsPatch = {
  message_routing_mode?: MessageRoutingMode | null;
  fallback_agent_id?: string | null;
  interaction_mode?: TaskInteractionMode | null;
  auto_distill_enabled?: boolean | null;
  superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
};

type SystemSettingsSavePatch = {
  message_routing_mode: MessageRoutingMode;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode;
  auto_distill_enabled: boolean;
  superpowers_bootstrap_owner: SuperpowersBootstrapOwner;
  langchain_planner_model?: string | null;
  openai_base_url?: string | null;
  openai_api_key?: string | null;
};

const ROUTING_OPTIONS: Array<{ value: MessageRoutingMode; descriptionKey: MessageKey }> = [
  { value: 'mentions_only', descriptionKey: 'settings.routing.mentions_only.description' },
  { value: 'fallback_reply', descriptionKey: 'settings.routing.fallback_reply.description' },
];

const INTERACTION_OPTIONS: Array<{ value: TaskInteractionMode; descriptionKey: MessageKey }> = [
  { value: 'ask_user', descriptionKey: 'settings.interaction.ask_user.description' },
  { value: 'auto_recommended', descriptionKey: 'settings.interaction.auto_recommended.description' },
];

const SUPERPOWERS_BOOTSTRAP_OPTIONS: Array<{ value: SuperpowersBootstrapOwner; descriptionKey: MessageKey }> = [
  { value: 'project', descriptionKey: 'settings.superpowersBootstrap.project.description' },
  { value: 'provider', descriptionKey: 'settings.superpowersBootstrap.provider.description' },
  { value: 'disabled', descriptionKey: 'settings.superpowersBootstrap.disabled.description' },
];

const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  message_routing_mode: 'fallback_reply',
  fallback_agent_id: 'planner',
  interaction_mode: 'ask_user',
  auto_distill_enabled: true,
  default_workflow_definition_id: null,
  superpowers_bootstrap_owner: 'provider',
  workspace_excluded_dirs: [],
  active_ai_config_id: null,
  ai_configs: [],
  langchain_planner_model: null,
  openai_base_url: null,
  openai_api_key_set: false,
  openai_api_key_preview: null,
};

type SystemSettingsCategory = 'general' | 'chat' | 'model' | 'skills';

type AiConfigDraft = {
  name: string;
  plannerModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  clearOpenaiApiKey: boolean;
};

export function SystemSettingsDialog({
  children,
  theme,
  onThemeChange,
}: {
  children: ReactNode;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const { data: settings = DEFAULT_SYSTEM_SETTINGS } = useQuery({
    queryKey: ['settings', 'system'],
    queryFn: api.getSystemSettings,
    enabled: open,
  });
  const { data: aiConfigs } = useQuery({
    queryKey: ['settings', 'ai-configs'],
    queryFn: api.listAiConfigs,
    enabled: open,
  });
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: api.listAgents,
    enabled: open,
  });
  const save = useMutation({
    mutationFn: api.updateSystemSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['settings', 'ai-configs'] });
      toast.success(t('settings.systemSaved'));
      setOpen(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        title={t('settings.systemTitle')}
        description={t('settings.systemDescription')}
        className="max-h-[88vh] w-[min(94vw,900px)] overflow-y-auto"
      >
        <SystemSettingsForm
          key={`${settings.message_routing_mode}:${settings.fallback_agent_id ?? ''}:${settings.interaction_mode}:${settings.auto_distill_enabled}:${settings.active_ai_config_id ?? ''}:${aiConfigs?.items.length ?? 0}`}
          theme={theme}
          value={settings}
          aiConfigs={aiConfigs ?? { active_ai_config_id: settings.active_ai_config_id, items: settings.ai_configs ?? [] }}
          fallbackOptions={toGlobalFallbackOptions(agents)}
          isSaving={save.isPending}
          onThemeChange={onThemeChange}
          onSave={(patch) => save.mutate(patch)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function ProjectSettingsDialog({
  project,
  children,
}: {
  project: Project;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const { data: settings } = useQuery({
    queryKey: ['settings', 'project', project.id],
    queryFn: () => api.getProjectSettings(project.id),
    enabled: open,
  });
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: api.listAgents,
    enabled: open,
  });
  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api.updateProjectSettings(project.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success(t('settings.projectSaved'));
      setOpen(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        title={t('settings.projectTitle')}
        description={project.name}
        className="max-h-[88vh] w-[min(94vw,780px)] overflow-y-auto"
      >
        <ProjectSettingsForm
          key={`${project.id}:${settings?.project?.updated_at ?? 0}`}
          project={project}
          settings={settings}
          fallbackOptions={toGlobalFallbackOptions(agents)}
          isSaving={save.isPending}
          onSave={(patch) => save.mutate(patch)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function RoomSettingsDialog({
  project,
  room,
  agents,
  children,
}: {
  project: Project;
  room: Room;
  agents: RoomAgent[];
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const { data: settings } = useQuery({
    queryKey: ['settings', 'room', room.id],
    queryFn: () => api.getRoomSettings(room.id),
    enabled: open,
  });
  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api.updateRoomSettings(room.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success(t('settings.roomSaved'));
      setOpen(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const fallbackOptions = useMemo(
    () => toRoomFallbackOptions(agents),
    [agents],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        title={t('settings.roomTitle')}
        description={`${project.name} / ${room.name}`}
        className="max-h-[88vh] w-[min(94vw,780px)] overflow-y-auto"
      >
        <RoomSettingsForm
          key={`${room.id}:${settings?.room?.updated_at ?? 0}`}
          room={room}
          settings={settings}
          fallbackOptions={fallbackOptions}
          isSaving={save.isPending}
          onSave={(patch) => save.mutate(patch)}
        />
      </DialogContent>
    </Dialog>
  );
}

function SystemSettingsForm({
  theme,
  value,
  aiConfigs,
  fallbackOptions,
  isSaving,
  onThemeChange,
  onSave,
}: {
  theme: ThemeMode;
  value: SystemSettings;
  aiConfigs: { active_ai_config_id: string | null; items: AiConfig[] };
  fallbackOptions: FallbackAgentOption[];
  isSaving: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onSave: (patch: SystemSettingsSavePatch) => void;
}): JSX.Element {
  const [routingMode, setRoutingMode] = useState<MessageRoutingMode>(value.message_routing_mode);
  const [fallbackAgentId, setFallbackAgentId] = useState(value.fallback_agent_id ?? 'planner');
  const [interactionMode, setInteractionMode] = useState<TaskInteractionMode>(value.interaction_mode);
  const [autoDistillEnabled, setAutoDistillEnabled] = useState(value.auto_distill_enabled);
  const [superpowersBootstrapOwner, setSuperpowersBootstrapOwner] = useState<SuperpowersBootstrapOwner>(
    value.superpowers_bootstrap_owner,
  );
  const [selectedAiConfigId, setSelectedAiConfigId] = useState<string | null>(
    aiConfigs.active_ai_config_id ?? aiConfigs.items[0]?.id ?? null,
  );
  const [aiConfigDraft, setAiConfigDraft] = useState<AiConfigDraft>(() =>
    createDraftFromConfig(aiConfigs.items.find((item) => item.id === aiConfigs.active_ai_config_id) ?? aiConfigs.items[0] ?? null),
  );
  const [aiConfigMode, setAiConfigMode] = useState<'edit' | 'create'>(aiConfigs.items.length > 0 ? 'edit' : 'create');
  const [aiConfigError, setAiConfigError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<SystemSettingsCategory>('general');
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const requiresFallback = routingMode !== 'mentions_only';
  const selectedFallbackAgentId = pickFallbackAgentId(fallbackAgentId, fallbackOptions);
  const selectedAiConfig = aiConfigs.items.find((item) => item.id === selectedAiConfigId) ?? null;
  const activeAiConfig = aiConfigs.items.find((item) => item.id === aiConfigs.active_ai_config_id) ?? null;
  const refreshAiConfigQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['settings', 'system'] }),
      queryClient.invalidateQueries({ queryKey: ['settings', 'ai-configs'] }),
      queryClient.invalidateQueries({ queryKey: ['settings'] }),
    ]);
  };
  const createAiConfigMutation = useMutation({
    mutationFn: api.createAiConfig,
    onSuccess: async (config) => {
      await refreshAiConfigQueries();
      setSelectedAiConfigId(config.id);
      setAiConfigDraft(createDraftFromConfig(config));
      setAiConfigMode('edit');
      setAiConfigError(null);
      toast.success(t('settings.aiConfigCreated'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const updateAiConfigMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof api.updateAiConfig>[1] }) =>
      api.updateAiConfig(id, input),
    onSuccess: async (config) => {
      await refreshAiConfigQueries();
      setSelectedAiConfigId(config.id);
      setAiConfigDraft(createDraftFromConfig(config));
      setAiConfigMode('edit');
      setAiConfigError(null);
      toast.success(t('settings.aiConfigSaved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const activateAiConfigMutation = useMutation({
    mutationFn: api.activateAiConfig,
    onSuccess: async () => {
      await refreshAiConfigQueries();
      setAiConfigError(null);
      toast.success(t('settings.aiConfigActivated'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const deleteAiConfigMutation = useMutation({
    mutationFn: api.deleteAiConfig,
    onSuccess: async (_result, deletedId) => {
      await refreshAiConfigQueries();
      const nextItems = aiConfigs.items.filter((item) => item.id !== deletedId);
      const nextSelected = aiConfigs.active_ai_config_id === deletedId
        ? nextItems.find((item) => item.id !== deletedId)?.id ?? null
        : selectedAiConfigId === deletedId
          ? aiConfigs.active_ai_config_id ?? nextItems[0]?.id ?? null
          : selectedAiConfigId;
      const nextConfig = nextItems.find((item) => item.id === nextSelected) ?? null;
      setSelectedAiConfigId(nextSelected);
      setAiConfigDraft(createDraftFromConfig(nextConfig));
      setAiConfigMode(nextConfig ? 'edit' : 'create');
      setAiConfigError(null);
      toast.success(t('settings.aiConfigDeleted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const aiConfigBusy =
    createAiConfigMutation.isPending ||
    updateAiConfigMutation.isPending ||
    activateAiConfigMutation.isPending ||
    deleteAiConfigMutation.isPending;
  const saveAiConfig = (activate: boolean) => {
    const validationError = validateAiConfigDraft(aiConfigDraft, t);
    if (validationError) {
      setAiConfigError(validationError);
      return;
    }
    const input = {
      name: aiConfigDraft.name.trim(),
      langchain_planner_model: aiConfigDraft.plannerModel.trim(),
      openai_base_url: aiConfigDraft.openaiBaseUrl.trim(),
      activate,
      ...(aiConfigDraft.clearOpenaiApiKey
        ? { openai_api_key: null }
        : aiConfigDraft.openaiApiKey.trim()
          ? { openai_api_key: aiConfigDraft.openaiApiKey.trim() }
          : {}),
    };
    if (aiConfigMode === 'edit' && selectedAiConfig) {
      updateAiConfigMutation.mutate({ id: selectedAiConfig.id, input });
    } else {
      createAiConfigMutation.mutate(input);
    }
  };

  useEffect(() => {
    const nextSelectedId = aiConfigs.active_ai_config_id ?? aiConfigs.items[0]?.id ?? null;
    setSelectedAiConfigId(nextSelectedId);
    setAiConfigDraft(createDraftFromConfig(aiConfigs.items.find((item) => item.id === nextSelectedId) ?? aiConfigs.items[0] ?? null));
    setAiConfigMode(aiConfigs.items.length > 0 ? 'edit' : 'create');
    setAiConfigError(null);
  }, [aiConfigs.active_ai_config_id, aiConfigs.items]);
  const categories: Array<{
    value: SystemSettingsCategory;
    title: string;
    description: string;
    icon: LucideIcon;
  }> = [
    {
      value: 'general',
      title: t('settings.generalSettings'),
      description: t('settings.generalSettingsDescription'),
      icon: Settings2,
    },
    {
      value: 'chat',
      title: t('settings.chatSettings'),
      description: t('settings.chatSettingsDescription'),
      icon: Bot,
    },
    {
      value: 'model',
      title: t('settings.modelSettings'),
      description: t('settings.modelSettingsDescription'),
      icon: Sparkles,
    },
    {
      value: 'skills',
      title: t('settings.skills'),
      description: t('settings.skillsDescription'),
      icon: ShieldCheck,
    },
  ];
  const activeCategoryMeta = categories.find((category) => category.value === activeCategory) ?? categories[0];
  const ActiveCategoryIcon = activeCategoryMeta.icon;

  return (
    <SettingsDialogBody
      footer={
        <Button
          type="button"
          disabled={isSaving || (requiresFallback && !selectedFallbackAgentId)}
          onClick={() => {
            const patch: SystemSettingsSavePatch = {
              message_routing_mode: routingMode,
              fallback_agent_id: requiresFallback ? selectedFallbackAgentId : null,
              interaction_mode: interactionMode,
              auto_distill_enabled: autoDistillEnabled,
              superpowers_bootstrap_owner: superpowersBootstrapOwner,
            };
            onSave(patch);
          }}
        >
          <Save className="h-3.5 w-3.5" />
          {t('settings.saveSystem')}
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5"
          aria-label={t('settings.categoryNavigation')}
        >
          {categories.map((category) => {
            const Icon = category.icon;
            return (
              <button
                key={category.value}
                type="button"
                className={cn(
                  'flex min-h-[54px] w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ease-ocean',
                  activeCategory === category.value
                    ? 'bg-[var(--color-surface-raised)] text-[var(--color-fg)] shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                    : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
                )}
                aria-current={activeCategory === category.value ? 'page' : undefined}
                onClick={() => setActiveCategory(category.value)}
              >
                <Icon className="h-4 w-4 flex-shrink-0 text-[var(--color-accent)]" strokeWidth={1.75} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold leading-tight">{category.title}</span>
                  <span className="mt-1 block text-[11px] leading-snug text-[var(--color-fg-muted)]">
                    {category.description}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="mb-4 flex items-start gap-2.5">
            <ActiveCategoryIcon className="mt-0.5 h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
            <div>
              <h3 className="font-display text-[14px] font-semibold text-[var(--color-fg)]">
                {activeCategoryMeta.title}
              </h3>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
                {activeCategoryMeta.description}
              </p>
            </div>
          </div>
          {activeCategory === 'general' && (
            <div className="space-y-4">
              <SubSettingSection
                title={t('settings.appearance')}
                description={t('settings.appearanceDescription')}
                icon={<SwatchBook className="h-4 w-4" strokeWidth={1.75} />}
              >
                <AppearanceSection theme={theme} onThemeChange={onThemeChange} />
              </SubSettingSection>
              <SubSettingSection
                title={t('settings.language')}
                description={t('settings.languageDescription')}
                icon={<Globe2 className="h-4 w-4" strokeWidth={1.75} />}
              >
                <LanguageSection />
              </SubSettingSection>
            </div>
          )}
          {activeCategory === 'chat' && (
            <div className="space-y-3">
              <SubSettingSection
                title={t('settings.collaborationDefaults')}
                description={t('settings.collaborationDefaultsDescription')}
                icon={<Bot className="h-4 w-4" strokeWidth={1.75} />}
              >
                <RoutingSection
                  mode={routingMode}
                  fallbackAgentId={fallbackAgentId}
                  fallbackOptions={fallbackOptions}
                  inheritedLabel={null}
                  onModeChange={(mode) => {
                    if (mode !== 'inherit') setRoutingMode(mode);
                  }}
                  onFallbackAgentChange={setFallbackAgentId}
                />
                <InteractionSection
                  mode={interactionMode}
                  inheritedLabel={null}
                  onModeChange={(mode) => {
                    if (mode !== 'inherit') setInteractionMode(mode);
                  }}
                />
                <AutoDistillSection
                  mode={autoDistillEnabled}
                  inheritedLabel={null}
                  onModeChange={(mode) => {
                    if (mode !== 'inherit') setAutoDistillEnabled(mode);
                  }}
                />
                <SuperpowersBootstrapSection
                  mode={superpowersBootstrapOwner}
                  inheritedLabel={null}
                  onModeChange={(mode) => {
                    if (mode !== 'inherit') setSuperpowersBootstrapOwner(mode);
                  }}
                />
              </SubSettingSection>
            </div>
          )}
          {activeCategory === 'model' && (
            <div className="space-y-3">
              <SubSettingSection
                title={t('settings.modelProvider')}
                description={t('settings.modelProviderDescription')}
                icon={<Sparkles className="h-4 w-4" strokeWidth={1.75} />}
              >
                <ModelSettingsSection
                  configs={aiConfigs.items}
                  activeConfigId={aiConfigs.active_ai_config_id}
                  selectedConfigId={selectedAiConfigId}
                  activeConfig={activeAiConfig}
                  draft={aiConfigDraft}
                  mode={aiConfigMode}
                  error={aiConfigError}
                  isSaving={aiConfigBusy}
                  onSelectConfig={(config) => {
                    setSelectedAiConfigId(config.id);
                    setAiConfigDraft(createDraftFromConfig(config));
                    setAiConfigMode('edit');
                    setAiConfigError(null);
                  }}
                  onCreateConfig={() => {
                    setSelectedAiConfigId(null);
                    setAiConfigDraft(createEmptyAiConfigDraft(aiConfigs.items.length));
                    setAiConfigMode('create');
                    setAiConfigError(null);
                  }}
                  onDraftChange={(patch) => {
                    setAiConfigDraft((current) => ({ ...current, ...patch }));
                    setAiConfigError(null);
                  }}
                  onSaveDraft={() => saveAiConfig(false)}
                  onUseCurrent={() => saveAiConfig(true)}
                  onActivateConfig={(configId) => activateAiConfigMutation.mutate(configId)}
                  onDeleteConfig={(configId) => deleteAiConfigMutation.mutate(configId)}
                />
              </SubSettingSection>
            </div>
          )}
          {activeCategory === 'skills' && <SkillsSettingsPanel />}
        </section>
      </div>
    </SettingsDialogBody>
  );
}

function SubSettingSection({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 flex-shrink-0 text-[var(--color-accent)]">{icon}</span>
        <div>
          <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">{title}</h4>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function AppearanceSection({
  theme,
  onThemeChange,
}: {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): JSX.Element {
  const { t } = useI18n();
  const style = getThemeStyle(theme);
  const tone = getThemeTone(theme);
  const styleIcons: Record<ThemeStyle, LucideIcon> = {
    apple: Sparkles,
    minimal: PanelTop,
  };
  const toneIcons: Record<ThemeTone, LucideIcon> = {
    light: Sun,
    dark: Moon,
  };
  const styleLabels: Record<ThemeStyle, string> = {
    apple: t('theme.style.apple'),
    minimal: t('theme.style.minimal'),
  };
  const toneLabels: Record<ThemeTone, string> = {
    light: t('theme.tone.light'),
    dark: t('theme.tone.dark'),
  };

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <SegmentedSetting
        label={t('theme.style.label')}
        ariaLabel={t('theme.style.label')}
        options={THEME_STYLES.map((option) => ({
          value: option,
          label: styleLabels[option],
          icon: styleIcons[option],
        }))}
        value={style}
        onChange={(nextStyle) => onThemeChange(createThemeMode(nextStyle, tone))}
      />
      <SegmentedSetting
        label={t('theme.tone.label')}
        ariaLabel={t('theme.tone.label')}
        options={THEME_TONES.map((option) => ({
          value: option,
          label: toneLabels[option],
          icon: toneIcons[option],
        }))}
        value={tone}
        onChange={(nextTone) => onThemeChange(createThemeMode(style, nextTone))}
      />
    </div>
  );
}

function LanguageSection(): JSX.Element {
  const { locale, setLocale, t } = useI18n();
  const options: Array<{ value: Locale; label: string }> = [
    { value: 'zh', label: t('language.zh') },
    { value: 'en', label: t('language.en') },
  ];

  return (
    <SegmentedSetting
      label={t('language.label')}
      ariaLabel={t('language.label')}
      options={options}
      value={locale}
      onChange={setLocale}
    />
  );
}

function ModelSettingsSection({
  configs,
  activeConfigId,
  selectedConfigId,
  activeConfig,
  draft,
  mode,
  error,
  isSaving,
  onSelectConfig,
  onCreateConfig,
  onDraftChange,
  onSaveDraft,
  onUseCurrent,
  onActivateConfig,
  onDeleteConfig,
}: {
  configs: AiConfig[];
  activeConfigId: string | null;
  selectedConfigId: string | null;
  activeConfig: AiConfig | null;
  draft: AiConfigDraft;
  mode: 'edit' | 'create';
  error: string | null;
  isSaving: boolean;
  onSelectConfig: (config: AiConfig) => void;
  onCreateConfig: () => void;
  onDraftChange: (patch: Partial<AiConfigDraft>) => void;
  onSaveDraft: () => void;
  onUseCurrent: () => void;
  onActivateConfig: (configId: string) => void;
  onDeleteConfig: (configId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const selectedConfig = configs.find((item) => item.id === selectedConfigId) ?? null;
  const canDelete = mode === 'edit' && Boolean(selectedConfig);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(300px,1.05fr)]">
      <div className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h5 className="text-[12px] font-semibold text-[var(--color-fg)]">{t('settings.aiConfigList')}</h5>
            <p className="mt-1 truncate text-[11px] text-[var(--color-fg-muted)]">
              {activeConfig ? t('settings.aiConfigActiveSummary', { name: activeConfig.name }) : t('settings.aiConfigNoActive')}
            </p>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={onCreateConfig}>
            <Plus className="h-3.5 w-3.5" />
            {t('settings.aiConfigNew')}
          </Button>
        </div>

        {configs.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-3 py-6 text-center">
            <Sparkles className="mx-auto h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.75} />
            <div className="mt-2 text-[12px] font-semibold text-[var(--color-fg)]">{t('settings.aiConfigEmptyTitle')}</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              {t('settings.aiConfigEmptyDescription')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {configs.map((config) => {
              const isActive = config.id === activeConfigId;
              const isSelected = config.id === selectedConfigId;
              return (
                <button
                  key={config.id}
                  type="button"
                  onClick={() => onSelectConfig(config)}
                  className={cn(
                    'w-full rounded-md border p-3 text-left transition-colors ease-ocean',
                    isSelected
                      ? 'border-[var(--color-accent)] bg-[var(--color-surface-raised)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-raised)] hover:border-[var(--color-border-strong)]',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {isActive ? (
                          <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-success)]" strokeWidth={1.9} />
                        ) : (
                          <Circle className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted)]" strokeWidth={1.7} />
                        )}
                        <span className="truncate text-[13px] font-semibold text-[var(--color-fg)]">{config.name}</span>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11.5px] text-[var(--color-fg-muted)]">
                        {config.langchain_planner_model}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold',
                        isActive
                          ? 'bg-[color-mix(in_srgb,var(--color-success)_14%,transparent)] text-[var(--color-success)]'
                          : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)]',
                      )}
                    >
                      {isActive ? t('settings.aiConfigCurrent') : t('settings.aiConfigStandby')}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-1 text-[11px] text-[var(--color-fg-muted)]">
                    <span className="truncate">{config.openai_base_url}</span>
                    <span className="inline-flex items-center gap-1">
                      <KeyRound className="h-3 w-3" strokeWidth={1.75} />
                      {config.openai_api_key_set ? t('settings.openaiApiKeySaved', { preview: config.openai_api_key_preview ?? '' }) : t('settings.openaiApiKeyNotSaved')}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h5 className="text-[12px] font-semibold text-[var(--color-fg)]">
              {mode === 'create' ? t('settings.aiConfigCreateTitle') : t('settings.aiConfigEditTitle')}
            </h5>
            <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
              {mode === 'create' ? t('settings.aiConfigCreateDescription') : t('settings.aiConfigEditDescription')}
            </p>
          </div>
          {mode === 'edit' && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-surface-raised)] px-2 py-1 text-[10.5px] font-semibold text-[var(--color-fg-muted)]">
              <Pencil className="h-3 w-3" strokeWidth={1.75} />
              {selectedConfig?.id === activeConfigId ? t('settings.aiConfigCurrent') : t('settings.aiConfigStandby')}
            </span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label>{t('settings.aiConfigName')}</Label>
            <Input
              value={draft.name}
              onChange={(event) => onDraftChange({ name: event.target.value })}
              placeholder={t('settings.aiConfigNamePlaceholder')}
            />
          </div>
          <div>
            <Label>{t('settings.plannerModel')}</Label>
            <Input
              value={draft.plannerModel}
              onChange={(event) => onDraftChange({ plannerModel: event.target.value })}
              placeholder={t('settings.plannerModelPlaceholder')}
              className="font-mono"
            />
          </div>
          <div>
            <Label>{t('settings.openaiBaseUrl')}</Label>
            <Input
              value={draft.openaiBaseUrl}
              onChange={(event) => onDraftChange({ openaiBaseUrl: event.target.value })}
              placeholder={t('settings.openaiBaseUrlPlaceholder')}
              className="font-mono"
            />
          </div>
          <div className="sm:col-span-2">
            <Label>{t('settings.openaiApiKey')}</Label>
            <Input
              type="password"
              value={draft.openaiApiKey}
              onChange={(event) => onDraftChange({ openaiApiKey: event.target.value, clearOpenaiApiKey: false })}
              placeholder={t('settings.openaiApiKeyPlaceholder')}
              className="font-mono"
              disabled={draft.clearOpenaiApiKey}
              autoComplete="new-password"
            />
            <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              {selectedConfig?.openai_api_key_set
                ? t('settings.openaiApiKeySaved', { preview: selectedConfig.openai_api_key_preview ?? '' })
                : t('settings.openaiApiKeyNotSaved')}
            </p>
            {selectedConfig?.openai_api_key_set && (
              <label className="mt-2 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[12px] text-[var(--color-fg-muted)]">
                <input
                  type="checkbox"
                  checked={draft.clearOpenaiApiKey}
                  onChange={(event) => onDraftChange({ clearOpenaiApiKey: event.target.checked, openaiApiKey: '' })}
                  className="h-3.5 w-3.5 accent-[var(--color-primary)]"
                />
                <span>{t('settings.clearOpenaiApiKey')}</span>
              </label>
            )}
          </div>
        </div>
        {error && <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-danger)]">{error}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {canDelete && (
            <Button type="button" size="sm" variant="danger" disabled={isSaving} onClick={() => selectedConfig && onDeleteConfig(selectedConfig.id)}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('settings.aiConfigDelete')}
            </Button>
          )}
          <Button type="button" size="sm" variant="secondary" disabled={isSaving} onClick={onSaveDraft}>
            <Save className="h-3.5 w-3.5" />
            {mode === 'create' ? t('settings.aiConfigCreate') : t('settings.aiConfigSave')}
          </Button>
          {selectedConfig && (
            <Button
              type="button"
              size="sm"
              disabled={isSaving}
              onClick={() => {
                if (selectedConfig.id === activeConfigId) {
                  onUseCurrent();
                } else {
                  onActivateConfig(selectedConfig.id);
                }
              }}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {selectedConfig.id === activeConfigId ? t('settings.aiConfigReapply') : t('settings.aiConfigUse')}
            </Button>
          )}
          {!selectedConfig && (
            <Button type="button" size="sm" disabled={isSaving} onClick={onUseCurrent}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('settings.aiConfigSaveAndUse')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SegmentedSetting<T extends string>({
  label,
  ariaLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  options: Array<{ value: T; label: string; icon?: LucideIcon }>;
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div>
      <Label>{label}</Label>
      <div
        className="mt-1.5 flex min-h-10 w-full items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1"
        role="group"
        aria-label={ariaLabel}
      >
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              className={cn(
                'inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] font-medium leading-none transition-colors ease-ocean',
                value === option.value
                  ? 'bg-[var(--color-surface)] text-[var(--color-primary)] shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                  : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]',
              )}
              aria-pressed={value === option.value}
              onClick={() => onChange(option.value)}
            >
              {Icon && <Icon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.75} />}
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProjectSettingsForm({
  project,
  settings,
  fallbackOptions,
  isSaving,
  onSave,
}: {
  project: Project;
  settings?: SettingsResolution;
  fallbackOptions: FallbackAgentOption[];
  isSaving: boolean;
  onSave: (patch: SettingsPatch) => void;
}): JSX.Element {
  const system = settings?.system ?? DEFAULT_SYSTEM_SETTINGS;
  const own = settings?.project;
  const { interactionModeLabel, routingModeLabel, t } = useI18n();
  const [superpowersBootstrapOwner, setSuperpowersBootstrapOwner] = useState<SuperpowersBootstrapOwner | 'inherit'>(
    own?.superpowers_bootstrap_owner ?? 'inherit',
  );
  const [routingMode, setRoutingMode] = useState<MessageRoutingMode | 'inherit'>(
    own?.message_routing_mode ?? 'inherit',
  );
  const [fallbackAgentId, setFallbackAgentId] = useState(own?.fallback_agent_id ?? system.fallback_agent_id ?? 'planner');
  const [interactionMode, setInteractionMode] = useState<TaskInteractionMode | 'inherit'>(
    own?.interaction_mode ?? 'inherit',
  );
  const [autoDistillEnabled, setAutoDistillEnabled] = useState<boolean | 'inherit'>(
    own?.auto_distill_enabled === null || own?.auto_distill_enabled === undefined
      ? 'inherit'
      : Boolean(own.auto_distill_enabled),
  );
  const requiresFallback = routingMode !== 'inherit' && routingMode !== 'mentions_only';
  const selectedFallbackAgentId = pickFallbackAgentId(fallbackAgentId, fallbackOptions);

  return (
    <SettingsDialogBody
      footer={
        <Button
          type="button"
          disabled={isSaving || (requiresFallback && !selectedFallbackAgentId)}
          onClick={() =>
            onSave({
              message_routing_mode: routingMode === 'inherit' ? null : routingMode,
              fallback_agent_id: routingMode === 'inherit' || routingMode === 'mentions_only' ? null : selectedFallbackAgentId,
              interaction_mode: interactionMode === 'inherit' ? null : interactionMode,
              auto_distill_enabled: autoDistillEnabled === 'inherit' ? null : autoDistillEnabled,
              superpowers_bootstrap_owner: superpowersBootstrapOwner === 'inherit' ? null : superpowersBootstrapOwner,
            })
          }
        >
          <Save className="h-3.5 w-3.5" />
          {t('settings.saveProject')}
        </Button>
      }
    >
      <SettingGroup title={t('settings.projectInfo')} icon={<Settings2 className="h-4 w-4" strokeWidth={1.75} />}>
        <ReadonlyField label={t('settings.projectPath')} value={project.path} />
        {project.description && <ReadonlyField label={t('settings.projectDescription')} value={project.description} />}
      </SettingGroup>
      <InheritanceSummary settings={settings} scope="project" />
      <SettingGroup title={t('settings.projectRouting')} icon={<Bot className="h-4 w-4" strokeWidth={1.75} />}>
        <RoutingSection
          mode={routingMode}
          fallbackAgentId={fallbackAgentId || system.fallback_agent_id || ''}
          fallbackOptions={fallbackOptions}
          inheritedLabel={t('settings.inheritedSystem', { value: routingModeLabel(system.message_routing_mode) })}
          onModeChange={setRoutingMode}
          onFallbackAgentChange={setFallbackAgentId}
        />
      </SettingGroup>
      <SettingGroup title={t('settings.projectInteraction')} icon={<ShieldCheck className="h-4 w-4" strokeWidth={1.75} />}>
        <InteractionSection
          mode={interactionMode}
          inheritedLabel={t('settings.inheritedSystem', { value: interactionModeLabel(system.interaction_mode) })}
          onModeChange={setInteractionMode}
        />
        <AutoDistillSection
          mode={autoDistillEnabled}
          inheritedLabel={t('settings.inheritedSystem', { value: autoDistillLabel(system.auto_distill_enabled, t) })}
          onModeChange={setAutoDistillEnabled}
        />
        <SuperpowersBootstrapSection
          mode={superpowersBootstrapOwner}
          inheritedLabel={t('settings.inheritedSystem', { value: superpowersBootstrapOwnerLabel(system.superpowers_bootstrap_owner, t) })}
          onModeChange={setSuperpowersBootstrapOwner}
        />
      </SettingGroup>
      {(routingMode !== 'inherit' || interactionMode !== 'inherit' || autoDistillEnabled !== 'inherit' || superpowersBootstrapOwner !== 'inherit') && (
        <ResetInheritanceButton
          onClick={() => {
            setRoutingMode('inherit');
            setFallbackAgentId('');
            setInteractionMode('inherit');
            setAutoDistillEnabled('inherit');
            setSuperpowersBootstrapOwner('inherit');
          }}
        />
      )}
    </SettingsDialogBody>
  );
}

function RoomSettingsForm({
  room,
  settings,
  fallbackOptions,
  isSaving,
  onSave,
}: {
  room: Room;
  settings?: SettingsResolution;
  fallbackOptions: FallbackAgentOption[];
  isSaving: boolean;
  onSave: (patch: SettingsPatch) => void;
}): JSX.Element {
  const inherited = settings ? inheritedForRoom(settings) : DEFAULT_SYSTEM_SETTINGS;
  const own = settings?.room;
  const { interactionModeLabel, routingModeLabel, t } = useI18n();
  const [superpowersBootstrapOwner, setSuperpowersBootstrapOwner] = useState<SuperpowersBootstrapOwner | 'inherit'>(
    own?.superpowers_bootstrap_owner ?? 'inherit',
  );
  const [routingMode, setRoutingMode] = useState<MessageRoutingMode | 'inherit'>(
    own?.message_routing_mode ?? 'inherit',
  );
  const [fallbackAgentId, setFallbackAgentId] = useState(own?.fallback_agent_id ?? '');
  const [interactionMode, setInteractionMode] = useState<TaskInteractionMode | 'inherit'>(
    own?.interaction_mode ?? 'inherit',
  );
  const [autoDistillEnabled, setAutoDistillEnabled] = useState<boolean | 'inherit'>(
    own?.auto_distill_enabled === null || own?.auto_distill_enabled === undefined
      ? 'inherit'
      : Boolean(own.auto_distill_enabled),
  );
  const requiresFallback = routingMode !== 'inherit' && routingMode !== 'mentions_only';
  const selectedFallbackAgentId = pickFallbackAgentId(fallbackAgentId || inherited.fallback_agent_id || '', fallbackOptions);

  return (
    <SettingsDialogBody
      footer={
        <Button
          type="button"
          disabled={isSaving || (requiresFallback && !selectedFallbackAgentId)}
          onClick={() =>
            onSave({
              message_routing_mode: routingMode === 'inherit' ? null : routingMode,
              fallback_agent_id: routingMode === 'inherit' || routingMode === 'mentions_only' ? null : selectedFallbackAgentId,
              interaction_mode: interactionMode === 'inherit' ? null : interactionMode,
              auto_distill_enabled: autoDistillEnabled === 'inherit' ? null : autoDistillEnabled,
              superpowers_bootstrap_owner: superpowersBootstrapOwner === 'inherit' ? null : superpowersBootstrapOwner,
            })
          }
        >
          <Save className="h-3.5 w-3.5" />
          {t('settings.saveRoom')}
        </Button>
      }
    >
      <SettingGroup title={t('settings.roomInfo')} icon={<Settings2 className="h-4 w-4" strokeWidth={1.75} />}>
        <ReadonlyField label={t('settings.roomName')} value={room.name} />
        {room.description && <ReadonlyField label={t('settings.roomDescription')} value={room.description} />}
      </SettingGroup>
      <InheritanceSummary settings={settings} scope="room" />
      <SettingGroup title={t('settings.roomRouting')} icon={<Bot className="h-4 w-4" strokeWidth={1.75} />}>
        <RoutingSection
          mode={routingMode}
          fallbackAgentId={fallbackAgentId || inherited.fallback_agent_id || ''}
          fallbackOptions={fallbackOptions}
          inheritedLabel={t('settings.inheritedParent', { value: routingModeLabel(inherited.message_routing_mode) })}
          onModeChange={setRoutingMode}
          onFallbackAgentChange={setFallbackAgentId}
        />
      </SettingGroup>
      <SettingGroup title={t('settings.roomInteraction')} icon={<ShieldCheck className="h-4 w-4" strokeWidth={1.75} />}>
        <InteractionSection
          mode={interactionMode}
          inheritedLabel={t('settings.inheritedParent', { value: interactionModeLabel(inherited.interaction_mode) })}
          onModeChange={setInteractionMode}
        />
        <AutoDistillSection
          mode={autoDistillEnabled}
          inheritedLabel={t('settings.inheritedParent', { value: autoDistillLabel(inherited.auto_distill_enabled, t) })}
          onModeChange={setAutoDistillEnabled}
        />
        <SuperpowersBootstrapSection
          mode={superpowersBootstrapOwner}
          inheritedLabel={t('settings.inheritedParent', { value: superpowersBootstrapOwnerLabel(inherited.superpowers_bootstrap_owner, t) })}
          onModeChange={setSuperpowersBootstrapOwner}
        />
      </SettingGroup>
      {(routingMode !== 'inherit' || interactionMode !== 'inherit' || autoDistillEnabled !== 'inherit' || superpowersBootstrapOwner !== 'inherit') && (
        <ResetInheritanceButton
          onClick={() => {
            setRoutingMode('inherit');
            setFallbackAgentId('');
            setInteractionMode('inherit');
            setAutoDistillEnabled('inherit');
            setSuperpowersBootstrapOwner('inherit');
          }}
        />
      )}
    </SettingsDialogBody>
  );
}

function SettingsDialogBody({
  children,
  footer,
}: {
  children: ReactNode;
  footer: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-4">
      {children}
      <div className="flex justify-end gap-2 border-t border-[var(--color-border)] pt-4">
        {footer}
      </div>
    </div>
  );
}

function SettingGroup({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-3 flex items-center gap-2 text-[var(--color-fg)]">
        <span className="text-[var(--color-accent)]">{icon}</span>
        <h3 className="font-display text-[13px] font-semibold">{title}</h3>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function RoutingSection({
  mode,
  fallbackAgentId,
  fallbackOptions,
  inheritedLabel,
  onModeChange,
  onFallbackAgentChange,
}: {
  mode: MessageRoutingMode | 'inherit';
  fallbackAgentId: string;
  fallbackOptions: FallbackAgentOption[];
  inheritedLabel: string | null;
  onModeChange: (mode: MessageRoutingMode | 'inherit') => void;
  onFallbackAgentChange: (agentId: string) => void;
}): JSX.Element {
  const { routingModeLabel, t } = useI18n();
  const requiresFallback = mode !== 'inherit' && mode !== 'mentions_only';
  return (
    <>
      <div className="grid gap-2">
        {inheritedLabel && (
          <OptionButton
            active={mode === 'inherit'}
            title={t('settings.inheritParentSettings')}
            description={inheritedLabel}
            onClick={() => onModeChange('inherit')}
          />
        )}
        {ROUTING_OPTIONS.map((option) => (
          <OptionButton
            key={option.value}
            active={mode === option.value}
            title={routingModeLabel(option.value)}
            description={t(option.descriptionKey)}
            onClick={() => onModeChange(option.value)}
          />
        ))}
      </div>
      {requiresFallback && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
          <Label>{t('settings.fallbackAgent')}</Label>
          <select
            value={pickFallbackAgentId(fallbackAgentId, fallbackOptions)}
            onChange={(event) => onFallbackAgentChange(event.target.value)}
            className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] outline-none transition-all focus:border-[var(--color-primary)] focus:glow-primary"
          >
            {fallbackOptions.length === 0 ? (
              <option value="">{t('settings.noFallbackAgents')}</option>
            ) : (
              fallbackOptions.map((agent) => (
                <option key={agent.agent_id} value={agent.agent_id}>
                  {agent.agent_name} ({agent.agent_id})
                </option>
              ))
            )}
          </select>
        </div>
      )}
    </>
  );
}

function InteractionSection({
  mode,
  inheritedLabel,
  onModeChange,
}: {
  mode: TaskInteractionMode | 'inherit';
  inheritedLabel: string | null;
  onModeChange: (mode: TaskInteractionMode | 'inherit') => void;
}): JSX.Element {
  const { interactionModeLabel, t } = useI18n();
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {inheritedLabel && (
        <OptionButton
          active={mode === 'inherit'}
          title={t('settings.inheritParentSettings')}
          description={inheritedLabel}
          onClick={() => onModeChange('inherit')}
        />
      )}
      {INTERACTION_OPTIONS.map((option) => (
        <OptionButton
        key={option.value}
        active={mode === option.value}
        title={interactionModeLabel(option.value)}
        description={t(option.descriptionKey)}
        onClick={() => onModeChange(option.value)}
      />
      ))}
    </div>
  );
}

function AutoDistillSection({
  mode,
  inheritedLabel,
  onModeChange,
}: {
  mode: boolean | 'inherit';
  inheritedLabel: string | null;
  onModeChange: (mode: boolean | 'inherit') => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className={cn('grid gap-2', inheritedLabel ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
      {inheritedLabel && (
        <OptionButton
          active={mode === 'inherit'}
          title={t('settings.inheritParentSettings')}
          description={inheritedLabel}
          onClick={() => onModeChange('inherit')}
        />
      )}
      <OptionButton
        active={mode === true}
        title={t('settings.autoDistill.on')}
        description={t('settings.autoDistill.on.description')}
        onClick={() => onModeChange(true)}
      />
      <OptionButton
        active={mode === false}
        title={t('settings.autoDistill.off')}
        description={t('settings.autoDistill.off.description')}
        onClick={() => onModeChange(false)}
      />
    </div>
  );
}

function SuperpowersBootstrapSection({
  mode,
  inheritedLabel,
  onModeChange,
}: {
  mode: SuperpowersBootstrapOwner | 'inherit';
  inheritedLabel: string | null;
  onModeChange: (mode: SuperpowersBootstrapOwner | 'inherit') => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className={cn('grid gap-2', inheritedLabel ? 'md:grid-cols-4' : 'md:grid-cols-3')}>
      {inheritedLabel && (
        <OptionButton
          active={mode === 'inherit'}
          title={t('settings.inheritParentSettings')}
          description={inheritedLabel}
          onClick={() => onModeChange('inherit')}
        />
      )}
      {SUPERPOWERS_BOOTSTRAP_OPTIONS.map((option) => (
        <OptionButton
          key={option.value}
          active={mode === option.value}
          title={superpowersBootstrapOwnerLabel(option.value, t)}
          description={t(option.descriptionKey)}
          onClick={() => onModeChange(option.value)}
        />
      ))}
    </div>
  );
}

function OptionButton({
  active,
  title,
  description,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-h-[62px] rounded-md border px-3 py-2.5 text-left transition-colors ease-ocean',
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-surface-raised)] text-[var(--color-fg)]'
          : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]',
      )}
    >
      <span className="block text-[13px] font-semibold">{title}</span>
      <span className="mt-1 block text-[12px] leading-relaxed">{description}</span>
    </button>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2">
      <div className="text-[11px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 break-words font-mono text-[12px] text-[var(--color-fg)]">{value}</div>
    </div>
  );
}

function ResetInheritanceButton({ onClick }: { onClick: () => void }): JSX.Element {
  const { t } = useI18n();
  return (
    <Button type="button" variant="ghost" onClick={onClick}>
      <RotateCcw className="h-3.5 w-3.5" />
      {t('settings.resetInheritance')}
    </Button>
  );
}

function InheritanceSummary({
  settings,
  scope,
}: {
  settings?: SettingsResolution;
  scope: 'project' | 'room';
}): JSX.Element | null {
  const { interactionModeLabel, routingModeLabel, settingsScopeLabel, t } = useI18n();
  if (!settings) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-[12px] text-[var(--color-fg-muted)]">
      <div className="font-display text-[13px] font-semibold text-[var(--color-fg)]">
        {t('settings.inheritanceTitle')}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <SummaryItem
          label={t('settings.messageRouting')}
          value={routingModeLabel(settings.effective.message_routing_mode)}
          source={settingsScopeLabel(settings.sources.message_routing)}
        />
        <SummaryItem
          label={t('settings.interactionPolicy')}
          value={interactionModeLabel(settings.effective.interaction_mode)}
          source={settingsScopeLabel(settings.sources.interaction_mode)}
        />
        <SummaryItem
          label={t('settings.autoDistill')}
          value={autoDistillLabel(settings.effective.auto_distill_enabled, t)}
          source={settingsScopeLabel(settings.sources.auto_distill)}
        />
        <SummaryItem
          label={t('settings.superpowersBootstrapOwner')}
          value={superpowersBootstrapOwnerLabel(settings.effective.superpowers_bootstrap_owner, t)}
          source={settingsScopeLabel(settings.sources.superpowers_bootstrap_owner)}
        />
      </div>
      <p className="mt-2 leading-relaxed">
        {scope === 'room'
          ? t('settings.roomInheritanceDescription')
          : t('settings.projectInheritanceDescription')}
      </p>
    </div>
  );
}

function SummaryItem({ label, value, source }: { label: string; value: string; source: string }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="text-[11px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 text-[13px] font-medium text-[var(--color-fg)]">{value}</div>
      <div className="mt-1 font-mono text-[10.5px] text-[var(--color-muted)]">
        {t('settings.source', { source })}
      </div>
    </div>
  );
}

function inheritedForRoom(settings: SettingsResolution): EffectiveSettings {
  return {
    message_routing_mode: settings.project?.message_routing_mode ?? settings.system.message_routing_mode,
    fallback_agent_id: settings.project?.message_routing_mode
      ? settings.project.message_routing_mode === 'mentions_only'
        ? null
        : settings.project.fallback_agent_id
      : settings.system.fallback_agent_id,
    interaction_mode: settings.project?.interaction_mode ?? settings.system.interaction_mode,
    auto_distill_enabled:
      settings.project?.auto_distill_enabled === null || settings.project?.auto_distill_enabled === undefined
        ? settings.system.auto_distill_enabled
        : Boolean(settings.project.auto_distill_enabled),
    default_workflow_definition_id:
      settings.project?.default_workflow_definition_id ?? settings.system.default_workflow_definition_id,
    superpowers_bootstrap_owner:
      settings.project?.superpowers_bootstrap_owner ?? settings.system.superpowers_bootstrap_owner,
    workspace_excluded_dirs: settings.system.workspace_excluded_dirs,
  };
}

type FallbackAgentOption = {
  agent_id: string;
  agent_name: string;
};

function toGlobalFallbackOptions(agents: Agent[]): FallbackAgentOption[] {
  return agents
    .map((agent) => ({ agent_id: agent.agent_id, agent_name: agent.name }))
    .sort((a, b) => a.agent_name.localeCompare(b.agent_name))
    .filter((agent, index, list) => list.findIndex((item) => item.agent_id === agent.agent_id) === index);
}

function toRoomFallbackOptions(agents: RoomAgent[]): FallbackAgentOption[] {
  return agents
    .map((agent) => ({ agent_id: agent.agent_id, agent_name: agent.agent_name }))
    .sort((a, b) => a.agent_name.localeCompare(b.agent_name))
    .filter((agent, index, list) => list.findIndex((item) => item.agent_id === agent.agent_id) === index);
}

function pickFallbackAgentId(value: string, options: FallbackAgentOption[]): string {
  if (options.length === 0) return '';
  if (options.some((agent) => agent.agent_id === value)) return value;
  return options.find((agent) => agent.agent_id === 'planner')?.agent_id ?? options[0].agent_id;
}

function createEmptyAiConfigDraft(count: number): AiConfigDraft {
  return {
    name: count > 0 ? `AI 配置 ${count + 1}` : '默认 AI 配置',
    plannerModel: '',
    openaiBaseUrl: '',
    openaiApiKey: '',
    clearOpenaiApiKey: false,
  };
}

function createDraftFromConfig(config: AiConfig | null): AiConfigDraft {
  if (!config) return createEmptyAiConfigDraft(0);
  return {
    name: config.name,
    plannerModel: config.langchain_planner_model,
    openaiBaseUrl: config.openai_base_url,
    openaiApiKey: '',
    clearOpenaiApiKey: false,
  };
}

function validateAiConfigDraft(
  draft: AiConfigDraft,
  t: (key: MessageKey, vars?: Record<string, string>) => string,
): string | null {
  if (!draft.name.trim()) return t('settings.aiConfigNameRequired');
  if (!draft.plannerModel.trim()) return t('settings.aiConfigModelRequired');
  const baseUrl = draft.openaiBaseUrl.trim();
  if (!baseUrl) return t('settings.aiConfigBaseUrlRequired');
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return t('settings.aiConfigBaseUrlInvalid');
  } catch {
    return t('settings.aiConfigBaseUrlInvalid');
  }
  return null;
}

function autoDistillLabel(
  enabled: boolean,
  t: (key: MessageKey, vars?: Record<string, string>) => string,
): string {
  return enabled ? t('settings.autoDistill.on') : t('settings.autoDistill.off');
}

function superpowersBootstrapOwnerLabel(
  owner: SuperpowersBootstrapOwner,
  t: (key: MessageKey, vars?: Record<string, string>) => string,
): string {
  return t(`settings.superpowersBootstrap.${owner}` as MessageKey);
}
