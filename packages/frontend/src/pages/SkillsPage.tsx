import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  Loader2,
  RefreshCcw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/Button';
import { Input, Label } from '../components/ui/Input';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';
import type {
  PlatformSkill,
  PlatformSkillAggregate,
  PlatformSkillInstallMode,
  PlatformSkillProvider,
  PlatformSkillSummary,
} from '../lib/types';
import { cn } from '../lib/utils';

const PROVIDERS: PlatformSkillProvider[] = ['codex', 'claudecode', 'opencode'];
const INSTALL_MODES: PlatformSkillInstallMode[] = ['copy', 'symlink', 'unknown'];

type MatrixStatusFilter = 'all' | 'missing' | 'issues';

export function SkillsPage(): JSX.Element {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<MatrixStatusFilter>('all');
  const [providerFilters, setProviderFilters] = useState<PlatformSkillProvider[]>([]);
  const [installModeFilter, setInstallModeFilter] = useState<PlatformSkillInstallMode[]>([]);
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);

  const summariesQuery = useQuery({
    queryKey: ['platform-skills', 'platforms'],
    queryFn: api.listPlatformSkillSummaries,
  });
  const aggregatesQuery = useQuery({
    queryKey: ['platform-skills', 'aggregate'],
    queryFn: api.listPlatformSkillAggregates,
  });

  const summaries = summariesQuery.data ?? [];
  const aggregates = aggregatesQuery.data ?? [];
  const filteredAggregates = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return aggregates.filter((aggregate) => {
      if (query) {
        const haystack = [
          aggregate.name,
          aggregate.displayName,
          aggregate.description ?? '',
          ...Object.values(aggregate.installations).map((skill) => skill?.sourceLabel ?? ''),
        ].join('\n').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (statusFilter === 'missing' && aggregate.missingProviders.length === 0) return false;
      if (statusFilter === 'issues' && aggregate.issues.length === 0) return false;
      if (providerFilters.length > 0 && !providerFilters.some((provider) => aggregate.providers.includes(provider))) return false;
      if (
        installModeFilter.length > 0
        && !Object.values(aggregate.installModes).some((mode) => mode && installModeFilter.includes(mode))
      ) {
        return false;
      }
      return true;
    });
  }, [aggregates, installModeFilter, providerFilters, searchQuery, statusFilter]);

  const selectedAggregate = useMemo(
    () => filteredAggregates.find((skill) => skill.name === selectedSkillName) ?? filteredAggregates[0] ?? null,
    [filteredAggregates, selectedSkillName],
  );

  return (
    <div className="files-page">
      <SkillMatrixToolbar
        total={aggregates.length}
        issues={aggregates.filter((skill) => skill.issues.length > 0).length}
        refreshing={summariesQuery.isFetching || aggregatesQuery.isFetching}
        onRefresh={async () => {
          await Promise.all([summariesQuery.refetch(), aggregatesQuery.refetch()]);
          toast.success(t('platformSkills.refreshDone'));
        }}
      />
      <main className="min-h-0 flex-1 overflow-auto p-3 xl:overflow-hidden">
        <div className="grid min-h-0 gap-3 xl:h-full xl:grid-cols-[232px_minmax(0,1fr)_340px]">
          <SkillMatrixFilters
            searchQuery={searchQuery}
            statusFilter={statusFilter}
            providerFilters={providerFilters}
            installModeFilter={installModeFilter}
            onSearchChange={setSearchQuery}
            onStatusChange={setStatusFilter}
            onProviderToggle={(provider) => setProviderFilters((current) => toggleArrayItem(current, provider))}
            onInstallModeToggle={(mode) => setInstallModeFilter((current) => toggleArrayItem(current, mode))}
          />
          <SkillMatrixTable
            aggregates={filteredAggregates}
            loading={aggregatesQuery.isLoading}
            error={aggregatesQuery.error as Error | null}
            selectedName={selectedAggregate?.name ?? null}
            summaries={summaries}
            onSelect={setSelectedSkillName}
          />
          <SkillMatrixDetail
            aggregate={selectedAggregate}
            summaries={summaries}
          />
        </div>
      </main>
    </div>
  );
}

