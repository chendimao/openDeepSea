import assert from 'node:assert/strict';
import test from 'node:test';
import { TtlCache } from './cache.js';

test('TtlCache returns fresh values before ttl expires', () => {
  let now = 1_000;
  const cache = new TtlCache<string, number>({ now: () => now });

  cache.set('skills', 42, 100);

  assert.equal(cache.get('skills')?.value, 42);
  assert.equal(cache.get('skills')?.stale, false);

  now = 1_050;
  assert.equal(cache.get('skills')?.value, 42);
  assert.equal(cache.get('skills')?.stale, false);
});

test('TtlCache exposes stale values after ttl expires', () => {
  let now = 1_000;
  const cache = new TtlCache<string, number>({ now: () => now });

  cache.set('skills', 42, 100);
  now = 1_101;

  const entry = cache.get('skills');
  assert.equal(entry?.value, 42);
  assert.equal(entry?.stale, true);
});

test('TtlCache delete removes cached values', () => {
  const cache = new TtlCache<string, number>();

  cache.set('skills', 42, 100);
  cache.delete('skills');

  assert.equal(cache.get('skills'), null);
});
