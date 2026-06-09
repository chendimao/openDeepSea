import { listPlatformSkillAggregates } from '../platform-skills/service.js';
import type { PlatformSkillProvider } from '../platform-skills/types.js';
import { parseRestrictedSkillsCommand } from '../terminal/restricted-skills-shell.js';
import { TtlCache } from './cache.js';
import { resolveSkillsShBearerToken } from './config.js';
import { SkillsShClient } from './client.js';
import type {
  OnlineSkill,
  OnlineSkillAuditResponse,
  OnlineSkillDetailResponse,
  OnlineSkillListInput,
  OnlineSkillListResponse,
  OnlineSkillProvider,
  OnlineSkillSearchInput,
  OnlineSkillsService,
  SkillsShClientLike,
  SkillsShListResponse,
  SkillsShPagination,
  SkillsShSkill,
} from './types.js';

interface OnlineSkillsServiceOptions {
  client?: SkillsShClientLike;
  now?: () => number;
  cacheTtlMs?: number;
}

interface CachedList {
  raw: SkillsShListResponse;
  inputPage: number;
  inputLimit: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_SOURCE_URL = 'https://skills.sh';

export function createOnlineSkillsService(options: OnlineSkillsServiceOptions = {}): OnlineSkillsService {
  const client = options.client ?? new SkillsShClient({ tokenProvider: resolveSkillsShBearerToken });
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const listCache = new TtlCache<string, CachedList>({ now });
  const detailCache = new TtlCache<string, unknown>({ now });
  const auditCache = new TtlCache<string, unknown>({ now });

  async function getInstalledProvidersBySlug(): Promise<Map<string, OnlineSkillProvider[]>> {
    const aggregates = await listPlatformSkillAggregates();
    const bySlug = new Map<string, OnlineSkillProvider[]>();
    for (const aggregate of aggregates) {
      const providers = aggregate.providers.slice();
      if (providers.length === 0) continue;
      bySlug.set(normalizeLookupKey(aggregate.name), providers);
      bySlug.set(normalizeLookupKey(aggregate.displayName), providers);
    }
    return bySlug;
  }

  async function buildListResponse(input: OnlineSkillListInput | OnlineSkillSearchInput, cacheKey: string, load: () => Promise<SkillsShListResponse>): Promise<OnlineSkillListResponse> {
    const page = 'page' in input && typeof input.page === 'number' ? input.page : 0;
    const limit = input.limit;
    const cached = listCache.get(cacheKey);
    let stale = false;
    let cachedList: CachedList;

    if (cached && !cached.stale && !input.forceRefresh) {
      cachedList = cached.value;
    } else {
      try {
        const raw = await load();
        cachedList = { raw, inputPage: page, inputLimit: limit };
        listCache.set(cacheKey, cachedList, cacheTtlMs);
      } catch (err) {
        if (!cached) throw err;
        cachedList = cached.value;
        stale = true;
      }
    }

    const installedProvidersBySlug = await getInstalledProvidersBySlug();
    return normalizeSkillsShListResponse(cachedList.raw, installedProvidersBySlug, {
      inputPage: cachedList.inputPage,
      inputLimit: cachedList.inputLimit,
      stale,
      updatedAt: now(),
    });
  }

  return {
    listOnlineSkills(input) {
      const page = normalizePage(input.page);
      const limit = normalizeLimit(input.limit);
      const view = input.view;
      const cacheKey = `list:${view}:${page}:${limit}`;
      return buildListResponse({ ...input, page, limit }, cacheKey, () => client.listSkills({ view, page, limit }));
    },

    searchOnlineSkills(input) {
      const q = input.q.trim();
      const page = normalizePage(input.page ?? 0);
      const limit = normalizeLimit(input.limit);
      const cacheKey = `search:${q}:${limit}`;
      return buildListResponse({ ...input, q, page, limit }, cacheKey, () => client.searchSkills({ q, limit }));
    },

    async getOnlineSkill(id) {
      const cacheKey = `detail:${id}`;
      const cached = detailCache.get(cacheKey);
      let stale = false;
      let raw: unknown;
      if (cached && !cached.stale) {
        raw = cached.value;
      } else {
        try {
          raw = await client.getSkill(id);
          detailCache.set(cacheKey, raw, cacheTtlMs * 5);
        } catch (err) {
          if (!cached) throw err;
          raw = cached.value;
          stale = true;
        }
      }
      const installedProvidersBySlug = await getInstalledProvidersBySlug();
      return {
        skill: normalizeSkillsShSkill(raw, installedProvidersBySlug.get(normalizeLookupKey(getSkillSlug(raw, id))) ?? []),
        stale,
        updatedAt: now(),
      } satisfies OnlineSkillDetailResponse;
    },

    async getOnlineSkillAudit(id) {
      const cacheKey = `audit:${id}`;
      const cached = auditCache.get(cacheKey);
      if (cached && !cached.stale) {
        return {
          id,
          status: 'available',
          audit: cached.value,
          stale: false,
          updatedAt: now(),
        } satisfies OnlineSkillAuditResponse;
      }

      try {
        const audit = await client.getSkillAudit(id);
        auditCache.set(cacheKey, audit, cacheTtlMs * 5);
        return {
          id,
          status: 'available',
          audit,
          stale: false,
          updatedAt: now(),
        };
      } catch (err) {
        if ((err as Error).message === 'audit_not_found') {
          return {
            id,
            status: 'none',
            audit: null,
            stale: false,
            updatedAt: now(),
          };
        }
        if (cached) {
          return {
            id,
            status: 'available',
            audit: cached.value,
            stale: true,
            updatedAt: now(),
          };
        }
        throw err;
      }
    },
  };
}

export const onlineSkillsService = createOnlineSkillsService();

export function normalizeSkillsShSkill(raw: unknown, installedProviders: PlatformSkillProvider[]): OnlineSkill {
  const skill = isRecord(raw) ? raw as SkillsShSkill : {};
  const id = getString(skill.id) ?? buildSkillId(skill);
  const slug = getSkillSlug(skill, id);
  const upstreamSource = getString(skill.source) ?? sourceFromId(id);
  const displayName = getString(skill.displayName) ?? getString(skill.name) ?? getString(skill.title) ?? slug;
  const installUrl = getString(skill.installUrl) ?? getString(skill.install_url);
  const sourceUrl = getString(skill.url) ?? getString(skill.sourceUrl) ?? `${DEFAULT_SOURCE_URL}/${id}`;
  const installCommand = buildInstallCommand(installUrl, slug);

  return {
    id,
    slug,
    name: slug,
    displayName,
    description: getString(skill.description) ?? getString(skill.desc) ?? getString(skill.summary),
    source: 'skills_sh',
    upstreamSource,
    sourceType: getString(skill.sourceType),
    sourceUrl,
    installUrl,
    installCommand,
    tags: getStringArray(skill.tags) ?? getStringArray(skill.topics) ?? [],
    author: getString(skill.author) ?? getString(skill.owner) ?? authorFromSource(upstreamSource),
    stars: getNumber(skill.stars),
    installs: getNumber(skill.installs),
    updatedAt: getTimestamp(skill.updatedAt) ?? getTimestamp(skill.updated) ?? getTimestamp(skill.lastUpdatedAt),
    auditStatus: 'unknown',
    installedProviders,
    isDuplicate: skill.isDuplicate === true,
  };
}

function normalizeSkillsShListResponse(
  raw: SkillsShListResponse,
  installedProvidersBySlug: Map<string, OnlineSkillProvider[]>,
  options: { inputPage: number; inputLimit: number; stale: boolean; updatedAt: number },
): OnlineSkillListResponse {
  const rawSkills = extractSkills(raw);
  const pagination = isRecord(raw.pagination) ? raw.pagination as SkillsShPagination : {};
  const limit = getNumber(pagination.per_page)
    ?? getNumber(pagination.perPage)
    ?? getNumber(pagination.limit)
    ?? getNumber(raw.per_page)
    ?? getNumber(raw.limit)
    ?? options.inputLimit;
  const total = getNumber(pagination.total) ?? getNumber(raw.total) ?? rawSkills.length;
  const page = getNumber(pagination.page) ?? getNumber(raw.page) ?? options.inputPage;
  const pages = getNumber(pagination.total_pages)
    ?? getNumber(pagination.totalPages)
    ?? getNumber(pagination.pages)
    ?? getNumber(raw.pages)
    ?? Math.ceil(total / Math.max(1, limit));

  const skills = rawSkills.map((item) => {
    const slug = getSkillSlug(item);
    const installedProviders = installedProvidersBySlug.get(normalizeLookupKey(slug)) ?? [];
    return normalizeSkillsShSkill(item, installedProviders);
  });

  return {
    skills,
    total,
    page,
    pages,
    limit,
    stale: options.stale,
    updatedAt: options.updatedAt,
  };
}

function extractSkills(raw: SkillsShListResponse): unknown[] {
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.skills)) return raw.skills;
  if (Array.isArray(raw.results)) return raw.results;
  return [];
}