function SkillMatrixToolbar({
  total,
  issues,
  refreshing,
  onRefresh,
}: {
  total: number;
  issues: number;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <header className="agents-header">
      <div>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[var(--color-primary)]" strokeWidth={1.8} />
          <h1 className="font-display text-[22px] font-semibold tracking-tight">{t('platformSkills.matrixTitle')}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
          {t('platformSkills.matrixDescription')}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Pill>{t('platformSkills.uniqueSkills', { count: total })}</Pill>
        <Pill>{t('platformSkills.issueCount', { count: issues })}</Pill>
        <Button type="button" size="sm" variant="ghost" aria-label={t('common.refresh')} onClick={onRefresh}>
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </header>
  );
}

function SkillMatrixFilters({
  searchQuery,
  statusFilter,
  providerFilters,
  installModeFilter,
  onSearchChange,
  onStatusChange,
  onProviderToggle,
  onInstallModeToggle,
}: {
  searchQuery: string;
  statusFilter: MatrixStatusFilter;
  providerFilters: PlatformSkillProvider[];
  installModeFilter: PlatformSkillInstallMode[];
  onSearchChange: (value: string) => void;
  onStatusChange: (value: MatrixStatusFilter) => void;
  onProviderToggle: (provider: PlatformSkillProvider) => void;
  onInstallModeToggle: (mode: PlatformSkillInstallMode) => void;
}): JSX.Element {
  const { t } = useI18n();
  const statusOptions: Array<{ value: MatrixStatusFilter; label: MessageKey }> = [
    { value: 'all', label: 'platformSkills.filterAll' },
    { value: 'missing', label: 'platformSkills.filterMissing' },
    { value: 'issues', label: 'platformSkills.filterIssues' },
  ];

  return (
    <aside className="min-h-0 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-fg-muted)]" />
        <Input
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t('platformSkills.searchAllPlaceholder')}
          className="h-8 pl-8 text-[12px]"
        />
      </div>

      <div className="mt-3 space-y-2">
        <Label>{t('platformSkills.health')}</Label>
        <div className="grid gap-1">
          {statusOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={statusFilter === option.value}
              className={cn(
                'h-8 rounded-md px-2 text-left text-[12px] font-medium transition-colors ease-ocean',
                statusFilter === option.value
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
              )}
              onClick={() => onStatusChange(option.value)}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <Label>{t('platformSkills.platforms')}</Label>
        <div className="grid gap-1">
          {PROVIDERS.map((provider) => (
            <TogglePill
              key={provider}
              active={providerFilters.includes(provider)}
              onClick={() => onProviderToggle(provider)}
            >
              {providerLabel(provider)}
            </TogglePill>
          ))}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <Label>{t('platformSkills.installMode')}</Label>
        <div className="grid gap-1">
          {INSTALL_MODES.map((mode) => (
            <TogglePill
              key={mode}
              active={installModeFilter.includes(mode)}
              onClick={() => onInstallModeToggle(mode)}
            >
              {installModeLabel(mode, t)}
            </TogglePill>
          ))}
        </div>
      </div>
    </aside>
  );
}

