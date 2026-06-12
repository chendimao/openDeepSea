import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSuperpowersInvocationPrompt,
  parseRequiredSuperpowersEvidence,
} from './superpowers-invocation.js';

test('buildSuperpowersInvocationPrompt constrains worker not to act as planner', () => {
  const prompt = buildSuperpowersInvocationPrompt({
    stageId: 'execute',
    controller: 'worker',
    requiredSkills: ['test-driven-development'],
    roleInstruction: '你是 frontend implementer。',
    context: 'Task 2 context',
    expectedEvidence: ['tddEvidence'],
  });

  assert.match(prompt, /你不是 planner/);
  assert.match(prompt, /只执行分配给你的阶段或任务/);
  assert.match(prompt, /test-driven-development/);
  assert.match(prompt, /tddEvidence/);
});

test('parseRequiredSuperpowersEvidence reports missing evidence', () => {
  const result = parseRequiredSuperpowersEvidence('自然语言完成了', ['designDocPath']);

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /missing required evidence/);
});
