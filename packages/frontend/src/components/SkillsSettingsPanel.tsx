import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Eye,
  FolderInput,
  Loader2,
  Power,
  RefreshCcw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { Skill, SkillBinding, SkillRuntimeScope, SkillTriggerMode } from '../lib/types';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Input, Label, Textarea } from './ui/Input';

const RUNTIME_SCOPES: SkillRuntimeScope[] = ['planner', 'model_chat', 'workflow', 'memory', 'review'];
const TRIGGER_MODES: SkillTriggerMode[] = ['manual', 'keyword', 'always_for_scope'];

export function SkillsSettingsPanel(): JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [localPath, setLocalPath] = useState('');
  const [previewScopes, setPreviewScopes] = useState<SkillRuntimeScope[]>(['planner']);
  const [previewMessage, setPreviewMessage] = useState('');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: api.listSkills,
  });
  const bindingsQuery = useQuery({
    queryKey: ['skills', 'bindings', 'system'],
    queryFn: () => api.listSkillBindings({ scope: 'system', scopeId: 'default' }),
  });
  const preview = useMutation({
    mutationFn: () => api.previewSkillSelection({
      runtimeScopes: previewScopes,
      message: previewMessage,
      skillIds: selectedSkillId ? [selectedSkillId] : undefined,
    }),
    onError: (err) => toast.error((err as Error).message),
  });
  const importSkill = useMutation({
    mutationFn: api.importLocalSkill,
    onSuccess: async (skill) => {
      setLocalPath('');
      toast.success(t('settings.skillsImportSuccess', { name: skill.name }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
        queryClient.invalidateQueries({ queryKey: ['skills', 'bindings'] }),
      ]);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const updateSkill = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.updateSkill>[1] }) =>
      api.updateSkill(id, patch),
    onSuccess: async () => {
      toast.success(t('settings.skillsSaved'));
      await queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const deleteSkill = useMutation({
    mutationFn: api.deleteSkill,
    onSuccess: async () => {
      setSelectedSkillId(null);
      toast.success(t('settings.skillsDeleted'));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
        queryClient.invalidateQueries({ queryKey: ['skills', 'bindings'] }),
      ]);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const upsertBinding = useMutation({
    mutationFn: api.upsertSkillBinding,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['skills', 'bindings'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const skills = skillsQuery.data ?? [];
  const bindings = bindingsQuery.data ?? [];
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? skills[0] ?? null;

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">{t('settings.skillsImportLocal')}</h4>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              {t('settings.skillsImportLocalDescription')}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              skillsQuery.refetch();
              bindingsQuery.refetch();
            }}
            aria-label={t('common.refresh')}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={localPath}
            onChange={(event) => setLocalPath(event.target.value)}
            placeholder={t('settings.skillsImportPathPlaceholder')}
            className="font-mono"
          />
          <Button
            type="button"
            disabled={importSkill.isPending || !localPath.trim()}
            onClick={() => importSkill.mutate(localPath.trim())}
          >
            {importSkill.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderInput className="h-3.5 w-3.5" />}
            {t('settings.skillsImport')}
          </Button>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">{t('settings.skillsInstalled')}</h4>
              <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
                {t('settings.skillsCount', { count: skills.length })}
              </p>
            </div>
          </div>
          {skillsQuery.isLoading ? (
            <div className="flex min-h-[160px] items-center justify-center text-[12px] text-[var(--color-fg-muted)]">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              {t('common.loading')}
            </div>
          ) : skills.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[12px] text-[var(--color-fg-muted)]">
              {t('settings.skillsNoResults')}
            </div>
          ) : (
            <div className="max-h-[430px] space-y-2 overflow-y-auto pr-1">
              {skills.map((skill) => (
                <SkillListItem
                  key={skill.id}
                  skill={skill}
                  selected={selectedSkill?.id === skill.id}
                  binding={bindings.find((binding) => binding.skill_id === skill.id)}
                  onSelect={() => setSelectedSkillId(skill.id)}
                  onToggleEnabled={() => updateSkill.mutate({
                    id: skill.id,
                    patch: { enabled: skill.enabled !== 1 },
                  })}
                  onToggleSystemBinding={(enabled) => upsertBinding.mutate({
                    skill_id: skill.id,
                    scope: 'system',
                    scope_id: 'default',
                    enabled,
                  })}
                  t={t}
                />
              ))}
            </div>
          )}
        </section>

        <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
          {selectedSkill ? (
            <SkillDetail
              key={selectedSkill.id}
              skill={selectedSkill}
              binding={bindings.find((binding) => binding.skill_id === selectedSkill.id)}
              isSaving={updateSkill.isPending}
              isDeleting={deleteSkill.isPending}
              onSave={(patch) => updateSkill.mutate({ id: selectedSkill.id, patch })}
              onDelete={() => deleteSkill.mutate(selectedSkill.id)}
            />
          ) : (
            <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[12px] text-[var(--color-fg-muted)]">
              {t('settings.skillsNoResults')}
            </div>
          )}
        </section>
      </div>

      <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
        <div className="mb-3 flex items-start gap-2.5">
          <Eye className="mt-0.5 h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.75} />
          <div>
            <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">{t('settings.skillsPreview')}</h4>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              {t('settings.skillsPreviewDescription')}
            </p>
          </div>
        </div>
        <ScopePicker value={previewScopes} onChange={setPreviewScopes} />
        <div className="mt-3">
          <Label>{t('settings.skillsPreviewMessage')}</Label>
          <Textarea
            value={previewMessage}
            onChange={(event) => setPreviewMessage(event.target.value)}
            placeholder={t('settings.skillsPreviewPlaceholder')}
            className="min-h-[96px]"
          />
        </div>
        <div className="mt-3 flex justify-end">
          <Button type="button" disabled={preview.isPending || previewScopes.length === 0} onClick={() => preview.mutate()}>
            {preview.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            {t('settings.skillsRunPreview')}
          </Button>
        </div>
        {preview.data && (
          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="text-[12px] font-semibold text-[var(--color-fg)]">{t('settings.skillsMatched')}</div>
              <div className="mt-2 space-y-2">
                {preview.data.skills.length === 0 ? (
                  <div className="text-[12px] text-[var(--color-fg-muted)]">{t('settings.skillsNoResults')}</div>
                ) : preview.data.skills.map((item) => (
                  <div key={item.id} className="rounded-md bg-[var(--color-surface-raised)] p-2 text-[12px]">
                    <div className="break-words font-medium text-[var(--color-fg)]">{item.name}</div>
                    <div className="mt-1 break-words text-[11px] text-[var(--color-fg-muted)]">
                      {item.reasons.join(' · ')} / {item.effectivePriority}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <pre className="max-h-[260px] overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
              {preview.data.promptPreview || t('settings.skillsPreviewEmpty')}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}

function SkillListItem({
  skill,
  binding,
  selected,
  onSelect,
  onToggleEnabled,
  onToggleSystemBinding,
  t,
}: {
  skill: Skill;
  binding?: SkillBinding;
  selected: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
  onToggleSystemBinding: (enabled: boolean) => void;
  t: ReturnType<typeof useI18n>['t'];
}): JSX.Element {
  const systemEnabled = binding?.enabled === 1;

  return (
    <div
      className={cn(
        'rounded-md border p-2.5 transition-colors ease-ocean',
        selected
          ? 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]',
      )}
    >
      <button type="button" className="block w-full text-left" onClick={onSelect}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-[var(--color-fg)]">{skill.name}</div>
            <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
              {skill.description || skill.install_path_label || skillSourceLabel(skill.source_type, t)}
            </div>
          </div>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium',
              skill.enabled === 1
                ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]'
                : 'bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)]',
            )}
          >
            {skill.enabled === 1 ? t('settings.skillsStatusOn') : t('settings.skillsStatusOff')}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {skill.runtime_scopes.map((scope) => (
            <span key={scope} className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
              {runtimeScopeLabel(scope, t)}
            </span>
          ))}
        </div>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TogglePill active={skill.enabled === 1} icon={<Power className="h-3 w-3" />} label={t('settings.skillsEnabled')} onClick={onToggleEnabled} />
        <TogglePill
          active={systemEnabled}
          icon={<ShieldCheck className="h-3 w-3" />}
          label={t('settings.skillsSystemBindingShort')}
          onClick={() => onToggleSystemBinding(!systemEnabled)}
        />
      </div>
    </div>
  );
}

function TogglePill({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[10px] font-medium transition-colors ease-ocean',
        active
          ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
          : 'bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function SkillDetail({
  skill,
  binding,
  isSaving,
  isDeleting,
  onSave,
  onDelete,
}: {
  skill: Skill;
  binding?: SkillBinding;
  isSaving: boolean;
  isDeleting: boolean;
  onSave: (patch: Parameters<typeof api.updateSkill>[1]) => void;
  onDelete: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description ?? '');
  const [priority, setPriority] = useState(String(skill.priority));
  const [triggerMode, setTriggerMode] = useState<SkillTriggerMode>(skill.trigger_mode);
  const [triggerKeywords, setTriggerKeywords] = useState(skill.trigger_keywords.join(', '));
  const [runtimeScopes, setRuntimeScopes] = useState<SkillRuntimeScope[]>(skill.runtime_scopes);
  useEffect(() => {
    setName(skill.name);
    setDescription(skill.description ?? '');
    setPriority(String(skill.priority));
    setTriggerMode(skill.trigger_mode);
    setTriggerKeywords(skill.trigger_keywords.join(', '));
    setRuntimeScopes(skill.runtime_scopes);
  }, [skill.id, skill.updated_at]);

  const parsedPriority = Number(priority);
  const priorityValid = Number.isInteger(parsedPriority);

  const dirty = useMemo(() => (
    name !== skill.name ||
    description !== (skill.description ?? '') ||
    parsedPriority !== skill.priority ||
    triggerMode !== skill.trigger_mode ||
    triggerKeywords !== skill.trigger_keywords.join(', ') ||
    runtimeScopes.join('|') !== skill.runtime_scopes.join('|')
  ), [description, name, parsedPriority, runtimeScopes, skill, triggerKeywords, triggerMode]);

  return (
    <div className="space-y-3" key={skill.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-[13px] font-semibold text-[var(--color-fg)]">{skill.name}</h4>
          <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
            {skill.install_path_label ?? (skill.install_path_set ? t('settings.skillsPathSet') : t('common.none'))}
          </p>
        </div>
        <Button type="button" size="sm" variant="danger" disabled={isDeleting} onClick={onDelete}>
          {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          {t('common.delete')}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t('settings.skillsName')}</Label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div>
          <Label>{t('settings.skillsPriority')}</Label>
        <Input value={priority} type="number" onChange={(event) => setPriority(event.target.value)} />
        {!priorityValid && (
          <p className="mt-1 text-[11px] text-[var(--color-danger)]">{t('settings.skillsPriorityInvalid')}</p>
        )}
        </div>
      </div>
      <div>
        <Label>{t('settings.skillsDescriptionField')}</Label>
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-[72px]" />
      </div>
      <ScopePicker value={runtimeScopes} onChange={setRuntimeScopes} />
      <div>
        <Label>{t('settings.skillsTriggerMode')}</Label>
        <div className="mt-1.5 grid gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 sm:grid-cols-3">
          {TRIGGER_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={cn(
                'h-8 rounded-[5px] px-2 text-[12px] font-medium transition-colors ease-ocean',
                triggerMode === mode
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-primary)] shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                  : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
              )}
              onClick={() => setTriggerMode(mode)}
            >
              {triggerModeLabel(mode, t)}
            </button>
          ))}
        </div>
      </div>
      <div>
        <Label>{t('settings.skillsKeywords')}</Label>
        <Input
          value={triggerKeywords}
          onChange={(event) => setTriggerKeywords(event.target.value)}
          placeholder={t('settings.skillsKeywordsPlaceholder')}
        />
      </div>
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[12px] text-[var(--color-fg-muted)]">
        <div>{t('settings.skillsSource')}: {skillSourceLabel(skill.source_type, t)}</div>
        <div className="mt-1">
          {t('settings.skillsSystemBinding')}: {binding?.enabled === 1 ? t('settings.skillsStatusOn') : t('settings.skillsStatusOff')}
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={isSaving || !dirty || runtimeScopes.length === 0 || !name.trim() || !priorityValid}
          onClick={() => onSave({
            name: name.trim(),
            description: description.trim() || null,
            priority: parsedPriority,
            trigger_mode: triggerMode,
            trigger_keywords: splitKeywords(triggerKeywords),
            runtime_scopes: runtimeScopes,
          })}
        >
          {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

function ScopePicker({
  value,
  onChange,
}: {
  value: SkillRuntimeScope[];
  onChange: (value: SkillRuntimeScope[]) => void;
}): JSX.Element {
  const { t } = useI18n();
  const selected = new Set(value);
  return (
    <div>
      <Label>{t('settings.skillsRuntimeScopes')}</Label>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {RUNTIME_SCOPES.map((scope) => {
          const active = selected.has(scope);
          return (
            <button
              key={scope}
              type="button"
              className={cn(
                'h-7 rounded-full px-2.5 text-[11px] font-medium transition-colors ease-ocean',
                active
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
              )}
              onClick={() => {
                const next = active ? value.filter((item) => item !== scope) : [...value, scope];
                onChange(next);
              }}
            >
              {runtimeScopeLabel(scope, t)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function splitKeywords(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function runtimeScopeLabel(scope: SkillRuntimeScope, t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<SkillRuntimeScope, string> = {
    planner: t('settings.skillsScopePlanner'),
    model_chat: t('settings.skillsScopeModelChat'),
    workflow: t('settings.skillsScopeWorkflow'),
    memory: t('settings.skillsScopeMemory'),
    review: t('settings.skillsScopeReview'),
  };
  return labels[scope];
}

function triggerModeLabel(mode: SkillTriggerMode, t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<SkillTriggerMode, string> = {
    manual: t('settings.skillsTriggerManual'),
    keyword: t('settings.skillsTriggerKeyword'),
    always_for_scope: t('settings.skillsTriggerAlways'),
  };
  return labels[mode];
}

function skillSourceLabel(source: Skill['source_type'], t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<Skill['source_type'], string> = {
    local_directory: t('settings.skillsSourceLocal'),
    git_repo: t('settings.skillsSourceGit'),
    manual: t('settings.skillsSourceManual'),
  };
  return labels[source];
}
