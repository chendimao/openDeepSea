import type { AgentWorkflowState } from './state.js';

function isNonEmptyTrimmedString(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidTddExemption(state: AgentWorkflowState): boolean {
  const exemption = state.tddExemption;
  if (!exemption) {
    return false;
  }

  const validCreatedAt = typeof exemption.createdAt === 'number'
    && Number.isFinite(exemption.createdAt)
    && exemption.createdAt > 0;

  return isNonEmptyTrimmedString(exemption.reason)
    && isNonEmptyTrimmedString(exemption.approvedBy)
    && validCreatedAt;
}

export function canLeaveBrainstorming(state: AgentWorkflowState): boolean {
  return isNonEmptyTrimmedString(state.designDocPath) && state.designReviewVerdict === 'approved';
}

export function canLeaveWritingPlans(state: AgentWorkflowState): boolean {
  return isNonEmptyTrimmedString(state.implementationPlanPath) && state.planReviewVerdict === 'approved';
}

export function canLeaveTddExecute(state: AgentWorkflowState): boolean {
  if (isValidTddExemption(state)) {
    return true;
  }

  const evidence = state.tddEvidence ?? [];
  const hasRed = evidence.some((record) => record.stage === 'RED' && record.passed === false);
  const hasGreen = evidence.some((record) => record.stage === 'GREEN' && record.passed === true);

  return hasRed && hasGreen;
}

export function canLeaveVerify(state: AgentWorkflowState): boolean {
  const evidence = state.verificationEvidence ?? [];
  const requiredEvidence = evidence.filter((record) => record.required);
  if (requiredEvidence.length === 0 && canSkipRequiredVerification(state)) {
    return true;
  }

  return requiredEvidence.length > 0
    && requiredEvidence.every((record) => record.status === 'passed' && record.fresh === true);
}

function canSkipRequiredVerification(state: AgentWorkflowState): boolean {
  if (state.selectedIntent !== 'review_only') return false;
  const commands = state.plan?.verificationCommands ?? [];
  const legacyCommands = state.plan?.verification ?? [];
  const hasRequiredCommand = commands.some((command) => command.required !== false && command.command.trim().length > 0);
  const hasLegacyCommand = legacyCommands.some((command) => command.trim().length > 0);
  return !hasRequiredCommand && !hasLegacyCommand;
}
