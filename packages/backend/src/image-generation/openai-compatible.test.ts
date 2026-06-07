import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requestOpenAICompatibleImageEdit,
  requestOpenAICompatibleImageGeneration,
} from './openai-compatible.js';

test('runtime saves base64 image generation result into buffers', async () => {
  const pngBytes = Buffer.from('fake-png');
  let requestedUrl = '';
  let requestBody: Record<string, unknown> | null = null;

  const response = await requestOpenAICompatibleImageGeneration({
    baseUrl: 'https://example.com',
    apiKey: 'secret',
    model: 'gpt-image-2',
    prompt: 'apple',
    count: 1,
    quality: 'auto',
    size: '1024x1024',
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        data: [{ b64_json: pngBytes.toString('base64') }],
      }), { status: 200 });
    },
  });

  assert.equal(requestedUrl, 'https://example.com/v1/images/generations');
  assert.deepEqual(requestBody, {
    model: 'gpt-image-2',
    prompt: 'apple',
    n: 1,
    size: '1024x1024',
  });
  assert.equal(response.images.length, 1);
  assert.deepEqual(response.images[0]?.data, pngBytes);
  assert.equal(response.images[0]?.mimeType, 'image/png');
});

test('runtime downloads ordinary URL image generation results', async () => {
  const webpBytes = Buffer.from('fake-webp');
  const requestedUrls: string[] = [];

  const response = await requestOpenAICompatibleImageGeneration({
    baseUrl: 'https://example.com/v1',
    apiKey: 'secret',
    model: 'gpt-image-2',
    prompt: 'apple',
    count: 1,
    quality: 'standard',
    size: 'auto',
    fetchImpl: async (input) => {
      requestedUrls.push(String(input));
      if (requestedUrls.length === 1) {
        return new Response(JSON.stringify({
          data: [{ url: 'https://cdn.example.com/generated.webp' }],
        }));
      }
      return new Response(webpBytes, {
        headers: { 'content-type': 'image/webp' },
      });
    },
  });

  assert.deepEqual(requestedUrls, [
    'https://example.com/v1/images/generations',
    'https://cdn.example.com/generated.webp',
  ]);
  assert.equal(response.images.length, 1);
  assert.deepEqual(response.images[0]?.data, webpBytes);
  assert.equal(response.images[0]?.mimeType, 'image/webp');
});

test('runtime normalizes URL download failures without leaking API keys', async () => {
  let requestCount = 0;

  await assert.rejects(
    requestOpenAICompatibleImageGeneration({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-runtime-secret',
      model: 'gpt-image-2',
      prompt: 'apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      fetchImpl: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({
            data: [{ url: 'https://cdn.example.com/generated.webp' }],
          }));
        }
        throw new Error('Bearer sk-runtime-secret download failed');
      },
    }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /图片资源下载失败/);
      assert.match(err.message, /Bearer \[REDACTED_CREDENTIAL\]/);
      assert.doesNotMatch(err.message, /sk-runtime-secret/);
      return true;
    },
  );
});

test('runtime decodes data URL image generation results', async () => {
  const jpegBytes = Buffer.from('fake-jpeg');
  const response = await requestOpenAICompatibleImageGeneration({
    baseUrl: 'https://example.com/v1',
    apiKey: 'secret',
    model: 'gpt-image-2',
    prompt: 'apple',
    count: 1,
    quality: 'auto',
    size: 'auto',
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ url: `data:image/jpeg;base64,${jpegBytes.toString('base64')}` }],
    })),
  });

  assert.equal(response.images.length, 1);
  assert.deepEqual(response.images[0]?.data, jpegBytes);
  assert.equal(response.images[0]?.mimeType, 'image/jpeg');
});

