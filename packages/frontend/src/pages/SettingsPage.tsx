import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Building2,
  ChevronRight,
  MessagesSquare,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
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
import { Button } from '../components/ui/Button';
import { Input, Label } from '../components/ui/Input';

const ROUTING_OPTIONS: Array<{ value: MessageRoutingMode; description: string }> = [
  { value: 'mentions_only', description: '没有明确 @ 智能体时保持安静。' },
  { value: 'fallback_reply', description: '没有 @ 时由兜底智能体直接回复。' },
  { value: 'fallback_route', description: '没有 @ 时由兜底智能体先判断并分派协作对象。' },
];

const INTERACTION_OPTIONS: Array<{ value: TaskInteractionMode; description: string }> = [
  { value: 'ask_user', description: '工作流遇到阻塞决策时暂停，等待人工选择。' },
  { value: 'auto_recommended', description: '工作流使用推荐选项自动继续，适合低风险任务。' },
];

export function SettingsPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProjectId = searchParams.get('project') ?? '';
  const selectedRoomId = searchParams.get('room') ?? '';
  const activeScope: SettingsScope = selectedRoomId ? 'room' : selectedProjectId ? 'project' : 'system';
  const queryClient = useQueryClient();

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
  });
  const { data: systemSettings } = useQuery({
    queryKey: ['settings', 'system'],
    queryFn: api.getSystemSettings,
  });
  const { data: rooms = [] } = useQuery({
    queryKey: ['rooms', selectedProjectId],
    queryFn: () => api.listRooms(selectedProjectId),
    enabled: !!selectedProjectId,
  });
  const { data: projectSettings } = useQuery({
    queryKey: ['settings', 'project', selectedProjectId],
    queryFn: () => api.getProjectSettings(selectedProjectId),
    enabled: activeScope === 'project' && !!selectedProjectId,
  });
  const { data: roomSettings } = useQuery({
    queryKey: ['settings', 'room', selectedRoomId],
    queryFn: () => api.getRoomSettings(selectedRoomId),
    enabled: activeScope === 'room' && !!selectedRoomId,
  });
  const { data: roomAgents = [] } = useQuery({
    queryKey: ['room-agents', selectedRoomId],
    queryFn: () => api.listRoomAgents(selectedRoomId),
    enabled: activeScope === 'room' && !!selectedRoomId,
  });

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const currentSettings = activeScope === 'room' ? roomSettings : activeScope === 'project' ? projectSettings : undefined;

  const saveSystem = useMutation({
    mutationFn: api.updateSystemSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('系统级设置已保存');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const saveProject = useMutation({
    mutationFn: (input: SettingsPatch) => api.updateProjectSettings(selectedProjectId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('项目级设置已保存');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const saveRoom = useMutation({
    mutationFn: (input: SettingsPatch) => api.updateRoomSettings(selectedRoomId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('群聊级设置已保存');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const fallbackOptions = useMemo(
    () =>
      [...roomAgents]
        .sort((a, b) => a.agent_name.localeCompare(b.agent_name))
        .filter((agent, index, list) => list.findIndex((item) => item.agent_id === agent.agent_id) === index),
    [roomAgents],
  );

  const systemValue = systemSettings ?? {
    message_routing_mode: 'mentions_only',
    fallback_agent_id: null,
    interaction_mode: 'ask_user',
  };

  const selectSystem = () => setSearchParams({});
  const selectProject = (projectId: string) => setSearchParams({ project: projectId });
  const selectRoom = (projectId: string, roomId: string) => setSearchParams({ project: projectId, room: roomId });

  return (
    <div className="h-full overflow-y-auto">
      <header className="border-b border-[var(--color-border)] px-4 pb-5 pt-8 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg surface-2">
              <Settings2 className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.75} />
            </div>
            <div>
              <h1 className="font-display text-[22px] font-semibold tracking-tight">设置</h1>
              <p className="mt-1 text-[13px] text-[var(--color-fg-muted)]">
                系统、项目、群聊三级配置统一管理，生效优先级为群聊高于项目高于系统。
              </p>
            </div>
          </div>
        </div>
      </header>

      <section className="px-4 py-6 sm:px-8">
        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="surface-1 rounded-lg p-2 lg:sticky lg:top-6 lg:self-start">
            <ScopeButton
              active={activeScope === 'system'}
              icon={<ShieldCheck className="h-4 w-4" strokeWidth={1.75} />}
              title="系统级设置"
              subtitle="默认值，所有项目继承"
              onClick={selectSystem}
            />
            <div className="my-2 border-t border-[var(--color-border)]" />
            <div className="px-2 py-2 font-mono text-[10.5px] uppercase text-[var(--color-fg-muted)]">
              项目与群聊
            </div>
            <div className="space-y-1">
              {projects.map((project) => (
                <ProjectScopeGroup
                  key={project.id}
                  project={project}
                  activeProjectId={selectedProjectId}
                  activeRoomId={selectedRoomId}
                  expanded={project.id === selectedProjectId}
                  rooms={project.id === selectedProjectId ? rooms : []}
                  onProjectClick={() => selectProject(project.id)}
                  onRoomClick={(roomId) => selectRoom(project.id, roomId)}
                />
              ))}
              {projects.length === 0 && (
                <div className="px-3 py-6 text-center text-[12px] text-[var(--color-fg-muted)]">
                  暂无项目
                </div>
              )}
            </div>
          </aside>

          <main className="min-w-0">
            {activeScope === 'system' ? (
              <SystemSettingsCard
                key={`${systemValue.message_routing_mode}:${systemValue.fallback_agent_id ?? ''}:${systemValue.interaction_mode}`}
                value={systemValue}
                isSaving={saveSystem.isPending}
                onSave={(patch) => saveSystem.mutate(patch)}
              />
            ) : activeScope === 'project' && selectedProject ? (
              <ScopedSettingsCard
                key={`project:${selectedProject.id}:${projectSettings?.project?.updated_at ?? 0}`}
                scope="project"
                title={selectedProject.name}
                subtitle={selectedProject.path}
                settings={projectSettings}
                system={systemValue}
                fallbackOptions={[]}
                isSaving={saveProject.isPending}
                onSave={(patch) => saveProject.mutate(patch)}
              />
            ) : activeScope === 'room' && selectedProject && selectedRoom ? (
              <ScopedSettingsCard
                key={`room:${selectedRoom.id}:${roomSettings?.room?.updated_at ?? 0}`}
                scope="room"
                title={selectedRoom.name}
                subtitle={selectedProject.name}
                settings={roomSettings}
                system={systemValue}
                fallbackOptions={fallbackOptions}
                isSaving={saveRoom.isPending}
                onSave={(patch) => saveRoom.mutate(patch)}
              />
            ) : (
              <div className="surface-1 rounded-lg p-8 text-[13px] text-[var(--color-fg-muted)]">
                请选择要编辑的设置层级。
              </div>
            )}

            {currentSettings && (
              <EffectiveSummary settings={currentSettings} className="mt-4" />
            )}
          </main>
        </div>
      </section>
    </div>
  );
}

type SettingsPatch = {
  message_routing_mode?: MessageRoutingMode | null;
  fallback_agent_id?: string | null;
  interaction_mode?: TaskInteractionMode | null;
};

function SystemSettingsCard({
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
    <SettingsPanel
      eyebrow="系统级设置"
      title="全局默认行为"
      description="当项目或群聊没有覆盖时，所有工作区都使用这里的默认值。"
      actions={
        <Button
          type="button"
          disabled={isSaving || (requiresFallback && !fallbackAgentId)}
          onClick={() =>
            onSave({
              message_routing_mode: routingMode,
              fallback_agent_id: requiresFallback ? fallbackAgentId : null,
              interaction_mode: interactionMode,
            })
          }
        >
          <Save className="h-3.5 w-3.5" />
          保存
        </Button>
      }
    >
      <RoutingSection
        mode={routingMode}
        fallbackAgentId={fallbackAgentId}
        fallbackOptions={[]}
        inheritedLabel={null}
        onModeChange={(nextMode) => {
          if (nextMode !== 'inherit') setRoutingMode(nextMode);
        }}
        onFallbackAgentChange={setFallbackAgentId}
      />
      <InteractionSection
        mode={interactionMode}
        inheritedLabel={null}
        onModeChange={(nextMode) => {
          if (nextMode !== 'inherit') setInteractionMode(nextMode);
        }}
      />
    </SettingsPanel>
  );
}

function ScopedSettingsCard({
  scope,
  title,
  subtitle,
  settings,
  system,
  fallbackOptions,
  isSaving,
  onSave,
}: {
  scope: 'project' | 'room';
  title: string;
  subtitle: string;
  settings?: SettingsResolution;
  system: EffectiveSettings;
  fallbackOptions: RoomAgent[];
  isSaving: boolean;
  onSave: (patch: SettingsPatch) => void;
}): JSX.Element {
  const own = scope === 'room' ? settings?.room : settings?.project;
  const inherited =
    scope === 'project'
      ? system
      : settings
        ? {
            message_routing_mode: settings.project?.message_routing_mode ?? settings.system.message_routing_mode,
            fallback_agent_id: settings.project?.message_routing_mode
              ? settings.project.message_routing_mode === 'mentions_only'
                ? null
                : settings.project.fallback_agent_id
              : settings.system.fallback_agent_id,
            interaction_mode: settings.project?.interaction_mode ?? settings.system.interaction_mode,
          }
        : system;
  const [routingMode, setRoutingMode] = useState<MessageRoutingMode | 'inherit'>(
    own?.message_routing_mode ?? 'inherit',
  );
  const [fallbackAgentId, setFallbackAgentId] = useState(own?.fallback_agent_id ?? '');
  const [interactionMode, setInteractionMode] = useState<TaskInteractionMode | 'inherit'>(
    own?.interaction_mode ?? 'inherit',
  );
  const actualRoutingMode = routingMode === 'inherit' ? inherited.message_routing_mode : routingMode;
  const requiresFallback = routingMode !== 'inherit' && routingMode !== 'mentions_only';
  const label = scope === 'room' ? '群聊级设置' : '项目级设置';
  const inheritedLabel = scope === 'room' ? '继承项目/系统' : '继承系统';

  return (
    <SettingsPanel
      eyebrow={label}
      title={title}
      description={subtitle}
      actions={
        <Button
          type="button"
          disabled={isSaving || (requiresFallback && !fallbackAgentId)}
          onClick={() =>
            onSave({
              message_routing_mode: routingMode === 'inherit' ? null : routingMode,
              fallback_agent_id: routingMode === 'inherit' || routingMode === 'mentions_only' ? null : fallbackAgentId,
              interaction_mode: interactionMode === 'inherit' ? null : interactionMode,
            })
          }
        >
          <Save className="h-3.5 w-3.5" />
          保存
        </Button>
      }
    >
      <InheritanceStrip
        scope={scope}
        routingSource={settings?.sources.message_routing ?? 'system'}
        interactionSource={settings?.sources.interaction_mode ?? 'system'}
      />
      <RoutingSection
        mode={routingMode}
        fallbackAgentId={fallbackAgentId || inherited.fallback_agent_id || ''}
        fallbackOptions={fallbackOptions}
        inheritedLabel={`${inheritedLabel}: ${MESSAGE_ROUTING_MODE_LABEL[inherited.message_routing_mode]}`}
        onModeChange={setRoutingMode}
        onFallbackAgentChange={setFallbackAgentId}
      />
      <InteractionSection
        mode={interactionMode}
        inheritedLabel={`${inheritedLabel}: ${TASK_INTERACTION_MODE_LABEL[inherited.interaction_mode]}`}
        onModeChange={setInteractionMode}
      />
      {(routingMode !== 'inherit' || interactionMode !== 'inherit') && (
        <Button
          type="button"
          variant="ghost"
          className="mt-1"
          onClick={() => {
            setRoutingMode('inherit');
            setInteractionMode('inherit');
            setFallbackAgentId('');
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          本页改为全部继承
        </Button>
      )}
      {actualRoutingMode !== 'mentions_only' && fallbackOptions.length === 0 && scope === 'room' && (
        <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
          当前群聊没有可选智能体。使用兜底回复或兜底调度前，请先回到群聊邀请 agent。
        </p>
      )}
    </SettingsPanel>
  );
}

function SettingsPanel({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="surface-1 rounded-lg">
      <div className="flex flex-wrap items-start gap-3 border-b border-[var(--color-border)] px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <div className="font-mono text-[10.5px] uppercase text-[var(--color-fg-muted)]">{eyebrow}</div>
          <h2 className="mt-1 font-display text-[18px] font-semibold">{title}</h2>
          <p className="mt-1 break-words text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">{description}</p>
        </div>
        <div className="ml-auto">{actions}</div>
      </div>
      <div className="space-y-5 p-4 sm:p-5">{children}</div>
    </div>
  );
}

function ScopeButton({
  active,
  icon,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ease-ocean',
        active
          ? 'bg-[var(--color-surface-raised)] text-[var(--color-fg)]'
          : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
      )}
    >
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-[var(--color-border)]">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{title}</span>
        <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{subtitle}</span>
      </span>
    </button>
  );
}

function ProjectScopeGroup({
  project,
  rooms,
  activeProjectId,
  activeRoomId,
  expanded,
  onProjectClick,
  onRoomClick,
}: {
  project: Project;
  rooms: Room[];
  activeProjectId: string;
  activeRoomId: string;
  expanded: boolean;
  onProjectClick: () => void;
  onRoomClick: (roomId: string) => void;
}): JSX.Element {
  return (
    <div>
      <ScopeButton
        active={activeProjectId === project.id && !activeRoomId}
        icon={<Building2 className="h-4 w-4" strokeWidth={1.75} />}
        title={project.name}
        subtitle="项目级设置"
        onClick={onProjectClick}
      />
      {expanded && (
        <div className="ml-6 mt-1 space-y-1 border-l border-[var(--color-border)] pl-2">
          {rooms.map((room) => (
            <ScopeButton
              key={room.id}
              active={activeRoomId === room.id}
              icon={<MessagesSquare className="h-4 w-4" strokeWidth={1.75} />}
              title={room.name}
              subtitle="群聊级设置"
              onClick={() => onRoomClick(room.id)}
            />
          ))}
          {rooms.length === 0 && (
            <div className="px-3 py-2 text-[11.5px] text-[var(--color-muted)]">该项目暂无群聊</div>
          )}
        </div>
      )}
    </div>
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
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Bot className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
        <h3 className="font-display text-[14px] font-semibold">消息路由设置</h3>
      </div>
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
        <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
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
    </section>
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
    <section>
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-[var(--color-success)]" strokeWidth={1.75} />
        <h3 className="font-display text-[14px] font-semibold">交互策略设置</h3>
      </div>
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
    </section>
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
        'min-h-[68px] rounded-md border px-3 py-3 text-left transition-colors ease-ocean',
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

function InheritanceStrip({
  scope,
  routingSource,
  interactionSource,
}: {
  scope: 'project' | 'room';
  routingSource: SettingsScope;
  interactionSource: SettingsScope;
}): JSX.Element {
  return (
    <div className="grid gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-[12px] text-[var(--color-fg-muted)] sm:grid-cols-2">
      <span>消息路由当前来源：{scopeLabel(routingSource)}</span>
      <span>交互策略当前来源：{scopeLabel(interactionSource)}</span>
      <span className="sm:col-span-2">
        优先级：群聊级 <ChevronRight className="inline h-3 w-3" /> 项目级 <ChevronRight className="inline h-3 w-3" /> 系统级。
      </span>
      {scope === 'project' && <span className="sm:col-span-2">项目级设置会影响未覆盖的群聊。</span>}
    </div>
  );
}

function EffectiveSummary({ settings, className }: { settings: SettingsResolution; className?: string }): JSX.Element {
  return (
    <div className={cn('surface-1 rounded-lg p-4', className)}>
      <div className="font-display text-[14px] font-semibold">当前最终生效值</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
      <p className="mt-3 text-[12px] text-[var(--color-fg-muted)]">
        兜底智能体：{settings.effective.fallback_agent_id ?? '未设置'}
      </p>
    </div>
  );
}

function SummaryItem({ label, value, source }: { label: string; value: string; source: string }): JSX.Element {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2">
      <div className="text-[11.5px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 text-[13px] font-medium">{value}</div>
      <div className="mt-1 font-mono text-[10.5px] text-[var(--color-muted)]">来源：{source}</div>
    </div>
  );
}

function scopeLabel(scope: SettingsScope): string {
  if (scope === 'room') return '群聊级';
  if (scope === 'project') return '项目级';
  return '系统级';
}
