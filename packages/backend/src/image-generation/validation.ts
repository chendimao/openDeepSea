import type { ImageProviderCompatProfileId } from './types.js';

const IMAGE_PROVIDER_COMPAT_PROFILE_IDS = new Set<ImageProviderCompatProfileId>([
  'openai',
  'openai-sdk',
  'images-edits',
  'chat-completions',
]);

export function normalizeImageBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('base_url is required');

  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new Error('base_url must be a valid http(s) URL');
  }
}

export function normalizeImageProfileName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('name is required');
  if (name.length > 80) throw new Error('name is too long');
  return name;
}

export function normalizeImageModel(value: string): string {
  const model = value.trim();
  if (!model) throw new Error('model is required');
  return model;
}

export function normalizeOptionalApiKey(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.trim();
}

export function normalizeImageCompatProfileId(
  value: ImageProviderCompatProfileId | undefined,
): ImageProviderCompatProfileId {
  const profileId = value ?? 'openai';
  if (!IMAGE_PROVIDER_COMPAT_PROFILE_IDS.has(profileId)) {
    throw new Error('compat_profile_id is invalid');
  }
  return profileId;
}

export function normalizeSupportsCountParameter(value: boolean | undefined): 0 | 1 {
  return value === false ? 0 : 1;
}
