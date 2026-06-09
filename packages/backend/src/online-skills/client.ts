import type {
  SkillsMpClientLike,
  SkillsMpClientSearchInput,
  SkillsMpSearchResponse,
} from './types.js';

export type SkillsMpFetch = typeof fetch;
export type SkillsMpTokenProvider = () => string | null | Promise<string | null>;

export interface SkillsMpClientOptions {
  baseUrl?: string;
  fetchImpl?: SkillsMpFetch;
  tokenProvider?: SkillsMpTokenProvider;
}

export class SkillsMpClient implements SkillsMpClientLike {
  private readonly baseUrl: string;
  private readonly fetchImpl: SkillsMpFetch;
  private readonly tokenProvider: SkillsMpTokenProvider;

  constructor(options: SkillsMpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://skillsmp.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenProvider = options.tokenProvider ?? (() => getSkillsMpBearerTokenFromEnv(process.env));
  }

  async searchSkills(input: SkillsMpClientSearchInput): Promise<SkillsMpSearchResponse> {
    const params = new URLSearchParams({
      q: input.q,
      page: String(input.page),
      limit: String(input.limit),
    });
    if (input.sortBy) params.set('sortBy', input.sortBy);
    if (input.category) params.set('category', input.category);
    if (input.occupation) params.set('occupation', input.occupation);
    return this.getJson<SkillsMpSearchResponse>(`/api/v1/skills/search?${params.toString()}`);
  }

  private async getJson<T>(path: string): Promise<T> {
    const token = (await this.tokenProvider())?.trim();
    const headers = new Headers({ Accept: 'application/json' });
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers,
    });

    if (res.status === 404) throw new Error('skill_not_found');
    if (res.status === 429) throw new Error('upstream_rate_limited');
    if (!res.ok) throw new Error('upstream_unavailable');

    return await res.json() as T;
  }
}

export function getSkillsMpBearerTokenFromEnv(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.SKILLSMP_API_TOKEN?.trim() || env.SKILLS_MP_API_TOKEN?.trim();
  return explicit || null;
}
