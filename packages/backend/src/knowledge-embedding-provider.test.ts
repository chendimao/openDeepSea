import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { KnowledgeEmbeddingProvider } from './knowledge-embedding.js';
import type { FetchLike } from './knowledge-embedding-provider.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-embedding-provider-')), 'test.db');

const { settingsRepo } = await import('./repos/settings.js');
const {
  createOpenAICompatibleEmbeddingProvider,
  getKnowledgeEmbeddingProvider,
  getKnowledgeEmbeddingRuntime,
  normalizeEmbeddingBaseUrl,
  sanitizeEmbeddingProviderError,
  testEmbeddingProvider,
  testKnowledgeEmbeddingProvider,
} = await import('./knowledge-embedding-provider.js');

function clearAiConfigs(): void {
  for (const config of settingsRepo.listAiConfigs()) {
    settingsRepo.deleteAiConfig(config.id);
  }
}

test('knowledge embedding runtime defaults to local hash', () => {
  clearAiConfigs();
  settingsRepo.updateSystem({
    openai_api_key: null,
    openai_base_url: null,
    knowledge_embedding_provider: null,
    knowledge_embedding_model: null,
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: null,
    knowledge_embedding_api_key_env_var: null,
  });

  const runtime = getKnowledgeEmbeddingRuntime();
  const provider = getKnowledgeEmbeddingProvider();

  assert.deepEqual(runtime, {
    provider: 'local-hash',
    model: 'local-hash-v1',
    dimensions: 256,
    base_url: null,
    api_key_set: false,
    api_key_env_var: null,
    available: true,
    unavailable_reason: null,
  });
  assert.equal(provider.id, 'local-hash');
  assert.equal(provider.model, 'local-hash-v1');
  assert.equal(provider.dimensions, 256);
});

test('openai-compatible provider posts embeddings request and returns the response vector', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fetchImpl: FetchLike = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({ data: [{ embedding: [0.25, -0.5, 1] }] });
  };
  const provider = createOpenAICompatibleEmbeddingProvider({
    baseUrl: ' https://embedding.example.test/v1/ ',
    apiKey: 'sk-request-secret',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    fetchImpl,
  });
  const controller = new AbortController();

  const vector = await provider.embed('A12 hybrid search', { signal: controller.signal });

  assert.equal(provider.id, 'openai-compatible');
  assert.equal(provider.model, 'text-embedding-3-small');
  assert.equal(provider.dimensions, 1536);
  assert.equal(requestUrl, 'https://embedding.example.test/v1/embeddings');
  assert.equal(requestInit?.method, 'POST');
  assert.equal(requestInit?.signal, controller.signal);
  assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer sk-request-secret');
  assert.equal(new Headers(requestInit?.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    model: 'text-embedding-3-small',
    input: 'A12 hybrid search',
  });
  assert.deepEqual(vector, [0.25, -0.5, 1]);
});

test('openai-compatible provider accepts null dimensions as unknown', () => {
  const provider = createOpenAICompatibleEmbeddingProvider({
    baseUrl: 'https://embedding.example.test/v1',
    apiKey: 'sk-dimensions-secret',
    model: 'text-embedding-3-small',
    dimensions: null,
    fetchImpl: async () => Response.json({ data: [{ embedding: [0.25] }] }),
  });

  assert.equal(provider.dimensions, 0);
});

test('openai-compatible provider rejects non-finite embedding values', async () => {
  const provider = createOpenAICompatibleEmbeddingProvider({
    baseUrl: 'https://embedding.example.test/v1',
    apiKey: 'sk-invalid-secret',
    model: 'text-embedding-3-small',
    fetchImpl: async () => Response.json({ data: [{ embedding: [1, 'bad', 3] }] }),
  });

  await assert.rejects(
    () => provider.embed('invalid vector'),
    /embedding vector must contain only finite numbers/,
  );
});

test('openai-compatible provider sanitizes upstream HTTP errors', async () => {
  const apiKey = 'sk-http-secret';
  const provider = createOpenAICompatibleEmbeddingProvider({
    baseUrl: 'https://embedding.example.test/v1',
    apiKey,
    model: 'text-embedding-3-small',
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        message: `upstream rejected Authorization: Bearer ${apiKey} api_key=${apiKey}`,
      },
    }), { status: 401 }),
  });

  await assert.rejects(
    () => provider.embed('secret failure'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /HTTP 401/);
      assert.doesNotMatch(err.message, new RegExp(apiKey));
      assert.doesNotMatch(err.message, /Authorization:\s*Bearer\s+sk-http-secret/);
      assert.match(err.message, /\[REDACTED_CREDENTIAL\]/);
      return true;
    },
  );
});

