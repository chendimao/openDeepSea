import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSuperpowersRuntimeGraph,
  SUPERPOWERS_GRAPH_VERSION,
  SUPERPOWERS_RUNTIME_PROFILE,
} from './superpowers-runtime.js';

test('buildSuperpowersRuntimeGraph exposes Superpowers runtime profile metadata', () => {
  const graph = buildSuperpowersRuntimeGraph();

  assert.equal(graph.graphVersion, SUPERPOWERS_GRAPH_VERSION);
  assert.equal(graph.runtimeProfile, SUPERPOWERS_RUNTIME_PROFILE);
  assert.deepEqual(graph.placeholderNodeTypes, [
    'brainstorming',
    'spec_review',
    'worktree',
    'writing_plans',
    'plan_review',
    'tdd_execute',
    'spec_compliance_review',
    'code_quality_review',
    'finish_branch',
  ]);
});
