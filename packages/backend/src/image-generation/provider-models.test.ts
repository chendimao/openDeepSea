import assert from 'node:assert/strict';
import test from 'node:test';
import { listImageProviderModels } from './provider-models.js';

test('provider model discovery normalizes image and other models', async () => {
  let requestedUrl = '';
  let authorization = '';

  const result = await listImageProviderModels({
    baseUrl: 'https://example.com',
    apiKey: 'secret',
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({
        data: [
          { id: 'gpt-image-2' },
          { id: 'dall-e-3' },
          { id: 'gpt-5.5' },
          { id: '' },
          { id: null },
        ],
      }));
    },
  });

  assert.equal(requestedUrl, 'https://example.com/v1/models');
  assert.equal(authorization, 'Bearer secret');
  assert.equal(result.normalized_base_url, 'https://example.com/v1');
  assert.equal(result.warning, null);
  assert.deepEqual(result.models, [
    { id: 'gpt-image-2', category: 'image' },
    { id: 'dall-e-3', category: 'image' },
    { id: 'gpt-5.5', category: 'other' },
  ]);
});

test('provider model discovery rejects base urls with credentials before fetching', async () => {
  let fetched = false;

  await assert.rejects(
    listImageProviderModels({
      baseUrl: 'https://user:pass@example.com',
      apiKey: 'secret',
      fetchImpl: async () => {
        fetched = true;
        return new Response(JSON.stringify({ data: [] }));
      },
    }),
    /base_url must not include credentials/,
  );
  assert.equal(fetched, false);
});

test('provider model discovery returns warning instead of throwing on HTTP failures', async () => {
  const result = await listImageProviderModels({
    baseUrl: 'https://example.com/v1/',
    apiKey: 'sk-provider-secret',
    fetchImpl: async () => new Response('upstream failed with sk-provider-secret', {
      status: 401,
    }),
  });

  assert.equal(result.normalized_base_url, 'https://example.com/v1');
  assert.deepEqual(result.models, []);
  assert.match(result.warning ?? '', /模型列表拉取失败：HTTP 401/);
  assert.doesNotMatch(result.warning ?? '', /sk-provider-secret/);
});

test('provider model discovery sanitizes thrown fetch errors', async () => {
  const result = await listImageProviderModels({
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-thrown-secret',
    fetchImpl: async () => {
      throw new Error('Authorization: Bearer sk-thrown-secret rejected');
    },
  });

  assert.deepEqual(result.models, []);
  assert.match(result.warning ?? '', /模型列表拉取失败：/);
  assert.match(result.warning ?? '', /\[REDACTED_CREDENTIAL\]/);
  assert.doesNotMatch(result.warning ?? '', /sk-thrown-secret/);
});

test('provider model discovery reports invalid JSON as a warning', async () => {
  const result = await listImageProviderModels({
    baseUrl: 'https://example.com/v1',
    apiKey: 'secret',
    fetchImpl: async () => new Response('not json'),
  });

  assert.deepEqual(result.models, []);
  assert.match(result.warning ?? '', /模型列表拉取失败：/);
});
