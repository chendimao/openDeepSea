import assert from 'node:assert/strict';
import test from 'node:test';
import { getFrontendCacheControl, shouldServeFrontendFallback } from './frontend-static.js';

test('shouldServeFrontendFallback serves app routes', () => {
  assert.equal(shouldServeFrontendFallback('/'), true);
  assert.equal(shouldServeFrontendFallback('/projects/project-1/sessions/session-1'), true);
  assert.equal(shouldServeFrontendFallback('/skills'), true);
});

test('shouldServeFrontendFallback excludes backend routes and websocket path', () => {
  assert.equal(shouldServeFrontendFallback('/api/health'), false);
  assert.equal(shouldServeFrontendFallback('/api/projects'), false);
  assert.equal(shouldServeFrontendFallback('/uploads/files/project/file.png'), false);
  assert.equal(shouldServeFrontendFallback('/ws'), false);
});

test('getFrontendCacheControl avoids immutable caching for index.html', () => {
  assert.equal(getFrontendCacheControl('/app/dist/index.html'), 'no-store');
  assert.equal(getFrontendCacheControl('/app/dist/assets/index-abc123.js'), 'public, max-age=3600, immutable');
});
