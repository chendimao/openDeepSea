import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpenClawSessionAlreadyPresentError } from './dispatcher.js';

test('detects OpenClaw session already exists errors as reusable', () => {
  assert.equal(isOpenClawSessionAlreadyPresentError(new Error('session already exists')), true);
});

test('detects OpenClaw label already in use errors as reusable', () => {
  assert.equal(
    isOpenClawSessionAlreadyPresentError(new Error('label already in use: OpenClaw Room pm')),
    true,
  );
});

test('does not treat unrelated gateway errors as reusable sessions', () => {
  assert.equal(isOpenClawSessionAlreadyPresentError(new Error('Gateway connect timeout')), false);
});
