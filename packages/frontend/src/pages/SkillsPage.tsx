import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderInput,
  Link2,
  Loader2,
  RefreshCcw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/Button';
import { Input, Label } from '../components/ui/Input';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type {
  PlatformSkill,
  PlatformSkillInstallMode,
  PlatformSkillProvider,
  PlatformSkillSummary,
  SkillsShSearchResult,
} from '../lib/types';
import { cn } from '../lib/utils';

const PROVIDERS: PlatformSkillProvider[] = ['codex', 'claudecode', 'opencode'];

export function SkillsPage(): JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [activeProvider, setActiveProvider] = useState<PlatformSkillProvider>('codex');
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [targets, setTargets] = useState<PlatformSkillProvider[]>(['codex']);
  const [installMode, setInstallMode] = useState<Exclude<PlatformSkillInstallMode, 'unknown'>>('copy');

  const summariesQuery = useQuery({
    queryKey: ['platform-skills', 'platforms'],
    queryFn: api.listPlatformSkillSummaries,
  });
  const skillsQuery = useQuery({
    queryKey: ['platform-skills', activeProvider],
    queryFn: () => api.listPlatformSkills(activeProvider),
  });
  const search = useMutation({
    mutationFn: api.searchPlatformSkillMarketplace,
    onError: (err) => toast.error((err as Error).message),
  });
  const install = useMutation({
    mutationFn: (installLabel: string) => api.installPlatformSkill({ installLabel, targets, installMode }),
    onSuccess: async (installed) => {
      toast.success(t('platformSkills.installSuccess', { count: installed.length }));
      const first = installed[0] ?? null;
      setActiveProvider(first?.provider ?? activeProvider);
      setSelectedSkillName(first?.name ?? null);
      await invalidatePlatformSkills(queryClient);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const importLocal = useMutation({
    mutationFn: () => api.importLocalPlatformSkill({ path: localPath.trim(), targets, installMode }),
    onSuccess: async (installed) => {
      toast.success(t('platformSkills.installSuccess', { count: installed.length }));
      setLocalPath('');
      const first = installed[0] ?? null;
      setActiveProvider(first?.provider ?? activeProvider);
      setSelectedSkillName(first?.name ?? null);
      await invalidatePlatformSkills(queryClient);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const deleteSkill = useMutation({
    mutationFn: (skill: PlatformSkill) => api.deletePlatformSkill(skill.provider, skill.name),
    onSuccess: async (_value, skill) => {
      toast.success(t('platformSkills.deleteSuccess', { name: skill.name }));
      setSelectedSkillName(null);
      await invalidatePlatformSkills(queryClient);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const summaries = summariesQuery.data ?? [];
  const skills = skillsQuery.data ?? [];
  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.name === selectedSkillName) ?? skills[0] ?? null,
    [selectedSkillName, skills],
  );
  const activeSummary = summaries.find((item) => item.provider === activeProvider) ?? null;

  function toggleTarget(provider: PlatformSkillProvider): void {
    setTargets((current) => {
      if (current.includes(provider)) {
        if (current.length === 1) return current;
        return current.filter((item) => item !== provider);
      }
      return [...current, provider];
    });
  }

  return (
    <div className="files-page">
      <header className="agents-header">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-[var(--color-primary)]" strokeWidth={1.8} />
            <h1 className="font-display text-[22px] font-semibold tracking-tight">{t('platformSkills.title')}</h1>
          </div>
          <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
            {t('platformSkills.description')}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t('common.refresh')}
          onClick={async () => {
            await invalidatePlatformSkills(queryClient);
            toast.success(t('platformSkills.refreshDone'));
          }}
        >
          <RefreshCcw className="h-3.5 w-3.5" />
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.85fr)]">
          <div className="min-w-0 space-y-4">
            <PlatformTabs
              activeProvider={activeProvider}
              summaries={summaries}
              onSelect={(provider) => {
                setActiveProvider(provider);
                setSelectedSkillName(null);
              }}
            />

            <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
              <div className="mb-3">
                <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">{t('platformSkills.marketplaceTitle')}</h4>
                <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">{t('platformSkills.marketplaceDescription')}</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') search.mutate(query);
                  }}
                  placeholder={t('platformSkills.searchPlaceholder')}
                />
                <Button type="button" disabled={search.isPending} onClick={() => search.mutate(query)}>
                  {search.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  {t('settings.skillsMarketplaceSearch')}
                </Button>
              </div>
              <div className="mt-3 max-h-[260px] space-y-2 overflow-y-auto pr-1">
                {search.isPending ? (
                  <LoadingLine label={t('common.loading')} />
                ) : (search.data ?? []).length === 0 ? (
                  <EmptyBox>{search.data ? t('platformSkills.marketplaceNoResults') : t('settings.skillsMarketplaceEmpty')}</EmptyBox>
                ) : (
                  (search.data ?? []).map((item) => (
                    <MarketplaceRow
                      key={item.id}
                      result={item}
                      installing={install.isPending && install.variables === item.installLabel}
                      onInstall={() => install.mutate(item.installLabel)}
                    />
                  ))
                )}
              </div>
            </section>

            <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div>
                  <Label>{t('platformSkills.targets')}</Label>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {PROVIDERS.map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        className={cn(
                          'h-7 rounded-full px-2.5 text-[11px] font-medium transition-colors ease-ocean',
                          targets.includes(provider)
                            ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                            : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)]',
                        )}
                        onClick={() => toggleTarget(provider)}
                      >
                        {platformLabel(provider, summaries)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label>{t('platformSkills.installMode')}</Label>
                  <details className="mt-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
                    <summary className="cursor-pointer text-[12px] font-medium text-[var(--color-fg-muted)]">
                      {t('platformSkills.advancedOptions')}
                    </summary>
                    <div className="mt-2 space-y-2">
                      <div className="grid grid-cols-2 gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1">
                        {(['copy', 'symlink'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            className={cn(
                              'h-8 rounded-[5px] px-2 text-[12px] font-medium transition-colors ease-ocean',
                              installMode === mode
                                ? 'bg-[var(--color-surface)] text-[var(--color-primary)] shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                                : 'text-[var(--color-fg-muted)]',
                            )}
                            onClick={() => setInstallMode(mode)}
                          >
                            {mode === 'copy' ? t('platformSkills.installModeCopy') : t('platformSkills.installModeSymlink')}
                          </button>
                        ))}
                      </div>
                      <div className="rounded-md border border-[var(--color-warning,#d97706)]/30 bg-[var(--color-surface-raised)] p-2 text-[11px] text-[var(--color-fg-muted)]">
                        {t('platformSkills.symlinkRisk')}
                      </div>
                    </div>
                  </details>
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input
                  value={localPath}
                  onChange={(event) => setLocalPath(event.target.value)}
                  placeholder={t('platformSkills.localPathPlaceholder')}
                  className="font-mono"
                />
                <Button
                  type="button"
                  disabled={importLocal.isPending || !localPath.trim() || targets.length === 0}
                  onClick={() => importLocal.mutate()}
                >
                  {importLocal.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderInput className="h-3.5 w-3.5" />}
                  {t('platformSkills.importLocal')}
                </Button>
              </div>
            </section>

            <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
              <div className="mb-3">
                <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">{t('platformSkills.installedTitle')}</h4>
                <p className="mt-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
                  {t('platformSkills.root')}: {activeSummary?.root ?? ''}
                </p>
              </div>
              {skillsQuery.isLoading ? (
                <LoadingLine label={t('common.loading')} />
              ) : skills.length === 0 ? (
                <EmptyBox>{t('platformSkills.empty')}</EmptyBox>
              ) : (
                <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                  {skills.map((skill) => (
                    <button
                      key={`${skill.provider}:${skill.name}`}
                      type="button"
                      className={cn(
                        'block w-full rounded-md border p-2.5 text-left transition-colors ease-ocean',
                        selectedSkill?.name === skill.name
                          ? 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
                          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]',
                      )}
                      onClick={() => setSelectedSkillName(skill.name)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-semibold text-[var(--color-fg)]">{skill.name}</div>
                          <div className="mt-1 line-clamp-2 text-[11px] text-[var(--color-fg-muted)]">{skill.description ?? skill.path}</div>
                        </div>
                        {skill.valid ? (
                          <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 text-[var(--color-danger)]" />
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Pill>{skill.installMode === 'copy' ? t('platformSkills.installModeCopy') : t('platformSkills.installModeSymlink')}</Pill>
                        {skill.version ? <Pill>v{skill.version}</Pill> : null}
                        {skill.installMode === 'symlink' ? (
                          <Pill>
                            <Link2 className="h-2.5 w-2.5" />
                            symlink
                          </Pill>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
          <section className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
            <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">{t('platformSkills.detailsTitle')}</h4>
            {!selectedSkill ? (
              <EmptyBox>{t('platformSkills.noSelection')}</EmptyBox>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[16px] font-semibold text-[var(--color-fg)]">{selectedSkill.name}</div>
                    <div className="mt-1 text-[12px] text-[var(--color-fg-muted)]">{selectedSkill.description ?? t('common.none')}</div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={deleteSkill.isPending}
                    onClick={() => {
                      const label = platformLabel(selectedSkill.provider, summaries);
                      if (window.confirm(t('platformSkills.deleteConfirm', { name: selectedSkill.name, platform: label }))) {
                        deleteSkill.mutate(selectedSkill);
                      }
                    }}
                  >
                    {deleteSkill.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    {t('common.delete')}
                  </Button>
                </div>

                <MetadataRow label="Provider" value={platformLabel(selectedSkill.provider, summaries)} />
                <MetadataRow
                  label={t('platformSkills.installMode')}
                  value={selectedSkill.installMode === 'copy' ? t('platformSkills.installModeCopy') : (
                    selectedSkill.installMode === 'symlink' ? t('platformSkills.installModeSymlink') : selectedSkill.installMode
                  )}
                />
                <MetadataRow label={t('platformSkills.path')} value={selectedSkill.path} />
                <MetadataRow label={t('platformSkills.manifestPath')} value={selectedSkill.manifestPath ?? t('common.none')} />
                <MetadataRow label={t('platformSkills.sourceLabel')} value={selectedSkill.sourceLabel ?? t('common.none')} />
                <MetadataRow label={t('platformSkills.version')} value={selectedSkill.version ?? t('common.none')} />
                <MetadataRow
                  label={t('platformSkills.lastModified')}
                  value={selectedSkill.lastModifiedAt ? new Date(selectedSkill.lastModifiedAt).toLocaleString() : t('common.none')}
                />
                <MetadataRow
                  label={t('platformSkills.status')}
                  value={selectedSkill.valid ? t('platformSkills.valid') : t('platformSkills.invalid')}
                />
                {selectedSkill.issues.length > 0 ? (
                  <div className="rounded-md border border-[var(--color-danger)]/35 bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] p-2 text-[12px] text-[var(--color-danger)]">
                    {selectedSkill.issues.join(' · ')}
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function PlatformTabs({
  activeProvider,
  summaries,
  onSelect,
}: {
  activeProvider: PlatformSkillProvider;
  summaries: PlatformSkillSummary[];
  onSelect: (provider: PlatformSkillProvider) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="grid gap-2 md:grid-cols-3">
      {PROVIDERS.map((provider) => {
        const summary = summaries.find((item) => item.provider === provider);
        const active = provider === activeProvider;
        const issueKey = !summary?.rootExists
          ? 'platformSkills.rootMissing'
          : !summary?.rootWritable
            ? 'platformSkills.rootNotWritable'
            : 'platformSkills.rootHealthy';
        return (
          <button
            key={provider}
            type="button"
            className={cn(
              'rounded-md border p-3 text-left transition-colors ease-ocean',
              active
                ? 'border-[var(--color-border-strong)] bg-[var(--color-surface-raised)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]',
            )}
            onClick={() => onSelect(provider)}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-[var(--color-fg)]">{summary?.label ?? provider}</div>
              <Pill>{summary?.installedCount ?? 0}</Pill>
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">{summary?.root ?? '-'}</div>
            <div className="mt-1 text-[10px] text-[var(--color-fg-muted)]">{t(issueKey)}</div>
          </button>
        );
      })}
    </div>
  );
}

function MarketplaceRow({
  result,
  installing,
  onInstall,
}: {
  result: SkillsShSearchResult;
  installing: boolean;
  onInstall: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[var(--color-fg)]">{result.name}</div>
          <div className="mt-1 line-clamp-2 text-[11px] text-[var(--color-fg-muted)]">{result.description ?? result.installLabel}</div>
          <div className="mt-2 truncate font-mono text-[10px] text-[var(--color-fg-muted)]">{result.installLabel}</div>
        </div>
        <Button type="button" size="sm" disabled={installing} onClick={onInstall}>
          {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {t('platformSkills.install')}
        </Button>
      </div>
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="grid gap-1 text-[12px] sm:grid-cols-[96px_minmax(0,1fr)]">
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

function EmptyBox({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[12px] text-[var(--color-fg-muted)]">
      {children}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span className="inline-flex max-w-full items-center gap-1 truncate rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
      {children}
    </span>
  );
}

function platformLabel(provider: PlatformSkillProvider, summaries: PlatformSkillSummary[]): string {
  return summaries.find((item) => item.provider === provider)?.label ?? provider;
}

async function invalidatePlatformSkills(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['platform-skills'] });
}
