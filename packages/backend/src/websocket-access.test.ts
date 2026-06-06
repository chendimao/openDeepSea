import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWebSocketAccess } from './websocket-access.js';

test('websocket access accepts trusted browser origins without a token', () => {
  const result = validateWebSocketAccess({
    headers: { origin: 'http://localhost:5173' },
    url: '/ws',
  });

  assert.equal(result.ok, true);
});

test('websocket access rejects untrusted browser origins', () => {
  const result = validateWebSocketAccess({
    headers: { origin: 'https://evil.example' },
    url: '/ws',
  });

  assert.equal(result.ok, false);
});

test('websocket access requires token for no-origin clients', () => {
  const previous = process.env.OPENDEEPSEA_LOCAL_TOKEN;
  process.env.OPENDEEPSEA_LOCAL_TOKEN = 'ws-test-token';
  try {
    const missing = validateWebSocketAccess({ headers: {}, url: '/ws' });
    const wrong = validateWebSocketAccess({ headers: {}, url: '/ws?localToken=wrong' });
    const valid = validateWebSocketAccess({ headers: {}, url: '/ws?localToken=ws-test-token' });
    const protocol = validateWebSocketAccess({
      headers: { 'sec-websocket-protocol': 'opendeepsea, opendeepsea.local-token.ws-test-token' },
      url: '/ws',
    });

    assert.equal(missing.ok, false);
    assert.equal(wrong.ok, false);
    assert.equal(valid.ok, true);
    assert.equal(protocol.ok, true);
  } finally {
    if (previous === undefined) delete process.env.OPENDEEPSEA_LOCAL_TOKEN;
    else process.env.OPENDEEPSEA_LOCAL_TOKEN = previous;
  }
});
