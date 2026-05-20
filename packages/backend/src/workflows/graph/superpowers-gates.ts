import type { AgentWorkflowState } from './state.js';

export function canLeaveBrainstorming(state: AgentWorkflowState): boolean {
  return Boolean(state.designDocPath) && state.designReviewVerdict === 'approved';
}

export function canLeaveWritingPlans(state: AgentWorkflowState): boolean {
  return Boolean(state.implementationPlanPath) && state.planReviewVerdict === 'approved';
}

export function canLeaveTddExecute(state: AgentWorkflowState): boolean {
  if (state.tddExemption) {
    return true;
  }

  const evidence = state.tddEvidence ?? [];
  const hasRed = evidence.some((record) => record.stage === 'RED');
  const hasGreen = evidence.some((record) => record.stage === 'GREEN' && record.passed === true);

  return hasRed && hasGreen;
}

export function canLeaveVerify(state: AgentWorkflowState): boolean {
  const evidence = state.verificationEvidence ?? [];
  return evidence.length > 0 && evidence.every((record) => record.status === 'passed');
}
