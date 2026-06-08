# Skills 官方 API 在线列表与终端安装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/skills` 默认页切换为通过后端代理调用 `skills.sh` 官方 token API 的在线 skills 列表，并继续用受限安装终端完成交互式安装。

**Architecture:** 后端新增 `online-skills` 子系统，负责 token、官方 API client、TTL 缓存、响应规范化和本地安装状态叠加。前端新增 `OnlineSkill` 类型和 API helper，把 Skills 页面主列表切到在线数据，安装按钮打开现有 `skills_install` 终端并预填安全安装命令。

**Tech Stack:** Node.js、Express、TypeScript、React 18、TanStack Query、xterm、node:test、Vite。

---

## 文件结构

- Create: `packages/backend/src/online-skills/types.ts`
  - 定义官方 API 原始响应的最小可用类型、OpenDeepSea 内部 `OnlineSkill`、查询参数、错误类型。
- Create: `packages/backend/src/online-skills/cache.ts`
  - 小型内存 TTL 缓存，支持 stale fallback。
- Create: `packages/backend/src/online-skills/client.ts`
  - 封装 `https://skills.sh/api/v1` 请求、Bearer token 注入、响应错误归一化。
- Create: `packages/backend/src/online-skills/service.ts`
  - 调用 client，规范化 skill 数据，生成安装命令，叠加本地平台安装状态。
- Create: `packages/backend/src/online-skills/routes.ts`
  - 暴露 `/api/online-skills`、`/search`、`/:id`、`/:id/audit`，并要求 local access token。
- Create: `packages/backend/src/online-skills/*.test.ts`
  - 覆盖缓存、client、service、routes。
- Modify: `packages/backend/src/routes.ts`
  - 挂载 `onlineSkillsRouter`。
- Modify: `packages/backend/src/terminal/restricted-skills-shell.test.ts`
  - 补 `npx skills add <installUrl> --skill <name>` 的允许用例。
- Modify: `packages/frontend/src/lib/types.ts`
  - 增加 `OnlineSkill`、`OnlineSkillListResponse`、`OnlineSkillAuditResponse`、`OnlineSkillView`。
- Modify: `packages/frontend/src/lib/api.ts`
  - 增加在线 skills API helper。
- Modify: `packages/frontend/src/components/TerminalPanel.tsx`
  - 增加 `initialInput`，用于预填命令但不自动回车执行。
- Modify: `packages/frontend/src/pages/SkillsPage.tsx`
  - 默认使用在线列表，保留本地平台扫描用于状态叠加和刷新。
- Modify: `packages/frontend/src/pages/SkillsPage.test.tsx`
  - 增加源代码级断言，确保在线列表 API、预填终端和 `skills_install` 边界存在。

## 实施约束

- 不提交当前工作区已有的无关改动；每个提交都使用路径限定。
- 不把 token 写入前端类型、localStorage、终端环境或日志。
- 不在 `/skills` 使用 `project_shell`。
- 不接入网页爬取源。
- 安装成功判断以本地三平台重新扫描结果为准。

---

### Task 1: 后端在线 skills 基础类型、缓存和官方 API client

**Files:**
- Create: `packages/backend/src/online-skills/types.ts`
- Create: `packages/backend/src/online-skills/cache.ts`
- Create: `packages/backend/src/online-skills/client.ts`
- Test: `packages/backend/src/online-skills/cache.test.ts`
- Test: `packages/backend/src/online-skills/client.test.ts`

- [ ] **Step 1: 写缓存失败测试**

Create `packages/backend/src/online-skills/cache.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { TtlCache } from './cache.js';

test('TtlCache returns fresh values before ttl expires', () => {
  let now = 1_000;
  const cache = new TtlCache<string, number>({ now: () => now });

  cache.set('skills', 42, 100);

  assert.equal(cache.get('skills')?.value, 42);
  assert.equal(cache.get('skills')?.stale, false);

  now = 1_050;
  assert.equal(cache.get('skills')?.value, 42);
  assert.equal(cache.get('skills')?.stale, false);
});

test('TtlCache exposes stale values after ttl expires', () => {
  let now = 1_000;
  const cache = new TtlCache<string, number>({ now: () => now });

  cache.set('skills', 42, 100);
  now = 1_101;

  const entry = cache.get('skills');
  assert.equal(entry?.value, 42);
  assert.equal(entry?.stale, true);
});

test('TtlCache delete removes cached values', () => {
  const cache = new TtlCache<string, number>();

  cache.set('skills', 42, 100);
  cache.delete('skills');

  assert.equal(cache.get('skills'), null);
});
```

- [ ] **Step 2: 写 client 失败测试**

Create `packages/backend/src/online-skills/client.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SkillsShClient,
  getSkillsShBearerTokenFromEnv,
  type SkillsShFetch,
} from './client.js';

test('getSkillsShBearerTokenFromEnv prefers explicit skills token and trims values', () => {
  const env = {
    SKILLS_SH_API_TOKEN: '  explicit-token  ',
    VERCEL_OIDC_TOKEN: 'oidc-token',
  };

  assert.equal(getSkillsShBearerTokenFromEnv(env), 'explicit-token');
});

test('getSkillsShBearerTokenFromEnv falls back to VERCEL_OIDC_TOKEN', () => {
  const env = {
    VERCEL_OIDC_TOKEN: '  oidc-token  ',
  };

  assert.equal(getSkillsShBearerTokenFromEnv(env), 'oidc-token');
});

test('SkillsShClient sends bearer token and parses list responses', async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl: SkillsShFetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get('Authorization'),
    });
    return new Response(JSON.stringify({
      skills: [
        {
          id: 'anthropics/docx',
          name: 'docx',
          description: 'Create and edit Word documents.',
          installUrl: 'https://skills.sh/anthropics/skills/docx',
          tags: ['documents'],
          author: 'anthropics',
          stars: 123,
          installs: 456,
          updatedAt: '2026-06-08T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pages: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new SkillsShClient({
    baseUrl: 'https://skills.test/api/v1',
    fetchImpl,
    tokenProvider: () => 'secret-token',
  });

  const result = await client.listSkills({ view: 'all-time', page: 1, limit: 30 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://skills.test/api/v1/skills?view=all-time&page=1&limit=30');
  assert.equal(calls[0]?.authorization, 'Bearer secret-token');
  assert.equal(result.skills[0]?.id, 'anthropics/docx');
});

test('SkillsShClient maps missing token to token_missing without leaking Authorization', async () => {
  const client = new SkillsShClient({
    baseUrl: 'https://skills.test/api/v1',
    fetchImpl: async () => new Response('{}', { status: 200 }),
    tokenProvider: () => null,
  });

  await assert.rejects(
    () => client.searchSkills({ q: 'browser', page: 1, limit: 30 }),
    (error: unknown) => {
      assert.equal((error as Error).message, 'token_missing');
      return true;
    },
  );
});

test('SkillsShClient maps audit 404 to audit_not_found', async () => {
  const client = new SkillsShClient({
    baseUrl: 'https://skills.test/api/v1',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    tokenProvider: () => 'secret-token',
  });

  await assert.rejects(
    () => client.getSkillAudit('anthropics/docx'),
    (error: unknown) => {
      assert.equal((error as Error).message, 'audit_not_found');
      return true;
    },
  );
});
```

