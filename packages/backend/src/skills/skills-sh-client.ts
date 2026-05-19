import { createSkillsShPackage, type SkillsShPackage } from './installer-runner.js';

const DEFAULT_BASE_URL = 'https://skills.sh';
const ALLOWED_PUBLIC_HOSTS = new Set(['skills.sh', 'www.skills.sh']);

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SkillsShClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface SkillsShSearchResult {
  id: string;
  name: string;
  skillId: string | null;
  source: string | null;
  installLabel: string;
  description: string | null;
  installs: number | null;
  version: string | null;
  revision: string | null;
}

export class SkillsShClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: FetchLike;

  constructor(options: SkillsShClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async search(query: string): Promise<SkillsShSearchResult[]> {
    const url = new URL('/api/search', this.baseUrl);
    url.searchParams.set('q', query.trim());
    url.searchParams.set('limit', '10');
    const payload = await this.fetchJson(url);
    return normalizeSearchResults(payload);
  }

  async fetchPackage(installLabel: string): Promise<SkillsShPackage> {
    const label = installLabel.trim();
    if (!label) throw new Error('skills.sh install label is required');
    const url = new URL(`/api/download/${encodeInstallLabel(label)}`, this.baseUrl);
    const payload = await this.fetchJson(url);
    return createSkillsShPackage(payload, label);
  }

  async fetchPackageMetadata(installLabel: string): Promise<SkillsShPackage> {
    return this.fetchPackage(installLabel);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const response = await this.fetchImpl(url.toString(), {
      headers: {
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`skills.sh request failed: ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  }
}

export function normalizeSearchResults(payload: unknown): SkillsShSearchResult[] {
  const items = findResultArray(payload);
  return items.map(normalizeSearchResult).filter((item): item is SkillsShSearchResult => item !== null);
}

function normalizeSearchResult(raw: unknown): SkillsShSearchResult | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = firstString(record.id, record.package_id, record.packageId);
  const skillId = firstString(record.skillId, record.skill_id, record.slug) ?? skillIdFromLabel(id ?? '');
  const source = firstString(record.source, record.repository, record.repo) ?? sourceFromLabel(id ?? '');
  const name = firstString(record.name, record.title, skillId, id);
  if (!name) return null;
  const installLabel = firstString(record.installLabel, record.install_label)
    ?? labelFromParts(source, skillId)
    ?? id
    ?? name;

  return {
    id: id ?? installLabel,
    name,
    skillId,
    source,
    installLabel,
    description: firstString(record.description, record.summary) ?? null,
    installs: normalizeNumber(record.installs, record.install_count, record.installCount),
    version: firstString(record.version, record.package_version, record.packageVersion),
    revision: firstString(record.revision, record.package_revision, record.packageRevision, record.sha),
  };
}

function findResultArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of ['skills', 'results', 'items', 'packages']) {
    if (Array.isArray(record[key])) return record[key];
  }
  const data = asRecord(record.data);
  if (data) {
    for (const key of ['skills', 'results', 'items', 'packages']) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLocaleLowerCase();
  if (url.protocol !== 'https:' || !ALLOWED_PUBLIC_HOSTS.has(host)) {
    throw new Error('only public skills.sh source is supported');
  }
  return url;
}

function encodeInstallLabel(label: string): string {
  const parts = label.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error('skills.sh install label is required');
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('skills.sh install label must not contain dot segments');
  }
  return parts.map(encodeURIComponent).join('/');
}

function normalizeNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function labelFromParts(source: string | null, skillId: string | null): string | null {
  if (!source || !skillId) return null;
  return `${source}/${skillId}`;
}

function sourceFromLabel(label: string): string | null {
  const parts = label.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  return parts.slice(0, -1).join('/');
}

function skillIdFromLabel(label: string): string | null {
  const parts = label.split('/').filter(Boolean);
  return parts.at(-1) ?? null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
