import type { PlatformSkillProvider } from '../platform-skills/types.js';

export type OnlineSkillProvider = PlatformSkillProvider;
export type OnlineSkillView = 'all-time' | 'trending' | 'hot';
export type OnlineSkillAuditStatus = 'unknown' | 'none' | 'available';
export type SkillsMpSortBy = 'stars' | 'recent';

export interface OnlineSkill {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string | null;
  source: 'skillsmp';
  upstreamSource: string | null;
  sourceType: string | null;
  sourceUrl: string;
  installUrl: string | null;
  installCommand: string;
  tags: string[];
  author: string | null;
  stars: number | null;
  installs: number | null;
  updatedAt: number | null;
  auditStatus: OnlineSkillAuditStatus;
  installedProviders: OnlineSkillProvider[];
  isDuplicate: boolean;
}

export interface OnlineSkillListInput {
  view: OnlineSkillView;
  page: number;
  limit: number;
  forceRefresh?: boolean;
}

export interface OnlineSkillSearchInput {
  q: string;
  page?: number;
  limit: number;
  forceRefresh?: boolean;
}

export interface OnlineSkillListResponse {
  skills: OnlineSkill[];
  total: number;
  page: number;
  pages: number;
  limit: number;
  stale: boolean;
  updatedAt: number;
}

export interface OnlineSkillDetailResponse {
  skill: OnlineSkill;
  stale: boolean;
  updatedAt: number;
}

export interface OnlineSkillAuditResponse {
  id: string;
  status: Extract<OnlineSkillAuditStatus, 'none' | 'available'>;
  audit: unknown | null;
  stale: boolean;
  updatedAt: number;
}

export interface SkillsMpSkill {
  id?: unknown;
  name?: unknown;
  author?: unknown;
  description?: unknown;
  githubUrl?: unknown;
  skillUrl?: unknown;
  stars?: unknown;
  updatedAt?: unknown;
}

export interface SkillsMpPagination {
  page?: unknown;
  limit?: unknown;
  total?: unknown;
  totalPages?: unknown;
  hasNext?: unknown;
  hasPrev?: unknown;
  totalIsExact?: unknown;
}

export interface SkillsMpSearchData {
  skills?: SkillsMpSkill[];
  pagination?: SkillsMpPagination;
  filters?: unknown;
}

export interface SkillsMpSearchResponse {
  success?: unknown;
  data?: SkillsMpSearchData | SkillsMpSkill[];
  skills?: SkillsMpSkill[];
  pagination?: SkillsMpPagination;
  error?: unknown;
  meta?: unknown;
}

export interface SkillsMpClientSearchInput {
  q: string;
  page: number;
  limit: number;
  sortBy?: SkillsMpSortBy;
  category?: string;
  occupation?: string;
}

export interface SkillsMpClientLike {
  searchSkills(input: SkillsMpClientSearchInput): Promise<SkillsMpSearchResponse>;
}

export interface OnlineSkillsService {
  listOnlineSkills(input: OnlineSkillListInput): Promise<OnlineSkillListResponse>;
  searchOnlineSkills(input: OnlineSkillSearchInput): Promise<OnlineSkillListResponse>;
  getOnlineSkill(id: string): Promise<OnlineSkillDetailResponse>;
  getOnlineSkillAudit(id: string): Promise<OnlineSkillAuditResponse>;
}
