import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Star,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import type { ImageProviderCompatProfileId, ImageProviderProfile } from '../lib/types';
import {
  buildProviderProfilePayload,
  createEmptyProviderProfileFormState,
  createProviderProfileFormState,
  type ProviderProfileFormState,
} from './imageGenerationModel';

type ProviderProfilePanelViewProps = {
  profiles: ImageProviderProfile[];
  selectedProfile: ImageProviderProfile | null;
  form: ProviderProfileFormState;
  mode: 'create' | 'edit';
  error: string | null;
  modelWarning: string | null;
  modelIds: string[];
  busy: boolean;
  modelsLoading: boolean;
  onCreateProfile: () => void;
  onSelectProfile: (profile: ImageProviderProfile) => void;
  onFormChange: (patch: Partial<ProviderProfileFormState>) => void;
  onSave: () => void;
  onActivate: () => void;
  onDelete: () => void;
  onFetchModels: () => void;
};

const compatProfileOptions: Array<{ value: ImageProviderCompatProfileId; label: string }> = [
  { value: 'openai', label: 'OpenAI Images' },
  { value: 'openai-sdk', label: 'OpenAI SDK' },
  { value: 'images-edits', label: 'Images Edits' },
  { value: 'chat-completions', label: 'Chat Completions' },
];

