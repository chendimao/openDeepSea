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
    designDocPath: 'docs/x.md',
    designReviewVerdict: 'approved',
  })), true);
});

test('canLeaveWritingPlans requires an approved implementation plan', () => {
  assert.equal(canLeaveWritingPlans(buildState({ implementationPlanPath: null })), false);
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
});

test('canLeaveVerify requires fresh passing required verification evidence', () => {
  assert.equal(canLeaveVerify(buildState({ verificationEvidence: [] })), false);
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
});
