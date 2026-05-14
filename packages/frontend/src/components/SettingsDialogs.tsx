import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, RotateCcw, Save, Settings2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import {
  MESSAGE_ROUTING_MODE_LABEL,
  TASK_INTERACTION_MODE_LABEL,
  type EffectiveSettings,
  type MessageRoutingMode,
  type Project,
  type Room,
  type RoomAgent,
  type SettingsResolution,
  type SettingsScope,
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

const ROUTING_OPTIONS: Array<{ value: MessageRoutingMode; description: string }> = [
  { value: 'mentions_only', description: '没有明确 @ 智能体时保持安静。' },
  { value: 'fallback_reply', description: '没有 @ 时由兜底智能体直接回复。' },
  { value: 'fallback_route', description: '没有 @ 时由兜底智能体先判断并分派协作对象。' },
];

const INTERACTION_OPTIONS: Array<{ value: TaskInteractionMode; description: string }> = [
  { value: 'ask_user', description: '工作流遇到阻塞决策时暂停，等待人工选择。' },
  { value: 'auto_recommended', description: '工作流使用推荐选项自动继续，适合低风险任务。' },
];

const DEFAULT_SYSTEM_SETTINGS: EffectiveSettings = {
  message_routing_mode: 'mentions_only',
  fallback_agent_id: null,
  interaction_mode: 'ask_user',
};

export function SystemSettingsDialog({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data: settings = DEFAULT_SYSTEM_SETTINGS } = useQuery({
    queryKey: ['settings', 'system'],
    queryFn: api.getSystemSettings,
    enabled: open,
  });
  const save = useMutation({
    mutationFn: api.updateSystemSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('系统设置已保存');
      setOpen(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        title="系统设置"
        description="配置全局默认行为。项目和群聊可以对重复设置项单独覆盖。"
        className="max-h-[88vh] w-[min(94vw,760px)] overflow-y-auto"
      >
        <SystemSettingsForm
          key={`${settings.message_routing_mode}:${settings.fallback_agent_id ?? ''}:${settings.interaction_mode}`}
          value={settings}
          isSaving={save.isPending}
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
  const { data: settings } = useQuery({
    queryKey: ['settings', 'project', project.id],
    queryFn: () => api.getProjectSettings(project.id),
    enabled: open,
  });
  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api.updateProjectSettings(project.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('项目设置已保存');
      setOpen(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        title="项目设置"
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
  const { data: settings } = useQuery({
    queryKey: ['settings', 'room', room.id],
    queryFn: () => api.getRoomSettings(room.id),
    enabled: open,
  });
  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api.updateRoomSettings(room.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('群聊设置已保存');
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
        title="群聊设置"
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
  value,
  isSaving,
  onSave,
}: {
  value: EffectiveSettings;
  isSaving: boolean;
  onSave: (patch: {
    message_routing_mode: MessageRoutingMode;
    fallback_agent_id: string | null;
    interaction_mode: TaskInteractionMode;
  }) => void;
}): JSX.Element {
  const [routingMode, setRoutingMode] = useState<MessageRoutingMode>(value.message_routing_mode);
  const [fallbackAgentId, setFallbackAgentId] = useState(value.fallback_agent_id ?? '');
  const [interactionMode, setInteractionMode] = useState<TaskInteractionMode>(value.interaction_mode);
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
          保存系统设置
        </Button>
      }
    >
      <SettingGroup title="默认消息路由" icon={<Bot className="h-4 w-4" strokeWidth={1.75} />}>
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
      </SettingGroup>
      <SettingGroup title="默认交互策略" icon={<ShieldCheck className="h-4 w-4" strokeWidth={1.75} />}>
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
          保存项目设置
        </Button>
      }
    >
      <SettingGroup title="项目信息" icon={<Settings2 className="h-4 w-4" strokeWidth={1.75} />}>
        <ReadonlyField label="项目路径" value={project.path} />
        {project.description && <ReadonlyField label="项目描述" value={project.description} />}
      </SettingGroup>
      <InheritanceSummary settings={settings} scope="project" />
      <SettingGroup title="项目消息路由" icon={<Bot className="h-4 w-4" strokeWidth={1.75} />}>
        <RoutingSection
          mode={routingMode}
          fallbackAgentId={fallbackAgentId || system.fallback_agent_id || ''}
          fallbackOptions={[]}
          inheritedLabel={`继承系统: ${MESSAGE_ROUTING_MODE_LABEL[system.message_routing_mode]}`}
          onModeChange={setRoutingMode}
          onFallbackAgentChange={setFallbackAgentId}
        />
      </SettingGroup>
      <SettingGroup title="项目交互策略" icon={<ShieldCheck className="h-4 w-4" strokeWidth={1.75} />}>
        <InteractionSection
          mode={interactionMode}
          inheritedLabel={`继承系统: ${TASK_INTERACTION_MODE_LABEL[system.interaction_mode]}`}
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
          保存群聊设置
        </Button>
      }
    >
      <SettingGroup title="群聊信息" icon={<Settings2 className="h-4 w-4" strokeWidth={1.75} />}>
        <ReadonlyField label="群聊名称" value={room.name} />
        {room.description && <ReadonlyField label="群聊描述" value={room.description} />}
      </SettingGroup>
      <InheritanceSummary settings={settings} scope="room" />
      <SettingGroup title="群聊消息路由" icon={<Bot className="h-4 w-4" strokeWidth={1.75} />}>
        <RoutingSection
          mode={routingMode}
          fallbackAgentId={fallbackAgentId || inherited.fallback_agent_id || ''}
          fallbackOptions={fallbackOptions}
          inheritedLabel={`继承上级: ${MESSAGE_ROUTING_MODE_LABEL[inherited.message_routing_mode]}`}
          onModeChange={setRoutingMode}
          onFallbackAgentChange={setFallbackAgentId}
        />
      </SettingGroup>
      <SettingGroup title="群聊交互策略" icon={<ShieldCheck className="h-4 w-4" strokeWidth={1.75} />}>
        <InteractionSection
          mode={interactionMode}
          inheritedLabel={`继承上级: ${TASK_INTERACTION_MODE_LABEL[inherited.interaction_mode]}`}
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
  const requiresFallback = mode !== 'inherit' && mode !== 'mentions_only';
  return (
    <>
      <div className="grid gap-2">
        {inheritedLabel && (
          <OptionButton
            active={mode === 'inherit'}
            title="继承上级设置"
            description={inheritedLabel}
            onClick={() => onModeChange('inherit')}
          />
        )}
        {ROUTING_OPTIONS.map((option) => (
          <OptionButton
            key={option.value}
            active={mode === option.value}
            title={MESSAGE_ROUTING_MODE_LABEL[option.value]}
            description={option.description}
            onClick={() => onModeChange(option.value)}
          />
        ))}
      </div>
      {requiresFallback && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
          <Label>兜底智能体</Label>
          {fallbackOptions.length > 0 ? (
            <select
              value={fallbackAgentId}
              onChange={(event) => onFallbackAgentChange(event.target.value)}
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] outline-none transition-all focus:border-[var(--color-primary)] focus:glow-primary"
            >
              {!fallbackAgentId && <option value="">选择兜底智能体</option>}
              {fallbackAgentId && !fallbackOptions.some((agent) => agent.agent_id === fallbackAgentId) && (
                <option value={fallbackAgentId}>{fallbackAgentId}（继承或当前不可见）</option>
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
              placeholder="输入 agent_id"
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
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {inheritedLabel && (
        <OptionButton
          active={mode === 'inherit'}
          title="继承上级设置"
          description={inheritedLabel}
          onClick={() => onModeChange('inherit')}
        />
      )}
      {INTERACTION_OPTIONS.map((option) => (
        <OptionButton
          key={option.value}
          active={mode === option.value}
          title={TASK_INTERACTION_MODE_LABEL[option.value]}
          description={option.description}
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
  return (
    <Button type="button" variant="ghost" onClick={onClick}>
      <RotateCcw className="h-3.5 w-3.5" />
      重置重复项为继承
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
  if (!settings) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-[12px] text-[var(--color-fg-muted)]">
      <div className="font-display text-[13px] font-semibold text-[var(--color-fg)]">重复设置项生效状态</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <SummaryItem
          label="消息路由"
          value={MESSAGE_ROUTING_MODE_LABEL[settings.effective.message_routing_mode]}
          source={scopeLabel(settings.sources.message_routing)}
        />
        <SummaryItem
          label="交互策略"
          value={TASK_INTERACTION_MODE_LABEL[settings.effective.interaction_mode]}
          source={scopeLabel(settings.sources.interaction_mode)}
        />
      </div>
      <p className="mt-2 leading-relaxed">
        {scope === 'room'
          ? '群聊覆盖项目和系统；未覆盖的设置继续向上继承。'
          : '项目覆盖系统；未覆盖的设置继续使用系统默认值。'}
      </p>
    </div>
  );
}

function SummaryItem({ label, value, source }: { label: string; value: string; source: string }): JSX.Element {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="text-[11px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 text-[13px] font-medium text-[var(--color-fg)]">{value}</div>
      <div className="mt-1 font-mono text-[10.5px] text-[var(--color-muted)]">来源：{source}</div>
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

function scopeLabel(scope: SettingsScope): string {
  if (scope === 'room') return '群聊级';
  if (scope === 'project') return '项目级';
  return '系统级';
}
