import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCcw, Save, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { Skill, SkillUpdateApplyMode, SkillUpdateCheckMode, SkillsShUpdateResult } from '../lib/types';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Label } from './ui/Input';

const CHECK_MODES: SkillUpdateCheckMode[] = ['off', 'startup', 'manual'];
const APPLY_MODES: SkillUpdateApplyMode[] = ['prompt'];

export function SkillUpdateSettingsPanel({
  skill,
}: {
  skill: Skill | null;
}): JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [checkMode, setCheckMode] = useState<SkillUpdateCheckMode>('startup');
  const [applyMode, setApplyMode] = useState<SkillUpdateApplyMode>('prompt');
  const [latestCheck, setLatestCheck] = useState<SkillsShUpdateResult | null>(null);

  useEffect(() => {
    setCheckMode(skill?.update_check_mode ?? 'startup');
    setApplyMode(skill?.update_apply_mode ?? 'prompt');
    setLatestCheck(null);
  }, [skill?.id, skill?.update_apply_mode, skill?.update_check_mode]);

  const save = useMutation({
    mutationFn: () => {
      if (!skill) throw new Error(t('settings.skillsUpdateSelectRequired'));
      return api.updateSkill(skill.id, {
        update_check_mode: checkMode,
        update_apply_mode: applyMode,
      });
    },
    onSuccess: async () => {
      toast.success(t('settings.skillsUpdateSettingsSaved'));
      await queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const check = useMutation({
    mutationFn: () => {
      if (!skill) throw new Error(t('settings.skillsUpdateSelectRequired'));
      return api.checkSkillUpdate(skill.id);
    },
    onSuccess: async (result) => {
      setLatestCheck(result);
      toast.success(
        result.hasUpdate
          ? t('settings.skillsUpdateCheckHasUpdate', { version: result.availableVersion ?? result.availableRevision ?? t('common.none') })
          : t('settings.skillsUpdateCheckCurrent'),
      );
      await queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const isSkillsSh = skill?.source_type === 'skills_sh';
  const dirty = Boolean(skill && (
    checkMode !== skill.update_check_mode ||
    applyMode !== skill.update_apply_mode
  ));
  const updateSummary = useMemo(() => summarizeUpdate(skill, latestCheck, t), [latestCheck, skill, t]);

  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
            <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">
              {t('settings.skillsUpdateSettingsTitle')}
            </h4>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            {skill ? t('settings.skillsUpdateSettingsFor', { name: skill.name }) : t('settings.skillsUpdateSelectRequired')}
          </p>
        </div>
      </div>

      {!skill ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[12px] text-[var(--color-fg-muted)]">
          {t('settings.skillsNoResults')}
        </div>
      ) : (
        <div className="space-y-3">
          <SegmentedControl
            label={t('settings.skillsUpdateCheckMode')}
            values={CHECK_MODES}
            value={checkMode}
            disabled={!isSkillsSh}
            labelFor={(value) => updateCheckModeLabel(value, t)}
            onChange={setCheckMode}
          />
          <SegmentedControl
            label={t('settings.skillsUpdateApplyMode')}
            values={APPLY_MODES}
            value={applyMode}
            disabled={!isSkillsSh}
            labelFor={(value) => updateApplyModeLabel(value, t)}
            onChange={setApplyMode}
          />
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[12px] text-[var(--color-fg-muted)]">
            <div>{t('settings.skillsUpdateStatus')}: {updateSummary.status}</div>
            <div className="mt-1">
              {t('settings.skillsPackageVersion')}: {skill.package_version ?? t('common.none')}
              {skill.package_revision ? ` / ${skill.package_revision}` : ''}
            </div>
            <div className="mt-1">
              {t('settings.skillsUpdateAvailableVersion')}: {updateSummary.available}
            </div>
            <div className="mt-1">
              {t('settings.skillsLastUpdateCheck')}: {updateSummary.checkedAt}
            </div>
          </div>
          {!isSkillsSh && (
            <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
              {t('settings.skillsUpdateOnlySkillsSh')}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={!isSkillsSh || check.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              {t('settings.skillsUpdateCheckNow')}
            </Button>
            <Button
              type="button"
              disabled={!isSkillsSh || save.isPending || !dirty}
              onClick={() => save.mutate()}
            >
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function SegmentedControl<T extends string>({
  label,
  values,
  value,
  disabled,
  labelFor,
  onChange,
}: {
  label: string;
  values: T[];
  value: T;
  disabled: boolean;
  labelFor: (value: T) => string;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1.5 grid gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 sm:grid-cols-4">
        {values.map((item) => (
          <button
            key={item}
            type="button"
            disabled={disabled}
            className={cn(
              'h-8 rounded-[5px] px-2 text-[12px] font-medium transition-colors ease-ocean disabled:cursor-not-allowed disabled:opacity-50',
              value === item
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-primary)] shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
            )}
            onClick={() => onChange(item)}
          >
            {labelFor(item)}
          </button>
        ))}
      </div>
    </div>
  );
}

function summarizeUpdate(
  skill: Skill | null,
  latestCheck: SkillsShUpdateResult | null,
  t: ReturnType<typeof useI18n>['t'],
): { status: string; available: string; checkedAt: string } {
  if (!skill) {
    return { status: t('common.none'), available: t('common.none'), checkedAt: t('common.none') };
  }
  const availableVersion = latestCheck?.availableVersion ?? skill.available_version;
  const availableRevision = latestCheck?.availableRevision ?? skill.available_revision;
  const checkedAt = latestCheck?.checkedAt ?? skill.last_update_checked_at;
  const hasUpdate = latestCheck?.hasUpdate ?? hasAvailableUpdate(skill, availableVersion, availableRevision);
  return {
    status: hasUpdate
      ? t('settings.skillsUpdateAvailable', { version: availableVersion ?? availableRevision ?? t('common.none') })
      : checkedAt ? t('settings.skillsUpdateCurrent') : t('settings.skillsUpdateUnknown'),
    available: [availableVersion, availableRevision].filter(Boolean).join(' / ') || t('common.none'),
    checkedAt: checkedAt ? new Date(checkedAt).toLocaleString() : t('common.none'),
  };
}

function hasAvailableUpdate(skill: Skill, version: string | null, revision: string | null): boolean {
  if (version !== null && version !== skill.package_version) return true;
  if (revision !== null && revision !== skill.package_revision) return true;
  return false;
}

function updateCheckModeLabel(mode: SkillUpdateCheckMode, t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<SkillUpdateCheckMode, string> = {
    off: t('settings.skillsUpdateCheckOff'),
    startup: t('settings.skillsUpdateCheckStartup'),
    manual: t('settings.skillsUpdateCheckManual'),
  };
  return labels[mode];
}

function updateApplyModeLabel(mode: SkillUpdateApplyMode, t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<SkillUpdateApplyMode, string> = {
    prompt: t('settings.skillsUpdateApplyPrompt'),
  };
  return labels[mode];
}
