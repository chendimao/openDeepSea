import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Search, Store } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { SkillsShSearchResult } from '../lib/types';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

export function SkillMarketplacePanel({
  onInstalled,
}: {
  onInstalled?: (skillId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const installedSkillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: api.listSkills,
  });
  const search = useMutation({
    mutationFn: (value: string) => api.searchSkillMarketplace(value),
    onError: (err) => toast.error((err as Error).message),
  });
  const install = useMutation({
    mutationFn: (installLabel: string) => api.importSkillsShSkill(installLabel),
    onSuccess: async (skill) => {
      let systemBindingEnabled = true;
      try {
        await api.upsertSkillBinding({
          skill_id: skill.id,
          scope: 'system',
          scope_id: 'default',
          enabled: true,
        });
      } catch (err) {
        systemBindingEnabled = false;
        toast.error(t('settings.skillsSystemBindingFailed', { message: (err as Error).message }));
      }
      toast.success(t(
        systemBindingEnabled ? 'settings.skillsImportAndBindSuccess' : 'settings.skillsImportSuccess',
        { name: skill.name },
      ));
      onInstalled?.(skill.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
        queryClient.invalidateQueries({ queryKey: ['skills', 'bindings'] }),
      ]);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const installedLabels = new Set(
    (installedSkillsQuery.data ?? [])
      .filter((skill) => skill.source_type === 'skills_sh')
      .map((skill) => skill.install_source_label ?? skill.source_uri?.replace(/^skills\.sh\//, '') ?? '')
      .filter(Boolean),
  );
  const results = search.data ?? [];

  function runSearch(): void {
    search.mutate(query);
  }

  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Store className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
            <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">
              {t('settings.skillsMarketplaceTitle')}
            </h4>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            {t('settings.skillsMarketplaceDescription')}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') runSearch();
          }}
          placeholder={t('settings.skillsMarketplaceSearchPlaceholder')}
        />
        <Button type="button" disabled={search.isPending} onClick={runSearch}>
          {search.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          {t('settings.skillsMarketplaceSearch')}
        </Button>
      </div>

      <div className="mt-3 max-h-[320px] space-y-2 overflow-y-auto pr-1">
        {search.isPending ? (
          <div className="flex min-h-[96px] items-center justify-center text-[12px] text-[var(--color-fg-muted)]">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            {t('common.loading')}
          </div>
        ) : results.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[12px] text-[var(--color-fg-muted)]">
            {search.data ? t('settings.skillsMarketplaceNoResults') : t('settings.skillsMarketplaceEmpty')}
          </div>
        ) : (
          results.map((result) => (
            <MarketplaceResult
              key={result.id}
              result={result}
              installed={installedLabels.has(result.installLabel)}
              installing={install.isPending && install.variables === result.installLabel}
              onInstall={() => install.mutate(result.installLabel)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function MarketplaceResult({
  result,
  installed,
  installing,
  onInstall,
}: {
  result: SkillsShSearchResult;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[var(--color-fg)]">{result.name}</div>
          <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
            {result.description ?? result.installLabel}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            <Tag>{result.installLabel}</Tag>
            {result.version && <Tag>v{result.version}</Tag>}
            {result.revision && <Tag>{result.revision}</Tag>}
            {result.installs !== null && <Tag>{t('settings.skillsMarketplaceInstalls', { count: result.installs })}</Tag>}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={installed ? 'secondary' : 'primary'}
          disabled={installed || installing}
          onClick={onInstall}
          className={cn(installed && 'min-w-[72px]')}
        >
          {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {installed ? t('settings.skillsMarketplaceInstalled') : t('settings.skillsMarketplaceInstall')}
        </Button>
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span className="max-w-full truncate rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
      {children}
    </span>
  );
}
