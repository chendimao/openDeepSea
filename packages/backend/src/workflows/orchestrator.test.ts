import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseLangChainPlanner } from './orchestrator.js';

test('shouldUseLangChainPlanner only enables LangChain for planning stage with enabled config', () => {
  assert.equal(shouldUseLangChainPlanner('planning', { enabled: true, model: 'gpt-4.1-mini' }), true);
  assert.equal(shouldUseLangChainPlanner('analysis', { enabled: true, model: 'gpt-4.1-mini' }), false);
  assert.equal(shouldUseLangChainPlanner('planning', { enabled: false, model: null }), false);
});
