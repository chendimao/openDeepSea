import test from 'node:test';
import assert from 'node:assert/strict';

const {
  applySuperpowersBootstrap,
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

test('applySuperpowersBootstrap injects when owner is project', () => {
  const result = applySuperpowersBootstrap({
    prompt: '当前用户请求：\nhi',
    owner: 'project',
    workflowRunId: null,
  });

  assert.equal(result.injected, true);
  assert.equal(result.source, 'project');
  assert.equal(result.skill, 'superpowers:using-superpowers');
  assert.equal(result.skipReason, null);
  assert.match(result.prompt, /You have superpowers\./);
});

test('applySuperpowersBootstrap skips when owner is provider', () => {
  const prompt = '当前用户请求：\nhi';
  const result = applySuperpowersBootstrap({
    prompt,
    owner: 'provider',
    workflowRunId: null,
  });

  assert.equal(result.injected, false);
  assert.equal(result.source, 'provider');
  assert.equal(result.skipReason, 'provider_owner');
  assert.equal(result.prompt, prompt);
});

test('applySuperpowersBootstrap skips workflow runs', () => {
  const result = applySuperpowersBootstrap({
    prompt: '当前用户请求：\nhi',
    owner: 'project',
    workflowRunId: 'workflow-1',
  });

  assert.equal(result.injected, false);
  assert.equal(result.skipReason, 'workflow_run');
});
