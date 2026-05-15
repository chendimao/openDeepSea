import test from 'node:test';
import assert from 'node:assert/strict';
import { getLangChainPlannerConfig } from './langchain-planner.js';

test('getLangChainPlannerConfig returns disabled config when no model is configured', () => {
  const config = getLangChainPlannerConfig({
    LANGCHAIN_PLANNER_MODEL: '',
    OPENAI_API_KEY: '',
  });

  assert.equal(config.enabled, false);
  assert.equal(config.model, null);
});
