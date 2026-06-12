import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUPERPOWERS_V2_GRAPH_VERSION,
  getSuperpowersStage,
  listSuperpowersStages,
} from './superpowers-stage-registry.js';

test('Superpowers v2 stage registry defines planner controlled gates before execution', () => {
  assert.equal(SUPERPOWERS_V2_GRAPH_VERSION, 'superpowers-v2');
  assert.deepEqual(listSuperpowersStages().slice(0, 6).map((stage) => stage.id), [
    'intake',
    'route_skills',
    'brainstorming',
    'spec_review',
    'spec_confirm',
    'writing_plans',
  ]);
  assert.equal(getSuperpowersStage('brainstorming')?.controller, 'planner');
  assert.equal(getSuperpowersStage('execute')?.controller, 'worker');
  assert.equal(getSuperpowersStage('code_quality_review')?.controller, 'reviewer');
  assert.equal(getSuperpowersStage('verification')?.controller, 'verifier');
});