function buildInstallCommand(installUrl: string | null, slug: string): string {
  if (!installUrl) return '';
  const command = `npx skills add ${quoteCommandToken(installUrl)} --skill ${quoteCommandToken(slug)}`;
  try {
    parseRestrictedSkillsCommand(command);
    return command;
  } catch {
    return '';
  }
}

function quoteCommandToken(value: string): string {
  if (/^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getSkillSlug(raw: unknown, fallbackId?: string): string {
  const skill = isRecord(raw) ? raw as SkillsShSkill : {};
  const slug = getString(skill.slug);
  if (slug) return slug;
  const id = getString(skill.id) ?? fallbackId;
  if (id) return id.split('/').filter(Boolean).at(-1) ?? id;
  return slugify(getString(skill.name) ?? getString(skill.displayName) ?? getString(skill.title) ?? 'skill');
}

function buildSkillId(skill: SkillsShSkill): string {
  const source = getString(skill.source);
  const slug = getSkillSlug(skill);
  if (source && slug) return `${source}/${slug}`;
  return slug;
}

function sourceFromId(id: string): string | null {
  const parts = id.split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join('/');
}

function authorFromSource(source: string | null): string | null {
  if (!source) return null;
  return source.split('/').filter(Boolean)[0] ?? source;
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePage(value: number): number {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value)) return 30;
  return Math.min(500, Math.max(1, value));
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'skill';
}

function getString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function getStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
