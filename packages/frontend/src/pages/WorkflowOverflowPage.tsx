import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, Layers3, Search, Workflow } from 'lucide-react';
import { api } from '../lib/api';
import type { WorkflowDefinition } from '../lib/types';
import { Input } from '../components/ui/Input';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';

export function WorkflowOverflowPage(): JSX.Element {
  const [query, setQuery] = useState('');
  const { data: definitions = [], isLoading } = useQuery({
    queryKey: ['workflow-definitions'],
    queryFn: api.listWorkflowDefinitions,
  });
  const filteredDefinitions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return definitions;
    return definitions.filter((definition) =>
      [definition.name, definition.description, definition.scope, definition.status, definition.builtin_key]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery)),
    );
  }, [definitions, query]);
  const stats = useMemo(() => ({
    total: definitions.length,
    published: definitions.filter((definition) => definition.status === 'published').length,
    roomScoped: definitions.filter((definition) => definition.scope === 'room').length,
  }), [definitions]);

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
                查看已发布和草稿工作流定义，管理群聊可应用的执行闭环。
              </p>
            </div>
            <div className="ml-auto grid grid-cols-3 gap-2 max-sm:w-full">
              <Metric label="总数" value={stats.total} />
              <Metric label="已发布" value={stats.published} />
              <Metric label="群聊级" value={stats.roomScoped} />
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
          ) : filteredDefinitions.length === 0 ? (
            <WorkspaceEmptyState
              icon={<Search className="h-9 w-9" strokeWidth={1.75} />}
              title="没有匹配的工作流"
              description="调整搜索条件，或在群聊设置中创建并发布新的工作流定义。"
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {filteredDefinitions.map((definition) => (
                <WorkflowDefinitionCard key={definition.id} definition={definition} />
              ))}
            </div>
          )}
        </div>
      </section>
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

function WorkflowDefinitionCard({ definition }: { definition: WorkflowDefinition }): JSX.Element {
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
            <Badge>{definition.status}</Badge>
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
        <Tile label="Scope" value={`${definition.scope}:${definition.scope_id}`} />
        <Tile label="Nodes" value={definition.definition.nodes.length} />
        <Tile label="Edges" value={definition.definition.edges.length} />
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
    </article>
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
