import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, FolderOpen, MessageSquare, Plus, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { CreateProjectDialog } from '../components/CreateProjectDialog';
import { LobsterMark } from '../components/LobsterMark';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';

export function DashboardPage() {
  const { t, formatRelativeTime } = useI18n();
  const [projectQuery, setProjectQuery] = useState('');
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
  });
  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => project.name.toLowerCase().includes(query));
  }, [projectQuery, projects]);
  const hasProjectQuery = projectQuery.trim().length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <header className="px-4 sm:px-8 pt-8 sm:pt-10 pb-6 border-b border-[var(--color-border)]">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-wrap items-center gap-3">
            <LobsterMark className="h-9 w-9" />
            <div>
              <h1 className="font-display text-[24px] font-semibold tracking-tight">
                {t('app.name')}
              </h1>
              <p className="text-[13px] text-[var(--color-fg-muted)] mt-0.5">
                {t('app.tagline')}
              </p>
            </div>
            <div className="ml-auto max-sm:w-full">
              <CreateProjectDialog>
                <Button variant="primary" className="max-sm:w-full">
                  <Plus className="h-4 w-4" /> {t('dashboard.newProject')}
                </Button>
              </CreateProjectDialog>
            </div>
          </div>
        </div>
      </header>

      <section className="px-4 sm:px-8 py-8">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-wrap items-center gap-3 mb-5">
            <h2 className="font-display text-[15px] font-medium">{t('dashboard.allProjects')}</h2>
            <span className="text-[12px] font-mono text-[var(--color-fg-muted)]">
              {hasProjectQuery
                ? `${filteredProjects.length} / ${projects.length}`
                : t('dashboard.projectCount', { count: projects.length })}
            </span>
            <div className="relative ml-auto w-full sm:w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" />
              <Input
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.target.value)}
                placeholder={t('dashboard.projectSearchPlaceholder')}
                className="pl-9"
                aria-label={t('dashboard.projectSearchPlaceholder')}
              />
            </div>
          </div>

          {isLoading ? (
            <div className="text-[var(--color-fg-muted)] text-[13px]">{t('dashboard.loading')}</div>
          ) : projects.length === 0 ? (
            <EmptyState />
          ) : filteredProjects.length === 0 ? (
            <WorkspaceEmptyState
              icon={<Search className="h-9 w-9" strokeWidth={1.75} />}
              title={t('dashboard.noProjectMatchesTitle')}
              description={t('dashboard.noProjectMatchesDescription')}
            />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
              {filteredProjects.map((p) => (
                <Link
                  key={p.id}
                  to={`/projects/${p.id}`}
                  className="group fade-up surface-1 hover:border-[var(--color-accent)] rounded-xl p-5 ease-ocean transition-all hover:shadow-[0_0_0_3px_rgba(34,211,238,0.08)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <FolderOpen className="h-4 w-4 text-[var(--color-accent)] flex-shrink-0" strokeWidth={1.75} />
                        <h3 className="font-display text-[15px] font-semibold truncate">{p.name}</h3>
                      </div>
                      <p
                        className="text-[11.5px] text-[var(--color-muted)] font-mono truncate"
                        title={p.path}
                      >
                        {p.path}
                      </p>
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-[var(--color-muted)] group-hover:text-[var(--color-accent)] transition-colors" strokeWidth={1.5} />
                  </div>

                  {p.description && (
                    <p className="text-[12.5px] text-[var(--color-fg-muted)] mt-3 line-clamp-2">
                      {p.description}
                    </p>
                  )}

                  <div className="mt-5 flex items-center gap-4 text-[11px] font-mono text-[var(--color-fg-muted)]">
                    <span className="flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" strokeWidth={1.75} />
                      {t('project.stats.rooms', { count: p.stats?.rooms ?? 0 })}
                    </span>
                    <span>·</span>
                    <span>
                      {t('project.stats.tasks', {
                        count: `${p.stats?.tasksDone ?? 0}/${p.stats?.tasks ?? 0}`,
                      })}
                    </span>
                    <span className="ml-auto">{formatRelativeTime(p.updated_at)}</span>
                  </div>

                  {(p.stats?.tasks ?? 0) > 0 && (
                    <div className="mt-3 h-1 rounded-full bg-[var(--color-surface-raised)] overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-success)]"
                        style={{ width: `${((p.stats?.tasksDone ?? 0) / (p.stats?.tasks ?? 1)) * 100}%` }}
                      />
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function EmptyState(): JSX.Element {
  const { t } = useI18n();

  return (
    <WorkspaceEmptyState
      icon={<LobsterMark className="h-14 w-14" />}
      title={t('dashboard.emptyTitle')}
      description={t('dashboard.emptyDescription')}
      action={
        <CreateProjectDialog>
          <Button variant="primary">
            <Plus className="h-4 w-4" /> {t('dashboard.addFirstProject')}
          </Button>
        </CreateProjectDialog>
      }
    />
  );
}