test('openai-compatible provider sanitizes non-sk api keys in request errors', async () => {
  const apiKey = 'provider-secret-token-1234';
  const provider = createOpenAICompatibleEmbeddingProvider({
    baseUrl: 'https://embedding.example.test/v1',
    apiKey,
    model: 'text-embedding-3-small',
    fetchImpl: async () => {
      throw new Error(`upstream rejected ${apiKey}`);
    },
  });

  await assert.rejects(
    () => provider.embed('secret failure'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, new RegExp(apiKey));
      assert.match(err.message, /\[REDACTED_CREDENTIAL\]/);
      return true;
    },
  );
});

test('embedding base url rejects embedded credentials and preserves local http URLs', () => {
  assert.equal(
    normalizeEmbeddingBaseUrl(' http://127.0.0.1:11434/v1/ '),
    'http://127.0.0.1:11434/v1',
  );
  assert.equal(
    normalizeEmbeddingBaseUrl('https://embedding.example.test/v1///?token=leaky#fragment'),
    'https://embedding.example.test/v1',
  );
  assert.throws(() => normalizeEmbeddingBaseUrl('   '), /base_url is required/);
  assert.throws(
    () => normalizeEmbeddingBaseUrl('https://user:password@embedding.example.test/v1'),
    /base_url must not include credentials/,
  );
});

test('sanitizeEmbeddingProviderError redacts api keys and bearer credentials', () => {
  const sanitized = sanitizeEmbeddingProviderError(
    new Error('Authorization: Bearer sk-direct-secret failed with api_key=sk-direct-secret and sk-naked-secret'),
    'sk-direct-secret',
  );

  assert.doesNotMatch(sanitized, /sk-direct-secret/);
  assert.doesNotMatch(sanitized, /sk-naked-secret/);
  assert.doesNotMatch(sanitized, /Authorization:\s*Bearer\s+sk-direct-secret/);
  assert.match(sanitized, /\[REDACTED_CREDENTIAL\]/);
});

test('testEmbeddingProvider reports dimensions and sanitized errors', async () => {
  const successProvider: KnowledgeEmbeddingProvider = {
    id: 'stub-success',
    model: 'stub-model',
    dimensions: 0,
    embed: async () => [0.1, 0.2, 0.3],
  };
  const success = await testEmbeddingProvider(successProvider);

  assert.deepEqual(success, { ok: true, dimensions: 3, error: null });

  const failureProvider: KnowledgeEmbeddingProvider = {
    id: 'stub-failure',
    model: 'stub-model',
    dimensions: 0,
    embed: async () => {
      throw new Error('Incorrect API key provided: sk-test-secret');
    },
  };
  const failure = await testEmbeddingProvider(failureProvider);

  assert.equal(failure.ok, false);
  assert.equal(failure.dimensions, null);
  assert.doesNotMatch(failure.error ?? '', /sk-test-secret/);
  assert.match(failure.error ?? '', /\[REDACTED_CREDENTIAL\]/);
});

test('knowledge embedding provider resolves active AI config credentials', async () => {
  clearAiConfigs();
  settingsRepo.createAiConfig({
    name: 'Embedding Runtime',
    langchain_planner_model: 'planner-model',
    openai_base_url: ' https://active-embedding.example/v1 ',
    openai_api_key: ' sk-active-provider-secret ',
    activate: true,
  });
  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: 1536,
    knowledge_embedding_base_url: null,
    knowledge_embedding_api_key_env_var: null,
  });

  let authorization = '';
  const provider = getKnowledgeEmbeddingProvider({
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    },
  });
  const runtime = getKnowledgeEmbeddingRuntime();
  const vector = await provider.embed('active config');

  assert.equal(runtime.provider, 'openai-compatible');
  assert.equal(runtime.model, 'text-embedding-3-small');
  assert.equal(runtime.dimensions, 1536);
  assert.equal(runtime.base_url, 'https://active-embedding.example/v1');
  assert.equal(runtime.api_key_set, true);
  assert.equal(runtime.available, true);
  assert.equal(runtime.unavailable_reason, null);
  assert.equal(provider.dimensions, 1536);
  assert.equal(authorization, 'Bearer sk-active-provider-secret');
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
});

