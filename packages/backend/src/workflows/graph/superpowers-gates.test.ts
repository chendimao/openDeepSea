import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canLeaveBrainstorming,
  canLeaveTddExecute,
  canLeaveVerify,
  canLeaveWritingPlans,
} from './superpowers-gates.js';
import { emptyAgentWorkflowState, type AgentWorkflowState } from './state.js';

function buildState(overrides: Partial<AgentWorkflowState>): AgentWorkflowState {
  return {
    ...emptyAgentWorkflowState({
      workflowRunId: 'run-superpowers-gates',
      projectId: 'project-superpowers-gates',
      roomId: 'room-superpowers-gates',
      taskId: 'task-superpowers-gates',
      userGoal: 'Superpowers gates',
      projectPath: '/tmp/openclaw-room-superpowers-gates',
    }),
    ...overrides,
  };
}

test('canLeaveBrainstorming requires an approved design document', () => {
  assert.equal(canLeaveBrainstorming(buildState({ designDocPath: null })), false);
  assert.equal(canLeaveBrainstorming(buildState({
    designDocPath: '   ',
    designReviewVerdict: 'approved',
  })), false);
  assert.equal(canLeaveBrainstorming(buildState({
    designDocPath: 'docs/x.md',
    designReviewVerdict: 'approved',
  })), true);
});

test('canLeaveWritingPlans requires an approved implementation plan', () => {
  assert.equal(canLeaveWritingPlans(buildState({ implementationPlanPath: null })), false);
  assert.equal(canLeaveWritingPlans(buildState({
    implementationPlanPath: '   ',
    planReviewVerdict: 'approved',
  })), false);
  assert.equal(canLeaveWritingPlans(buildState({
    implementationPlanPath: 'docs/superpowers/plans/x.md',
    planReviewVerdict: 'approved',
  })), true);
});

test('canLeaveTddExecute requires RED and GREEN evidence', () => {
  assert.equal(canLeaveTddExecute(buildState({ tddEvidence: [] })), false);
  assert.equal(canLeaveTddExecute(buildState({
    tddEvidence: [
      { stage: 'RED', command: 'npm test', passed: false, summary: 'failed as expected' },
      { stage: 'GREEN', command: 'npm test', passed: true, summary: 'passed' },
    ],
  })), true);
  assert.equal(canLeaveTddExecute(buildState({
    tddEvidence: [
      { stage: 'RED', command: 'npm test', passed: true, summary: 'unexpected pass' },
      { stage: 'GREEN', command: 'npm test', passed: true, summary: 'passed' },
    ],
  })), false);
});

test('canLeaveTddExecute allows explicit exemption without RED/GREEN evidence', () => {
  assert.equal(canLeaveTddExecute(buildState({
    tddEvidence: [],
    tddExemption: {
      reason: 'legacy module without deterministic test harness',
      approvedBy: 'reviewer-1',
      createdAt: Date.now(),
    },
  })), true);
  assert.equal(canLeaveTddExecute(buildState({
    tddEvidence: [],
    tddExemption: {
      reason: '   ',
      approvedBy: 'reviewer-1',
      createdAt: Date.now(),
    },
  })), false);
  assert.equal(canLeaveTddExecute(buildState({
    tddEvidence: [],
    tddExemption: {
      reason: 'legacy module without deterministic test harness',
      approvedBy: '   ',
      createdAt: Date.now(),
    },
  })), false);
  assert.equal(canLeaveTddExecute(buildState({
    tddEvidence: [],
    tddExemption: {
      reason: 'legacy module without deterministic test harness',
      approvedBy: 'reviewer-1',
      createdAt: Number.NaN,
    },
  })), false);
});

test('canLeaveVerify requires non-empty required passed fresh verification evidence', () => {
  assert.equal(canLeaveVerify(buildState({ verificationEvidence: [] })), false);
  assert.equal(canLeaveVerify(buildState({
    verificationEvidence: [
      { command: 'npm run lint', status: 'passed', required: false, fresh: true, recordedAt: null },
    ],
  })), false);
  assert.equal(canLeaveVerify(buildState({
    verificationEvidence: [
      { command: 'npm test', status: 'passed', required: true, fresh: true, recordedAt: null },
    ],
  })), true);
  assert.equal(canLeaveVerify(buildState({
    verificationEvidence: [
      { command: 'npm test', status: 'passed', required: true, fresh: false, recordedAt: null },
    ],
  })), false);
  assert.equal(canLeaveVerify(buildState({
    verificationEvidence: [
      { command: 'npm test', status: 'failed', required: true, fresh: true, recordedAt: null },
    ],
  })), false);
  assert.equal(canLeaveVerify(buildState({
    verificationEvidence: [
      { command: 'npm run lint', status: 'failed', required: false, fresh: true, recordedAt: null },
      { command: 'npm test', status: 'passed', required: true, fresh: true, recordedAt: null },
    ],
  })), true);
});
