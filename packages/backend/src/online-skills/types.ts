import type { PlatformSkillProvider } from '../platform-skills/types.js';

export type OnlineSkillProvider = PlatformSkillProvider;
export type OnlineSkillView = 'all-time' | 'trending' | 'hot';
export type OnlineSkillAuditStatus = 'unknown' | 'none' | 'available';
export type OnlineSkillsTokenSource = 'settings' | 'environment' | 'vercel_oidc' | 'none';

export interface OnlineSkill {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string | null;
  source: 'skills_sh';
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

export interface OnlineSkillsTokenConfig {
  tokenConfigured: boolean;
  tokenPreview: string | null;
  source: OnlineSkillsTokenSource;
  storedTokenConfigured: boolean;
  storedTokenPreview: string | null;
  environmentTokenConfigured: boolean;
  environmentTokenPreview: string | null;
  vercelOidcTokenConfigured: boolean;
  vercelOidcTokenPreview: string | null;
}

export interface SkillsShSkill {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  displayName?: unknown;
  title?: unknown;
  description?: unknown;
  desc?: unknown;
  summary?: unknown;
  source?: unknown;
  sourceType?: unknown;
  sourceUrl?: unknown;
  url?: unknown;
  installUrl?: unknown;
  install_url?: unknown;
  tags?: unknown;
  topics?: unknown;
  author?: unknown;
  owner?: unknown;
  stars?: unknown;
  installs?: unknown;
  updatedAt?: unknown;
  updated?: unknown;
  lastUpdatedAt?: unknown;
  isDuplicate?: unknown;
}

export interface SkillsShPagination {
  page?: unknown;
  per_page?: unknown;
  perPage?: unknown;
  limit?: unknown;
  total?: unknown;
  total_pages?: unknown;
  totalPages?: unknown;
  pages?: unknown;
}

export interface SkillsShListResponse {
  data?: SkillsShSkill[];
  skills?: SkillsShSkill[];
  results?: SkillsShSkill[];
  pagination?: SkillsShPagination;
  total?: unknown;
  page?: unknown;
  pages?: unknown;
  limit?: unknown;
  per_page?: unknown;
}

export interface SkillsShClientListInput {
  view: OnlineSkillView;
  page: number;
  limit: number;
}

export interface SkillsShClientSearchInput {
  q: string;
  limit: number;
}

export interface SkillsShClientLike {
  listSkills(input: SkillsShClientListInput): Promise<SkillsShListResponse>;
  searchSkills(input: SkillsShClientSearchInput): Promise<SkillsShListResponse>;
  getSkill(id: string): Promise<unknown>;
  getSkillAudit(id: string): Promise<unknown>;
}

export interface OnlineSkillsService {
  listOnlineSkills(input: OnlineSkillListInput): Promise<OnlineSkillListResponse>;
  searchOnlineSkills(input: OnlineSkillSearchInput): Promise<OnlineSkillListResponse>;
  getOnlineSkill(id: string): Promise<OnlineSkillDetailResponse>;
  getOnlineSkillAudit(id: string): Promise<OnlineSkillAuditResponse>;
}