- [ ] **Step 3: 运行失败测试**

Run:

```bash
npm run test -w @openclaw-room/backend -- src/online-skills/cache.test.ts src/online-skills/client.test.ts
```

Expected: FAIL because `cache.ts` and `client.ts` do not exist.

- [ ] **Step 4: 实现类型、缓存和 client**

Create `packages/backend/src/online-skills/types.ts`:

```ts
export type OnlineSkillProvider = 'codex' | 'claudecode' | 'opencode';
export type OnlineSkillView = 'all-time' | 'trending' | 'hot';
export type OnlineSkillAuditStatus = 'unknown' | 'none' | 'available';

export interface OnlineSkill {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: 'skills_sh';
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
}

export interface OnlineSkillListResponse {
  skills: OnlineSkill[];
  total: number;
  page: number;
  pages: number;
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
  status: 'none' | 'available';
  audit: unknown | null;
  stale: boolean;
  updatedAt: number;
}

export interface SkillsShSkill {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  description?: unknown;
  desc?: unknown;
  sourceUrl?: unknown;
  url?: unknown;
  installUrl?: unknown;
  install_url?: unknown;
  tags?: unknown;
  author?: unknown;
  owner?: unknown;
  stars?: unknown;
  installs?: unknown;
  updatedAt?: unknown;
  updated?: unknown;
}

export interface SkillsShListResponse {
  skills?: unknown;
  results?: unknown;
  total?: unknown;
  page?: unknown;
  pages?: unknown;
}

export interface SkillsShClientListInput {
  view: OnlineSkillView;
  page: number;
  limit: number;
}

export interface SkillsShClientSearchInput {
  q: string;
  page: number;
  limit: number;
}
```

Create `packages/backend/src/online-skills/cache.ts`:

```ts
interface TtlCacheOptions {
  now?: () => number;
}

export interface TtlCacheEntry<T> {
  value: T;
  stale: boolean;
  expiresAt: number;
  updatedAt: number;
}

export class TtlCache<K, V> {
  private readonly values = new Map<K, { value: V; expiresAt: number; updatedAt: number }>();
  private readonly now: () => number;

  constructor(options: TtlCacheOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get(key: K): TtlCacheEntry<V> | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    const current = this.now();
    return {
      value: entry.value,
      stale: current > entry.expiresAt,
      expiresAt: entry.expiresAt,
      updatedAt: entry.updatedAt,
    };
  }

  set(key: K, value: V, ttlMs: number): void {
    const current = this.now();
    this.values.set(key, {
      value,
      updatedAt: current,
      expiresAt: current + Math.max(0, ttlMs),
    });
  }

  delete(key: K): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}
```

Create `packages/backend/src/online-skills/client.ts`:

```ts
import type {
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

export class SkillsShClient {
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
      limit: String(input.limit),
    });
    return this.getJson<SkillsShListResponse>(`/skills?${params.toString()}`);
  }

  async searchSkills(input: SkillsShClientSearchInput): Promise<SkillsShListResponse> {
    const params = new URLSearchParams({
      q: input.q,
      page: String(input.page),
      limit: String(input.limit),
    });
    return this.getJson<SkillsShListResponse>(`/skills/search?${params.toString()}`);
  }

  async getSkill(id: string): Promise<unknown> {
    return this.getJson<unknown>(`/skills/${encodeURIComponent(id)}`);
  }

  async getSkillAudit(id: string): Promise<unknown> {
    return this.getJson<unknown>(`/skills/audit/${encodeURIComponent(id)}`);
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
    if (res.status === 429) throw new Error('upstream_rate_limited');
    if (!res.ok) throw new Error('upstream_unavailable');

    return await res.json() as T;
  }
}

export function getSkillsShBearerTokenFromEnv(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.SKILLS_SH_API_TOKEN?.trim();
  if (explicit) return explicit;
  const oidc = env.VERCEL_OIDC_TOKEN?.trim();
  return oidc || null;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
npm run test -w @openclaw-room/backend -- src/online-skills/cache.test.ts src/online-skills/client.test.ts
```

Expected: PASS.

- [ ] **Step 6: 提交 Task 1**

Run:

```bash
git add packages/backend/src/online-skills/types.ts \
  packages/backend/src/online-skills/cache.ts \
  packages/backend/src/online-skills/client.ts \
  packages/backend/src/online-skills/cache.test.ts \
  packages/backend/src/online-skills/client.test.ts
git commit -m "feat(skills): 添加官方 API 客户端"
```

---

### Task 2: 后端 service 规范化响应、缓存和本地安装状态叠加

**Files:**
- Create: `packages/backend/src/online-skills/service.ts`
- Test: `packages/backend/src/online-skills/service.test.ts`

- [ ] **Step 1: 写 service 失败测试**

