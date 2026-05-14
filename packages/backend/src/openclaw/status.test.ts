import assert from 'node:assert/strict';
import test from 'node:test';
import { statusTestInternals } from './status.js';

test('gateway status falls back to TCP probe when CLI status fails', async () => {
  const status = await statusTestInternals.getOpenClawGatewayStatusWithDeps(1, {
    execGatewayStatus: (_timeoutMs, callback) => {
      callback(new Error('Command failed: openclaw gateway status --json'), '', '');
      return { on: () => undefined };
    },
    canConnect: async (target) => {
      assert.equal(target.host, '127.0.0.1');
      assert.equal(target.port, 18789);
      return true;
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.running, true);
  assert.equal(status.rpcOk, false);
  assert.equal(status.source, 'tcp-probe');
  assert.match(status.warning ?? '', /Command failed: openclaw gateway status --json/);
  assert.equal(status.error, undefined);
});

test('gateway status reports offline when CLI and TCP probe both fail', async () => {
  const status = await statusTestInternals.getOpenClawGatewayStatusWithDeps(1, {
    execGatewayStatus: (_timeoutMs, callback) => {
      callback(new Error('spawn openclaw ENOENT'), '', '');
      return { on: () => undefined };
    },
    canConnect: async () => false,
  });

  assert.equal(status.ok, false);
  assert.equal(status.running, false);
  assert.equal(status.source, 'tcp-probe');
  assert.match(status.error ?? '', /spawn openclaw ENOENT/);
});
