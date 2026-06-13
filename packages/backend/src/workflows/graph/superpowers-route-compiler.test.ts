import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSuperpowersRouteDefinition } from './superpowers-route-compiler.js';

test('buildSuperpowersRouteDefinition exposes all intent branches', () => {
  const definition = buildSuperpowersRouteDefinition();
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const edgeIds = new Set(definition.edges.map((edge) => `${edge.from}->${edge.to}:${edge.condition ?? ''}`));

  for (const id of [
    'context',
    'intake',
    'route_skills',
    'answer',
    'analysis_plan',
    'lightweight_plan',
    'brainstorming',
    'debug_plan',
    'systematic_debugging',
    'review_plan',
    'agent_assignment',
    'dispatch',
    'verification',
    'finish_branch',
    'acceptance',
    'memory',
  ]) {
    assert.equal(nodeIds.has(id), true, `missing node ${id}`);
  }

  assert.equal(edgeIds.has('context->intake:'), true);
  assert.equal(edgeIds.has('intake->route_skills:'), true);
  assert.equal(edgeIds.has('route_skills->answer:answer'), true);
  assert.equal(edgeIds.has('route_skills->analysis_plan:analysis'), true);
  assert.equal(edgeIds.has('route_skills->lightweight_plan:lightweight_task'), true);
  assert.equal(edgeIds.has('route_skills->brainstorming:standard_development'), true);
  assert.equal(edgeIds.has('route_skills->debug_plan:debug'), true);
  assert.equal(edgeIds.has('route_skills->review_plan:review_only'), true);
  assert.equal(edgeIds.has('spec_compliance_review->verification:review_only'), true);
});