function SkillMatrixTable({
  aggregates,
  loading,
  error,
  selectedName,
  summaries,
  onSelect,
}: {
  aggregates: PlatformSkillAggregate[];
  loading: boolean;
  error: Error | null;
  selectedName: string | null;
  summaries: PlatformSkillSummary[];
  onSelect: (name: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (loading) return <Panel><LoadingLine label={t('common.loading')} /></Panel>;
  if (error) return <Panel><ErrorBox>{error.message}</ErrorBox></Panel>;
  if (aggregates.length === 0) return <Panel><EmptyBox>{t('platformSkills.noAggregates')}</EmptyBox></Panel>;

  return (
    <section className="min-h-0 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2">
      <div className="min-w-[560px]">
        <div className="sticky top-0 z-10 grid grid-cols-[minmax(190px,1.1fr)_minmax(260px,1.2fr)_92px] gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 pb-2 text-[10px] font-semibold uppercase text-[var(--color-fg-muted)]">
          <div>Skill</div>
          <div>{t('platformSkills.platforms')}</div>
          <div>{t('platformSkills.health')}</div>
        </div>
        <div className="space-y-1 pt-2">
          {aggregates.map((aggregate) => {
            const selected = selectedName === aggregate.name;
            return (
              <button
                key={aggregate.name}
                type="button"
                className={cn(
                  'grid min-h-[46px] w-full grid-cols-[minmax(190px,1.1fr)_minmax(260px,1.2fr)_92px] items-center gap-2 rounded-md border p-2 text-left transition-colors ease-ocean',
                  selected
                    ? 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]',
                )}
                onClick={() => onSelect(aggregate.name)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-[var(--color-fg)]">{aggregate.displayName}</span>
                  <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-[var(--color-fg-muted)]">
                    {aggregate.description ?? aggregate.name}
                  </span>
                </span>
                <span className="grid min-w-0 grid-cols-3 gap-1">
                  {PROVIDERS.map((provider) => (
                    <SkillPlatformCell
                      key={provider}
                      provider={provider}
                      skill={aggregate.installations[provider]}
                      summary={summaries.find((item) => item.provider === provider) ?? null}
                    />
                  ))}
                </span>
                <span>
                  {aggregate.valid ? (
                    <Pill><CheckCircle2 className="h-3 w-3 text-[var(--color-success)]" />{t('platformSkills.valid')}</Pill>
                  ) : (
                    <Pill><AlertTriangle className="h-3 w-3 text-[var(--color-danger)]" />{aggregate.issues.length}</Pill>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function SkillPlatformCell({
  provider,
  skill,
  summary,
}: {
  provider: PlatformSkillProvider;
  skill?: PlatformSkill;
  summary: PlatformSkillSummary | null;
}): JSX.Element {
  const { t } = useI18n();
  const label = summary?.label ?? providerLabel(provider);
  if (!skill) {
    return (
      <span className="min-w-0 rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-fg-muted)]">
        <span className="block truncate font-medium">{label}</span>
        <span className="block truncate">{t('platformSkills.missing')}</span>
      </span>
    );
  }

  return (
    <span className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-[11px]">
      <span className="flex min-w-0 items-center gap-1">
        {skill.valid ? (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-[var(--color-success)]" />
        ) : (
          <AlertTriangle className="h-3 w-3 shrink-0 text-[var(--color-danger)]" />
        )}
        <span className="truncate font-medium text-[var(--color-fg)]">{label}</span>
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-[var(--color-fg-muted)]">
        {skill.installMode === 'symlink' ? <Link2 className="h-2.5 w-2.5 shrink-0" /> : null}
        <span className="truncate">{installModeLabel(skill.installMode, t)}</span>
      </span>
    </span>
  );
}

function SkillMatrixDetail({
  aggregate,
  summaries,
}: {
  aggregate: PlatformSkillAggregate | null;
  summaries: PlatformSkillSummary[];
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="min-h-0 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
      <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">{t('platformSkills.detailsTitle')}</h4>
      {!aggregate ? (
        <div className="mt-3"><EmptyBox>{t('platformSkills.noSelection')}</EmptyBox></div>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[16px] font-semibold text-[var(--color-fg)]">{aggregate.displayName}</div>
                <div className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
                  {aggregate.description ?? t('common.none')}
                </div>
              </div>
              {aggregate.valid ? (
                <Pill><CheckCircle2 className="h-3 w-3 text-[var(--color-success)]" />{t('platformSkills.valid')}</Pill>
              ) : (
                <Pill><AlertTriangle className="h-3 w-3 text-[var(--color-danger)]" />{t('platformSkills.issueCount', { count: aggregate.issues.length })}</Pill>
              )}
            </div>
          </div>

          {PROVIDERS.map((provider) => {
            const skill = aggregate.installations[provider];
            return (
              <div key={provider} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[12px] font-semibold text-[var(--color-fg)]">{platformLabel(provider, summaries)}</div>
                  {skill ? (
                    skill.valid ? (
                      <Pill><CheckCircle2 className="h-3 w-3 text-[var(--color-success)]" />{t('platformSkills.valid')}</Pill>
                    ) : (
                      <Pill><AlertTriangle className="h-3 w-3 text-[var(--color-danger)]" />{t('platformSkills.invalid')}</Pill>
                    )
                  ) : (
                    <Pill>{t('platformSkills.missing')}</Pill>
                  )}
                </div>
                {skill ? (
                  <div className="mt-2 space-y-1.5">
                    <MetadataRow label={t('platformSkills.installMode')} value={installModeLabel(skill.installMode, t)} />
                    <MetadataRow label={t('platformSkills.path')} value={skill.path} />
                    <MetadataRow label={t('platformSkills.manifestPath')} value={skill.manifestPath ?? t('common.none')} />
                    <MetadataRow label={t('platformSkills.sourceLabel')} value={skill.sourceLabel ?? t('common.none')} />
                    <MetadataRow label={t('platformSkills.version')} value={skill.version ?? t('common.none')} />
                    <MetadataRow
                      label={t('platformSkills.lastModified')}
                      value={skill.lastModifiedAt ? new Date(skill.lastModifiedAt).toLocaleString() : t('common.none')}
                    />
                    <MetadataRow label={t('platformSkills.status')} value={skill.valid ? t('platformSkills.valid') : t('platformSkills.invalid')} />
                    {skill.issues.length > 0 ? <ErrorBox>{skill.issues.join(' · ')}</ErrorBox> : null}
                  </div>
                ) : null}
              </div>
            );
          })}

          {aggregate.issues.length > 0 ? (
            <ErrorBox>
              {aggregate.issues.map((issue) => `${providerLabel(issue.provider)}: ${issue.message}`).join(' · ')}
            </ErrorBox>
          ) : null}
        </div>
      )}
    </section>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="grid gap-1 text-[12px] sm:grid-cols-[92px_minmax(0,1fr)]">
      <div className="text-[var(--color-fg-muted)]">{label}</div>
      <div className="min-w-0 break-words font-mono text-[11px] text-[var(--color-fg-muted)]">{value}</div>
    </div>
  );
}

function LoadingLine({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex min-h-[96px] items-center justify-center text-[12px] text-[var(--color-fg-muted)]">
      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
      {label}
    </div>
  );
}

function EmptyBox({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[12px] text-[var(--color-fg-muted)]">
      {children}
    </div>
  );
}

function ErrorBox({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-md border border-[var(--color-danger)]/35 bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] p-3 text-[12px] text-[var(--color-danger)]">
      {children}
    </div>
  );
}

function Panel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <section className="min-h-0 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
      {children}
    </section>
  );
}

function Pill({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex max-w-full items-center gap-1 truncate rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
      {children}
    </span>
  );
}

function TogglePill({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'min-h-8 rounded-md px-2 text-left text-[11px] font-medium transition-colors ease-ocean',
        active
          ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
          : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function toggleArrayItem<T>(items: T[], item: T): T[] {
  return items.includes(item) ? items.filter((value) => value !== item) : [...items, item];
}

function providerLabel(provider: PlatformSkillProvider): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claudecode') return 'Claude Code';
  return 'OpenCode';
}

function platformLabel(provider: PlatformSkillProvider, summaries: PlatformSkillSummary[]): string {
  return summaries.find((item) => item.provider === provider)?.label ?? providerLabel(provider);
}

function installModeLabel(installMode: PlatformSkillInstallMode, t: (key: MessageKey) => string): string {
  if (installMode === 'copy') return t('platformSkills.installModeCopy');
  if (installMode === 'symlink') return t('platformSkills.installModeSymlink');
  return t('platformSkills.installModeUnknown');
}
