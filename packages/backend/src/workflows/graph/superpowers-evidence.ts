import type { AgentWorkflowState, SuperpowersFinishBranchDecision, SuperpowersReview } from './state.js';

export interface SuperpowersEvidencePatch {
  designDocPath?: string | null;
  designReviewVerdict?: AgentWorkflowState['designReviewVerdict'];
  implementationPlanPath?: string | null;
  planReviewVerdict?: AgentWorkflowState['planReviewVerdict'];
  worktree?: AgentWorkflowState['worktree'];
  tddEvidence?: NonNullable<AgentWorkflowState['tddEvidence']>;
  tddExemption?: AgentWorkflowState['tddExemption'];
  specComplianceReview?: SuperpowersReview | null;
  codeQualityReview?: SuperpowersReview | null;
  verificationEvidence?: NonNullable<AgentWorkflowState['verificationEvidence']>;
  finishBranchDecision?: SuperpowersFinishBranchDecision | null;
}

type EvidenceRecord = Record<string, unknown>;

export function parseSuperpowersEvidence(output: string): SuperpowersEvidencePatch {
  const parsed = parseEvidenceObject(output);
  if (!parsed) return {};
  const root = isRecord(parsed.superpowers) ? parsed.superpowers : parsed;
  const patch: SuperpowersEvidencePatch = {};

  const designDocPath = stringValue(root.designDocPath ?? root.design_doc_path);
  if (designDocPath) patch.designDocPath = designDocPath;

  const designReviewVerdict = reviewVerdict(root.designReviewVerdict ?? root.design_review_verdict);
  if (designReviewVerdict) patch.designReviewVerdict = designReviewVerdict;

  const implementationPlanPath = stringValue(root.implementationPlanPath ?? root.implementation_plan_path);
  if (implementationPlanPath) patch.implementationPlanPath = implementationPlanPath;

  const planReviewVerdict = reviewVerdict(root.planReviewVerdict ?? root.plan_review_verdict);
  if (planReviewVerdict) patch.planReviewVerdict = planReviewVerdict;

  const worktree = isRecord(root.worktree) ? root.worktree : null;
  if (worktree) {
    const path = stringValue(worktree.path);
    const branchName = stringValue(worktree.branchName ?? worktree.branch_name);
    if (path && branchName) {
      patch.worktree = {
        path,
        branchName,
        baseRef: stringValue(worktree.baseRef ?? worktree.base_ref),
      };
    }
  }

  const tddEvidence = arrayValue(root.tddEvidence ?? root.tdd_evidence)
    .flatMap((item) => isRecord(item) ? [item] : [])
    .flatMap(parseTddRecord);
  if (tddEvidence.length > 0) patch.tddEvidence = tddEvidence;

  const exemption = isRecord(root.tddExemption ?? root.tdd_exemption) ? root.tddExemption ?? root.tdd_exemption : null;
  if (isRecord(exemption)) {
    const reason = stringValue(exemption.reason);
    const approvedBy = stringValue(exemption.approvedBy ?? exemption.approved_by);
    const createdAt = numberValue(exemption.createdAt ?? exemption.created_at) ?? Date.now();
    if (reason && approvedBy) patch.tddExemption = { reason, approvedBy, createdAt };
  }

  const specComplianceReview = parseReview(root.specComplianceReview ?? root.spec_compliance_review);
  if (specComplianceReview) patch.specComplianceReview = specComplianceReview;

  const codeQualityReview = parseReview(root.codeQualityReview ?? root.code_quality_review);
  if (codeQualityReview) patch.codeQualityReview = codeQualityReview;

  const verificationEvidence = arrayValue(root.verificationEvidence ?? root.verification_evidence)
    .flatMap((item) => isRecord(item) ? [item] : [])
    .flatMap(parseVerificationRecord);
  if (verificationEvidence.length > 0) patch.verificationEvidence = verificationEvidence;

  const finishBranchDecision = parseFinishBranchDecision(root.finishBranchDecision ?? root.finish_branch_decision);
  if (finishBranchDecision) patch.finishBranchDecision = finishBranchDecision;

  return patch;
}