export function ProviderProfilePanel({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [mode, setMode] = useState<'create' | 'edit'>('create');
  const [form, setForm] = useState<ProviderProfileFormState>(() => createEmptyProviderProfileFormState());
  const [error, setError] = useState<string | null>(null);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const profilesQueryKey = ['image-provider-profiles', projectId];
  const { data: profiles = [] } = useQuery({
    queryKey: profilesQueryKey,
    queryFn: () => api.listImageProviderProfiles(projectId),
  });
  const selectedProfile = mode === 'edit'
    ? profiles.find((profile) => profile.id === selectedProfileId) ?? null
    : null;
  const refreshProfiles = async () => {
    await queryClient.invalidateQueries({ queryKey: profilesQueryKey });
  };

  useEffect(() => {
    if (mode === 'create') return;
    const current = profiles.find((profile) => profile.id === selectedProfileId);
    if (current) return;
    const nextProfile = profiles.find((profile) => profile.active === 1) ?? profiles[0] ?? null;
    setSelectedProfileId(nextProfile?.id ?? null);
    setForm(createProviderProfileFormState(nextProfile));
    setMode(nextProfile ? 'edit' : 'create');
    setError(null);
    setModelIds([]);
    setModelWarning(null);
  }, [mode, profiles, selectedProfileId]);

  useEffect(() => {
    if (profiles.length === 0 || selectedProfileId || mode === 'create') return;
    const nextProfile = profiles.find((profile) => profile.active === 1) ?? profiles[0];
    setSelectedProfileId(nextProfile.id);
    setForm(createProviderProfileFormState(nextProfile));
    setMode('edit');
  }, [mode, profiles, selectedProfileId]);

  const createProfile = useMutation({
    mutationFn: (input: ReturnType<typeof buildProviderProfilePayload>) =>
      api.createImageProviderProfile(projectId, input),
    onSuccess: async (profile) => {
      await refreshProfiles();
      selectProfile(profile);
      toast.success('图片提供方已保存');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const updateProfile = useMutation({
    mutationFn: ({ profileId, input }: { profileId: string; input: ReturnType<typeof buildProviderProfilePayload> }) =>
      api.updateImageProviderProfile(projectId, profileId, input),
    onSuccess: async (profile) => {
      await refreshProfiles();
      selectProfile(profile);
      toast.success('图片提供方已更新');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const activateProfile = useMutation({
    mutationFn: (profileId: string) => api.activateImageProviderProfile(projectId, profileId),
    onSuccess: async (profile) => {
      await refreshProfiles();
      selectProfile(profile);
      toast.success('已设为当前图片提供方');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const deleteProfile = useMutation({
    mutationFn: (profileId: string) => api.deleteImageProviderProfile(projectId, profileId),
    onSuccess: async (deletedProfile) => {
      await refreshProfiles();
      const nextProfile = profiles.filter((profile) => profile.id !== deletedProfile.id)
        .find((profile) => profile.active === 1)
        ?? profiles.find((profile) => profile.id !== deletedProfile.id)
        ?? null;
      if (nextProfile) {
        selectProfile(nextProfile);
      } else {
        startCreateProfile();
      }
      toast.success('图片提供方已删除');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const fetchModels = useMutation({
    mutationFn: (profileId: string) => api.listImageProviderModels(projectId, profileId),
    onSuccess: (response) => {
      setModelIds(response.models.map((model) => model.id));
      setModelWarning(response.warning);
    },
    onError: (err) => {
      setModelIds([]);
      setModelWarning((err as Error).message);
    },
  });
  const busy =
    createProfile.isPending ||
    updateProfile.isPending ||
    activateProfile.isPending ||
    deleteProfile.isPending;

  function selectProfile(profile: ImageProviderProfile): void {
    setSelectedProfileId(profile.id);
    setForm(createProviderProfileFormState(profile));
    setMode('edit');
    setError(null);
    setModelIds([]);
    setModelWarning(null);
  }

  function startCreateProfile(): void {
    setSelectedProfileId(null);
    setForm(createEmptyProviderProfileFormState(profiles.length));
    setMode('create');
    setError(null);
    setModelIds([]);
    setModelWarning(null);
  }

  function saveProfile(): void {
    const validationError = validateProviderProfileForm(form);
    if (validationError) {
      setError(validationError);
      return;
    }
    const input = buildProviderProfilePayload(form);
    if (mode === 'edit' && selectedProfile) {
      updateProfile.mutate({ profileId: selectedProfile.id, input });
      return;
    }
    createProfile.mutate(input);
  }

  return (
    <ProviderProfilePanelView
      profiles={profiles}
      selectedProfile={selectedProfile}
      form={form}
      mode={mode}
      error={error}
      modelWarning={modelWarning}
      modelIds={modelIds}
      busy={busy}
      modelsLoading={fetchModels.isPending}
      onCreateProfile={startCreateProfile}
      onSelectProfile={selectProfile}
      onFormChange={(patch) => {
        setForm((current) => ({ ...current, ...patch }));
        setError(null);
      }}
      onSave={saveProfile}
      onActivate={() => selectedProfile && activateProfile.mutate(selectedProfile.id)}
      onDelete={() => selectedProfile && deleteProfile.mutate(selectedProfile.id)}
      onFetchModels={() => selectedProfile && fetchModels.mutate(selectedProfile.id)}
    />
  );
}

export function ProviderProfilePanelView({
  profiles,
  selectedProfile,
  form,
  mode,
  error,
  modelWarning,
  modelIds,
  busy,
  modelsLoading,
  onCreateProfile,
  onSelectProfile,
  onFormChange,
  onSave,
  onActivate,
  onDelete,
  onFetchModels,
}: ProviderProfilePanelViewProps): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[12px] font-semibold">
            <ServerCog className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
            <span>Provider</span>
          </h3>
          <p className="mt-1 text-[11px] leading-snug text-[var(--color-fg-muted)]">
            OpenAI 兼容图片生成端点
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onCreateProfile} disabled={busy}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          新建
        </Button>
      </div>

      {profiles.length > 0 ? (
        <div className="space-y-1.5" aria-label="图片提供方列表">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={cn(
                'flex w-full items-center justify-between gap-2 border-l-2 px-2 py-2 text-left transition-colors ease-ocean',
                selectedProfile?.id === profile.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-bg-soft)] text-[var(--color-fg)]'
                  : 'border-transparent text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-soft)] hover:text-[var(--color-fg)]',
              )}
              onClick={() => onSelectProfile(profile)}
            >
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-semibold">{profile.name}</span>
                <span className="mt-0.5 block truncate font-mono text-[10px] uppercase text-[var(--color-fg-subtle)]">
                  {profile.compat_profile_id} · {profile.model}
                </span>
              </span>
              {profile.active === 1 && (
                <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                  当前使用
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="border border-dashed border-[var(--color-border)] px-3 py-4 text-[12px] text-[var(--color-fg-muted)]">
          还没有图片提供方
        </div>
      )}

      <form
        className="space-y-3 border-t border-[var(--color-border)] pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <Field label="名称">
          <Input
            value={form.name}
            onChange={(event) => onFormChange({ name: event.currentTarget.value })}
            placeholder="OpenAI Images"
          />
        </Field>
        <Field label="Base URL">
          <Input
            value={form.baseUrl}
            onChange={(event) => onFormChange({ baseUrl: event.currentTarget.value })}
            placeholder="https://api.openai.com/v1"
          />
        </Field>
        <Field label="API Key">
          <div className="space-y-1.5">
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-fg-subtle)]" aria-hidden="true" />
              <Input
                className="pl-8"
                type="password"
                value={form.apiKey}
                onChange={(event) => onFormChange({ apiKey: event.currentTarget.value })}
                placeholder={form.hasSavedApiKey ? '留空继续使用已保存密钥' : '输入 API Key'}
              />
            </div>
            {form.hasSavedApiKey && (
              <div className="text-[11px] text-[var(--color-fg-subtle)]">
                已保存密钥，留空不会覆盖
              </div>
            )}
          </div>
        </Field>
        <Field label="Model">
          <Input
            value={form.model}
            onChange={(event) => onFormChange({ model: event.currentTarget.value })}
            placeholder="gpt-image-2"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="兼容模式">
            <select
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
              value={form.compatProfileId}
              onChange={(event) =>
                onFormChange({ compatProfileId: event.currentTarget.value as ImageProviderCompatProfileId })
              }
            >
              {compatProfileOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
          <label className="flex items-end gap-2 pb-2 text-[12px] text-[var(--color-fg-muted)]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--color-accent)]"
              checked={form.supportsCountParameter}
              onChange={(event) => onFormChange({ supportsCountParameter: event.currentTarget.checked })}
            />
            支持 count
          </label>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-[12px] text-[var(--color-danger)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        {modelWarning && (
          <div className="flex items-start gap-2 text-[12px] text-[var(--color-warning)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5" aria-hidden="true" />
            <span>{modelWarning}</span>
          </div>
        )}
        {modelIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {modelIds.map((modelId) => (
              <span key={modelId} className="rounded-full bg-[var(--color-bg-soft)] px-2 py-0.5 font-mono text-[var(--color-fg-muted)]">
                {modelId}
              </span>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            保存配置
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onFetchModels} disabled={busy || modelsLoading || !selectedProfile}>
            <RefreshCw className={cn('h-3.5 w-3.5', modelsLoading && 'animate-spin')} aria-hidden="true" />
            拉取模型
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onActivate}
            disabled={busy || !selectedProfile || selectedProfile.active === 1}
          >
            <Star className="h-3.5 w-3.5" aria-hidden="true" />
            设为当前
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={onDelete} disabled={busy || mode !== 'edit' || !selectedProfile}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            删除
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function validateProviderProfileForm(form: ProviderProfileFormState): string | null {
  if (!form.name.trim()) return '请填写 Provider 名称';
  if (!form.baseUrl.trim()) return '请填写 Base URL';
  if (!form.model.trim()) return '请填写默认模型';
  return null;
}
