import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldServeFrontendFallback } from './frontend-static.js';

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
