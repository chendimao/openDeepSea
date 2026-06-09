# 知识库 Phase 4B 真实 Embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Phase 4A 的本地 hash embedding 骨架升级为可配置、可测试、可重建、可观测的真实 OpenAI-compatible embedding 最小闭环。

**Architecture:** 保留 SQLite `knowledge_chunk_embeddings` 作为当前 provider 单活存储；新增 embedding runtime config 和 provider registry，让 search/rebuild/Agent RAG 通过 registry 获取 provider，不再硬编码 `local-hash`。系统设置复用 active AI config 的 base URL/API key，并增加知识库 embedding 专用 provider/model/dimensions/env var 覆盖字段。

**Tech Stack:** Node.js、TypeScript、Express、SQLite/better-sqlite3、React 18、TanStack Query、Vite、node:test。

---

## 文件结构

- Modify: `packages/backend/src/db.ts` - settings 表新增 knowledge embedding 字段和兼容迁移。
- Modify: `packages/backend/src/types.ts` - 后端设置、前端共享类型新增 knowledge embedding 配置和状态类型。
- Modify: `packages/backend/src/repos/settings.ts` - 读取、更新、脱敏输出 knowledge embedding 设置。
- Modify: `packages/backend/src/repos/settings.test.ts` - settings 仓储测试。
- Modify: `packages/backend/src/knowledge-embedding.ts` - provider 接口支持 async，并保留 local hash provider。
- Create: `packages/backend/src/knowledge-embedding-provider.ts` - runtime config 解析、provider registry、OpenAI-compatible provider、provider test。
- Create: `packages/backend/src/knowledge-embedding-provider.test.ts` - provider registry 和 OpenAI-compatible 请求测试。
- Create: `packages/backend/src/knowledge-embedding-rebuild.ts` - project/source 级批量重建。
- Create: `packages/backend/src/knowledge-embedding-rebuild.test.ts` - rebuild 跳过、重建、失败隔离测试。
- Modify: `packages/backend/src/knowledge-search.ts` - 新增 async search，使用当前 provider 生成 query embedding。
- Modify: `packages/backend/src/knowledge-search.test.ts` - async search 和 provider fallback 测试。
- Modify: `packages/backend/src/knowledge-rag.ts` - Agent RAG 使用 async search，并记录 provider/model metadata。
- Modify: `packages/backend/src/knowledge-rag.test.ts` - usage metadata 测试。
- Modify: `packages/backend/src/knowledge-cli.ts` - CLI 输出 embedding provider/model。
- Modify: `packages/backend/src/knowledge-cli.test.ts` - CLI 输出测试。
- Modify: `packages/backend/src/knowledge-service.ts` - 暴露 embedding status/test/rebuild/search async 服务方法。
- Modify: `packages/backend/src/routes.ts` - 新增 embedding status/test/rebuild/settings route，search route 改 async。
- Modify: `packages/backend/src/knowledge.routes.test.ts` - API route 测试。
- Modify: `packages/frontend/src/lib/types.ts` - 前端共享类型新增 embedding 配置和状态。
- Modify: `packages/frontend/src/lib/knowledgeDisplay.ts` - provider/coverage 展示 helper。
- Modify: `packages/frontend/src/lib/knowledgeDisplay.test.ts` - helper 测试。
- Modify: `packages/frontend/src/lib/api.ts` - 新增 embedding API helper。
- Modify: `packages/frontend/src/lib/api.test.ts` - API helper 测试。
- Modify: `packages/frontend/src/pages/KnowledgePage.tsx` - `/knowledge` 最小索引状态入口。
- Modify: `packages/frontend/src/pages/KnowledgePage.test.tsx` - 页面 wiring 测试。
- Modify: `packages/frontend/src/components/SettingsDialogs.tsx` - 系统设置中新增 embedding 配置字段。
- Modify: `packages/frontend/src/components/SettingsDialogs.test.tsx` - 设置 wiring 测试。
- Create: `docs/superpowers/verification/2026-06-09-知识库Phase4B真实Embedding验收.md` - 验收记录。

---

### Task 1: Settings Schema and Repository

**Files:**
- Modify: `packages/backend/src/db.ts`
- Modify: `packages/backend/src/types.ts`
- Modify: `packages/backend/src/repos/settings.ts`
- Test: `packages/backend/src/repos/settings.test.ts`

- [x] **Step 1: Write failing settings repository test**

Add to `packages/backend/src/repos/settings.test.ts`:

```ts
test('settingsRepo stores knowledge embedding config while redacting credential source', () => {
  const updated = settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: 1536,
    knowledge_embedding_base_url: 'https://embeddings.example/v1',
    knowledge_embedding_api_key_env_var: 'OPENDEEPSEA_EMBEDDING_API_KEY',
  });

  assert.equal(updated.knowledge_embedding_provider, 'openai-compatible');
  assert.equal(updated.knowledge_embedding_model, 'text-embedding-3-small');
  assert.equal(updated.knowledge_embedding_dimensions, 1536);
  assert.equal(updated.knowledge_embedding_base_url, 'https://embeddings.example/v1');
  assert.equal(updated.knowledge_embedding_api_key_env_var, 'OPENDEEPSEA_EMBEDDING_API_KEY');

  const runtime = settingsRepo.getKnowledgeEmbeddingSettings();
  assert.deepEqual(runtime, {
    provider: 'openai-compatible',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    base_url: 'https://embeddings.example/v1',
    api_key: null,
    api_key_env_var: 'OPENDEEPSEA_EMBEDDING_API_KEY',
  });
});
```

- [x] **Step 2: Run failing test**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/repos/settings.test.ts
```

Expected: FAIL with TypeScript/runtime errors for missing `knowledge_embedding_*` fields and `getKnowledgeEmbeddingSettings()`.

- [x] **Step 3: Add backend types**

In `packages/backend/src/types.ts`, add:

```ts
export type KnowledgeEmbeddingProviderId = 'local-hash' | 'openai-compatible';