test('knowledge embedding provider prefers configured env var over active AI config key', async () => {
  clearAiConfigs();
  settingsRepo.createAiConfig({
    name: 'Embedding Runtime Env Fallback',
    langchain_planner_model: 'planner-model',
    openai_base_url: 'https://active-env.example/v1',
    openai_api_key: 'sk-active-ignored-secret',
    activate: true,
  });
  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: null,
    knowledge_embedding_api_key_env_var: 'OPENDEEPSEA_EMBEDDING_TEST_KEY',
  });

  let authorization = '';
  const env = { OPENDEEPSEA_EMBEDDING_TEST_KEY: ' sk-env-provider-secret ' };
  const provider = getKnowledgeEmbeddingProvider({
    env,
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ data: [{ embedding: [1, 2] }] });
    },
  });
  const runtime = getKnowledgeEmbeddingRuntime(env);

  assert.equal(runtime.api_key_set, true);
  assert.equal(runtime.api_key_env_var, 'OPENDEEPSEA_EMBEDDING_TEST_KEY');
  assert.equal(runtime.dimensions, null);
  assert.equal(provider.dimensions, 0);
  assert.deepEqual(await provider.embed('env config'), [1, 2]);
  assert.equal(authorization, 'Bearer sk-env-provider-secret');
});

test('knowledge embedding runtime reports unavailable openai-compatible config', () => {
  clearAiConfigs();
  settingsRepo.updateSystem({
    openai_api_key: null,
    openai_base_url: null,
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: '',
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: '',
    knowledge_embedding_api_key_env_var: '',
  });

  const runtime = getKnowledgeEmbeddingRuntime({});

  assert.equal(runtime.provider, 'openai-compatible');
  assert.equal(runtime.available, false);
  assert.equal(runtime.api_key_set, false);
  assert.match(runtime.unavailable_reason ?? '', /requires model, base URL, and API key/);
  assert.throws(
    () => getKnowledgeEmbeddingProvider({ env: {} }),
    /requires model, base URL, and API key/,
  );
});

test('knowledge embedding runtime reports unavailable when configured env var is absent', () => {
  clearAiConfigs();
  settingsRepo.updateSystem({
    openai_api_key: null,
    openai_base_url: null,
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: 'https://embedding.example.test/v1',
    knowledge_embedding_api_key_env_var: 'OPENDEEPSEA_MISSING_EMBEDDING_KEY',
  });

  const runtime = getKnowledgeEmbeddingRuntime({});

  assert.equal(runtime.provider, 'openai-compatible');
  assert.equal(runtime.model, 'text-embedding-3-small');
  assert.equal(runtime.base_url, 'https://embedding.example.test/v1');
  assert.equal(runtime.api_key_env_var, 'OPENDEEPSEA_MISSING_EMBEDDING_KEY');
  assert.equal(runtime.api_key_set, false);
  assert.equal(runtime.available, false);
  assert.match(runtime.unavailable_reason ?? '', /requires model, base URL, and API key/);
});

test('testKnowledgeEmbeddingProvider returns runtime and redacts naked upstream keys', async () => {
  clearAiConfigs();
  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: 'https://embedding.example.test/v1',
    knowledge_embedding_api_key_env_var: 'OPENDEEPSEA_EMBEDDING_SMOKE_KEY',
  });

  const result = await testKnowledgeEmbeddingProvider({
    env: { OPENDEEPSEA_EMBEDDING_SMOKE_KEY: 'sk-smoke-secret' },
    fetchImpl: async () => new Response('Incorrect API key provided: sk-smoke-secret', { status: 401 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.runtime.provider, 'openai-compatible');
  assert.equal(result.runtime.api_key_set, true);
  assert.equal(result.dimensions, null);
  assert.match(result.error ?? '', /HTTP 401/);
  assert.doesNotMatch(result.error ?? '', /sk-smoke-secret/);
  assert.match(result.error ?? '', /\[REDACTED_CREDENTIAL\]/);
});

test('local hash provider remains synchronous for existing callers', async () => {
  const { createLocalHashEmbeddingProvider } = await import('./knowledge-embedding.js');
  const provider = createLocalHashEmbeddingProvider({ dimensions: 16 });

  const vector = provider.embed('legacy sync embedding');

  assert.equal(Array.isArray(vector), true);
  assert.equal(vector.length, 16);
  assert.deepEqual(await Promise.resolve(vector), vector);
});
