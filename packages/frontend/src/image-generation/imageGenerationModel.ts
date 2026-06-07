import type {
  ImageJobGroup,
  ImagePromptPresetInput,
  ImageProviderCompatProfileId,
  ImageProviderProfile,
  ImageProviderProfileInput,
} from '../lib/types';

export type ProviderProfileFormState = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  compatProfileId: ImageProviderCompatProfileId;
  supportsCountParameter: boolean;
  hasSavedApiKey?: boolean;
};

export function createProviderProfileFormState(profile: ImageProviderProfile | null): ProviderProfileFormState {
  if (!profile) {
    return createEmptyProviderProfileFormState();
  }
  return {
    name: profile.name,
    baseUrl: profile.base_url,
    apiKey: '',
    model: profile.model,
    compatProfileId: profile.compat_profile_id,
    supportsCountParameter: profile.supports_count_parameter === 1,
    hasSavedApiKey: profile.has_api_key === 1,
  };
}

export function createEmptyProviderProfileFormState(index = 0): ProviderProfileFormState {
  return {
    name: index > 0 ? `图片提供方 ${index + 1}` : '图片提供方',
    baseUrl: '',
    apiKey: '',
    model: '',
    compatProfileId: 'openai',
    supportsCountParameter: true,
    hasSavedApiKey: false,
  };
}

export function buildProviderProfilePayload(form: ProviderProfileFormState): ImageProviderProfileInput {
  const apiKey = form.apiKey.trim();
  return {
    name: form.name.trim(),
    base_url: form.baseUrl.trim(),
    ...(apiKey ? { api_key: apiKey } : {}),
    model: form.model.trim(),
    compat_profile_id: form.compatProfileId,
    supports_count_parameter: form.supportsCountParameter,
  };
}

export type PromptPresetDraft = {
  title: string;
  prompt: string;
};

export function createPromptPresetDraft(currentPrompt = ''): PromptPresetDraft {
  return {
    title: '',
    prompt: currentPrompt.trim(),
  };
}

export function buildPromptPresetPayload(draft: PromptPresetDraft): ImagePromptPresetInput {
  const prompt = draft.prompt.trim();
  return {
    title: draft.title.trim() || buildPromptPresetTitle(prompt),
    prompt,
  };
}

export function filterImageJobGroups(groups: ImageJobGroup[], query: string): ImageJobGroup[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return groups;
  return groups.filter((group) =>
    group.key.toLowerCase().includes(normalizedQuery) ||
    group.label.toLowerCase().includes(normalizedQuery),
  );
}

function buildPromptPresetTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  const [firstPhrase] = normalized.split(/[，。,.!?！？;；]/);
  return (firstPhrase || normalized).slice(0, 20) || '未命名提示词';
}
