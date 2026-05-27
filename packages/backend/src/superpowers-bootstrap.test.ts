import test from 'node:test';
import assert from 'node:assert/strict';

const {
  prependSuperpowersSessionBootstrap,
} = await import('./superpowers-bootstrap.js');

test('prependSuperpowersSessionBootstrap still injects bootstrap when user prompt mentions using-superpowers', () => {
  const prompt = '当前用户请求：\n分析 using-superpowers 的调用方式';

  const withBootstrap = prependSuperpowersSessionBootstrap(prompt);

  assert.match(withBootstrap, /<EXTREMELY_IMPORTANT>/);
  assert.match(withBootstrap, /You have superpowers\./);
  assert.match(withBootstrap, /superpowers:using-superpowers/);
  assert.ok(withBootstrap.endsWith(prompt));
});

test('prependSuperpowersSessionBootstrap does not duplicate an existing bootstrap block', () => {
  const prompt = '当前用户请求：\nhi';

  const once = prependSuperpowersSessionBootstrap(prompt);
  const twice = prependSuperpowersSessionBootstrap(once);

  assert.equal(twice, once);
});
