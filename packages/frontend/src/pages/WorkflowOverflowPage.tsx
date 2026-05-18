import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Copy, Eye, GitBranch, Layers3, Pencil, Plus, Search, Send, Trash2, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type { WorkflowDefinition, WorkflowDefinitionScope, WorkflowDefinitionStatus } from '../lib/types';
import { Button } from '../components/ui/Button';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import { Input } from '../components/ui/Input';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';
import { WorkflowBuilderDialog } from '../components/WorkflowBuilderDialog';

export function WorkflowOverflowPage(): JSX.Element {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | WorkflowDefinitionStatus>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | WorkflowDefinitionScope>('all');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingDefinition, setEditingDefinition] = useState<WorkflowDefinition | null>(null);
  const [viewingDefinition, setViewingDefinition] = useState<WorkflowDefinition | null>(null);
  const queryClient = useQueryClient();
  const {
    data: definitions = [],
    error: definitionsError,
    isError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['workflow-definitions', { includeArchived: true }],
    queryFn: () => api.listWorkflowDefinitions({ includeArchived: true }),
  });
  const filteredDefinitions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return definitions.filter((definition) => {
      if (statusFilter !== 'all' && definition.status !== statusFilter) return false;
      if (scopeFilter !== 'all' && definition.scope !== scopeFilter) return false;
      if (!normalizedQuery) return true;
      return [definition.name, definition.description, definition.scope, definition.status, definition.builtin_key, definition.scope_id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [definitions, query, scopeFilter, statusFilter]);
  const stats = useMemo(() => ({
    total: definitions.length,
    published: definitions.filter((definition) => definition.status === 'published').length,
    draft: definitions.filter((definition) => definition.status === 'draft').length,
    archived: definitions.filter((definition) => definition.status === 'archived').length,
  }), [definitions]);
  const invalidateDefinitions = async () => {
    await queryClient.invalidateQueries({ queryKey: ['workflow-definitions'] });
  };
  const openCreateDialog = () => {
    setEditingDefinition(null);
    setBuilderOpen(true);
  };
  const openEditDialog = (definition: WorkflowDefinition) => {
    setEditingDefinition(definition);
    setBuilderOpen(true);
  };
  const createEditDraft = useMutation({
    mutationFn: api.createWorkflowDefinitionEditDraft,
    onSuccess: async (draft) => {
      await invalidateDefinitions();
      setEditingDefinition(draft);
      setBuilderOpen(true);
      toast.success('已创建编辑草稿');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const duplicateDefinition = useMutation({
    mutationFn: (definition: WorkflowDefinition) =>
      api.duplicateWorkflowDefinition(definition.id, { name: `${definition.name} 副本` }),
    onSuccess: async () => {
      await invalidateDefinitions();
      toast.success('工作流已复制为草稿');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const publishDefinition = useMutation({
    mutationFn: api.publishWorkflowDefinition,
    onSuccess: async () => {
      await invalidateDefinitions();
      toast.success('工作流已发布');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const archiveDefinition = useMutation({
    mutationFn: api.archiveWorkflowDefinition,
    onSuccess: async () => {
      await invalidateDefinitions();
      toast.success('工作流已归档');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const deleteDefinition = useMutation({
    mutationFn: api.deleteWorkflowDefinition,
    onSuccess: async () => {
      await invalidateDefinitions();
      toast.success('草稿已删除');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const actionsBusy = createEditDraft.isPending
    || duplicateDefinition.isPending
    || publishDefinition.isPending
    || archiveDefinition.isPending
    || deleteDefinition.isPending;

  return (
    <div className="h-full overflow-y-auto">
      <header className="border-b border-[var(--color-border)] px-4 py-7 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-accent)]">
              <Workflow className="h-5 w-5" strokeWidth={1.75} />
            </div>
            <div>
              <h1 className="font-display text-[22px] font-semibold tracking-tight">工作流</h1>
              <p className="mt-0.5 text-[13px] text-[var(--color-fg-muted)]">
                创建、筛选和维护工作流定义，按生命周期管理可发布的执行闭环。
              </p>
            </div>
            <Button type="button" className="ml-auto max-sm:w-full" onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              新建工作流
            </Button>
            <div className="grid grid-cols-4 gap-2 max-sm:w-full">
              <Metric label="总数" value={stats.total} />
              <Metric label="已发布" value={stats.published} />
              <Metric label="草稿" value={stats.draft} />
              <Metric label="已归档" value={stats.archived} />
            </div>
          </div>
        </div>
      </header>

      <section className="px-4 py-7 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <h2 className="font-display text-[15px] font-medium">定义列表</h2>
            <span className="font-mono text-[12px] text-[var(--color-fg-muted)]">
              {filteredDefinitions.length} / {definitions.length}
            </span>
            <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
              <SelectFilter
                label="状态"
                value={statusFilter}
                options={[
                  { value: 'all', label: '全部状态' },
                  { value: 'published', label: '已发布' },
                  { value: 'draft', label: '草稿' },
                  { value: 'archived', label: '已归档' },
                ]}
                onChange={(value) => setStatusFilter(value as 'all' | WorkflowDefinitionStatus)}
              />
              <SelectFilter
                label="范围"
                value={scopeFilter}
                options={[
                  { value: 'all', label: '全部范围' },
                  { value: 'system', label: '系统' },
                  { value: 'project', label: '项目' },
                  { value: 'room', label: '群聊' },
                ]}
                onChange={(value) => setScopeFilter(value as 'all' | WorkflowDefinitionScope)}
              />
            </div>
            <div className="relative ml-auto w-full sm:w-[300px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称、范围或状态"
                className="pl-9"
                aria-label="搜索工作流定义"
              />
            </div>
          </div>

          {isLoading ? (
            <div className="text-[13px] text-[var(--color-fg-muted)]">加载中...</div>
          ) : isError ? (
            <WorkflowErrorState
              message={definitionsError instanceof Error ? definitionsError.message : '工作流定义加载失败'}
              onRetry={() => void refetch()}
            />
          ) : filteredDefinitions.length === 0 ? (
            <WorkspaceEmptyState
              icon={<Search className="h-9 w-9" strokeWidth={1.75} />}
              title="没有匹配的工作流"
              description="调整搜索或筛选条件，也可以新建系统级工作流草稿。"
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {filteredDefinitions.map((definition) => (
                <WorkflowDefinitionCard
                  key={definition.id}
                  definition={definition}
                  disabled={actionsBusy}
                  onView={() => setViewingDefinition(definition)}
                  onEdit={() => openEditDialog(definition)}
                  onCreateEditDraft={() => createEditDraft.mutate(definition.id)}
                  onDuplicate={() => duplicateDefinition.mutate(definition)}
                  onPublish={() => publishDefinition.mutate(definition.id)}
                  onArchive={() => {
                    if (!window.confirm('确认归档这个已发布工作流？归档不会影响历史运行记录。')) return;
                    archiveDefinition.mutate(definition.id);
                  }}
                  onDelete={() => {
                    if (!window.confirm('确认删除这个草稿工作流？此操作不可撤销。')) return;
                    deleteDefinition.mutate(definition.id);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </section>
      <WorkflowBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        initialScope="system"
        initialScopeId="default"
        scopeOptions={[{ scope: 'system', scope_id: 'default', label: '系统' }]}
        definition={editingDefinition}
        mode={editingDefinition?.status === 'draft' ? 'edit-draft' : 'create'}
      />
      <WorkflowDefinitionViewDialog definition={viewingDefinition} onOpenChange={(open) => !open && setViewingDefinition(null)} />
    </div>
  );
}

function WorkflowErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-surface)] p-4">
      <div className="text-[13px] font-medium text-[var(--color-danger)]">工作流定义加载失败</div>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{message}</p>
      <Button type="button" variant="secondary" className="mt-3" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="min-w-[86px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-right">
      <div className="font-mono text-[16px] text-[var(--color-fg)]">{value}</div>
      <div className="mt-0.5 text-[10.5px] text-[var(--color-fg-muted)]">{label}</div>
    </div>
  );
}

function WorkflowDefinitionCard({
  definition,
  disabled,
  onView,
  onEdit,
  onCreateEditDraft,
  onDuplicate,
  onPublish,
  onArchive,
  onDelete,
}: {
  definition: WorkflowDefinition;
  disabled: boolean;
  onView: () => void;
  onEdit: () => void;
  onCreateEditDraft: () => void;
  onDuplicate: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onDelete: () => void;
}): JSX.Element {
  const stages = [...new Set(definition.definition.nodes.map((node) => node.stage).filter(Boolean))];
  return (
    <article className="surface-1 rounded-xl p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-accent)]">
          <GitBranch className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-display text-[15px] font-semibold">{definition.name}</h3>
            {definition.builtin_key && <Badge>内置</Badge>}
            <Badge>{statusLabel(definition.status)}</Badge>
          </div>
          {definition.description && (
            <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
              {definition.description}
            </p>
          )}
        </div>
        <div className="rounded-md bg-[var(--color-surface-raised)] px-2 py-1 font-mono text-[11px] text-[var(--color-fg-muted)]">
          v{definition.version}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Tile label="范围" value={`${scopeLabel(definition.scope)}:${definition.scope_id}`} />
        <Tile label="节点" value={definition.definition.nodes.length} />
        <Tile label="连线" value={definition.definition.edges.length} />
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <span className="mr-1 inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
          <Layers3 className="h-3 w-3" />
          stages
        </span>
        {stages.map((stage) => (
          <Badge key={stage}>{stage}</Badge>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
        <span className="font-mono text-[10.5px] text-[var(--color-fg-muted)]">
          更新 {formatTime(definition.updated_at)}
        </span>
        <WorkflowActions
          definition={definition}
          disabled={disabled}
          onView={onView}
          onEdit={onEdit}
          onCreateEditDraft={onCreateEditDraft}
          onDuplicate={onDuplicate}
          onPublish={onPublish}
          onArchive={onArchive}
          onDelete={onDelete}
        />
      </div>
    </article>
  );
}

function WorkflowActions({
  definition,
  disabled,
  onView,
  onEdit,
  onCreateEditDraft,
  onDuplicate,
  onPublish,
  onArchive,
  onDelete,
}: {
  definition: WorkflowDefinition;
  disabled: boolean;
  onView: () => void;
  onEdit: () => void;
  onCreateEditDraft: () => void;
  onDuplicate: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onDelete: () => void;
}): JSX.Element {
  const isBuiltIn = Boolean(definition.builtin_key);
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      <ActionButton icon={<Eye className="h-3.5 w-3.5" />} label="查看" onClick={onView} disabled={disabled} />
      {definition.status === 'draft' && !isBuiltIn && (
        <>
          <ActionButton icon={<Pencil className="h-3.5 w-3.5" />} label="编辑" onClick={onEdit} disabled={disabled} />
          <ActionButton icon={<Send className="h-3.5 w-3.5" />} label="发布" onClick={onPublish} disabled={disabled} />
        </>
      )}
      {definition.status === 'published' && !isBuiltIn && (
        <>
          <ActionButton
            icon={<Pencil className="h-3.5 w-3.5" />}
            label="编辑新草稿"
            onClick={onCreateEditDraft}
            disabled={disabled}
          />
          <ActionButton icon={<Archive className="h-3.5 w-3.5" />} label="归档" onClick={onArchive} disabled={disabled} />
        </>
      )}
      <ActionButton icon={<Copy className="h-3.5 w-3.5" />} label="复制" onClick={onDuplicate} disabled={disabled} />
      {definition.status === 'draft' && !isBuiltIn && (
        <ActionButton
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label="删除"
          onClick={onDelete}
          disabled={disabled}
          danger
        />
      )}
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
        danger
          ? 'border-[var(--color-danger)]/50 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10'
          : 'border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function WorkflowDefinitionViewDialog({
  definition,
  onOpenChange,
}: {
  definition: WorkflowDefinition | null;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <Dialog open={Boolean(definition)} onOpenChange={onOpenChange}>
      <DialogContent
        title={definition?.name ?? '工作流详情'}
        description="只读查看工作流定义，不会保存或发布任何修改。"
        className="w-[min(92vw,720px)]"
      >
        {definition && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="状态" value={statusLabel(definition.status)} />
              <Tile label="范围" value={`${scopeLabel(definition.scope)}:${definition.scope_id}`} />
              <Tile label="版本" value={`v${definition.version}`} />
              <Tile label="内置" value={definition.builtin_key ? '是' : '否'} />
            </div>
            {definition.description && (
              <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
                {definition.description}
              </p>
            )}
            <div>
              <div className="mb-2 text-[12px] font-semibold text-[var(--color-fg)]">节点</div>
              <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                {definition.definition.nodes.map((node) => (
                  <div
                    key={node.id}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium">{node.label}</span>
                      <Badge>{node.type}</Badge>
                      {node.stage && <Badge>{node.stage}</Badge>}
                      {node.role && <Badge>{node.role}</Badge>}
                    </div>
                    <div className="mt-1 font-mono text-[10.5px] text-[var(--color-fg-muted)]">{node.id}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="font-mono text-[10.5px] text-[var(--color-fg-muted)]">
              {definition.definition.edges.length} 条连线 · 更新 {formatTime(definition.updated_at)}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Tile({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-2">
      <div className="text-[10.5px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 truncate font-mono text-[11.5px] text-[var(--color-fg)]" title={String(value)}>
        {value}
      </div>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-fg-muted)]">
      {children}
    </span>
  );
}

function statusLabel(status: WorkflowDefinitionStatus): string {
  return status === 'published' ? '已发布' : status === 'draft' ? '草稿' : '已归档';
}

function scopeLabel(scope: WorkflowDefinitionScope): string {
  return scope === 'system' ? '系统' : scope === 'project' ? '项目' : '群聊';
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}