export interface KnowledgeEmbeddingSettings {
  provider: KnowledgeEmbeddingProviderId;
  model: string | null;
  dimensions: number | null;
  base_url: string | null;
  api_key: string | null;
  api_key_env_var: string | null;
}
```

Extend `SystemSettings` with safe fields:

```ts
knowledge_embedding_provider: KnowledgeEmbeddingProviderId;
knowledge_embedding_model: string | null;
knowledge_embedding_dimensions: number | null;
knowledge_embedding_base_url: string | null;
knowledge_embedding_api_key_env_var: string | null;
```

- [x] **Step 4: Add database columns and migrations**

In `packages/backend/src/db.ts`, add columns to `CREATE TABLE IF NOT EXISTS settings`:

```sql
knowledge_embedding_provider TEXT CHECK (knowledge_embedding_provider IN ('local-hash', 'openai-compatible')),
knowledge_embedding_model TEXT,
knowledge_embedding_dimensions INTEGER,
knowledge_embedding_api_key_env_var TEXT,
knowledge_embedding_base_url TEXT,
```

Add compatibility migrations near existing `settingsColumnNames` checks:

```ts
if (!settingsColumnNames.has('knowledge_embedding_provider')) {
  db.exec(`
    ALTER TABLE settings ADD COLUMN knowledge_embedding_provider TEXT
      CHECK (knowledge_embedding_provider IN ('local-hash', 'openai-compatible'))
  `);
}
if (!settingsColumnNames.has('knowledge_embedding_model')) {
  db.exec('ALTER TABLE settings ADD COLUMN knowledge_embedding_model TEXT');
}
if (!settingsColumnNames.has('knowledge_embedding_dimensions')) {
  db.exec('ALTER TABLE settings ADD COLUMN knowledge_embedding_dimensions INTEGER');
}
if (!settingsColumnNames.has('knowledge_embedding_api_key_env_var')) {
  db.exec('ALTER TABLE settings ADD COLUMN knowledge_embedding_api_key_env_var TEXT');
}
if (!settingsColumnNames.has('knowledge_embedding_base_url')) {
  db.exec('ALTER TABLE settings ADD COLUMN knowledge_embedding_base_url TEXT');
}
```

- [x] **Step 5: Implement settings repository support**

In `packages/backend/src/repos/settings.ts`, extend `SystemSettingsRow`:

```ts
knowledge_embedding_provider: KnowledgeEmbeddingProviderId | null;
knowledge_embedding_model: string | null;
knowledge_embedding_dimensions: number | null;
knowledge_embedding_api_key_env_var: string | null;
knowledge_embedding_base_url: string | null;
```

Add normalizers:

```ts
function normalizeKnowledgeEmbeddingProvider(value: string | null | undefined): KnowledgeEmbeddingProviderId {
  return value === 'openai-compatible' ? 'openai-compatible' : 'local-hash';
}

function normalizeKnowledgeEmbeddingDimensions(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 && normalized <= 8192 ? normalized : null;
}
```

Add `getKnowledgeEmbeddingSettings()` to `settingsRepo`:

```ts
getKnowledgeEmbeddingSettings(): KnowledgeEmbeddingSettings {
  normalizeLegacyRouting();
  const settings = getSystemRow();
  const activeAiConfig = resolveActiveAiConfig(settings);
  const provider = normalizeKnowledgeEmbeddingProvider(settings?.knowledge_embedding_provider);
  if (provider === 'local-hash') {
    return {
      provider,
      model: 'local-hash-v1',
      dimensions: normalizeKnowledgeEmbeddingDimensions(settings?.knowledge_embedding_dimensions) ?? 256,
      base_url: null,
      api_key: null,
      api_key_env_var: null,
    };
  }
  const envVar = normalizedOptionalString(settings?.knowledge_embedding_api_key_env_var);
  return {
    provider,
    model: normalizedOptionalString(settings?.knowledge_embedding_model),
    dimensions: normalizeKnowledgeEmbeddingDimensions(settings?.knowledge_embedding_dimensions),
    base_url: normalizedOptionalString(settings?.knowledge_embedding_base_url ?? activeAiConfig?.openai_base_url),
    api_key: envVar ? null : normalizedOptionalString(activeAiConfig?.openai_api_key ?? settings?.openai_api_key),
    api_key_env_var: envVar,
  };
}
```

- [x] **Step 6: Run settings test**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/repos/settings.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 1**

```bash
git add packages/backend/src/db.ts packages/backend/src/types.ts packages/backend/src/repos/settings.ts packages/backend/src/repos/settings.test.ts
git commit -m "feat(knowledge): 增加embedding配置存储"
```

---

### Task 2: Embedding Provider Registry

**Files:**
- Modify: `packages/backend/src/knowledge-embedding.ts`
- Create: `packages/backend/src/knowledge-embedding-provider.ts`
- Test: `packages/backend/src/knowledge-embedding-provider.test.ts`

- [x] **Step 1: Write failing provider tests**

Create `packages/backend/src/knowledge-embedding-provider.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-embedding-provider-')), 'test.db');

const { settingsRepo } = await import('./repos/settings.js');
const {
  createOpenAICompatibleEmbeddingProvider,
  getKnowledgeEmbeddingRuntime,
  testKnowledgeEmbeddingProvider,
} = await import('./knowledge-embedding-provider.js');

test('knowledge embedding runtime defaults to local hash', () => {
  const runtime = getKnowledgeEmbeddingRuntime();
  assert.equal(runtime.provider, 'local-hash');
  assert.equal(runtime.model, 'local-hash-v1');
  assert.equal(runtime.available, true);
});

