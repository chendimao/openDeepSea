import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
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
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n, type Locale, type MessageKey } from '../lib/i18n';
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
  type EffectiveSettings,
  type MessageRoutingMode,
  type Project,
  type Room,
  type RoomAgent,
  type SettingsResolution,
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
};

const ROUTING_OPTIONS: Array<{ value: MessageRoutingMode; descriptionKey: MessageKey }> = [
  { value: 'mentions_only', descriptionKey: 'settings.routing.mentions_only.description' },
  { value: 'fallback_reply', descriptionKey: 'settings.routing.fallback_reply.description' },
];

const INTERACTION_OPTIONS: Array<{ value: TaskInteractionMode; descriptionKey: MessageKey }> = [
  { value: 'ask_user', descriptionKey: 'settings.interaction.ask_user.description' },
  { value: 'auto_recommended', descriptionKey: 'settings.interaction.auto_recommended.description' },
];

const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  message_routing_mode: 'fallback_reply',
  fallback_agent_id: 'planner',
  interaction_mode: 'ask_user',
  auto_distill_enabled: true,
  langchain_planner_model: null,
  openai_base_url: null,
  openai_api_key_set: false,
  openai_api_key_preview: null,
};

type SystemSettingsCategory = 'general' | 'chat' | 'model';

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
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: api.listAgents,
    enabled: open,
  });
  const save = useMutation({
    mutationFn: api.updateSystemSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
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
          key={`${settings.message_routing_mode}:${settings.fallback_agent_id ?? ''}:${settings.interaction_mode}:${settings.auto_distill_enabled}:${settings.langchain_planner_model ?? ''}:${settings.openai_base_url ?? ''}:${settings.openai_api_key_set}:${settings.openai_api_key_preview ?? ''}`}
          theme={theme}
          value={settings}
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
  fallbackOptions,
  isSaving,
  onThemeChange,
  onSave,
}: {
  theme: ThemeMode;
  value: SystemSettings;
  fallbackOptions: FallbackAgentOption[];
  isSaving: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onSave: (patch: {
    message_routing_mode: MessageRoutingMode;
    fallback_agent_id: string | null;
    interaction_mode: TaskInteractionMode;
    auto_distill_enabled: boolean;
    langchain_planner_model: string | null;
    openai_base_url: string | null;
    openai_api_key?: string | null;
  }) => void;
}): JSX.Element {
  const [routingMode, setRoutingMode] = useState<MessageRoutingMode>(value.message_routing_mode);
  const [fallbackAgentId, setFallbackAgentId] = useState(value.fallback_agent_id ?? 'planner');
  const [interactionMode, setInteractionMode] = useState<TaskInteractionMode>(value.interaction_mode);
  const [autoDistillEnabled, setAutoDistillEnabled] = useState(value.auto_distill_enabled);
  const [plannerModel, setPlannerModel] = useState(value.langchain_planner_model ?? '');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(value.openai_base_url ?? '');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [clearOpenaiApiKey, setClearOpenaiApiKey] = useState(false);
  const [activeCategory, setActiveCategory] = useState<SystemSettingsCategory>('general');
  const { t } = useI18n();
  const requiresFallback = routingMode !== 'mentions_only';
  const selectedFallbackAgentId = pickFallbackAgentId(fallbackAgentId, fallbackOptions);
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
            const patch: Parameters<typeof onSave>[0] = {
              message_routing_mode: routingMode,
              fallback_agent_id: requiresFallback ? selectedFallbackAgentId : null,
              interaction_mode: interactionMode,
              auto_distill_enabled: autoDistillEnabled,
              langchain_planner_model: trimmedOrNull(plannerModel),
              openai_base_url: trimmedOrNull(openaiBaseUrl),
            };
            const nextApiKey = openaiApiKey.trim();
            if (clearOpenaiApiKey) {
              patch.openai_api_key = null;
            } else if (nextApiKey) {
              patch.openai_api_key = nextApiKey;
            }
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
                  plannerModel={plannerModel}
                  openaiBaseUrl={openaiBaseUrl}
                  openaiApiKey={openaiApiKey}
                  openaiApiKeySet={value.openai_api_key_set}
                  openaiApiKeyPreview={value.openai_api_key_preview}
                  clearOpenaiApiKey={clearOpenaiApiKey}
                  onPlannerModelChange={setPlannerModel}
                  onOpenaiBaseUrlChange={setOpenaiBaseUrl}
                  onOpenaiApiKeyChange={(nextValue) => {
                    setOpenaiApiKey(nextValue);
                    if (nextValue.trim()) setClearOpenaiApiKey(false);
                  }}
                  onClearOpenaiApiKeyChange={(nextValue) => {
                    setClearOpenaiApiKey(nextValue);
                    if (nextValue) setOpenaiApiKey('');
                  }}
                />
              </SubSettingSection>
            </div>
          )}
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
  plannerModel,
  openaiBaseUrl,
  openaiApiKey,
  openaiApiKeySet,
  openaiApiKeyPreview,
  clearOpenaiApiKey,
  onPlannerModelChange,
  onOpenaiBaseUrlChange,
  onOpenaiApiKeyChange,
  onClearOpenaiApiKeyChange,
}: {
  plannerModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiApiKeySet: boolean;
  openaiApiKeyPreview: string | null;
  clearOpenaiApiKey: boolean;
  onPlannerModelChange: (value: string) => void;
  onOpenaiBaseUrlChange: (value: string) => void;
  onOpenaiApiKeyChange: (value: string) => void;
  onClearOpenaiApiKeyChange: (value: boolean) => void;
}): JSX.Element {
  const { t } = useI18n();
  const apiKeyStatus = openaiApiKeySet
    ? t('settings.openaiApiKeySaved', { preview: openaiApiKeyPreview ?? '' })
    : t('settings.openaiApiKeyNotSaved');

  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="system-planner-model"
          className="mb-1.5 block text-[12px] font-medium text-[var(--color-fg-muted)]"
        >
          {t('settings.plannerModel')}
        </label>
        <Input
          id="system-planner-model"
          value={plannerModel}
          onChange={(event) => onPlannerModelChange(event.target.value)}
          placeholder={t('settings.plannerModelPlaceholder')}
          className="font-mono"
        />
      </div>
      <div>
        <label
          htmlFor="system-openai-base-url"
          className="mb-1.5 block text-[12px] font-medium text-[var(--color-fg-muted)]"
        >
          {t('settings.openaiBaseUrl')}
        </label>
        <Input
          id="system-openai-base-url"
          value={openaiBaseUrl}
          onChange={(event) => onOpenaiBaseUrlChange(event.target.value)}
          placeholder={t('settings.openaiBaseUrlPlaceholder')}
          className="font-mono"
        />
      </div>
      <div>
        <label
          htmlFor="system-openai-api-key"
          className="mb-1.5 block text-[12px] font-medium text-[var(--color-fg-muted)]"
        >
          {t('settings.openaiApiKey')}
        </label>
        <Input
          id="system-openai-api-key"
          type="password"
          value={openaiApiKey}
          onChange={(event) => onOpenaiApiKeyChange(event.target.value)}
          placeholder={t('settings.openaiApiKeyPlaceholder')}
          className="font-mono"
          disabled={clearOpenaiApiKey}
          autoComplete="new-password"
        />
        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{apiKeyStatus}</p>
        {openaiApiKeySet && (
          <label className="mt-2 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12px] text-[var(--color-fg-muted)]">
            <input
              type="checkbox"
              checked={clearOpenaiApiKey}
              onChange={(event) => onClearOpenaiApiKeyChange(event.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--color-primary)]"
            />
            <span>{t('settings.clearOpenaiApiKey')}</span>
          </label>
        )}
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
      </SettingGroup>
      {(routingMode !== 'inherit' || interactionMode !== 'inherit' || autoDistillEnabled !== 'inherit') && (
        <ResetInheritanceButton
          onClick={() => {
            setRoutingMode('inherit');
            setFallbackAgentId('');
            setInteractionMode('inherit');
            setAutoDistillEnabled('inherit');
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
      </SettingGroup>
      {(routingMode !== 'inherit' || interactionMode !== 'inherit' || autoDistillEnabled !== 'inherit') && (
        <ResetInheritanceButton
          onClick={() => {
            setRoutingMode('inherit');
            setFallbackAgentId('');
            setInteractionMode('inherit');
            setAutoDistillEnabled('inherit');
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

function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function autoDistillLabel(
  enabled: boolean,
  t: (key: MessageKey, vars?: Record<string, string>) => string,
): string {
  return enabled ? t('settings.autoDistill.on') : t('settings.autoDistill.off');
}