Create `packages/backend/src/online-skills/service.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOnlineSkillsService, normalizeSkillsShSkill } from './service.js';

const testHome = mkdtempSync(join(tmpdir(), 'opendeepsea-online-skills-service-home-'));
process.env.HOME = testHome;
process.env.CODEX_HOME = join(testHome, '.codex');

test('normalizeSkillsShSkill maps official fields and generates a safe install command', () => {
  const skill = normalizeSkillsShSkill({
    id: 'anthropics/docx',
    name: 'docx',
    description: 'Create and edit Word documents.',
    installUrl: 'https://skills.sh/anthropics/skills/docx',
    tags: ['documents'],
    author: 'anthropics',
    stars: 123,
    installs: 456,
    updatedAt: '2026-06-08T00:00:00.000Z',
  }, []);

  assert.equal(skill.id, 'anthropics/docx');
  assert.equal(skill.displayName, 'docx');
  assert.equal(skill.description, 'Create and edit Word documents.');
  assert.equal(skill.source, 'skills_sh');
  assert.equal(skill.installUrl, 'https://skills.sh/anthropics/skills/docx');
  assert.equal(skill.installCommand, 'npx skills add https://skills.sh/anthropics/skills/docx --skill docx');
  assert.deepEqual(skill.tags, ['documents']);
  assert.deepEqual(skill.installedProviders, []);
});

test('online skills service overlays installed platform providers by skill name', async () => {
  createPlatformSkill('codex', 'docx', 'Installed docx skill.');
  const service = createOnlineSkillsService({
    client: {
      listSkills: async () => ({
        skills: [
          {
            id: 'anthropics/docx',
            name: 'docx',
            description: 'Create and edit Word documents.',
            installUrl: 'https://skills.sh/anthropics/skills/docx',
          },
        ],
        total: 1,
        page: 1,
        pages: 1,
      }),
      searchSkills: async () => ({ skills: [], total: 0, page: 1, pages: 1 }),
      getSkill: async () => ({}),
      getSkillAudit: async () => ({}),
    },
    now: () => 1_780_000_000_000,
  });

  const result = await service.listOnlineSkills({ view: 'all-time', page: 1, limit: 30 });

  assert.equal(result.skills.length, 1);
  assert.deepEqual(result.skills[0]?.installedProviders, ['codex']);
  assert.equal(result.stale, false);
  assert.equal(result.updatedAt, 1_780_000_000_000);
});

test('online skills service returns stale cached list when upstream fails after a fresh load', async () => {
  let calls = 0;
  const service = createOnlineSkillsService({
    client: {
      listSkills: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            skills: [{ id: 'anthropics/docx', name: 'docx', installUrl: 'https://skills.sh/anthropics/skills/docx' }],
            total: 1,
            page: 1,
            pages: 1,
          };
        }
        throw new Error('upstream_unavailable');
      },
      searchSkills: async () => ({ skills: [], total: 0, page: 1, pages: 1 }),
      getSkill: async () => ({}),
      getSkillAudit: async () => ({}),
    },
    now: () => 1_780_000_000_000,
  });

  await service.listOnlineSkills({ view: 'all-time', page: 1, limit: 30 });
  const stale = await service.listOnlineSkills({ view: 'all-time', page: 1, limit: 30, forceRefresh: true });

  assert.equal(stale.stale, true);
  assert.equal(stale.skills[0]?.name, 'docx');
});

function createPlatformSkill(provider: 'codex' | 'claudecode' | 'opencode', name: string, description: string): void {
  const root = provider === 'codex'
    ? join(process.env.CODEX_HOME!, 'skills')
    : provider === 'claudecode'
      ? join(testHome, '.claude', 'skills')
      : join(testHome, '.config', 'opencode', 'skills');
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `Use ${name}.`,
    '',
  ].join('\n'));
}
```

- [ ] **Step 2: 运行失败测试**

Run:

```bash
npm run test -w @openclaw-room/backend -- src/online-skills/service.test.ts
```

Expected: FAIL because `service.ts` does not exist.

- [ ] **Step 3: 实现 service**

Create `packages/backend/src/online-skills/service.ts`:

```ts
import { listPlatformSkillAggregates } from '../platform-skills/service.js';
import type { PlatformSkillProvider } from '../platform-skills/types.js';
import { parseRestrictedSkillsCommand } from '../terminal/restricted-skills-shell.js';
import { TtlCache } from './cache.js';
import { SkillsShClient } from './client.js';
import type {
  OnlineSkill,
  OnlineSkillAuditResponse,
  OnlineSkillDetailResponse,
  OnlineSkillListResponse,
  OnlineSkillView,
  SkillsShListResponse,
  SkillsShSkill,
} from './types.js';

interface SkillsShClientLike {
  listSkills(input: { view: OnlineSkillView; page: number; limit: number }): Promise<SkillsShListResponse>;
  searchSkills(input: { q: string; page: number; limit: number }): Promise<SkillsShListResponse>;
  getSkill(id: string): Promise<unknown>;
  getSkillAudit(id: string): Promise<unknown>;
}

interface OnlineSkillsServiceOptions {
  client?: SkillsShClientLike;
  now?: () => number;
}

interface ListInput {
  view: OnlineSkillView;
  page: number;
  limit: number;
  forceRefresh?: boolean;
}

interface SearchInput {
  q: string;
  page: number;
  limit: number;
  forceRefresh?: boolean;
}

const LIST_TTL_MS = 60_000;
const DETAIL_TTL_MS = 5 * 60_000;
const AUDIT_TTL_MS = 5 * 60_000;

export function createOnlineSkillsService(options: OnlineSkillsServiceOptions = {}) {
  const client = options.client ?? new SkillsShClient();
  const now = options.now ?? Date.now;
  const listCache = new TtlCache<string, OnlineSkillListResponse>({ now });
  const detailCache = new TtlCache<string, OnlineSkillDetailResponse>({ now });
  const auditCache = new TtlCache<string, OnlineSkillAuditResponse>({ now });

  async function installedProvidersFor(rawSkills: SkillsShSkill[]): Promise<Map<string, PlatformSkillProvider[]>> {
    const aggregates = await listPlatformSkillAggregates();
    const byName = new Map<string, PlatformSkillProvider[]>();
    for (const aggregate of aggregates) {
      for (const key of skillLookupKeys({ id: aggregate.name, name: aggregate.name, displayName: aggregate.displayName })) {
        byName.set(key, aggregate.providers);
      }
    }

    const result = new Map<string, PlatformSkillProvider[]>();
    for (const raw of rawSkills) {
      const providers = new Set<PlatformSkillProvider>();
      for (const key of skillLookupKeys(raw)) {
        for (const provider of byName.get(key) ?? []) providers.add(provider);
      }
      const id = stringValue(raw.id) || stringValue(raw.name);
      if (id) result.set(id, [...providers]);
    }
    return result;
  }

  async function normalizeList(raw: SkillsShListResponse, stale: boolean): Promise<OnlineSkillListResponse> {
    const rawSkills = arrayValue(raw.skills) || arrayValue(raw.results) || [];
    const providerMap = await installedProvidersFor(rawSkills as SkillsShSkill[]);
    const skills = (rawSkills as SkillsShSkill[]).map((item) => {
      const id = stringValue(item.id) || stringValue(item.name) || 'unknown-skill';
      return normalizeSkillsShSkill(item, providerMap.get(id) ?? []);
    });
    return {
      skills,
      total: numberValue(raw.total) ?? skills.length,
      page: numberValue(raw.page) ?? 1,
      pages: numberValue(raw.pages) ?? 1,
      stale,
      updatedAt: now(),
    };
  }

  return {
    async listOnlineSkills(input: ListInput): Promise<OnlineSkillListResponse> {
      const cacheKey = `list:${input.view}:${input.page}:${input.limit}`;
      const cached = listCache.get(cacheKey);
      if (cached && !cached.stale && !input.forceRefresh) return cached.value;
      try {
        const normalized = await normalizeList(await client.listSkills(input), false);
        listCache.set(cacheKey, normalized, LIST_TTL_MS);
        return normalized;
      } catch (error) {
        if (cached) return { ...cached.value, stale: true, updatedAt: cached.updatedAt };
        throw error;
      }
    },

    async searchOnlineSkills(input: SearchInput): Promise<OnlineSkillListResponse> {
      const cacheKey = `search:${input.q}:${input.page}:${input.limit}`;
      const cached = listCache.get(cacheKey);
      if (cached && !cached.stale && !input.forceRefresh) return cached.value;
      try {
        const normalized = await normalizeList(await client.searchSkills(input), false);
        listCache.set(cacheKey, normalized, LIST_TTL_MS);
        return normalized;
      } catch (error) {
        if (cached) return { ...cached.value, stale: true, updatedAt: cached.updatedAt };
        throw error;
      }
    },

    async getOnlineSkill(id: string): Promise<OnlineSkillDetailResponse> {
      const cached = detailCache.get(id);
      if (cached && !cached.stale) return cached.value;
      const raw = await client.getSkill(id) as SkillsShSkill;
      const normalized = {
        skill: normalizeSkillsShSkill(raw, (await installedProvidersFor([raw])).get(stringValue(raw.id) || id) ?? []),
        stale: false,
        updatedAt: now(),
      };
      detailCache.set(id, normalized, DETAIL_TTL_MS);
      return normalized;
    },

    async getOnlineSkillAudit(id: string): Promise<OnlineSkillAuditResponse> {
      const cached = auditCache.get(id);
      if (cached && !cached.stale) return cached.value;
      try {
        const response = {
          id,
          status: 'available' as const,
          audit: await client.getSkillAudit(id),
          stale: false,
          updatedAt: now(),
        };
        auditCache.set(id, response, AUDIT_TTL_MS);
        return response;
      } catch (error) {
        if ((error as Error).message !== 'audit_not_found') throw error;
        const response = { id, status: 'none' as const, audit: null, stale: false, updatedAt: now() };
        auditCache.set(id, response, AUDIT_TTL_MS);
        return response;
      }
    },
  };
}

export const onlineSkillsService = createOnlineSkillsService();

export function normalizeSkillsShSkill(raw: SkillsShSkill, installedProviders: PlatformSkillProvider[]): OnlineSkill {
  const id = stringValue(raw.id) || stringValue(raw.name) || 'unknown-skill';
  const name = stringValue(raw.name) || lastPathPart(id);
  const installUrl = stringValue(raw.installUrl) || stringValue(raw.install_url) || stringValue(raw.sourceUrl) || stringValue(raw.url);
  const installCommand = buildInstallCommand(installUrl, name);
  return {
    id,
    name,
    displayName: stringValue(raw.displayName) || name,
    description: stringValue(raw.description) || stringValue(raw.desc),
    source: 'skills_sh',
    sourceUrl: stringValue(raw.sourceUrl) || stringValue(raw.url) || installUrl || `https://skills.sh/${encodeURIComponent(id)}`,
    installUrl,
    installCommand,
    tags: arrayValue(raw.tags).filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
    author: stringValue(raw.author) || stringValue(raw.owner),
    stars: numberValue(raw.stars),
    installs: numberValue(raw.installs),
    updatedAt: timestampValue(raw.updatedAt) ?? timestampValue(raw.updated),
    auditStatus: 'unknown',
    installedProviders,
  };
}

function buildInstallCommand(installUrl: string | null, name: string): string {
  const source = installUrl || name;
  const command = `npx skills add ${source} --skill ${name}`;
  parseRestrictedSkillsCommand(command);
  return command;
}

function skillLookupKeys(raw: Pick<SkillsShSkill, 'id' | 'name' | 'displayName'>): string[] {
  return [
    stringValue(raw.id),
    stringValue(raw.name),
    stringValue(raw.displayName),
    stringValue(raw.id).split('/').at(-1) ?? null,
  ]
    .filter((item): item is string => Boolean(item))
    .map((item) => item.trim().toLowerCase());
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function timestampValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function lastPathPart(value: string): string {
  return value.split('/').filter(Boolean).at(-1) ?? value;
}
```

- [ ] **Step 4: 运行 service 测试**

Run:

```bash
npm run test -w @openclaw-room/backend -- src/online-skills/service.test.ts
```

Expected: PASS.

- [ ] **Step 5: 提交 Task 2**

Run:

```bash
git add packages/backend/src/online-skills/service.ts \
  packages/backend/src/online-skills/service.test.ts
git commit -m "feat(skills): 规范化官方在线 skills"
```

---

### Task 3: 后端 online-skills routes 和全局路由挂载

**Files:**
- Create: `packages/backend/src/online-skills/routes.ts`
- Test: `packages/backend/src/online-skills/routes.test.ts`
- Modify: `packages/backend/src/routes.ts`

- [ ] **Step 1: 写 routes 失败测试**

Create `packages/backend/src/online-skills/routes.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-online-routes-db-')), 'test.db');
process.env.OPENDEEPSEA_LOCAL_TOKEN = 'online-routes-token';
process.env.SKILLS_SH_API_TOKEN = 'route-token';

const { createOnlineSkillsRouter } = await import('./routes.js');
const express = (await import('express')).default;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/online-skills', createOnlineSkillsRouter({
    service: {
      listOnlineSkills: async () => ({
        skills: [{
          id: 'anthropics/docx',
          name: 'docx',
          displayName: 'docx',
          description: 'Create and edit Word documents.',
          source: 'skills_sh',
          sourceUrl: 'https://skills.sh/anthropics/skills/docx',
          installUrl: 'https://skills.sh/anthropics/skills/docx',
          installCommand: 'npx skills add https://skills.sh/anthropics/skills/docx --skill docx',
          tags: ['documents'],
          author: 'anthropics',
          stars: 123,
          installs: 456,
          updatedAt: 1_780_000_000_000,
          auditStatus: 'unknown',
          installedProviders: [],
        }],
        total: 1,
        page: 1,
        pages: 1,
        stale: false,
        updatedAt: 1_780_000_000_000,
      }),
      searchOnlineSkills: async (input: { q: string }) => ({
        skills: [],
        total: input.q === 'browser' ? 0 : 1,
        page: 1,
        pages: 1,
        stale: false,
        updatedAt: 1_780_000_000_000,
      }),
      getOnlineSkill: async (id: string) => ({
        skill: {
          id,
          name: 'docx',
          displayName: 'docx',
          description: null,
          source: 'skills_sh',
          sourceUrl: 'https://skills.sh/anthropics/skills/docx',
          installUrl: 'https://skills.sh/anthropics/skills/docx',
          installCommand: 'npx skills add https://skills.sh/anthropics/skills/docx --skill docx',
          tags: [],
          author: null,
          stars: null,
          installs: null,
          updatedAt: null,
          auditStatus: 'unknown',
          installedProviders: [],
        },
        stale: false,
        updatedAt: 1_780_000_000_000,
      }),
      getOnlineSkillAudit: async (id: string) => ({
        id,
        status: 'none',
        audit: null,
        stale: false,
        updatedAt: 1_780_000_000_000,
      }),
    },
  }));
  return app;
}