test('openai-compatible embedding provider sends sanitized request and parses vector', async () => {
  const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
  const provider = createOpenAICompatibleEmbeddingProvider({
    baseUrl: 'https://embedding.example/v1',
    apiKey: 'sk-secret-value',
    model: 'text-embedding-3-small',
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as unknown,
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.deepEqual(await provider.embed('A12 验收'), [0.1, 0.2, 0.3]);
  assert.equal(requests[0]?.url, 'https://embedding.example/v1/embeddings');
  assert.equal(requests[0]?.authorization, 'Bearer sk-secret-value');
  assert.deepEqual(requests[0]?.body, { model: 'text-embedding-3-small', input: 'A12 验收' });
});

test('provider test uses active AI config and redacts upstream errors', async () => {
  settingsRepo.createAiConfig({
    name: 'Embedding Runtime',
    langchain_planner_model: 'planner',
    openai_api_key: 'sk-provider-secret',
    openai_base_url: 'https://embedding.example/v1',
  });
  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
  });

  const result = await testKnowledgeEmbeddingProvider({
    fetchImpl: async () => new Response('upstream sk-provider-secret failed', { status: 500 }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /HTTP 500/);
  assert.doesNotMatch(result.error ?? '', /sk-provider-secret/);
});
```

- [x] **Step 2: Run failing provider tests**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-embedding-provider.test.ts
```

Expected: FAIL because `knowledge-embedding-provider.ts` does not exist.

- [x] **Step 3: Make provider interface async-compatible**

In `packages/backend/src/knowledge-embedding.ts`, change:

```ts
embed(text: string): number[];
```

to:

```ts
embed(text: string, options?: { signal?: AbortSignal }): number[] | Promise<number[]>;
```

Keep `createLocalHashEmbeddingProvider()` returning a synchronous vector.

- [x] **Step 4: Create provider registry**

Create `packages/backend/src/knowledge-embedding-provider.ts` with:

```ts
import type { KnowledgeEmbeddingProvider } from './knowledge-embedding.js';
import { createLocalHashEmbeddingProvider } from './knowledge-embedding.js';
import { settingsRepo } from './repos/settings.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface KnowledgeEmbeddingRuntime {
  provider: 'local-hash' | 'openai-compatible';
  model: string;
  dimensions: number | null;
  base_url: string | null;
  api_key_set: boolean;
  api_key_env_var: string | null;
  available: boolean;
  unavailable_reason: string | null;
}

export function getKnowledgeEmbeddingRuntime(env: NodeJS.ProcessEnv = process.env): KnowledgeEmbeddingRuntime {
  const settings = settingsRepo.getKnowledgeEmbeddingSettings();
  if (settings.provider === 'local-hash') {
    return {
      provider: 'local-hash',
      model: 'local-hash-v1',
      dimensions: settings.dimensions ?? 256,
      base_url: null,
      api_key_set: false,
      api_key_env_var: null,
      available: true,
      unavailable_reason: null,
    };
  }
  const apiKey = settings.api_key_env_var ? env[settings.api_key_env_var]?.trim() : settings.api_key;
  const available = Boolean(settings.model && settings.base_url && apiKey);
  return {
    provider: 'openai-compatible',
    model: settings.model ?? '',
    dimensions: settings.dimensions,
    base_url: settings.base_url,
    api_key_set: Boolean(apiKey),
    api_key_env_var: settings.api_key_env_var,
    available,
    unavailable_reason: available ? null : 'embedding provider requires model, base URL, and API key',
  };
}

export function getKnowledgeEmbeddingProvider(input: {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
} = {}): KnowledgeEmbeddingProvider {
  const settings = settingsRepo.getKnowledgeEmbeddingSettings();
  if (settings.provider === 'local-hash') return createLocalHashEmbeddingProvider({ dimensions: settings.dimensions ?? 256 });
  const apiKey = settings.api_key_env_var ? input.env?.[settings.api_key_env_var]?.trim() ?? process.env[settings.api_key_env_var]?.trim() : settings.api_key;
  if (!settings.model || !settings.base_url || !apiKey) {
    throw new Error('embedding provider requires model, base URL, and API key');
  }
  return createOpenAICompatibleEmbeddingProvider({
    baseUrl: settings.base_url,
    apiKey,
    model: settings.model,
    dimensions: settings.dimensions,
    fetchImpl: input.fetchImpl,
  });
}
```

Then add `createOpenAICompatibleEmbeddingProvider()` and sanitizers in the same file:

```ts
export function createOpenAICompatibleEmbeddingProvider(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number | null;
  fetchImpl?: FetchLike;
}): KnowledgeEmbeddingProvider {
  const fetcher = input.fetchImpl ?? fetch;
  const baseUrl = normalizeEmbeddingBaseUrl(input.baseUrl);
  return {
    id: 'openai-compatible',
    model: input.model,
    dimensions: input.dimensions ?? 0,
    async embed(text, options) {
      const response = await fetcher(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: input.model, input: text }),
        signal: options?.signal,
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`embedding request failed: HTTP ${response.status}: ${redactCredentials(body, input.apiKey)}`);
      const parsed = JSON.parse(body || '{}') as { data?: Array<{ embedding?: unknown }> };
      const vector = parsed.data?.[0]?.embedding;
      if (!Array.isArray(vector) || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('embedding response did not include a numeric vector');
      }
      return vector;
    },
  };
}
```

- [x] **Step 5: Implement provider test helper**

Add:

```ts
export async function testKnowledgeEmbeddingProvider(input: {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ ok: boolean; runtime: KnowledgeEmbeddingRuntime; dimensions: number | null; error: string | null }> {
  const runtime = getKnowledgeEmbeddingRuntime(input.env);
  try {
    const provider = getKnowledgeEmbeddingProvider(input);
    const vector = await provider.embed('OpenDeepSea knowledge embedding smoke test.');
    return { ok: true, runtime, dimensions: vector.length, error: null };
  } catch (err) {
    return { ok: false, runtime, dimensions: null, error: redactCredentials(err instanceof Error ? err.message : String(err), '') };
  }
}
```

- [x] **Step 6: Run provider tests**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-embedding-provider.test.ts src/knowledge-embedding.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 2**

```bash
git add packages/backend/src/knowledge-embedding.ts packages/backend/src/knowledge-embedding-provider.ts packages/backend/src/knowledge-embedding-provider.test.ts
git commit -m "feat(knowledge): 增加真实embedding provider"
```

---

### Task 3: Embedding Rebuild Service

**Files:**
- Create: `packages/backend/src/knowledge-embedding-rebuild.ts`
- Test: `packages/backend/src/knowledge-embedding-rebuild.test.ts`
- Modify: `packages/backend/src/knowledge-imports.ts`
- Modify: `packages/backend/src/knowledge-embedding.ts`

- [x] **Step 1: Write failing rebuild tests**

Create `packages/backend/src/knowledge-embedding-rebuild.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-embedding-rebuild-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const { rebuildKnowledgeEmbeddings } = await import('./knowledge-embedding-rebuild.js');

test('rebuildKnowledgeEmbeddings rebuilds stale chunks and skips unchanged chunks', async () => {
  const project = projectRepo.create({ name: 'Embedding Rebuild', path: mkdtempSync(join(tmpdir(), 'embedding-rebuild-project-')) });
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: 'manual:rebuild',
    title: 'A12 验收',
    status: 'ready',
    content_hash: 'source-hash',
    tags: [],
    metadata: {},
  });
  const extraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: 'A12 验收需要截图。',
    markdown: null,
    metadata: {},
    truncated: false,
    original_char_count: 11,
    returned_char_count: 11,
  });
  knowledgeRepo.replaceChunks({
    source_id: source.id,
    extraction_id: extraction.id,
    chunks: [{ content: 'A12 验收需要截图。', chunk_type: 'body', metadata: {} }],
  });

  const first = await rebuildKnowledgeEmbeddings({ projectId: project.id });
  assert.equal(first.scanned_chunks, 1);
  assert.equal(first.rebuilt_chunks, 1);
  assert.equal(first.skipped_chunks, 0);

  const second = await rebuildKnowledgeEmbeddings({ projectId: project.id });
  assert.equal(second.scanned_chunks, 1);
  assert.equal(second.rebuilt_chunks, 0);
  assert.equal(second.skipped_chunks, 1);
});
```

- [x] **Step 2: Run failing rebuild test**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-embedding-rebuild.test.ts
```

Expected: FAIL because rebuild service does not exist.

- [x] **Step 3: Create rebuild service**

Create `packages/backend/src/knowledge-embedding-rebuild.ts`:

```ts
import { hashText } from './knowledge-extraction.js';
import { getKnowledgeEmbeddingProvider } from './knowledge-embedding-provider.js';
import type { KnowledgeChunk, KnowledgeSource } from './knowledge-types.js';
import { knowledgeRepo } from './repos/knowledge.js';
import { projectRepo } from './repos/projects.js';

export interface KnowledgeEmbeddingRebuildResult {
  project_id: string;
  source_id?: string;
  provider: string;
  model: string;
  scanned_chunks: number;
  rebuilt_chunks: number;
  skipped_chunks: number;
  failed_chunks: Array<{ chunk_id: string; source_id: string; error: string }>;
}

export async function rebuildKnowledgeEmbeddings(input: {
  projectId: string;
  sourceId?: string;
  limit?: number;
  fetchImpl?: Parameters<typeof getKnowledgeEmbeddingProvider>[0]['fetchImpl'];
}): Promise<KnowledgeEmbeddingRebuildResult> {
  const project = projectRepo.get(input.projectId);
  if (!project) throw new Error('project not found');
  const provider = getKnowledgeEmbeddingProvider({ fetchImpl: input.fetchImpl });
  const sources = listReadySources(input.projectId, input.sourceId);
  const result: KnowledgeEmbeddingRebuildResult = {
    project_id: project.id,
    ...(input.sourceId ? { source_id: input.sourceId } : {}),
    provider: provider.id,
    model: provider.model,
    scanned_chunks: 0,
    rebuilt_chunks: 0,
    skipped_chunks: 0,
    failed_chunks: [],
  };
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));

  for (const source of sources) {
    for (const chunk of knowledgeRepo.listChunks(source.id).filter((item) => item.enabled === 1)) {
      if (result.scanned_chunks >= limit) return result;
      result.scanned_chunks += 1;
      const contentHash = hashText(chunk.content);
      const existing = knowledgeRepo.getChunkEmbedding(chunk.id);
      if (existing && existing.provider === provider.id && existing.model === provider.model && existing.content_hash === contentHash) {
        result.skipped_chunks += 1;
        continue;
      }
      try {
        const vector = await provider.embed([source.title, chunk.heading, chunk.content].filter(Boolean).join('\n'));
        knowledgeRepo.upsertChunkEmbedding({
          chunk_id: chunk.id,
          source_id: source.id,
          project_id: source.project_id,
          provider: provider.id,
          model: provider.model,
          dimensions: vector.length,
          vector,
          content_hash: contentHash,
        });
        result.rebuilt_chunks += 1;
      } catch (err) {
        result.failed_chunks.push({
          chunk_id: chunk.id,
          source_id: source.id,
          error: err instanceof Error ? err.message : 'embedding rebuild failed',
        });
      }
    }
  }

  return result;
}