export function applySuperpowersEvidencePatch(
  state: AgentWorkflowState,
  patch: SuperpowersEvidencePatch,
): AgentWorkflowState {
  return {
    ...state,
    designDocPath: patch.designDocPath ?? state.designDocPath,
    designReviewVerdict: patch.designReviewVerdict ?? state.designReviewVerdict,
    implementationPlanPath: patch.implementationPlanPath ?? state.implementationPlanPath,
    planReviewVerdict: patch.planReviewVerdict ?? state.planReviewVerdict,
    worktree: patch.worktree ?? state.worktree,
    tddEvidence: appendUniqueTddEvidence(state.tddEvidence ?? [], patch.tddEvidence ?? []),
    tddExemption: patch.tddExemption ?? state.tddExemption,
    specComplianceReview: patch.specComplianceReview ?? state.specComplianceReview,
    codeQualityReview: patch.codeQualityReview ?? state.codeQualityReview,
    verificationEvidence: appendUniqueVerificationEvidence(
      state.verificationEvidence ?? [],
      patch.verificationEvidence ?? [],
    ),
    finishBranchDecision: patch.finishBranchDecision ?? state.finishBranchDecision,
  };
}

function parseEvidenceObject(output: string): EvidenceRecord | null {
  if (!output.trim()) return null;
  for (const candidate of extractJsonCandidates(output)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function extractJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  const fenced = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fenced) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  const firstBrace = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(output.slice(firstBrace, lastBrace + 1));
  candidates.push(output.trim());
  return candidates;
}

function parseTddRecord(record: EvidenceRecord): NonNullable<AgentWorkflowState['tddEvidence']> {
  const stage = record.stage;
  if (stage !== 'RED' && stage !== 'GREEN' && stage !== 'REFACTOR') return [];
  const passed = booleanOrNull(record.passed);
  if (passed === undefined) return [];
  return [{
    stage,
    command: stringValue(record.command),
    summary: stringValue(record.summary),
    passed,
  }];
}

function parseVerificationRecord(record: EvidenceRecord): NonNullable<AgentWorkflowState['verificationEvidence']> {
  const command = stringValue(record.command);
  const status = record.status;
  if (!command || (status !== 'passed' && status !== 'failed' && status !== 'skipped')) return [];
  return [{
    command,
    status,
    required: booleanValue(record.required) ?? true,
    fresh: booleanValue(record.fresh) ?? true,
    recordedAt: stringValue(record.recordedAt ?? record.recorded_at),
  }];
}

function parseReview(value: unknown): SuperpowersReview | null {
  if (!isRecord(value)) return null;
  const verdict = reviewVerdict(value.verdict);
  if (!verdict) return null;
  return {
    verdict,
    findings: arrayValue(value.findings).flatMap((item) => stringValue(item) ? [stringValue(item)!] : []),
    reviewedAt: stringValue(value.reviewedAt ?? value.reviewed_at),
  };
}

function parseFinishBranchDecision(value: unknown): SuperpowersFinishBranchDecision | null {
  if (!isRecord(value)) return null;
  const decision = value.decision;
  if (
    decision !== 'merge_local'
    && decision !== 'create_pr'
    && decision !== 'keep_branch'
    && decision !== 'discard_work'
  ) {
    return null;
  }
  const reason = stringValue(value.reason);
  if (!reason) return null;
  const options = arrayValue(value.options).filter((item): item is SuperpowersFinishBranchDecision['decision'] =>
    item === 'merge_local' || item === 'create_pr' || item === 'keep_branch' || item === 'discard_work',
  );
  return {
    decision,
    options,
    reason,
    decidedAt: stringValue(value.decidedAt ?? value.decided_at),
  };
}

function appendUniqueTddEvidence(
  existing: NonNullable<AgentWorkflowState['tddEvidence']>,
  incoming: NonNullable<AgentWorkflowState['tddEvidence']>,
): NonNullable<AgentWorkflowState['tddEvidence']> {
  const seen = new Set(existing.map((item) => JSON.stringify(item)));
  const next = [...existing];
  for (const item of incoming) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

function appendUniqueVerificationEvidence(
  existing: NonNullable<AgentWorkflowState['verificationEvidence']>,
  incoming: NonNullable<AgentWorkflowState['verificationEvidence']>,
): NonNullable<AgentWorkflowState['verificationEvidence']> {
  const seen = new Set(existing.map((item) => `${item.command}:${item.status}:${item.required}:${item.fresh}`));
  const next = [...existing];
  for (const item of incoming) {
    const key = `${item.command}:${item.status}:${item.required}:${item.fresh}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

function reviewVerdict(value: unknown): SuperpowersReview['verdict'] | null {
  if (value === 'pass') return 'approved';
  if (value === 'approved' || value === 'changes_requested' || value === 'failed' || value === 'pending') return value;
  return null;
}

function isRecord(value: unknown): value is EvidenceRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function booleanOrNull(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  return undefined;
}