async function request(path: string, init: RequestInit = {}, options: { localToken?: boolean } = {}): Promise<Response> {
  const server = createApp().listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (options.localToken !== false) {
      headers.set('X-OpenDeepSea-Local-Token', 'online-routes-token');
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('online skills routes require local access token', async () => {
  const res = await request('/api/online-skills', {}, { localToken: false });
  assert.equal(res.status, 403);
});

test('online skills routes list official skills', async () => {
  const res = await request('/api/online-skills?view=all-time&page=1&limit=30');
  assert.equal(res.status, 200);
  const body = await res.json() as { skills: Array<{ id: string; installCommand: string }>; stale: boolean };
  assert.equal(body.skills[0]?.id, 'anthropics/docx');
  assert.equal(body.skills[0]?.installCommand, 'npx skills add https://skills.sh/anthropics/skills/docx --skill docx');
  assert.equal(body.stale, false);
});

test('online skills search requires a non-empty query', async () => {
  const res = await request('/api/online-skills/search?q=');
  assert.equal(res.status, 400);
});

test('online skills audit returns no audit state', async () => {
  const res = await request('/api/online-skills/anthropics%2Fdocx/audit');
  assert.equal(res.status, 200);
  const body = await res.json() as { status: string; audit: unknown };
  assert.equal(body.status, 'none');
  assert.equal(body.audit, null);
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```bash
npm run test -w @openclaw-room/backend -- src/online-skills/routes.test.ts
```

Expected: FAIL because `routes.ts` does not exist.

- [ ] **Step 3: 实现 routes**

Create `packages/backend/src/online-skills/routes.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateLocalAccess } from '../local-access.js';
import { onlineSkillsService } from './service.js';
import type {
  OnlineSkillAuditResponse,
  OnlineSkillDetailResponse,
  OnlineSkillListResponse,
  OnlineSkillView,
} from './types.js';

interface OnlineSkillsServiceLike {
  listOnlineSkills(input: { view: OnlineSkillView; page: number; limit: number }): Promise<OnlineSkillListResponse>;
  searchOnlineSkills(input: { q: string; page: number; limit: number }): Promise<OnlineSkillListResponse>;
  getOnlineSkill(id: string): Promise<OnlineSkillDetailResponse>;
  getOnlineSkillAudit(id: string): Promise<OnlineSkillAuditResponse>;
}

interface OnlineSkillsRouterOptions {
  service?: OnlineSkillsServiceLike;
}

const listQuerySchema = z.object({
  view: z.enum(['all-time', 'trending', 'hot']).default('all-time'),
  page: z.coerce.number().int().min(1).max(50).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1),
  page: z.coerce.number().int().min(1).max(50).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const onlineSkillsRouter = createOnlineSkillsRouter();

export function createOnlineSkillsRouter(options: OnlineSkillsRouterOptions = {}): Router {
  const router = Router();
  const service = options.service ?? onlineSkillsService;

  router.use((req, res, next) => {
    if (!requireLocalAccess(req, res)) return;
    next();
  });

  router.get('/', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    await respondOnlineSkills(res, () => service.listOnlineSkills(parsed.data));
  });

  router.get('/search', async (req, res) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    await respondOnlineSkills(res, () => service.searchOnlineSkills(parsed.data));
  });

  router.get('/:id/audit', async (req, res) => {
    await respondOnlineSkills(res, () => service.getOnlineSkillAudit(req.params.id));
  });

  router.get('/:id', async (req, res) => {
    await respondOnlineSkills(res, () => service.getOnlineSkill(req.params.id));
  });

  return router;
}

async function respondOnlineSkills<T>(res: Response, load: () => Promise<T>): Promise<void> {
  try {
    res.json(await load());
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'token_missing') return void res.status(503).json({ error: 'token_missing' });
    if (message === 'upstream_rate_limited') return void res.status(429).json({ error: 'upstream_rate_limited' });
    if (message === 'audit_not_found') return void res.status(404).json({ error: 'audit_not_found' });
    res.status(502).json({ error: 'upstream_unavailable' });
  }
}

function requireLocalAccess(req: Request, res: Response): boolean {
  const auth = validateLocalAccess(req);
  if (auth.ok) return true;
  res.status(auth.status).json({ error: auth.error });
  return false;
}
```

- [ ] **Step 4: 挂载全局路由**

Modify `packages/backend/src/routes.ts` near the existing platform skills imports:

```ts
import { onlineSkillsRouter } from './online-skills/routes.js';
import { platformSkillsRouter } from './platform-skills/routes.js';
```

Modify the router setup:

```ts
export const router = Router();
router.use('/online-skills', onlineSkillsRouter);
router.use('/platform-skills', platformSkillsRouter);
router.use('/terminals', terminalRouter);
```

- [ ] **Step 5: 运行 routes 测试**

Run:

```bash
npm run test -w @openclaw-room/backend -- src/online-skills/routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: 提交 Task 3**

Run:

```bash
git add packages/backend/src/online-skills/routes.ts \
  packages/backend/src/online-skills/routes.test.ts \
  packages/backend/src/routes.ts
git commit -m "feat(skills): 暴露官方在线 skills 路由"
```

---

### Task 4: 受限终端命令兼容和 TerminalPanel 预填命令

**Files:**
- Modify: `packages/backend/src/terminal/restricted-skills-shell.test.ts`
- Modify: `packages/frontend/src/components/TerminalPanel.tsx`
- Test: `packages/frontend/src/pages/SkillsPage.test.tsx`

- [ ] **Step 1: 补受限终端安装命令测试**

Modify `packages/backend/src/terminal/restricted-skills-shell.test.ts` inside `restricted skills shell accepts npx skills commands`:

```ts
  assert.deepEqual(parseRestrictedSkillsCommand('npx skills add https://skills.sh/anthropics/skills/docx --skill docx'), {
    kind: 'spawn',
    file: 'npx',
    args: ['skills', 'add', 'https://skills.sh/anthropics/skills/docx', '--skill', 'docx'],
  });
```

- [ ] **Step 2: 运行受限终端测试**

Run:

```bash
npm run test -w @openclaw-room/backend -- src/terminal/restricted-skills-shell.test.ts
```

Expected: PASS. Current parser already allows `add` arguments, this test locks the official install command shape.

- [ ] **Step 3: 给 TerminalPanel 增加 initialInput**

Modify `packages/frontend/src/components/TerminalPanel.tsx` props:

```ts
export interface TerminalPanelProps {
  profile: TerminalProfile;
  projectId?: string;
  title: string;
  className?: string;
  initialInput?: string;
  onClose?: () => void;
  onRefreshRequested?: () => void;
}
```

Modify function parameters:

```ts
export function TerminalPanel({
  profile,
  projectId,
  title,
  className,
  initialInput,
  onClose,
  onRefreshRequested,
}: TerminalPanelProps): JSX.Element {
```

Add a ref near `lastSentSizeRef`:

```ts
  const initialInputSentRef = useRef(false);
```

Reset it when creating a session:

```ts
    initialInputSentRef.current = false;
```

After `roomSocket.resizeTerminal(nextSessionId, currentSize.cols, currentSize.rows);`, add:

```ts
      const command = initialInput?.trim();
      if (command && !initialInputSentRef.current) {
        initialInputSentRef.current = true;
        roomSocket.sendTerminalInput(nextSessionId, command);
      }
```

Update the effect dependency:

```ts
  }, [profile, projectId, initialInput]);
```

- [ ] **Step 4: 补前端源代码测试断言**

Modify `packages/frontend/src/pages/SkillsPage.test.tsx` by adding:

```ts
test('TerminalPanel supports prefilled command input without exposing project shell', () => {
  const terminalSource = readFileSync(new URL('../components/TerminalPanel.tsx', import.meta.url), 'utf8');

  assert.match(terminalSource, /initialInput\?: string/);
  assert.match(terminalSource, /roomSocket\.sendTerminalInput\(nextSessionId, command\)/);
  assert.doesNotMatch(terminalSource, /command \\+ ['"]\\n['"]/);
});
```

- [ ] **Step 5: 运行前端源代码测试**

Run:

```bash
node --import tsx --test packages/frontend/src/pages/SkillsPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: 提交 Task 4**

Run:

```bash
git add packages/backend/src/terminal/restricted-skills-shell.test.ts \
  packages/frontend/src/components/TerminalPanel.tsx \
  packages/frontend/src/pages/SkillsPage.test.tsx
git commit -m "feat(skills): 支持安装终端预填命令"
```

---

### Task 5: 前端在线 skills API 类型和 helper

**Files:**
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/lib/api.ts`
- Modify: `packages/frontend/src/lib/api.test.ts`

- [ ] **Step 1: 写 API helper 源代码测试**

Modify `packages/frontend/src/lib/api.test.ts` by adding source-level checks:

```ts
test('api exposes online skills helpers through workspaceRequest', () => {
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

  assert.match(source, /listOnlineSkills/);
  assert.match(source, /searchOnlineSkills/);
  assert.match(source, /getOnlineSkillAudit/);
  assert.match(source, /workspaceRequest<OnlineSkillListResponse>\(`\\/online-skills/);
});
```

If `api.test.ts` does not already import `readFileSync` or `test`, add:

```ts
import { readFileSync } from 'node:fs';
import test from 'node:test';
```

- [ ] **Step 2: 运行失败测试**

Run:

```bash
node --import tsx --test packages/frontend/src/lib/api.test.ts
```

Expected: FAIL because online skills helpers are not present.

- [ ] **Step 3: 增加前端类型**

Modify `packages/frontend/src/lib/types.ts` after platform skill types:

```ts
export type OnlineSkillView = 'all-time' | 'trending' | 'hot';
export type OnlineSkillAuditStatus = 'unknown' | 'none' | 'available';

export interface OnlineSkill {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: 'skills_sh';
  sourceUrl: string;
  installUrl: string | null;
  installCommand: string;
  tags: string[];
  author: string | null;
  stars: number | null;
  installs: number | null;
  updatedAt: number | null;
  auditStatus: OnlineSkillAuditStatus;
  installedProviders: PlatformSkillProvider[];
}

export interface OnlineSkillListResponse {
  skills: OnlineSkill[];
  total: number;
  page: number;
  pages: number;
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
  status: 'none' | 'available';
  audit: unknown | null;
  stale: boolean;
  updatedAt: number;
}
```

- [ ] **Step 4: 增加 API helper**

Modify `packages/frontend/src/lib/api.ts` type imports:

```ts
  OnlineSkillAuditResponse,
  OnlineSkillDetailResponse,
  OnlineSkillListResponse,
  OnlineSkillView,
```

Add a local helper above `export const api = {`:

```ts
function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}
```

Add API methods near platform skills methods:

```ts
  listOnlineSkills: (input: { view?: OnlineSkillView; page?: number; limit?: number } = {}) =>
    workspaceRequest<OnlineSkillListResponse>(`/online-skills${buildQuery({
      view: input.view ?? 'all-time',
      page: input.page ?? 1,
      limit: input.limit ?? 30,
    })}`),
  searchOnlineSkills: (input: { q: string; page?: number; limit?: number }) =>
    workspaceRequest<OnlineSkillListResponse>(`/online-skills/search${buildQuery({
      q: input.q,
      page: input.page ?? 1,
      limit: input.limit ?? 30,
    })}`),
  getOnlineSkill: (id: string) =>
    workspaceRequest<OnlineSkillDetailResponse>(`/online-skills/${encodeURIComponent(id)}`),
  getOnlineSkillAudit: (id: string) =>
    workspaceRequest<OnlineSkillAuditResponse>(`/online-skills/${encodeURIComponent(id)}/audit`),
```

- [ ] **Step 5: 运行 API helper 测试**

Run:

```bash
node --import tsx --test packages/frontend/src/lib/api.test.ts
```

Expected: PASS.

- [ ] **Step 6: 提交 Task 5**

Run:

```bash
git add packages/frontend/src/lib/types.ts \
  packages/frontend/src/lib/api.ts \
  packages/frontend/src/lib/api.test.ts
git commit -m "feat(skills): 添加在线 skills 前端 API"
```

---

### Task 6: Skills 页面默认在线列表和安装按钮预填终端

**Files:**
- Modify: `packages/frontend/src/pages/SkillsPage.tsx`
- Modify: `packages/frontend/src/pages/SkillsPage.css`
- Modify: `packages/frontend/src/pages/SkillsPage.test.tsx`

- [ ] **Step 1: 写 SkillsPage 行为源代码测试**

Modify `packages/frontend/src/pages/SkillsPage.test.tsx` by adding:

```ts
test('SkillsPage defaults to official online skills list', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /api\.listOnlineSkills/);
  assert.match(source, /api\.searchOnlineSkills/);
  assert.match(source, /online-skills', 'list'/);
  assert.match(source, /onlineSkill\.installCommand/);
  assert.match(source, /initialInput=\{initialCommand\}/);
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```bash
node --import tsx --test packages/frontend/src/pages/SkillsPage.test.tsx
```

Expected: FAIL because SkillsPage still defaults to platform aggregate records.

- [ ] **Step 3: 引入在线类型并新增状态**

Modify imports in `packages/frontend/src/pages/SkillsPage.tsx`:

```ts
  OnlineSkill,
  OnlineSkillView,
```

Add state next to existing filters:

```ts
  const [onlineView, setOnlineView] = useState<OnlineSkillView>('all-time');
  const [initialInstallCommand, setInitialInstallCommand] = useState('');
```

- [ ] **Step 4: 增加在线 skills query**

Add after platform queries:

```ts
  const normalizedSearchQuery = searchQuery.trim();
  const onlineSkillsQuery = useQuery({
    queryKey: ['online-skills', 'list', onlineView, normalizedSearchQuery],
    queryFn: () => normalizedSearchQuery
      ? api.searchOnlineSkills({ q: normalizedSearchQuery, page: 1, limit: 30 })
      : api.listOnlineSkills({ view: onlineView, page: 1, limit: 30 }),
  });
```

Change refresh to include online list:

```ts
  const refreshPlatformSkills = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['platform-skills', 'platforms'] });
    void queryClient.invalidateQueries({ queryKey: ['platform-skills', 'aggregate'] });
    void queryClient.invalidateQueries({ queryKey: ['online-skills'] });
  }, [queryClient]);
```

- [ ] **Step 5: 新增在线 record 转换**

Add near `toSkillRecord` helpers:

```ts
type OnlineSkillRecord = {
  onlineSkill: OnlineSkill;
  installed: boolean;
};

function filterOnlineSkills(
  skills: OnlineSkill[],
  filters: {
    statusFilter: MarketStatusFilter;
    sourceFilter: SourceFilter;
    categoryFilter: CategoryFilter;
    installedOnly: boolean;
  },
): OnlineSkillRecord[] {
  return skills
    .map((onlineSkill) => ({
      onlineSkill,
      installed: onlineSkill.installedProviders.length > 0,
    }))
    .filter((record) => {
      if (filters.installedOnly && !record.installed) return false;
      if (filters.statusFilter === 'installed' && !record.installed) return false;
      if (filters.sourceFilter !== 'all' && !record.onlineSkill.installedProviders.includes(filters.sourceFilter)) return false;
      if (filters.categoryFilter !== 'all' && !record.onlineSkill.tags.includes(filters.categoryFilter)) return false;
      return true;
    });
}
```

- [ ] **Step 6: 用在线数据驱动主面板**

In `SkillsPage`, add:

```ts
  const onlineSkills = onlineSkillsQuery.data?.skills ?? [];
  const onlineRecords = useMemo(() => filterOnlineSkills(onlineSkills, {
    statusFilter,
    sourceFilter,
    categoryFilter,
    installedOnly,
  }), [categoryFilter, installedOnly, onlineSkills, sourceFilter, statusFilter]);
  const onlineLoading = onlineSkillsQuery.isLoading && onlineRecords.length === 0;
  const onlineError = onlineSkillsQuery.error as Error | null;
```

Pass online props to `SkillsMarketPanel` and `SkillDetailsPanel`:

```tsx
        <SkillsMarketPanel
          records={filteredRecords}
          onlineRecords={onlineRecords}
          totalCount={onlineSkillsQuery.data?.total ?? metrics.total}
          loading={onlineLoading}
          error={onlineError}
          selectedName={selectedRecord?.aggregate.name ?? null}
          searchQuery={searchQuery}
          sourceFilter={sourceFilter}
          categoryFilter={categoryFilter}
          statusFilter={statusFilter}
          onlineView={onlineView}
          installedOnly={installedOnly}
          onSearchChange={setSearchQuery}
          onSourceChange={setSourceFilter}
          onCategoryChange={setCategoryFilter}
          onStatusChange={setStatusFilter}
          onOnlineViewChange={setOnlineView}
          onInstalledOnlyChange={setInstalledOnly}
          onSelect={setSelectedSkillName}
          onInstall={(skill) => {
            setInitialInstallCommand(skill.installCommand);
            setInstallerOpen(true);
          }}
        />
```

Update `SkillsInstallerDrawer` call:

```tsx
        <SkillsInstallerDrawer
          initialCommand={initialInstallCommand}
          onClose={() => setInstallerOpen(false)}
          onRefreshRequested={refreshPlatformSkills}
        />
```

- [ ] **Step 7: 扩展 SkillsMarketPanel props 和渲染**

Modify `SkillsMarketPanel` props to include:

```ts
  onlineRecords: OnlineSkillRecord[];
  onlineView: OnlineSkillView;
  onOnlineViewChange: (view: OnlineSkillView) => void;
  onInstall: (skill: OnlineSkill) => void;
```

Add view buttons near existing filters:

```tsx
        <div className="skills-online-views" role="group" aria-label="在线 Skills 视图">
          {(['all-time', 'trending', 'hot'] as OnlineSkillView[]).map((view) => (
            <button
              key={view}
              type="button"
              className={cn(view === onlineView && 'is-active')}
              onClick={() => onOnlineViewChange(view)}
            >
              {view === 'all-time' ? '全部' : view === 'trending' ? '趋势' : '热门'}
            </button>
          ))}
        </div>
```

Render online cards before the local fallback list:

```tsx
      {onlineRecords.length ? (
        <div className="skills-card-grid">
          {onlineRecords.map(({ onlineSkill }) => (
            <article key={onlineSkill.id} className="skill-card">
              <div className="skill-card__head">
                <h3>{onlineSkill.displayName}</h3>
                <span>{onlineSkill.author ?? 'skills.sh'}</span>
              </div>
              <p>{onlineSkill.description ?? '暂无描述'}</p>
              <div className="skill-card__tags">
                {onlineSkill.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}
              </div>
              <div className="skill-card__providers">
                {PROVIDERS.map((provider) => (
                  <span key={provider} className={cn(onlineSkill.installedProviders.includes(provider) && 'is-installed')}>
                    {providerLabel(provider)}
                  </span>
                ))}
              </div>
              <button type="button" onClick={() => onInstall(onlineSkill)}>
                <PackagePlus aria-hidden="true" />
                安装
              </button>
            </article>
          ))}
        </div>
      ) : null}
```

Keep the existing local list as fallback when `onlineRecords.length === 0`.

- [ ] **Step 8: 给安装抽屉传 initialInput**

Modify `SkillsInstallerDrawer` props:

```ts
function SkillsInstallerDrawer({
  initialCommand,
  onClose,
  onRefreshRequested,
}: {
  initialCommand: string;
  onClose: () => void;
  onRefreshRequested: () => void;
}): JSX.Element {
```

Pass to `TerminalPanel`:

```tsx
        <TerminalPanel
          profile="skills_install"
          title="Skills 安装终端"
          className="skills-terminal-panel"
          initialInput={initialCommand}
          onClose={onClose}
          onRefreshRequested={onRefreshRequested}
        />
```

- [ ] **Step 9: 增加最小 CSS**

Modify `packages/frontend/src/pages/SkillsPage.css`:

```css
.skills-online-views {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface);
}

.skills-online-views button {
  min-height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--color-fg-muted);
  font-size: 12px;
  cursor: pointer;
}

.skills-online-views button.is-active {
  background: var(--color-fg);
  color: var(--color-bg);
}

.skill-card__providers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.skill-card__providers span {
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 2px 6px;
  color: var(--color-fg-muted);
  font-size: 11px;
}

.skill-card__providers span.is-installed {
  border-color: rgba(34, 197, 94, 0.45);
  color: rgb(22, 101, 52);
  background: rgba(34, 197, 94, 0.08);
}
```

- [ ] **Step 10: 运行 SkillsPage 测试**

Run:

```bash
node --import tsx --test packages/frontend/src/pages/SkillsPage.test.tsx
```

Expected: PASS.

- [ ] **Step 11: 提交 Task 6**

Run:

```bash
git add packages/frontend/src/pages/SkillsPage.tsx \
  packages/frontend/src/pages/SkillsPage.css \
  packages/frontend/src/pages/SkillsPage.test.tsx
git commit -m "feat(skills): 默认展示官方在线列表"
```

---

### Task 7: 最终验证与验收记录

**Files:**
- Create: `docs/superpowers/verification/2026-06-08-Skills官方API在线列表与终端安装验收.md`

- [ ] **Step 1: 运行后端测试**

Run:

```bash
npm run test -w @openclaw-room/backend -- \
  src/online-skills/cache.test.ts \
  src/online-skills/client.test.ts \
  src/online-skills/service.test.ts \
  src/online-skills/routes.test.ts \
  src/terminal/restricted-skills-shell.test.ts
```

Expected: PASS.

- [ ] **Step 2: 运行前端源代码测试**

Run:

```bash
node --import tsx --test \
  packages/frontend/src/lib/api.test.ts \
  packages/frontend/src/pages/SkillsPage.test.tsx
```

Expected: PASS.

- [ ] **Step 3: 运行整体构建**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: 创建验收文档**

Create `docs/superpowers/verification/2026-06-08-Skills官方API在线列表与终端安装验收.md`:

```md
# Skills 官方 API 在线列表与终端安装验收

## 范围

- `/skills` 默认展示官方在线 skills 列表。
- 后端代理调用 `skills.sh` 官方 API，前端不接触 token。
- 安装入口仍使用 `skills_install` 受限终端。
- 本地 Codex、Claude Code、OpenCode 安装状态叠加到在线 skill。

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run test -w @openclaw-room/backend -- src/online-skills/cache.test.ts src/online-skills/client.test.ts src/online-skills/service.test.ts src/online-skills/routes.test.ts src/terminal/restricted-skills-shell.test.ts` | PASS |
| `node --import tsx --test packages/frontend/src/lib/api.test.ts packages/frontend/src/pages/SkillsPage.test.tsx` | PASS |
| `npm run build` | PASS |

## 手动验收

- 已确认 Skills 页面仍只传入 `profile="skills_install"`。
- 已确认安装命令通过 `initialInput` 预填，不自动追加换行执行。
- 已确认未在前端暴露 `VERCEL_OIDC_TOKEN` 或 `SKILLS_SH_API_TOKEN`。

## 备注

真实官方 API 请求依赖后端环境变量 `SKILLS_SH_API_TOKEN` 或 `VERCEL_OIDC_TOKEN`。未配置 token 时，页面显示配置错误。
```

- [ ] **Step 5: 提交最终验收文档**

Run:

```bash
git add docs/superpowers/verification/2026-06-08-Skills官方API在线列表与终端安装验收.md
git commit -m "docs(skills): 添加官方在线列表验收记录"
```

---

## 计划自检

- Spec 覆盖：
  - 官方 API token 后端代理：Task 1、Task 3。
  - 在线列表、搜索、详情、audit：Task 1、Task 2、Task 3。
  - 缓存和 stale fallback：Task 1、Task 2。
  - 本地安装状态叠加：Task 2、Task 6。
  - 受限终端安装和预填命令：Task 4、Task 6。
  - 前端默认在线列表：Task 5、Task 6。
  - 验证与验收记录：Task 7。
- 安全边界：
  - token 不进前端、不进终端环境、不进日志。
  - `/skills` 不暴露 `project_shell`。
  - 不使用网页爬取。
- 验证命令：
  - 后端定向测试。
  - 前端源代码测试。
  - 根目录 `npm run build`。