function listReadySources(projectId: string, sourceId?: string): KnowledgeSource[] {
  if (sourceId) {
    const source = knowledgeRepo.getSource(sourceId);
    return source && source.project_id === projectId && source.status === 'ready' ? [source] : [];
  }
  return knowledgeRepo.listSources({ projectId, statuses: ['ready'], limit: 1000 });
}
```

- [x] **Step 4: Keep import indexing deterministic**

In `packages/backend/src/knowledge-imports.ts`, keep direct synchronous `rebuildSourceEmbeddings(source.id)` calls for imports. Add this comment above the call if it is not already obvious:

```ts
// Imports keep local indexing deterministic; true provider rebuild is explicit via Phase 4B API.
rebuildSourceEmbeddings(source.id);
```

- [x] **Step 5: Run rebuild tests**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-embedding-rebuild.test.ts src/knowledge-imports.test.ts src/knowledge-embedding.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit Task 3**

```bash
git add packages/backend/src/knowledge-embedding-rebuild.ts packages/backend/src/knowledge-embedding-rebuild.test.ts packages/backend/src/knowledge-imports.ts packages/backend/src/knowledge-embedding.ts
git commit -m "feat(knowledge): 支持重建embedding索引"
```

---

### Task 4: Async Search, Agent RAG, and CLI Metadata

**Files:**
- Modify: `packages/backend/src/knowledge-search.ts`
- Modify: `packages/backend/src/knowledge-search.test.ts`
- Modify: `packages/backend/src/knowledge-rag.ts`
- Modify: `packages/backend/src/knowledge-rag.test.ts`
- Modify: `packages/backend/src/knowledge-cli.ts`
- Modify: `packages/backend/src/knowledge-cli.test.ts`

- [x] **Step 1: Write failing async search test**

Add to `packages/backend/src/knowledge-search.test.ts`:

```ts
test('searchKnowledgeAsync uses configured embedding provider metadata for hybrid results', async () => {
  const project = createProject('async-search-provider');
  const { source } = createSourceWithChunk({
    projectId: project.id,
    title: 'A12 语义验收',
    content: 'A12 需要移动端截图和控制台无错误。',
  });
  await rebuildKnowledgeEmbeddings({ projectId: project.id, sourceId: source.id });

  const results = await searchKnowledgeAsync({
    projectId: project.id,
    query: '移动端验收',
    mode: 'hybrid',
  });

  assert.equal(results[0]?.retrieval_mode, 'hybrid');
  assert.equal(results[0]?.ranking?.embeddingProvider, 'local-hash');
  assert.equal(results[0]?.ranking?.embeddingModel, 'local-hash-v1');
});
```

Extend `KnowledgeRankingSignals` with optional:

```ts
embeddingProvider?: string;
embeddingModel?: string;
embeddingFallback?: string;
```

- [x] **Step 2: Run failing async search test**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-search.test.ts
```

