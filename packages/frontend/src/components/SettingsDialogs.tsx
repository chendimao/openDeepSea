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
  type EffectiveSettings,
  type MessageRoutingMode,
  type Project,
  type Room,
  type RoomAgent,
  type SettingsResolution,
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
};

const ROUTING_OPTIONS: Array<{ value: MessageRoutingMode; descriptionKey: MessageKey }> = [
  { value: 'mentions_only', descriptionKey: 'settings.routing.mentions_only.description' },
  { value: 'fallback_reply', descriptionKey: 'settings.routing.fallback_reply.description' },
  { value: 'fallback_route', descriptionKey: 'settings.routing.fallback_route.description' },
];

const INTERACTION_OPTIONS: Array<{ value: TaskInteractionMode; descriptionKey: MessageKey }> = [
  { value: 'ask_user', descriptionKey: 'settings.interaction.ask_user.description' },
  { value: 'auto_recommended', descriptionKey: 'settings.interaction.auto_recommended.description' },
];

const DEFAULT_SYSTEM_SETTINGS: EffectiveSettings = {
  message_routing_mode: 'mentions_only',
  fallback_agent_id: null,
  interaction_mode: 'ask_user',
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
        className="max-h-[88vh] w-[min(94vw,760px)] overflow-y-auto"
      >
        <SystemSettingsForm
          key={`${settings.message_routing_mode}:${settings.fallback_agent_id ?? ''}:${settings.interaction_mode}`}
          theme={theme}
          value={settings}
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
    () =>
      [...agents]
        .sort((a, b) => a.agent_name.localeCompare(b.agent_name))
        .filter((agent, index, list) => list.findIndex((item) => item.agent_id === agent.agent_id) === index),
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
  isSaving,
  onThemeChange,
  onSave,
}: {
  theme: ThemeMode;
  value: EffectiveSettings;
  isSaving: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onSave: (patch: {
    message_routing_mode: MessageRoutingMode;
    fallback_agent_id: string | null;
    interaction_mode: TaskInteractionMode;
  }) => void;
}): JSX.Element {
  const [routingMode, setRoutingMode] = useState<MessageRoutingMode>(value.message_routing_mode);
  const [fallbackAgentId, setFallbackAgentId] = useState(value.fallback_agent_id ?? '');
  const [interactionMode, setInteractionMode] = useState<TaskInteractionMode>(value.interaction_mode);
  const { t } = useI18n();
  const requiresFallback = routingMode !== 'mentions_only';

  return (
    <SettingsDialogBody
      footer={
        <Button
          type="button"
          disabled={isSaving || (requiresFallback && !fallbackAgentId.trim())}
          onClick={() =>
            onSave({
              message_routing_mode: routingMode,
              fallback_agent_id: requiresFallback ? fallbackAgentId.trim() : null,
              interaction_mode: interactionMode,
            })
          }
        >
          <Save className="h-3.5 w-3.5" />
          {t('settings.saveSystem')}
        </Button>
      }
    >
      <SettingGroup title={t('settings.appearance')} icon={<SwatchBook className="h-4 w-4" strokeWidth={1.75} />}>
        <AppearanceSection theme={theme} onThemeChange={onThemeChange} />
      </SettingGroup>
      <SettingGroup title={t('settings.language')} icon={<Globe2 className="h-4 w-4" strokeWidth={1.75} />}>
        <LanguageSection />
      </SettingGroup>
      <SettingGroup title={t('settings.collaborationDefaults')} icon={<Bot className="h-4 w-4" strokeWidth={1.75} />}>
        <RoutingSection
          mode={routingMode}
          fallbackAgentId={fallbackAgentId}
          fallbackOptions={[]}
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
      </SettingGroup>
    </SettingsDialogBody>
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
      <div className="theme-toggle mt-1.5" role="group" aria-label={ariaLabel}>
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              className={cn('theme-toggle-option', value === option.value && 'is-active')}
              aria-pressed={value === option.value}
              onClick={() => onChange(option.value)}
            >
              {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />}
              <span>{option.label}</span>
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
  isSaving,
  onSave,
}: {
  project: Project;
  settings?: SettingsResolution;
  isSaving: boolean;
  onSave: (patch: SettingsPatch) => void;
}): JSX.Element {
  const system = settings?.system ?? DEFAULT_SYSTEM_SETTINGS;
  const own = settings?.project;
  const { interactionModeLabel, routingModeLabel, t } = useI18n();
  const [routingMode, setRoutingMode] = useState<MessageRoutingMode | 'inherit'>(
    own?.message_routing_mode ?? 'inherit',
  );
  const [fallbackAgentId, setFallbackAgentId] = useState(own?.fallback_agent_id ?? '');
  const [interactionMode, setInteractionMode] = useState<TaskInteractionMode | 'inherit'>(
    own?.interaction_mode ?? 'inherit',
  );
  const requiresFallback = routingMode !== 'inherit' && routingMode !== 'mentions_only';

  return (
    <SettingsDialogBody
      footer={
        <Button
          type="button"
          disabled={isSaving || (requiresFallback && !fallbackAgentId.trim())}
          onClick={() =>
            onSave({
              message_routing_mode: routingMode === 'inherit' ? null : routingMode,
              fallback_agent_id: routingMode === 'inherit' || routingMode === 'mentions_only' ? null : fallbackAgentId.trim(),
              interaction_mode: interactionMode === 'inherit' ? null : interactionMode,
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
          fallbackOptions={[]}
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
      </SettingGroup>
      {(routingMode !== 'inherit' || interactionMode !== 'inherit') && (
        <ResetInheritanceButton
          onClick={() => {
            setRoutingMode('inherit');
            setFallbackAgentId('');
            setInteractionMode('inherit');
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
  fallbackOptions: RoomAgent[];
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
  const requiresFallback = routingMode !== 'inherit' && routingMode !== 'mentions_only';

  return (
    <SettingsDialogBody
      footer={
        <Button
          type="button"
          disabled={isSaving || (requiresFallback && !fallbackAgentId.trim())}
          onClick={() =>
            onSave({
              message_routing_mode: routingMode === 'inherit' ? null : routingMode,
              fallback_agent_id: routingMode === 'inherit' || routingMode === 'mentions_only' ? null : fallbackAgentId.trim(),
              interaction_mode: interactionMode === 'inherit' ? null : interactionMode,
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
      </SettingGroup>
      {(routingMode !== 'inherit' || interactionMode !== 'inherit') && (
        <ResetInheritanceButton
          onClick={() => {
            setRoutingMode('inherit');
            setFallbackAgentId('');
            setInteractionMode('inherit');
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
  fallbackOptions: RoomAgent[];
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
          {fallbackOptions.length > 0 ? (
            <select
              value={fallbackAgentId}
              onChange={(event) => onFallbackAgentChange(event.target.value)}
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] outline-none transition-all focus:border-[var(--color-primary)] focus:glow-primary"
            >
              {!fallbackAgentId && <option value="">{t('settings.selectFallbackAgent')}</option>}
              {fallbackAgentId && !fallbackOptions.some((agent) => agent.agent_id === fallbackAgentId) && (
                <option value={fallbackAgentId}>
                  {t('settings.fallbackCurrentInvisible', { agentId: fallbackAgentId })}
                </option>
              )}
              {fallbackOptions.map((agent) => (
                <option key={agent.agent_id} value={agent.agent_id}>
                  {agent.agent_name} ({agent.agent_id})
                </option>
              ))}
            </select>
          ) : (
            <Input
              value={fallbackAgentId}
              onChange={(event) => onFallbackAgentChange(event.target.value)}
              placeholder={t('settings.fallbackPlaceholder')}
              className="font-mono"
            />
          )}
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
  };
}
