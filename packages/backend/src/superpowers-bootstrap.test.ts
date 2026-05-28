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

test('applySuperpowersBootstrap injects project-builtin brainstorming for matching project-owned prompts', () => {
  const result = applySuperpowersBootstrap({
    prompt: '当前用户请求：\n我想新增一个很小的设置项，请先按 using-superpowers 判断是否需要进入 workflow，并做简短 brainstorming 澄清，不要修改代码。',
    owner: 'project',
    workflowRunId: null,
  });

  assert.equal(result.injected, true);
  assert.match(result.prompt, /OpenDeepSea project-owned Superpowers skills are loaded below/);
  assert.match(result.prompt, /Skill: superpowers:brainstorming/);
  assert.match(result.prompt, /Source: project-builtin/);
  assert.match(result.prompt, /packages\/backend\/src\/superpowers\/skills\/brainstorming\/SKILL\.md/);
  assert.match(result.prompt, /# Brainstorming Ideas Into Designs/);
  assert.match(result.prompt, /Do not read or invoke same-name skills from ~\/\.agents\/skills/);
  assert.match(result.prompt, /ACP filesystem\/search\/shell tools remain available/);
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
