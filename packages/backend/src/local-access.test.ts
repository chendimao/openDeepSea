import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingHttpHeaders } from 'node:http';
import {
  createLocalAccessToken,
  getLocalAccessToken,
  isTrustedOrigin,
  validateLocalAccess,
} from './local-access.js';

type AccessRequest = {
  method?: string;
  headers?: IncomingHttpHeaders;
};

const TRUSTED_LOCALHOST_ORIGIN = 'http://localhost:5173';
const TRUSTED_LOOPBACK_ORIGIN = 'http://127.0.0.1:4173';
const UNTRUSTED_ORIGIN = 'https://evil.example';

function requestWithToken(token: string, origin: string): AccessRequest {
  return {
    method: 'GET',
    headers: {
      origin,
      'x-opendeepsea-local-token': token,
    },
  };
}

test('local access accepts trusted frontend origin with token', () => {
  const token = createLocalAccessToken();
  const result = validateLocalAccess(requestWithToken(token, TRUSTED_LOCALHOST_ORIGIN), token);
  assert.equal(result.ok, true);
});

test('local access rejects untrusted origin even with token', () => {
  const token = createLocalAccessToken();
  const result = validateLocalAccess(requestWithToken(token, UNTRUSTED_ORIGIN), token);
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('local access rejects missing or wrong token', () => {
  const token = createLocalAccessToken();

  const missingToken = validateLocalAccess({
    method: 'GET',
    headers: { origin: TRUSTED_LOCALHOST_ORIGIN },
  }, token);
  assert.equal(missingToken.ok, false);
  assert.equal(missingToken.status, 403);

  const wrongToken = validateLocalAccess({
    method: 'GET',
    headers: {
      origin: TRUSTED_LOCALHOST_ORIGIN,
      'x-opendeepsea-local-token': `${token}-wrong`,
    },
  }, token);
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.status, 403);
});

test('local access uses one configured token source', () => {
  const configured = 'configured-local-token-for-test';
  process.env.OPENDEEPSEA_LOCAL_TOKEN = configured;
  assert.equal(getLocalAccessToken(), configured);
  assert.equal(getLocalAccessToken(), configured);
  delete process.env.OPENDEEPSEA_LOCAL_TOKEN;
});

test('trusted origin check accepts localhost and 127.0.0.1 frontend ports', () => {
  assert.equal(isTrustedOrigin(TRUSTED_LOCALHOST_ORIGIN), true);
  assert.equal(isTrustedOrigin(TRUSTED_LOOPBACK_ORIGIN), true);
  assert.equal(isTrustedOrigin('http://[::1]:5173'), true);
  assert.equal(isTrustedOrigin(UNTRUSTED_ORIGIN), false);
});