Expected: FAIL because `searchKnowledgeAsync` and ranking metadata do not exist.

- [x] **Step 3: Implement async search**

In `packages/backend/src/knowledge-search.ts`, add:

```ts
export async function searchKnowledgeAsync(input: {
  projectId: string;
  roomId?: string;
  query: string;
  mode?: KnowledgeRetrievalMode;
  status?: KnowledgeStatus;
  sourceType?: KnowledgeSourceType;
  limit?: number;
}): Promise<KnowledgeSearchResult[]> {
  const query = input.query.trim();
  if (!query) return [];
  const mode = input.mode ?? 'keyword';
  if (mode === 'keyword') return keywordSearch({ ...input, query });
  if (mode === 'vector_preview') return vectorSearchAsync({ ...input, query, mode: 'vector_preview' });
  return hybridSearchAsync({ ...input, query });
}
```

Use `getKnowledgeEmbeddingProvider()` to embed the query and read `provider.id/model`. Keep existing synchronous `searchKnowledge()` for compatibility and local hash tests.

- [x] **Step 4: Update Agent RAG to async**

In `packages/backend/src/knowledge-rag.ts`, convert `searchKnowledgeForAgent()` to `async`:

```ts
export async function searchKnowledgeForAgent(input: {
  projectId: string;
  roomId?: string | null;
  query: string;
  mode?: KnowledgeSearchMode;
  limit?: number;
  usage?: KnowledgeAgentUsage | null;
}): Promise<KnowledgeAgentToolResponse<KnowledgeAgentSearchResult[]>> {
  const scope = resolveScope(input.projectId, input.roomId);
  const mode = input.mode ?? 'hybrid';
  const results = await searchKnowledgeAsync({
    projectId: scope.project_id,
    roomId: scope.room_id,
    query: input.query,
    mode,
    limit: normalizeLimit(input.limit, 5, 10),
  });
  const provider = results[0]?.ranking?.embeddingProvider;
  const model = results[0]?.ranking?.embeddingModel;
  recordResultUsage(scope.project_id, results, input.usage, 'search', {
    retrieval_mode: mode,
    query: input.query,
    ...(provider ? { embedding_provider: provider } : {}),
    ...(model ? { embedding_model: model } : {}),
  });
  return {
    source: 'openclaw.knowledge.search',
    scope,
    generated_at: Date.now(),
    retrieval_mode: mode,
    results: results.map(toSearchResult),
    citations: results.map((result) => citationFromSearchResult(result)),
  };
}
```

Update all call sites to `await`.

- [x] **Step 5: Update CLI output**

In `packages/backend/src/knowledge-cli.ts`, await async RAG search and include:

```ts
embedding_provider: result.results[0]?.ranking?.embeddingProvider ?? null,
embedding_model: result.results[0]?.ranking?.embeddingModel ?? null,
```

- [x] **Step 6: Run search/RAG/CLI tests**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-search.test.ts src/knowledge-rag.test.ts src/knowledge-cli.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 4**

```bash
git add packages/backend/src/knowledge-search.ts packages/backend/src/knowledge-search.test.ts packages/backend/src/knowledge-rag.ts packages/backend/src/knowledge-rag.test.ts packages/backend/src/knowledge-cli.ts packages/backend/src/knowledge-cli.test.ts packages/backend/src/knowledge-types.ts
git commit -m "feat(knowledge): 搜索记录embedding provider"
```

---

### Task 5: Backend API for Status, Test, Rebuild, and Settings

