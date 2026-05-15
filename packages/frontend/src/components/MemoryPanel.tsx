import { type FormEvent, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, Edit3, Pin, PinOff, Plus, Save, Search, Trash2, Upload, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import {
  type MemoryEntry,
  type MemoryInput,
  type MemorySearchResult,
  type MemoryScope,
  type MemoryType,
  type RoomAgent,
  type Task,
} from '../lib/types';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Input, Label, Textarea } from './ui/Input';

const MEMORY_TYPES: MemoryType[] = [
  'decision',
  'fact',
  'preference',
  'lesson',
  'task_summary',
  'artifact_summary',
];
const MEMORY_CONTENT_MAX_LENGTH = 12000;
const EMPTY_ROOM_AGENTS: RoomAgent[] = [];

interface MemoryPanelProps {
  projectId: string;
  roomId?: string;
  roomAgentId?: string;
  roomAgents?: RoomAgent[];
  task?: Task;
  defaultScope?: MemoryScope;
  compact?: boolean;
}

interface MemoryQueryFilters {
  roomId?: string;
  roomAgentIds: string[];
  taskId?: string;
}

type MemoryTab = 'context' | 'project' | 'search';

export function MemoryPanel({
  projectId,
  roomId,
  roomAgentId,
  roomAgents = EMPTY_ROOM_AGENTS,
  task,
  defaultScope = roomId ? 'room' : 'project',
  compact = false,
}: MemoryPanelProps) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [activeTab, setActiveTab] = useState<MemoryTab>('context');
  const [searchQuery, setSearchQuery] = useState('');
  const filters = useMemo<MemoryQueryFilters>(
    () => ({
      roomId,
      roomAgentIds: roomAgentId ? [roomAgentId] : roomAgents.map((agent) => agent.id).sort(),
      taskId: task?.id,
    }),
    [roomAgentId, roomId, roomAgents, task?.id],
  );

  const [showArchived, setShowArchived] = useState(false);

  const { data: memories = [], isLoading } = useQuery({
    queryKey: ['memories', projectId, filters, showArchived],
    queryFn: async () => {
      const result = await api.listMemories(projectId, {
        roomId: filters.roomId,
        roomAgentIds: filters.roomAgentIds.length > 0 ? filters.roomAgentIds : undefined,
        taskId: filters.taskId,
        includeArchived: showArchived,
      });
      return mergeMemories(result);
    },
    enabled: Boolean(projectId),
  });

  const { data: projectMemories = [], isLoading: isProjectLoading } = useQuery({
    queryKey: ['memories', projectId, 'project-only', showArchived],
    queryFn: async () => {
      const result = await api.searchMemories(projectId, {
        scope: 'project',
        limit: 100,
        includeArchived: showArchived,
      });
      return mergeMemories(result);
    },
    enabled: Boolean(projectId) && activeTab === 'project',
  });

  const trimmedSearchQuery = searchQuery.trim();
  const { data: searchResults = [], isLoading: isSearchLoading } = useQuery({
    queryKey: ['memories', projectId, 'search', trimmedSearchQuery, showArchived],
    queryFn: () =>
      api.searchMemories(projectId, {
        query: trimmedSearchQuery,
        limit: 20,
        includeArchived: showArchived,
      }),
    enabled: Boolean(projectId) && activeTab === 'search' && trimmedSearchQuery.length > 0,
  });

  const invalidateMemories = () => queryClient.invalidateQueries({ queryKey: ['memories', projectId] });
  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
  };

  const createMutation = useMutation({
    mutationFn: (input: MemoryInput) => api.createMemory(projectId, input),
    onSuccess: () => {
      toast.success(t('memory.saved'));
      closeForm();
      invalidateMemories();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Pick<MemoryInput, 'memory_type' | 'title' | 'content' | 'pinned'> }) =>
      api.updateMemory(projectId, id, input),
    onSuccess: () => {
      toast.success(t('memory.updated'));
      closeForm();
      invalidateMemories();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteMemory(projectId, id),
    onSuccess: () => {
      toast.success(t('memory.deleted'));
      invalidateMemories();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const pinMutation = useMutation({
    mutationFn: (memory: MemoryEntry) =>
      api.updateMemory(projectId, memory.id, {
        pinned: !memory.pinned,
      }),
    onSuccess: () => {
      invalidateMemories();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const archiveMutation = useMutation({
    mutationFn: (memory: MemoryEntry) =>
      api.archiveMemory(projectId, memory.id, !memory.archived),
    onSuccess: () => {
      toast.success(t('memory.archived'));
      invalidateMemories();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const promoteMutation = useMutation({
    mutationFn: (memory: MemoryEntry) =>
      api.createMemory(projectId, {
        scope: 'project',
        memory_type: memory.memory_type,
        title: memory.title,
        content: memory.content,
        source_type: 'manual',
        source_id: null,
        pinned: false,
      }),
    onSuccess: () => {
      toast.success(t('memory.promoted'));
      invalidateMemories();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const busy = createMutation.isPending || updateMutation.isPending;
  const displayedMemories = activeTab === 'project' ? projectMemories : memories;
  const displayedLoading = activeTab === 'project' ? isProjectLoading : isLoading;

  return (
    <section className={cn('space-y-3', compact && 'text-[12px]')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-[14px] font-semibold text-[var(--color-fg)]">{t('memory.title')}</h3>
          <p className="mt-0.5 text-[11px] leading-4 text-[var(--color-fg-muted)]">
            {t('memory.description')}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowArchived((v) => !v)}
            title={t('memory.showArchived')}
          >
            <Archive className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing(null);
              setShowForm((value) => !value);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('memory.add')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-1">
        {(['context', 'project', 'search'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={cn(
              'h-8 rounded px-2 text-[12px] font-medium text-[var(--color-fg-muted)] transition-colors',
              activeTab === tab && 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm',
            )}
            onClick={() => setActiveTab(tab)}
          >
            {t(`memory.tab.${tab}`)}
          </button>
        ))}
      </div>

      {(showForm || editing) && (
        <MemoryForm
          key={editing?.id ?? 'new-memory'}
          roomId={roomId}
          roomAgents={roomAgents}
          task={task}
          defaultScope={defaultScope}
          value={editing}
          busy={busy}
          onCancel={closeForm}
          onSubmit={(input) => {
            if (editing) {
              updateMutation.mutate({
                id: editing.id,
                input: {
                  memory_type: input.memory_type,
                  title: input.title,
                  content: input.content,
                  pinned: input.pinned,
                },
              });
              return;
            }
            createMutation.mutate(input);
          }}
        />
      )}

      {activeTab === 'search' ? (
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-fg-muted)]" />
            <Input
              className="pl-8"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('memory.search.placeholder')}
              aria-label={t('memory.search.placeholder')}
            />
          </div>
          {trimmedSearchQuery.length === 0 ? (
            <EmptyMemoryState>{t('memory.search.hint')}</EmptyMemoryState>
          ) : (
            <MemoryList
              memories={searchResults}
              loading={isSearchLoading}
              emptyText={t('memory.search.empty')}
              activeTab={activeTab}
              currentRoomId={roomId}
              pinPending={pinMutation.isPending}
              archivePending={archiveMutation.isPending}
              deletePending={deleteMutation.isPending}
              promotePending={promoteMutation.isPending}
              onPin={(memory) => pinMutation.mutate(memory)}
              onArchive={(memory) => archiveMutation.mutate(memory)}
              onEdit={(memory) => {
                setShowForm(false);
                setEditing(memory);
              }}
              onDelete={(memory) => {
                if (window.confirm(t('memory.deleteConfirm'))) deleteMutation.mutate(memory.id);
              }}
              onPromote={(memory) => promoteMutation.mutate(memory)}
            />
          )}
        </div>
      ) : (
        <MemoryList
          memories={displayedMemories}
          loading={displayedLoading}
          emptyText={activeTab === 'project' ? t('memory.empty.project') : t('memory.empty')}
          activeTab={activeTab}
          currentRoomId={roomId}
          pinPending={pinMutation.isPending}
          archivePending={archiveMutation.isPending}
          deletePending={deleteMutation.isPending}
          promotePending={promoteMutation.isPending}
          onPin={(memory) => pinMutation.mutate(memory)}
          onArchive={(memory) => archiveMutation.mutate(memory)}
          onEdit={(memory) => {
            setShowForm(false);
            setEditing(memory);
          }}
          onDelete={(memory) => {
            if (window.confirm(t('memory.deleteConfirm'))) deleteMutation.mutate(memory.id);
          }}
          onPromote={(memory) => promoteMutation.mutate(memory)}
        />
      )}
    </section>
  );
}

function MemoryList({
  memories,
  loading,
  emptyText,
  activeTab,
  currentRoomId,
  pinPending,
  archivePending,
  deletePending,
  promotePending,
  onPin,
  onArchive,
  onEdit,
  onDelete,
  onPromote,
}: {
  memories: Array<MemoryEntry | MemorySearchResult>;
  loading: boolean;
  emptyText: string;
  activeTab: MemoryTab;
  currentRoomId?: string;
  pinPending: boolean;
  archivePending: boolean;
  deletePending: boolean;
  promotePending: boolean;
  onPin: (memory: MemoryEntry) => void;
  onArchive: (memory: MemoryEntry) => void;
  onEdit: (memory: MemoryEntry) => void;
  onDelete: (memory: MemoryEntry) => void;
  onPromote: (memory: MemoryEntry) => void;
}) {
  const { memoryScopeLabel, memoryTypeLabel, t } = useI18n();
  return (
    <div className="space-y-2">
      {loading ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-4 text-[12px] text-[var(--color-fg-muted)]">
          {t('memory.loading')}
        </div>
      ) : memories.length === 0 ? (
        <EmptyMemoryState>{emptyText}</EmptyMemoryState>
      ) : (
        memories.map((memory) => {
          const canPromote = activeTab === 'search' && memory.scope === 'room' && memory.room_id !== currentRoomId;
          const sourceLabel = getMemorySourceLabel(memory);
          return (
            <article
              key={memory.id}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[0_8px_24px_rgba(15,23,42,0.04)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <MemoryBadge>{memoryScopeLabel(memory.scope)}</MemoryBadge>
                    <MemoryBadge>{memoryTypeLabel(memory.memory_type)}</MemoryBadge>
                    {sourceLabel ? <MemoryBadge>{sourceLabel}</MemoryBadge> : null}
                    {memory.pinned ? (
                      <span className="inline-flex h-5 items-center gap-1 rounded border border-[var(--color-accent)]/35 px-1.5 text-[10px] text-[var(--color-accent)]">
                        <Pin className="h-3 w-3" />
                        {t('memory.pinned')}
                      </span>
                    ) : null}
                  </div>
                  <h4 className="mt-1.5 break-words text-[13px] font-semibold leading-snug text-[var(--color-fg)]">
                    {memory.title}
                  </h4>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {canPromote ? (
                    <IconButton
                      label={t('memory.promote')}
                      disabled={promotePending}
                      onClick={() => onPromote(memory)}
                    >
                      <Upload className="h-3.5 w-3.5" />
                    </IconButton>
                  ) : null}
                  <IconButton
                    label={memory.pinned ? t('memory.unpin') : t('memory.pin')}
                    disabled={pinPending}
                    onClick={() => onPin(memory)}
                  >
                    {memory.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                  </IconButton>
                  <IconButton
                    label={memory.archived ? t('memory.unarchive') : t('memory.archive')}
                    disabled={archivePending}
                    onClick={() => onArchive(memory)}
                  >
                    {memory.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                  </IconButton>
                  <IconButton label={t('memory.edit')} onClick={() => onEdit(memory)}>
                    <Edit3 className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={t('memory.delete')}
                    disabled={deletePending}
                    onClick={() => onDelete(memory)}
                    danger
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--color-fg-muted)]">
                {memory.content}
              </p>
            </article>
          );
        })
      )}
    </div>
  );
}

function EmptyMemoryState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-4 text-[12px] leading-5 text-[var(--color-fg-muted)]">
      {children}
    </div>
  );
}

function MemoryForm({
  roomId,
  roomAgents,
  task,
  defaultScope,
  value,
  busy,
  onCancel,
  onSubmit,
}: {
  roomId?: string;
  roomAgents: RoomAgent[];
  task?: Task;
  defaultScope: MemoryScope;
  value: MemoryEntry | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: MemoryInput) => void;
}) {
  const { memoryScopeLabel, memoryTypeLabel, t } = useI18n();
  const initialScope = normalizeScope(value?.scope ?? defaultScope, roomId, roomAgents, task);
  const [scope, setScope] = useState<MemoryScope>(initialScope);
  const [memoryType, setMemoryType] = useState<MemoryType>(value?.memory_type ?? 'fact');
  const [title, setTitle] = useState(value?.title ?? '');
  const [content, setContent] = useState(value?.content ?? '');
  const [roomAgentId, setRoomAgentId] = useState(value?.room_agent_id ?? roomAgents[0]?.id ?? '');
  const [pinned, setPinned] = useState(Boolean(value?.pinned));

  const scopeOptions = useMemo(() => {
    const options: MemoryScope[] = ['project'];
    if (roomId) options.push('room');
    if (roomId && roomAgents.length > 0) options.push('agent');
    if (roomId && task) options.push('task');
    return options;
  }, [roomId, roomAgents.length, task]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim();
    const nextContent = content.trim();
    if (!nextTitle || !nextContent) return;

    onSubmit(buildMemoryInput({
      scope,
      memoryType,
      title: nextTitle,
      content: nextContent,
      roomId,
      roomAgentId,
      task,
      pinned,
    }));
  };

  return (
    <form
      className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-3"
      onSubmit={submit}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <Label>{t('memory.scope.label')}</Label>
          <select
            className="glass-select"
            value={scope}
            disabled={Boolean(value)}
            onChange={(event) => setScope(event.target.value as MemoryScope)}
          >
            {scopeOptions.map((option) => (
              <option key={option} value={option}>
                {memoryScopeLabel(option)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>{t('memory.type.label')}</Label>
          <select
            className="glass-select"
            value={memoryType}
            onChange={(event) => setMemoryType(event.target.value as MemoryType)}
          >
            {MEMORY_TYPES.map((type) => (
              <option key={type} value={type}>
                {memoryTypeLabel(type)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {scope === 'agent' ? (
        <div>
          <Label>{t('memory.agent')}</Label>
          <select
            className="glass-select"
            value={roomAgentId}
            onChange={(event) => setRoomAgentId(event.target.value)}
            required
          >
            {roomAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.agent_name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div>
        <Label>{t('memory.formTitle')}</Label>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={160}
          required
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <Label className="mb-0">{t('memory.content')}</Label>
          <span className="font-mono text-[10.5px] text-[var(--color-fg-muted)]">
            {content.length}/{MEMORY_CONTENT_MAX_LENGTH}
          </span>
        </div>
        <Textarea
          className="min-h-[104px]"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          maxLength={MEMORY_CONTENT_MAX_LENGTH}
          required
        />
        {content.length >= MEMORY_CONTENT_MAX_LENGTH ? (
          <p className="mt-1 text-[11px] text-[var(--color-warning)]">
            {t('memory.maxLengthReached')}
          </p>
        ) : null}
      </div>

      <label className="flex min-h-8 items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
        <input
          type="checkbox"
          checked={pinned}
          onChange={(event) => setPinned(event.target.checked)}
          className="h-4 w-4 accent-[var(--color-primary)]"
        />
        {t('memory.pinned')}
      </label>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          <X className="h-4 w-4" />
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={busy}>
          <Save className="h-4 w-4" />
          {busy ? t('memory.saving') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}

function buildMemoryInput({
  scope,
  memoryType,
  title,
  content,
  roomId,
  roomAgentId,
  task,
  pinned,
}: {
  scope: MemoryScope;
  memoryType: MemoryType;
  title: string;
  content: string;
  roomId?: string;
  roomAgentId: string;
  task?: Task;
  pinned: boolean;
}): MemoryInput {
  const base = {
    scope,
    memory_type: memoryType,
    title,
    content,
    pinned,
  };

  if (scope === 'project') return base;
  if (scope === 'room') return { ...base, room_id: roomId };
  if (scope === 'agent') return { ...base, room_id: roomId, room_agent_id: roomAgentId };
  return { ...base, room_id: roomId, task_id: task?.id };
}

function normalizeScope(
  scope: MemoryScope,
  roomId: string | undefined,
  roomAgents: RoomAgent[],
  task: Task | undefined,
): MemoryScope {
  if (scope === 'task' && roomId && task) return 'task';
  if (scope === 'agent' && roomId && roomAgents.length > 0) return 'agent';
  if (scope === 'room' && roomId) return 'room';
  return 'project';
}

function mergeMemories(memories: MemoryEntry[]): MemoryEntry[] {
  const byId = new Map<string, MemoryEntry>();
  for (const memory of memories) {
    byId.set(memory.id, memory);
  }
  return Array.from(byId.values()).sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned - a.pinned;
    return b.updated_at - a.updated_at;
  });
}

function getMemorySourceLabel(memory: MemoryEntry | MemorySearchResult): string | null {
  if (!('room_name' in memory) || !memory.room_name) return null;
  return memory.room_name;
}

function MemoryBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded border border-[var(--color-border)] px-1.5 text-[10px] text-[var(--color-fg-muted)]">
      {children}
    </span>
  );
}

function IconButton({
  label,
  children,
  danger = false,
  disabled,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn('h-7 w-7 px-0', danger && 'hover:text-[var(--color-danger)]')}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
