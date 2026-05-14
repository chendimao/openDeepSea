import { type FormEvent, useMemo, useState } from 'react';
import { Edit3, Pin, PinOff, Plus, Save, Trash2, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import {
  MEMORY_SCOPE_LABEL,
  MEMORY_TYPE_LABEL,
  type MemoryEntry,
  type MemoryInput,
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
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [showForm, setShowForm] = useState(false);
  const filters = useMemo<MemoryQueryFilters>(
    () => ({
      roomId,
      roomAgentIds: roomAgentId ? [roomAgentId] : roomAgents.map((agent) => agent.id).sort(),
      taskId: task?.id,
    }),
    [roomAgentId, roomId, roomAgents, task?.id],
  );

  const { data: memories = [], isLoading } = useQuery({
    queryKey: ['memories', projectId, filters],
    queryFn: async () => {
      const baseFilters = { roomId: filters.roomId, taskId: filters.taskId };
      const memoryGroups = await Promise.all([
        api.listMemories(projectId, baseFilters),
        ...filters.roomAgentIds.map((roomAgentId) =>
          api.listMemories(projectId, {
            ...baseFilters,
            roomAgentId,
          }),
        ),
      ]);
      return mergeMemories(memoryGroups.flat());
    },
    enabled: Boolean(projectId),
  });

  const invalidateMemories = () => queryClient.invalidateQueries({ queryKey: ['memories', projectId] });
  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
  };

  const createMutation = useMutation({
    mutationFn: (input: MemoryInput) => api.createMemory(projectId, input),
    onSuccess: () => {
      toast.success('记忆已保存');
      closeForm();
      invalidateMemories();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Pick<MemoryInput, 'memory_type' | 'title' | 'content' | 'pinned'> }) =>
      api.updateMemory(projectId, id, input),
    onSuccess: () => {
      toast.success('记忆已更新');
      closeForm();
      invalidateMemories();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteMemory(projectId, id),
    onSuccess: () => {
      toast.success('记忆已删除');
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

  const busy = createMutation.isPending || updateMutation.isPending;

  return (
    <section className={cn('space-y-3', compact && 'text-[12px]')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-[14px] font-semibold text-[var(--color-fg)]">记忆</h3>
          <p className="mt-0.5 text-[11px] leading-4 text-[var(--color-fg-muted)]">
            会注入后续智能体上下文
          </p>
        </div>
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
          新增
        </Button>
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

      <div className="space-y-2">
        {isLoading ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-4 text-[12px] text-[var(--color-fg-muted)]">
            正在载入记忆…
          </div>
        ) : memories.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-4 text-[12px] leading-5 text-[var(--color-fg-muted)]">
            暂无记忆
          </div>
        ) : (
          memories.map((memory) => (
            <article
              key={memory.id}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[0_8px_24px_rgba(15,23,42,0.04)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <MemoryBadge>{MEMORY_SCOPE_LABEL[memory.scope]}</MemoryBadge>
                    <MemoryBadge>{MEMORY_TYPE_LABEL[memory.memory_type]}</MemoryBadge>
                    {memory.pinned ? (
                      <span className="inline-flex h-5 items-center gap-1 rounded border border-[var(--color-accent)]/35 px-1.5 text-[10px] text-[var(--color-accent)]">
                        <Pin className="h-3 w-3" />
                        置顶
                      </span>
                    ) : null}
                  </div>
                  <h4 className="mt-1.5 break-words text-[13px] font-semibold leading-snug text-[var(--color-fg)]">
                    {memory.title}
                  </h4>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    label={memory.pinned ? '取消置顶记忆' : '置顶记忆'}
                    disabled={pinMutation.isPending}
                    onClick={() => pinMutation.mutate(memory)}
                  >
                    {memory.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                  </IconButton>
                  <IconButton label="编辑记忆" onClick={() => {
                    setShowForm(false);
                    setEditing(memory);
                  }}>
                    <Edit3 className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label="删除记忆"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (window.confirm('删除这条记忆？')) deleteMutation.mutate(memory.id);
                    }}
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
          ))
        )}
      </div>
    </section>
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
          <Label>范围</Label>
          <select
            className="glass-select"
            value={scope}
            disabled={Boolean(value)}
            onChange={(event) => setScope(event.target.value as MemoryScope)}
          >
            {scopeOptions.map((option) => (
              <option key={option} value={option}>
                {MEMORY_SCOPE_LABEL[option]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>类型</Label>
          <select
            className="glass-select"
            value={memoryType}
            onChange={(event) => setMemoryType(event.target.value as MemoryType)}
          >
            {MEMORY_TYPES.map((type) => (
              <option key={type} value={type}>
                {MEMORY_TYPE_LABEL[type]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {scope === 'agent' ? (
        <div>
          <Label>智能体</Label>
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
        <Label>标题</Label>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={160}
          required
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <Label className="mb-0">内容</Label>
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
            已达到记忆内容长度上限
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
        置顶
      </label>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          <X className="h-4 w-4" />
          取消
        </Button>
        <Button type="submit" disabled={busy}>
          <Save className="h-4 w-4" />
          {busy ? '保存中…' : '保存'}
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
