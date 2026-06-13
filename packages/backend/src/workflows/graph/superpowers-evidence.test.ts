import test from 'node:test';
import assert from 'node:assert/strict';

import { applySuperpowersEvidencePatch, parseSuperpowersEvidence } from './superpowers-evidence.js';
import { emptyAgentWorkflowState } from './state.js';

test('parseSuperpowersEvidence reads fenced superpowers evidence block', () => {
  const patch = parseSuperpowersEvidence([
    '阶段完成。',
    '```json',
    '{',
    '  "superpowers": {',
    '    "designDocPath": "docs/superpowers/specs/2026-05-27-x.md",',
    '    "designReviewVerdict": "approved",',
    '    "implementationPlanPath": "docs/superpowers/plans/2026-05-27-x.md",',
    '    "planReviewVerdict": "approved"',
    '  }',
    '}',
    '```',
  ].join('\n'));

  assert.equal(patch.designDocPath, 'docs/superpowers/specs/2026-05-27-x.md');
  assert.equal(patch.designReviewVerdict, 'approved');
  assert.equal(patch.implementationPlanPath, 'docs/superpowers/plans/2026-05-27-x.md');
  assert.equal(patch.planReviewVerdict, 'approved');
});

test('parseSuperpowersEvidence reads TDD, review, verification, and finish branch evidence', () => {
  const patch = parseSuperpowersEvidence(JSON.stringify({
    superpowers: {
      tddEvidence: [
        { stage: 'RED', command: 'npm test', passed: false, summary: 'failed' },
        { stage: 'GREEN', command: 'npm test', passed: true, summary: 'passed' },
      ],
      specComplianceReview: { verdict: 'pass', findings: ['ok'], reviewedAt: '2026-05-27T00:00:00.000Z' },
      codeQualityReview: { verdict: 'changes_requested', findings: ['fix x'] },
      verificationEvidence: [
        { command: 'npm run build', status: 'passed', required: true, fresh: true },
      ],
      finishBranchDecision: {
        decision: 'keep_branch',
        options: ['merge_local', 'create_pr', 'keep_branch', 'discard_work'],
        reason: '等待用户确认',
      },
    },
  }));

  assert.equal(patch.tddEvidence?.length, 2);
  assert.equal(patch.tddEvidence?.[0]?.stage, 'RED');
  assert.equal(patch.specComplianceReview?.verdict, 'approved');
  assert.equal(patch.codeQualityReview?.verdict, 'changes_requested');
  assert.equal(patch.verificationEvidence?.[0]?.command, 'npm run build');
  assert.equal(patch.finishBranchDecision?.decision, 'keep_branch');
});

test('parseSuperpowersEvidence infers TDD exemption from explicit documentation-only output', () => {
  const patch = parseSuperpowersEvidence([
    '这是文档-only 任务，没有生产代码行为变更。',
    '按 Superpowers 流程记录 TDD 豁免依据：TDD 不适用。',
    '已完成 README 文档更新。',
  ].join('\n'));

  assert.equal(patch.tddExemption?.approvedBy, 'workflow-runtime');
  assert.match(patch.tddExemption?.reason ?? '', /文档|只读|配置/u);
  assert.equal(typeof patch.tddExemption?.createdAt, 'number');
});

test('parseSuperpowersEvidence does not infer TDD exemption from unrelated prose', () => {
  const patch = parseSuperpowersEvidence('任务已经完成，后续可以继续 review。');

  assert.equal(patch.tddExemption, undefined);
});

test('applySuperpowersEvidencePatch merges evidence without duplicating records', () => {
  const state = emptyAgentWorkflowState({
    workflowRunId: 'run-evidence',
    projectId: 'project-evidence',
    roomId: 'room-evidence',
    taskId: 'task-evidence',
    userGoal: 'Evidence',
    projectPath: '/tmp/evidence',
  });

  const patch = parseSuperpowersEvidence(JSON.stringify({
    superpowers: {
      tddEvidence: [
        { stage: 'RED', command: 'npm test', passed: false, summary: 'failed' },
      ],
      verificationEvidence: [
        { command: 'npm run build', status: 'passed', required: true, fresh: true },
      ],
    },
  }));

  const once = applySuperpowersEvidencePatch(state, patch);
  const twice = applySuperpowersEvidencePatch(once, patch);

  assert.equal(twice.tddEvidence?.length, 1);
  assert.equal(twice.verificationEvidence?.length, 1);
});