**Files:**
- Modify: `packages/backend/src/knowledge-service.ts`
- Modify: `packages/backend/src/routes.ts`
- Test: `packages/backend/src/knowledge.routes.test.ts`
- Test: `packages/backend/src/settings.routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Add to `packages/backend/src/knowledge.routes.test.ts`:

```ts
test('knowledge embedding routes expose status, test, and rebuild without secrets', async () => {
  const project = createProject('embedding-routes');

  const statusRes = await request(`/api/knowledge/embedding/status?projectId=${encodeURIComponent(project.id)}`);
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json() as {
    runtime: { provider: string; model: string; api_key_set: boolean };
    total_enabled_chunks: number;
  };
  assert.equal(statusBody.runtime.provider, 'local-hash');
  assert.equal(statusBody.runtime.model, 'local-hash-v1');
  assert.equal('api_key' in statusBody.runtime, false);

  const testRes = await request('/api/knowledge/embedding/test', { method: 'POST', body: '{}' });
  assert.equal(testRes.status, 200);
  const testBody = await testRes.json() as { ok: boolean; dimensions: number | null };
  assert.equal(testBody.ok, true);
  assert.equal(typeof testBody.dimensions, 'number');

  const rebuildRes = await request('/api/knowledge/embedding/rebuild', {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id }),
  });
  assert.equal(rebuildRes.status, 200);
  const rebuildBody = await rebuildRes.json() as { project_id: string; scanned_chunks: number };
  assert.equal(rebuildBody.project_id, project.id);
});
```

Add to `packages/backend/src/settings.routes.test.ts`:

```ts
test('system knowledge embedding settings patch accepts safe fields only', async () => {
  const res = await request('/api/settings/system/knowledge-embedding', {
    method: 'PATCH',
    body: JSON.stringify({
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      baseUrl: 'https://embedding.example/v1',
      apiKeyEnvVar: 'OPENDEEPSEA_EMBEDDING_API_KEY',
      apiKey: 'sk-must-not-be-accepted',
    }),
  });

  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run failing route tests**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge.routes.test.ts src/settings.routes.test.ts
```

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Add service methods**

In `packages/backend/src/knowledge-service.ts`, add methods:

```ts
getEmbeddingStatus(input: { projectId?: string }) {
  return getKnowledgeEmbeddingStatus(input);
},
testEmbeddingProvider() {
  return testKnowledgeEmbeddingProvider();
},
rebuildEmbeddings(input: { projectId: string; sourceId?: string; limit?: number }) {
  return rebuildKnowledgeEmbeddings(input);
},
```

Implement `getKnowledgeEmbeddingStatus()` in either service or a small helper using `knowledgeRepo.listSources()` and `knowledgeRepo.listChunkEmbeddings()`.

- [ ] **Step 4: Add zod schemas and routes**

In `packages/backend/src/routes.ts`, add:

```ts
const knowledgeEmbeddingStatusSchema = z.object({
  projectId: z.string().optional(),
});

const knowledgeEmbeddingRebuildSchema = z.object({
  projectId: z.string().min(1),
  sourceId: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

const knowledgeEmbeddingSettingsSchema = z.object({
  provider: z.enum(['local-hash', 'openai-compatible']),
  model: z.string().trim().min(1).max(120).nullable().optional(),
  dimensions: z.number().int().min(1).max(8192).nullable().optional(),
  baseUrl: z.string().trim().max(2048).nullable().optional(),
  apiKeyEnvVar: z.string().trim().max(120).nullable().optional(),
}).strict();
```

Routes:

```ts
router.get('/knowledge/embedding/status', (req, res) => {
  const parsed = knowledgeEmbeddingStatusSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(knowledgeService.getEmbeddingStatus(parsed.data));
});

router.post('/knowledge/embedding/test', async (_req, res) => {
  res.json(await knowledgeService.testEmbeddingProvider());
});

router.post('/knowledge/embedding/rebuild', async (req, res) => {
  const parsed = knowledgeEmbeddingRebuildSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await knowledgeService.rebuildEmbeddings(parsed.data));
});

router.patch('/settings/system/knowledge-embedding', (req, res) => {
  const parsed = knowledgeEmbeddingSettingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(settingsRepo.updateSystem({
    knowledge_embedding_provider: parsed.data.provider,
    knowledge_embedding_model: parsed.data.model,
    knowledge_embedding_dimensions: parsed.data.dimensions,
    knowledge_embedding_base_url: parsed.data.baseUrl,
    knowledge_embedding_api_key_env_var: parsed.data.apiKeyEnvVar,
  }));
});
```

- [ ] **Step 5: Run route tests**

Run:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge.routes.test.ts src/settings.routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add packages/backend/src/knowledge-service.ts packages/backend/src/routes.ts packages/backend/src/knowledge.routes.test.ts packages/backend/src/settings.routes.test.ts
git commit -m "feat(knowledge): 增加embedding运维接口"
```

---

### Task 6: Frontend API, Display, and Knowledge Page

**Files:**
- Modify: `packages/frontend/src/lib/types.ts`
- Modify: `packages/frontend/src/lib/api.ts`
- Test: `packages/frontend/src/lib/api.test.ts`
- Modify: `packages/frontend/src/lib/knowledgeDisplay.ts`
- Test: `packages/frontend/src/lib/knowledgeDisplay.test.ts`
- Modify: `packages/frontend/src/pages/KnowledgePage.tsx`
- Test: `packages/frontend/src/pages/KnowledgePage.test.tsx`

- [ ] **Step 1: Write failing frontend API test**

Add to `packages/frontend/src/lib/api.test.ts`:

```ts
test('knowledge embedding APIs build status, test, rebuild, and settings requests', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.getKnowledgeEmbeddingStatus('project-1');
    await api.testKnowledgeEmbeddingProvider();
    await api.rebuildKnowledgeEmbeddings({ projectId: 'project-1', limit: 100 });
    await api.updateKnowledgeEmbeddingSettings({
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      baseUrl: 'https://embedding.example/v1',
      apiKeyEnvVar: 'OPENDEEPSEA_EMBEDDING_API_KEY',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { url: '/api/knowledge/embedding/status?projectId=project-1', method: 'GET', body: null },
    { url: '/api/knowledge/embedding/test', method: 'POST', body: '{}' },
    { url: '/api/knowledge/embedding/rebuild', method: 'POST', body: JSON.stringify({ projectId: 'project-1', limit: 100 }) },
    {
      url: '/api/settings/system/knowledge-embedding',
      method: 'PATCH',
      body: JSON.stringify({
        provider: 'openai-compatible',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        baseUrl: 'https://embedding.example/v1',
        apiKeyEnvVar: 'OPENDEEPSEA_EMBEDDING_API_KEY',
      }),
    },
  ]);
});
```

- [ ] **Step 2: Run failing frontend API test**

Run:

```bash
cd packages/frontend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/lib/api.test.ts
```

Expected: FAIL because API helpers do not exist.

- [ ] **Step 3: Add frontend types and API helpers**

In `packages/frontend/src/lib/types.ts`, add:

```ts
export type KnowledgeEmbeddingProviderId = 'local-hash' | 'openai-compatible';

export interface KnowledgeEmbeddingRuntimeSummary {
  provider: KnowledgeEmbeddingProviderId;
  model: string;
  dimensions: number | null;
  base_url: string | null;
  api_key_set: boolean;
  api_key_env_var: string | null;
  available: boolean;
  unavailable_reason: string | null;
}

export interface KnowledgeEmbeddingStatus {
  runtime: KnowledgeEmbeddingRuntimeSummary;
  project_id?: string;
  total_enabled_chunks: number;
  embedded_chunks: number;
  stale_chunks: number;
  missing_chunks: number;
  failed_sources: number;
}
```

In `packages/frontend/src/lib/api.ts`, add:

```ts
getKnowledgeEmbeddingStatus: (projectId?: string) =>
  request<KnowledgeEmbeddingStatus>(`/knowledge/embedding/status${buildQuery({ projectId })}`),
testKnowledgeEmbeddingProvider: () =>
  request<{ ok: boolean; dimensions: number | null; error: string | null }>('/knowledge/embedding/test', {
    method: 'POST',
    body: JSON.stringify({}),
  }),
rebuildKnowledgeEmbeddings: (input: { projectId: string; sourceId?: string; limit?: number }) =>
  request<KnowledgeEmbeddingRebuildResult>('/knowledge/embedding/rebuild', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
updateKnowledgeEmbeddingSettings: (input: KnowledgeEmbeddingSettingsPatch) =>
  request<SystemSettings>('/settings/system/knowledge-embedding', {
    method: 'PATCH',
    body: JSON.stringify(input),
  }),
```

- [ ] **Step 4: Add display helper test and implementation**

Add to `packages/frontend/src/lib/knowledgeDisplay.test.ts`:

```ts
test('knowledge embedding status display summarizes coverage and provider', () => {
  const summary = summarizeKnowledgeEmbeddingStatus({
    runtime: {
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      base_url: 'https://embedding.example/v1',
      api_key_set: true,
      api_key_env_var: null,
      available: true,
      unavailable_reason: null,
    },
    project_id: 'project-1',
    total_enabled_chunks: 10,
    embedded_chunks: 7,
    stale_chunks: 2,
    missing_chunks: 1,
    failed_sources: 0,
  });

  assert.equal(summary.providerLabel, 'OpenAI-compatible · text-embedding-3-small');
  assert.equal(summary.coverageLabel, '7 / 10');
  assert.equal(summary.warningLabel, '2 个过期，1 个缺失');
});
```

Implement `summarizeKnowledgeEmbeddingStatus()` in `knowledgeDisplay.ts`.

- [ ] **Step 5: Wire KnowledgePage**

In `packages/frontend/src/pages/KnowledgePage.tsx`, add query:

```ts
const { data: embeddingStatus, refetch: refetchEmbeddingStatus } = useQuery({
  queryKey: ['knowledge-embedding-status', selectedProjectId],
  queryFn: () => api.getKnowledgeEmbeddingStatus(selectedProjectId || undefined),
});
```

Add mutations:

```ts
const testEmbedding = useMutation({
  mutationFn: api.testKnowledgeEmbeddingProvider,
  onSuccess: (result) => {
    if (result.ok) toast.success('Embedding provider 可用', { description: result.dimensions ? `维度 ${result.dimensions}` : undefined });
    else toast.error('Embedding provider 不可用', { description: result.error ?? undefined });
  },
  onError: (err) => toast.error((err as Error).message),
});

const rebuildEmbedding = useMutation({
  mutationFn: () => api.rebuildKnowledgeEmbeddings({ projectId: selectedProjectId, limit: 100 }),
  onSuccess: async (result) => {
    await invalidateKnowledgeQueries(queryClient, selectedProjectId);
    await refetchEmbeddingStatus();
    toast.success('Embedding 索引已重建', {
      description: `重建 ${result.rebuilt_chunks} 个，跳过 ${result.skipped_chunks} 个，失败 ${result.failed_chunks.length} 个。`,
    });
  },
  onError: (err) => toast.error((err as Error).message),
});
```

Render a compact strip near `KnowledgeInsightsStrip` with provider label, coverage, test and rebuild buttons.

- [ ] **Step 6: Run frontend tests**

Run:

```bash
cd packages/frontend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/lib/api.test.ts src/lib/knowledgeDisplay.test.ts src/pages/KnowledgePage.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

```bash
git add packages/frontend/src/lib/types.ts packages/frontend/src/lib/api.ts packages/frontend/src/lib/api.test.ts packages/frontend/src/lib/knowledgeDisplay.ts packages/frontend/src/lib/knowledgeDisplay.test.ts packages/frontend/src/pages/KnowledgePage.tsx packages/frontend/src/pages/KnowledgePage.test.tsx
git commit -m "feat(knowledge): 展示embedding索引状态"
```

---

### Task 7: Settings UI and Final Verification

**Files:**
- Modify: `packages/frontend/src/components/SettingsDialogs.tsx`
- Modify: `packages/frontend/src/components/SettingsDialogs.test.tsx`
- Create: `docs/superpowers/verification/2026-06-09-知识库Phase4B真实Embedding验收.md`
- Modify: `docs/superpowers/plans/2026-06-09-知识库Phase4B真实Embedding实施计划.md`

- [ ] **Step 1: Add failing SettingsDialogs wiring test**

Add to `packages/frontend/src/components/SettingsDialogs.test.tsx`:

```ts
test('SettingsDialogs exposes knowledge embedding settings fields', () => {
  const source = readFileSync(new URL('./SettingsDialogs.tsx', import.meta.url), 'utf8');
  assert.match(source, /knowledge_embedding_provider/);
  assert.match(source, /knowledge_embedding_model/);
  assert.match(source, /api\.updateKnowledgeEmbeddingSettings/);
  assert.match(source, /OpenAI-compatible/);
});
```

- [ ] **Step 2: Run failing settings UI test**

Run:

```bash
cd packages/frontend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/components/SettingsDialogs.test.tsx
```

Expected: FAIL because UI wiring is missing.

- [ ] **Step 3: Add settings UI fields**

In `packages/frontend/src/components/SettingsDialogs.tsx`, add a compact section in system settings:

```tsx
<SettingGroup title="知识库 Embedding" icon={<Database className="h-4 w-4" strokeWidth={1.75} />}>
  <select
    value={systemDraft.knowledgeEmbeddingProvider}
    onChange={(event) => setSystemDraft((current) => ({ ...current, knowledgeEmbeddingProvider: event.target.value as KnowledgeEmbeddingProviderId }))}
  >
    <option value="local-hash">Local hash</option>
    <option value="openai-compatible">OpenAI-compatible</option>
  </select>
  <Input
    value={systemDraft.knowledgeEmbeddingModel}
    onChange={(event) => setSystemDraft((current) => ({ ...current, knowledgeEmbeddingModel: event.target.value }))}
    placeholder="text-embedding-3-small"
  />
  <Input
    value={systemDraft.knowledgeEmbeddingBaseUrl}
    onChange={(event) => setSystemDraft((current) => ({ ...current, knowledgeEmbeddingBaseUrl: event.target.value }))}
    placeholder="留空复用 active AI config"
  />
  <Input
    value={systemDraft.knowledgeEmbeddingApiKeyEnvVar}
    onChange={(event) => setSystemDraft((current) => ({ ...current, knowledgeEmbeddingApiKeyEnvVar: event.target.value }))}
    placeholder="OPENDEEPSEA_EMBEDDING_API_KEY"
  />
</SettingGroup>
```

Persist through `api.updateKnowledgeEmbeddingSettings()`.

- [ ] **Step 4: Run full focused verification**

Backend:

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-embedding.test.ts src/knowledge-embedding-provider.test.ts src/knowledge-embedding-rebuild.test.ts src/knowledge-search.test.ts src/knowledge-rag.test.ts src/knowledge-cli.test.ts src/knowledge.routes.test.ts src/settings.routes.test.ts src/repos/settings.test.ts
```

Expected: all tests pass.

Frontend:

```bash
cd packages/frontend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/lib/api.test.ts src/lib/knowledgeDisplay.test.ts src/pages/KnowledgePage.test.tsx src/components/SettingsDialogs.test.tsx
```

Expected: all tests pass.

Build:

```bash
npm run build
```

Expected: backend TypeScript and frontend build pass. Existing Vite chunk-size warning is acceptable.

- [ ] **Step 5: Browser smoke**

Run dev services:

```bash
PORT=7331 OPENDEEPSEA_LOCAL_TOKEN=openclaw-room-dev-token npm run dev -w @openclaw-room/backend
npm run dev -w @openclaw-room/frontend -- --port 5174
```

Smoke at `http://127.0.0.1:5174/knowledge`:

1. Knowledge page renders with embedding provider strip.
2. Local hash provider shows coverage and test succeeds.
3. Rebuild current project returns rebuilt/skipped/failed counts.
4. System settings displays knowledge embedding fields.
5. Console has no new errors.

- [ ] **Step 6: Write verification doc**

Create `docs/superpowers/verification/2026-06-09-知识库Phase4B真实Embedding验收.md`:

```markdown
# 知识库 Phase 4B 真实 Embedding 验收

- 日期：2026-06-09
- 范围：真实 embedding provider、批量重建、搜索 provider metadata、前端索引状态、系统设置入口
- 设计依据：`docs/superpowers/specs/2026-06-09-知识库Phase4B真实Embedding设计.md`
- 实施计划：`docs/superpowers/plans/2026-06-09-知识库Phase4B真实Embedding实施计划.md`

## 验证命令

记录后端聚焦测试、前端聚焦测试和 `npm run build` 的命令与结果。

## 浏览器验收

记录 `/knowledge` 和系统设置 smoke 的 URL、断言、截图路径和 console 状态。

## 代码审查

审查重点：

- API key 不通过知识库 API 泄露。
- 上游 provider 错误已脱敏。
- 未配置真实 provider 时 local-hash 兼容。
- rebuild 按 project/source 限界，不跨项目。
- search/Agent RAG usage metadata 包含 provider/model。

## 结论

说明 Phase 4B.1 是否通过验收。
```

- [ ] **Step 7: Final code review**

Review against:

- `docs/superpowers/specs/2026-06-09-知识库Phase4B真实Embedding设计.md`
- `docs/superpowers/plans/2026-06-09-知识库Phase4B真实Embedding实施计划.md`

Focus on credential safety, provider fallback semantics, async search call sites, rebuild scope, UI feedback, and tests.

- [ ] **Step 8: Commit verification and plan updates**

```bash
git add packages/frontend/src/components/SettingsDialogs.tsx packages/frontend/src/components/SettingsDialogs.test.tsx docs/superpowers/verification/2026-06-09-知识库Phase4B真实Embedding验收.md docs/superpowers/plans/2026-06-09-知识库Phase4B真实Embedding实施计划.md
git commit -m "docs(knowledge): 记录Phase4B验收"
```

---

## 最终验收命令

```bash
cd packages/backend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/knowledge-embedding.test.ts src/knowledge-embedding-provider.test.ts src/knowledge-embedding-rebuild.test.ts src/knowledge-search.test.ts src/knowledge-rag.test.ts src/knowledge-cli.test.ts src/knowledge.routes.test.ts src/settings.routes.test.ts src/repos/settings.test.ts
```

```bash
cd packages/frontend
/Users/chendimao/.local/share/mise/installs/node/22.18.0/bin/node --import tsx --test src/lib/api.test.ts src/lib/knowledgeDisplay.test.ts src/pages/KnowledgePage.test.tsx src/components/SettingsDialogs.test.tsx
```

```bash
npm run build
```

## 计划自审

- Spec coverage：覆盖 provider 配置、真实 provider、重建索引、search/Agent RAG metadata、API、前端入口、安全和验收。
- Placeholder scan：未使用待补占位；每个任务包含目标文件、测试、实现方向、验证命令和提交命令。
- Type consistency：统一使用 `KnowledgeEmbeddingProviderId`、`KnowledgeEmbeddingSettings`、`KnowledgeEmbeddingRuntime`、`KnowledgeEmbeddingStatus`、`KnowledgeEmbeddingRebuildResult`。
