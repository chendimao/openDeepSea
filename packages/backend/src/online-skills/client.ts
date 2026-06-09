import type {
  SkillsMpClientLike,
  SkillsMpClientSearchInput,
  SkillsMpSearchResponse,
} from './types.js';

export type SkillsMpFetch = typeof fetch;

export interface SkillsMpClientOptions {
  baseUrl?: string;
  fetchImpl?: SkillsMpFetch;
}

export class SkillsMpClient implements SkillsMpClientLike {
  private readonly baseUrl: string;
  private readonly fetchImpl: SkillsMpFetch;

  constructor(options: SkillsMpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://skillsmp.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
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
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (res.status === 404) throw new Error('skill_not_found');
    if (res.status === 429) throw new Error('upstream_rate_limited');
    if (!res.ok) throw new Error('upstream_unavailable');

    return await res.json() as T;
  }
}