test('runtime normalizes HTTP errors without leaking API keys', async () => {
  await assert.rejects(
    requestOpenAICompatibleImageGeneration({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-runtime-secret',
      model: 'gpt-image-2',
      prompt: 'apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: 'quota exceeded for sk-runtime-secret' },
      }), { status: 429 }),
    }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /图片生成失败：HTTP 429/);
      assert.match(err.message, /quota exceeded/);
      assert.match(err.message, /\[REDACTED_CREDENTIAL\]/);
      assert.doesNotMatch(err.message, /sk-runtime-secret/);
      return true;
    },
  );
});

test('runtime normalizes generation request failures without leaking API keys', async () => {
  await assert.rejects(
    requestOpenAICompatibleImageGeneration({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-runtime-secret',
      model: 'gpt-image-2',
      prompt: 'apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      fetchImpl: async () => {
        throw new Error('Authorization: Bearer sk-runtime-secret network failed');
      },
    }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /图片生成请求失败/);
      assert.match(err.message, /\[REDACTED_CREDENTIAL\]/);
      assert.doesNotMatch(err.message, /sk-runtime-secret/);
      return true;
    },
  );
});

test('runtime reports non JSON responses as readable errors', async () => {
  await assert.rejects(
    requestOpenAICompatibleImageGeneration({
      baseUrl: 'https://example.com/v1',
      apiKey: 'secret',
      model: 'gpt-image-2',
      prompt: 'apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      fetchImpl: async () => new Response('not json', { status: 200 }),
    }),
    /图片生成响应不是有效 JSON/,
  );
});

test('runtime sends image edits as multipart form data', async () => {
  const pngBytes = Buffer.from('edited-png');
  const sourceBytes = Buffer.from('source-a');
  let requestedUrl = '';
  const requestInits: RequestInit[] = [];

  const response = await requestOpenAICompatibleImageEdit({
    baseUrl: 'https://example.com',
    apiKey: 'secret',
    model: 'gpt-image-2',
    prompt: 'retouch',
    count: 2,
    quality: 'high',
    size: 'auto',
    sourceImages: [{
      data: sourceBytes,
      mimeType: 'image/png',
      name: 'source.png',
    }],
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestInits.push(init ?? {});
      return new Response(JSON.stringify({
        data: [{ b64_json: pngBytes.toString('base64') }],
      }));
    },
  });

  const requestInit = requestInits[0];
  assert.ok(requestInit);
  assert.equal(requestedUrl, 'https://example.com/v1/images/edits');
  assert.equal(requestInit.method, 'POST');
  assert.equal(new Headers(requestInit.headers).get('authorization'), 'Bearer secret');
  assert.equal(new Headers(requestInit.headers).has('content-type'), false);

  const formData = requestInit.body;
  assert.ok(formData instanceof FormData);
  assert.equal(formData.get('model'), 'gpt-image-2');
  assert.equal(formData.get('prompt'), 'retouch');
  assert.equal(formData.get('n'), '2');
  assert.equal(formData.get('quality'), 'high');
  assert.equal(formData.has('size'), false);

  const sourceFile = formData.get('image[]');
  assert.ok(sourceFile instanceof File);
  assert.equal(sourceFile.name, 'source.png');
  assert.equal(sourceFile.type, 'image/png');
  assert.equal(await sourceFile.text(), 'source-a');
  assert.deepEqual(response.images[0]?.data, pngBytes);
});

test('runtime normalizes edit request failures without leaking API keys', async () => {
  await assert.rejects(
    requestOpenAICompatibleImageEdit({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-runtime-secret',
      model: 'gpt-image-2',
      prompt: 'retouch',
      count: 1,
      quality: 'auto',
      size: 'auto',
      sourceImages: [{
        data: Buffer.from('source'),
        mimeType: 'image/png',
        name: 'source.png',
      }],
      fetchImpl: async () => {
        throw new Error('Bearer sk-runtime-secret edit failed');
      },
    }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /图片生成请求失败/);
      assert.match(err.message, /Bearer \[REDACTED_CREDENTIAL\]/);
      assert.doesNotMatch(err.message, /sk-runtime-secret/);
      return true;
    },
  );
});
