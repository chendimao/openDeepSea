import type {
  SkillsShClientLike,
  SkillsShClientListInput,
  SkillsShClientSearchInput,
  SkillsShListResponse,
} from './types.js';

export type SkillsShFetch = typeof fetch;
export type SkillsShTokenProvider = () => string | null | Promise<string | null>;

export interface SkillsShClientOptions {
  baseUrl?: string;
  fetchImpl?: SkillsShFetch;
  tokenProvider?: SkillsShTokenProvider;
}

export class SkillsShClient implements SkillsShClientLike {
  private readonly baseUrl: string;
  private readonly fetchImpl: SkillsShFetch;
  private readonly tokenProvider: SkillsShTokenProvider;

  constructor(options: SkillsShClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://skills.sh/api/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenProvider = options.tokenProvider ?? (() => getSkillsShBearerTokenFromEnv(process.env));
  }

  async listSkills(input: SkillsShClientListInput): Promise<SkillsShListResponse> {
    const params = new URLSearchParams({
      view: input.view,
      page: String(input.page),
      per_page: String(input.limit),
    });
    return this.getJson<SkillsShListResponse>(`/skills?${params.toString()}`);
  }

  async searchSkills(input: SkillsShClientSearchInput): Promise<SkillsShListResponse> {
    const params = new URLSearchParams({
      q: input.q,
      limit: String(input.limit),
    });
    return this.getJson<SkillsShListResponse>(`/skills/search?${params.toString()}`);
  }

  async getSkill(id: string): Promise<unknown> {
    return this.getJson<unknown>(`/skills/${encodeSkillIdPath(id)}`);
  }

  async getSkillAudit(id: string): Promise<unknown> {
    return this.getJson<unknown>(`/skills/audit/${encodeSkillIdPath(id)}`);
  }

  private async getJson<T>(path: string): Promise<T> {
    const token = await this.tokenProvider();
    if (!token) throw new Error('token_missing');

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (res.status === 404 && path.includes('/audit/')) throw new Error('audit_not_found');
    if (res.status === 404) throw new Error('skill_not_found');
    if (res.status === 401 || res.status === 403) throw new Error('upstream_unauthorized');
    if (res.status === 429) throw new Error('upstream_rate_limited');
    if (!res.ok) throw new Error('upstream_unavailable');

    return await res.json() as T;
  }
}

export function getSkillsShBearerTokenFromEnv(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.SKILLS_SH_API_TOKEN?.trim();
  if (explicit) return explicit;
  return null;
}

function encodeSkillIdPath(id: string): string {
  return id
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}
