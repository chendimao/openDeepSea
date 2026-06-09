import { listPlatformSkillAggregates } from '../platform-skills/service.js';
import type { PlatformSkillProvider } from '../platform-skills/types.js';
import { parseRestrictedSkillsCommand } from '../terminal/restricted-skills-shell.js';
import { TtlCache } from './cache.js';
import { SkillsMpClient } from './client.js';
import { resolveSkillsMpBearerToken } from './config.js';
import type {
  OnlineSkill,
  OnlineSkillAuditResponse,
  OnlineSkillDetailResponse,
  OnlineSkillListInput,
  OnlineSkillListResponse,
  OnlineSkillProvider,
  OnlineSkillSearchInput,
  OnlineSkillView,
  OnlineSkillsService,
  SkillsMpClientLike,
  SkillsMpPagination,
  SkillsMpSearchResponse,
  SkillsMpSkill,
  SkillsMpSortBy,
} from './types.js';

interface OnlineSkillsServiceOptions {
  client?: SkillsMpClientLike;
  now?: () => number;
  cacheTtlMs?: number;
}

interface CachedList {
  raw: SkillsMpSearchResponse;
  inputPage: number;
  inputLimit: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_SOURCE_URL = 'https://skillsmp.com';
const DEFAULT_SEARCH_QUERY = 'skill';

export function createOnlineSkillsService(options: OnlineSkillsServiceOptions = {}): OnlineSkillsService {
  const client = options.client ?? new SkillsMpClient({ tokenProvider: resolveSkillsMpBearerToken });
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const listCache = new TtlCache<string, CachedList>({ now });
  const detailCache = new TtlCache<string, SkillsMpSkill>({ now });

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

  async function buildListResponse(
    input: OnlineSkillListInput | OnlineSkillSearchInput,
    cacheKey: string,
    load: () => Promise<SkillsMpSearchResponse>,
  ): Promise<OnlineSkillListResponse> {
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
    return normalizeSkillsMpListResponse(cachedList.raw, installedProvidersBySlug, {
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
      const { q, sortBy } = mapViewToSearch(input.view);
      const upstreamPage = page + 1;
      const cacheKey = `list:${input.view}:${q}:${sortBy}:${page}:${limit}`;
      return buildListResponse({ ...input, page, limit }, cacheKey, () => client.searchSkills({
        q,
        page: upstreamPage,
        limit,
        sortBy,
      }));
    },

    searchOnlineSkills(input) {
      const q = normalizeSearchQuery(input.q);
      const page = normalizePage(input.page ?? 0);
      const limit = normalizeLimit(input.limit);
      const upstreamPage = page + 1;
      const cacheKey = `search:${q}:stars:${page}:${limit}`;
      return buildListResponse({ ...input, q, page, limit }, cacheKey, () => client.searchSkills({
        q,
        page: upstreamPage,
        limit,
        sortBy: 'stars',
      }));
    },

    async getOnlineSkill(id) {
      const cacheKey = `detail:${id}`;
      const cached = detailCache.get(cacheKey);
      let stale = false;
      let raw: SkillsMpSkill | null = null;

      if (cached && !cached.stale) {
        raw = cached.value;
      } else {
        try {
          raw = await findSkillById(client, id);
          detailCache.set(cacheKey, raw, cacheTtlMs * 5);
        } catch (err) {
          if (!cached) throw err;
          raw = cached.value;
          stale = true;
        }
      }

      const installedProvidersBySlug = await getInstalledProvidersBySlug();
      return {
        skill: normalizeSkillsMpSkill(raw, installedProvidersBySlug.get(normalizeLookupKey(getSkillSlug(raw, id))) ?? []),
        stale,
        updatedAt: now(),
      } satisfies OnlineSkillDetailResponse;
    },

    async getOnlineSkillAudit(id) {
      return {
        id,
        status: 'none',
        audit: null,
        stale: false,
        updatedAt: now(),
      } satisfies OnlineSkillAuditResponse;
    },
  };
}

export const onlineSkillsService = createOnlineSkillsService();

export function normalizeSkillsMpSkill(raw: unknown, installedProviders: PlatformSkillProvider[]): OnlineSkill {
  const skill = isRecord(raw) ? raw as SkillsMpSkill : {};
  const id = getString(skill.id) ?? buildSkillId(skill);
  const slug = getSkillSlug(skill, id);
  const displayName = getString(skill.name) ?? slug;
  const githubUrl = getString(skill.githubUrl);
  const skillUrl = getString(skill.skillUrl) ?? `${DEFAULT_SOURCE_URL}/skills/${encodeURIComponent(id)}`;
  const installCommand = buildInstallCommand(githubUrl, slug);

  return {
    id,
    slug,
    name: slug,
    displayName,
    description: getString(skill.description),
    source: 'skillsmp',
    upstreamSource: githubUrl,
    sourceType: githubUrl ? 'github' : null,
    sourceUrl: skillUrl,
    installUrl: githubUrl,
    installCommand,
    tags: [],
    author: getString(skill.author) ?? authorFromGithubUrl(githubUrl),
    stars: getNumber(skill.stars),
    installs: null,
    updatedAt: getTimestamp(skill.updatedAt),
    auditStatus: 'none',
    installedProviders,
    isDuplicate: false,
  };
}

function normalizeSkillsMpListResponse(
  raw: SkillsMpSearchResponse,
  installedProvidersBySlug: Map<string, OnlineSkillProvider[]>,
  options: { inputPage: number; inputLimit: number; stale: boolean; updatedAt: number },
): OnlineSkillListResponse {
  const rawSkills = extractSkills(raw);
  const pagination = extractPagination(raw);
  const limit = getNumber(pagination.limit) ?? options.inputLimit;
  const total = getNumber(pagination.total) ?? rawSkills.length;
  const page = getZeroBasedPage(getNumber(pagination.page), options.inputPage);
  const pages = getNumber(pagination.totalPages) ?? Math.ceil(total / Math.max(1, limit));

  const skills = rawSkills.map((item) => {
    const slug = getSkillSlug(item);
    const installedProviders = installedProvidersBySlug.get(normalizeLookupKey(slug)) ?? [];
    return normalizeSkillsMpSkill(item, installedProviders);
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

async function findSkillById(client: SkillsMpClientLike, id: string): Promise<SkillsMpSkill> {
  const response = await client.searchSkills({
    q: buildDetailSearchQuery(id),
    page: 1,
    limit: 10,
    sortBy: 'stars',
  });
  const skills = extractSkills(response);
  const exact = skills.find((item) => getString(item.id) === id);
  if (!exact) throw new Error('skill_not_found');
  return exact;
}

function extractSkills(raw: SkillsMpSearchResponse): SkillsMpSkill[] {
  if (Array.isArray(raw.data)) return raw.data;
  if (isRecord(raw.data) && Array.isArray(raw.data.skills)) return raw.data.skills;
  if (Array.isArray(raw.skills)) return raw.skills;
  return [];
}

function extractPagination(raw: SkillsMpSearchResponse): SkillsMpPagination {
  if (isRecord(raw.data) && isRecord(raw.data.pagination)) return raw.data.pagination as SkillsMpPagination;
  if (isRecord(raw.pagination)) return raw.pagination as SkillsMpPagination;
  return {};
}

function buildInstallCommand(installUrl: string | null, slug: string): string {
  if (!installUrl) return '';
  const command = `npx --yes skills add ${quoteCommandToken(installUrl)} --skill ${quoteCommandToken(slug)}`;
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
  const skill = isRecord(raw) ? raw as SkillsMpSkill : {};
  const name = getString(skill.name);
  if (name) return slugify(name);
  const id = getString(skill.id) ?? fallbackId;
  if (id) return slugify(id.replace(/-skill-md$/i, '').split('-skills-').at(-1) ?? id);
  return 'skill';
}

function buildSkillId(skill: SkillsMpSkill): string {
  return slugify(getString(skill.name) ?? 'skill');
}

function buildDetailSearchQuery(id: string): string {
  const normalized = id
    .replace(/-skill-md$/i, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\b(md|skill|skills)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalizeSearchQuery(normalized || id);
}

function mapViewToSearch(view: OnlineSkillView): { q: string; sortBy: SkillsMpSortBy } {
  if (view === 'trending') return { q: DEFAULT_SEARCH_QUERY, sortBy: 'recent' };
  return { q: DEFAULT_SEARCH_QUERY, sortBy: 'stars' };
}

function authorFromGithubUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('github.com')) return null;
    return parsed.pathname.split('/').filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSearchQuery(value: string): string {
  const trimmed = value.trim();
  if (!containsLetterOrNumber(trimmed)) return DEFAULT_SEARCH_QUERY;
  return trimmed;
}

function containsLetterOrNumber(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function normalizePage(value: number): number {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value)) return 30;
  return Math.min(50, Math.max(1, value));
}

function getZeroBasedPage(upstreamPage: number | null, fallback: number): number {
  if (upstreamPage === null) return fallback;
  return Math.max(0, upstreamPage - 1);
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

function getNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return normalizeEpoch(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return normalizeEpoch(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEpoch(value: number): number {
  const truncated = Math.trunc(value);
  return truncated > 0 && truncated < 10_000_000_000 ? truncated * 1000 : truncated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
