import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api';

test('api no longer exposes SessionOS HTTP command methods', () => {
  const legacyMethods = [
    'newSessionFromCurrent',
    'previewCompact',
    'applyCompact',
    'discardCompact',
    'updateSessionContract',
    'getSessionStatus',
    'getSessionContext',
    'listSessionEvidence',
    'createSessionCheckpoint',
    'forkSession',
    'listHistoryRecords',
    'resumeHistoryRecord',
    'forkHistoryRecord',
  ];

  for (const method of legacyMethods) {
    assert.equal(method in api, false, `${method} should use WebSocket, not HTTP api`);
  }
});
