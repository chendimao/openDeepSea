import test from 'node:test';
import assert from 'node:assert/strict';
import { getLangGraphWorkflowConfig } from './runtime-config.js';

test('getLangGraphWorkflowConfig is enabled by default', () => {
  const config = getLangGraphWorkflowConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.graphVersion, 'phase-b-v1');
});

test('getLangGraphWorkflowConfig enables graph runtime with explicit flag', () => {
  const config = getLangGraphWorkflowConfig({ LANGGRAPH_WORKFLOW_ENABLED: '1' });
  assert.equal(config.enabled, true);
});

test('getLangGraphWorkflowConfig can be disabled with explicit false flag', () => {
  assert.equal(getLangGraphWorkflowConfig({ LANGGRAPH_WORKFLOW_ENABLED: '0' }).enabled, false);
  assert.equal(getLangGraphWorkflowConfig({ LANGGRAPH_WORKFLOW_ENABLED: 'false' }).enabled, false);
});
