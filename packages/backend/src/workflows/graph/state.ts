import { z } from 'zod';
import type { GraphNodeName, WorkflowPlanJson, WorkflowRole, WorkflowStage, WorkflowStatus } from '../../types.js';
import {
  taskKindSchema,
  taskRiskLevelSchema,
  verificationCommandSchema,
} from '../plan-parser.js';
import type { ParsedPlan } from '../plan-parser.js';
import type { ApprovalCard, TaskRiskAssessment } from '../task-risk.js';

export const workflowGraphNodeNameSchema = z.enum([
  'context',
  'planning',
  'brainstorming',
  'spec_review',
  'worktree',
  'writing_plans',
  'plan_review',
  'approval',
  'dispatch',
  'execute',
  'tdd_execute',
  'review',
  'spec_compliance_review',
  'code_quality_review',
  'repair_decision',
  'verify',
  'finish_branch',
  'acceptance',
  'memory',
]);

export const workflowStatusSchema = z.enum([
  'draft',
  'running',
  'awaiting_decision',
  'awaiting_approval',
  'blocked',
  'cancelled',
  'completed',
  'failed',
]);

export const verificationResultSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});

export const supervisorAssignmentHintSchema = z.object({
  stage: z.enum(['analysis', 'planning', 'assignment', 'implementation', 'code_review', 'acceptance']),
  role: z.enum(['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor']),
  agentId: z.string(),
  reason: z.string(),
});

export const superpowersReviewVerdictSchema = z.enum([
  'pending',
  'approved',
  'changes_requested',
  'failed',
]);

export const superpowersWorktreeSchema = z.object({
  path: z.string(),
  branchName: z.string(),
  baseRef: z.string().nullable().default(null),
});

export const superpowersTddEvidenceSchema = z.object({
  stage: z.enum(['RED', 'GREEN', 'REFACTOR']),
  command: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  passed: z.boolean().nullable().default(null),
});

export const superpowersTddExemptionSchema = z.object({
  reason: z.string(),
  approvedBy: z.string().nullable().default(null),
  createdAt: z.number().nullable().default(null),
});

export const superpowersReviewSchema = z.object({
  verdict: superpowersReviewVerdictSchema,
  findings: z.array(z.string()).default([]),
  reviewedAt: z.string().nullable().default(null),
});

export const superpowersVerificationEvidenceSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  required: z.boolean().default(true),
  fresh: z.boolean().default(true),
  recordedAt: z.string().nullable().default(null),
});

export const superpowersFinishBranchDecisionSchema = z.object({
  decision: z.enum(['merge_local', 'create_pr', 'keep_branch', 'discard_work']),
  options: z.array(z.enum(['merge_local', 'create_pr', 'keep_branch', 'discard_work'])).default([]),
  reason: z.string(),
  decidedAt: z.string().nullable().default(null),
});

export const workflowExecutionModeSchema = z.enum(['serial', 'parallel', 'hybrid']);

export const superpowersAgentAssignmentSchema = z.object({
  taskId: z.string(),
  assignedAgentId: z.string().nullable(),
  fallbackAgentIds: z.array(z.string()).default([]),
  fallbackReason: z.string().nullable().default(null),
  executionMode: workflowExecutionModeSchema.default('serial'),
  scopeRead: z.array(z.string()).default([]),
  scopeWrite: z.array(z.string()).default([]),
});

export const superpowersRecoveryStateSchema = z.object({
  reason: z.string(),
  failedStage: z.string().nullable().default(null),
  retryable: z.boolean().default(true),
});

export const taskRiskAssessmentSchema = z.object({
  taskKind: taskKindSchema,
  riskLevel: taskRiskLevelSchema,
  requiresApproval: z.boolean(),
  approvalReason: z.string(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  scopeRead: z.array(z.string()),
  scopeWrite: z.array(z.string()),
  verificationCommands: z.array(verificationCommandSchema).default([]),
});

export const approvalCardSchema = z.object({
  riskLevel: z.enum(['medium', 'high']),
  taskKind: taskKindSchema,
  summary: z.string(),
  approvalReason: z.string(),
  agents: z.array(z.string()),
  executionMode: workflowExecutionModeSchema,
  scopeRead: z.array(z.string()),
  scopeWrite: z.array(z.string()),
  verification: z.array(verificationCommandSchema).default([]),
  risks: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
});

export const structuredAgentEventTypeSchema = z.enum([
  'started',
  'progress',
  'artifact',
  'decision_request',
  'scope_change_request',
  'blocked',
  'completed',
  'failed',
]);

export const structuredAgentEventDecisionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
  impact: z.string(),
});

export const structuredAgentEventSchema = z.object({
  workflowRunId: z.string(),
  stepId: z.string(),
  agentRunId: z.string(),
  type: structuredAgentEventTypeSchema,
  summary: z.string(),
  detail: z.string().optional(),
  progress: z.number().min(0).max(100).optional(),
  artifacts: z.array(z.string()).optional(),
  requestedDecision: structuredAgentEventDecisionSchema.optional(),
  createdAt: z.number().int().min(0),
}).passthrough();

export const parsedPlanTaskSchema = z.object({
  title: z.string(),
  description: z.string(),
  suggestedRole: z.enum(['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  acceptance: z.array(z.string()),
  scopeRead: z.array(z.string()),
  scopeWrite: z.array(z.string()),
  preferredBackend: z.enum(['claudecode', 'opencode', 'codex']).optional(),
  dependsOn: z.array(z.string()),
});

export const parsedPlanSchema = z.object({
  goal: z.string().nullable(),
  summary: z.string(),
  taskKind: taskKindSchema.optional(),
  riskLevel: taskRiskLevelSchema.optional(),
  approvalReason: z.string().optional(),
  assumptions: z.array(z.string()),
  tasks: z.array(parsedPlanTaskSchema),
  reviewFocus: z.array(z.string()),
  verification: z.array(z.string()),
  verificationCommands: z.array(z.object({
    command: z.string(),
    reason: z.string(),
    required: z.boolean(),
  })).default([]),
  risks: z.array(z.string()),
  needsApproval: z.boolean(),
});

export const workflowPlanTaskJsonSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  role: z.enum(['planner', 'executor', 'reviewer', 'acceptor']),
  agent_id: z.string().nullable(),
  mode: z.enum(['parallel', 'serial']),
  depends_on: z.array(z.string()),
  status: z.enum(['pending', 'running', 'completed', 'blocked', 'failed', 'skipped']),
  progress: z.number().min(0).max(100),
  result_refs: z.array(z.string()),
});

export const workflowPlanJsonSchema = z.object({
  workflow_name: z.string(),
  source_message_id: z.string(),
  goal: z.string(),
  summary: z.string(),
  tasks: z.array(workflowPlanTaskJsonSchema),
});

export const agentWorkflowStateSchema = z.object({
  workflowRunId: z.string(),
  projectId: z.string(),
  roomId: z.string(),
  taskId: z.string(),
  userGoal: z.string(),
  projectPath: z.string(),
  plan: parsedPlanSchema.nullable(),
  workflowPlan: workflowPlanJsonSchema.nullable().default(null),
  currentNode: workflowGraphNodeNameSchema.nullable(),
  currentStepId: z.string().nullable(),
  activeAgentRunId: z.string().nullable(),
  childTaskIds: z.array(z.string()),
  childTaskPlanIndexes: z.record(z.string(), z.number().int().min(0)).default({}),
  supervisorAssignments: z.array(supervisorAssignmentHintSchema).default([]),
  runtimeProfile: z.literal('superpowers').default('superpowers'),
  superpowersPhase: z.string().nullable().default(null),
  activeSuperpowersStage: z.string().nullable().default(null),
  draftSpecArtifactVersionId: z.string().nullable().default(null),
  approvedSpecArtifactVersionId: z.string().nullable().default(null),
  draftPlanArtifactVersionId: z.string().nullable().default(null),
  approvedPlanArtifactVersionId: z.string().nullable().default(null),
  lightweightPlanArtifactVersionId: z.string().nullable().default(null),
  artifactChangeRequestMessageId: z.string().nullable().default(null),
  artifactChangeRequestArtifactVersionId: z.string().nullable().default(null),
  agentAssignments: z.array(superpowersAgentAssignmentSchema).default([]),
  recoveryState: superpowersRecoveryStateSchema.nullable().default(null),
  designDocPath: z.string().nullable().default(null),
  designReviewVerdict: superpowersReviewVerdictSchema.nullable().default(null),
  implementationPlanPath: z.string().nullable().default(null),
  planReviewVerdict: superpowersReviewVerdictSchema.nullable().default(null),
  worktree: superpowersWorktreeSchema.nullable().default(null),
  tddEvidence: z.array(superpowersTddEvidenceSchema).default([]),
  tddExemption: superpowersTddExemptionSchema.nullable().default(null),
  specComplianceReview: superpowersReviewSchema.nullable().default(null),
  codeQualityReview: superpowersReviewSchema.nullable().default(null),
  verificationEvidence: z.array(superpowersVerificationEvidenceSchema).default([]),
  finishBranchDecision: superpowersFinishBranchDecisionSchema.nullable().default(null),
  riskAssessment: taskRiskAssessmentSchema.nullable().default(null),
  approvalCard: approvalCardSchema.nullable().default(null),
  agentEvents: z.array(structuredAgentEventSchema).default([]),
  reviewFindings: z.array(z.string()),
  reviewVerdict: z.enum(['pass', 'changes_requested', 'failed']).nullable().default(null),
  verificationResults: z.array(verificationResultSchema),
  repairAttempts: z.number().int().min(0),
  approval: z.enum(['not_required', 'pending', 'approved', 'rejected']),
  status: workflowStatusSchema,
  error: z.string().nullable(),
});

export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type SuperpowersReviewVerdict = z.infer<typeof superpowersReviewVerdictSchema>;
export type SuperpowersWorktree = z.infer<typeof superpowersWorktreeSchema>;
export type SuperpowersTddEvidence = z.infer<typeof superpowersTddEvidenceSchema>;
export type SuperpowersTddExemption = z.infer<typeof superpowersTddExemptionSchema>;
export type SuperpowersReview = z.infer<typeof superpowersReviewSchema>;
export type SuperpowersVerificationEvidence = z.infer<typeof superpowersVerificationEvidenceSchema>;
export type SuperpowersFinishBranchDecision = z.infer<typeof superpowersFinishBranchDecisionSchema>;
export type StructuredAgentEvent = z.infer<typeof structuredAgentEventSchema>;
export type SuperpowersAgentAssignment = z.infer<typeof superpowersAgentAssignmentSchema>;
export type SuperpowersRecoveryState = z.infer<typeof superpowersRecoveryStateSchema>;
export interface SupervisorAssignmentHint {
  stage: WorkflowStage;
  role: WorkflowRole;
  agentId: string;
  reason: string;
}
export type AgentWorkflowState = Omit<
  z.infer<typeof agentWorkflowStateSchema>,
  | 'plan'
  | 'workflowPlan'
  | 'currentNode'
  | 'status'
  | 'supervisorAssignments'
  | 'childTaskPlanIndexes'
  | 'runtimeProfile'
  | 'superpowersPhase'
  | 'activeSuperpowersStage'
  | 'draftSpecArtifactVersionId'
  | 'approvedSpecArtifactVersionId'
  | 'draftPlanArtifactVersionId'
  | 'approvedPlanArtifactVersionId'
  | 'lightweightPlanArtifactVersionId'
  | 'artifactChangeRequestMessageId'
  | 'artifactChangeRequestArtifactVersionId'
  | 'agentAssignments'
  | 'recoveryState'
  | 'designDocPath'
  | 'designReviewVerdict'
  | 'implementationPlanPath'
  | 'planReviewVerdict'
  | 'worktree'
  | 'tddEvidence'
  | 'tddExemption'
  | 'specComplianceReview'
  | 'codeQualityReview'
  | 'verificationEvidence'
  | 'finishBranchDecision'
  | 'riskAssessment'
  | 'approvalCard'
  | 'agentEvents'
> & {
  plan: ParsedPlan | null;
  workflowPlan?: WorkflowPlanJson | null;
  currentNode: GraphNodeName | null;
  status: WorkflowStatus;
  supervisorAssignments?: SupervisorAssignmentHint[];
  childTaskPlanIndexes?: Record<string, number>;
  runtimeProfile?: 'superpowers';
  superpowersPhase?: string | null;
  activeSuperpowersStage?: string | null;
  draftSpecArtifactVersionId?: string | null;
  approvedSpecArtifactVersionId?: string | null;
  draftPlanArtifactVersionId?: string | null;
  approvedPlanArtifactVersionId?: string | null;
  lightweightPlanArtifactVersionId?: string | null;
  artifactChangeRequestMessageId?: string | null;
  artifactChangeRequestArtifactVersionId?: string | null;
  agentAssignments?: SuperpowersAgentAssignment[];
  recoveryState?: SuperpowersRecoveryState | null;
  designDocPath?: string | null;
  designReviewVerdict?: SuperpowersReviewVerdict | null;
  implementationPlanPath?: string | null;
  planReviewVerdict?: SuperpowersReviewVerdict | null;
  worktree?: SuperpowersWorktree | null;
  tddEvidence?: SuperpowersTddEvidence[];
  tddExemption?: SuperpowersTddExemption | null;
  specComplianceReview?: SuperpowersReview | null;
  codeQualityReview?: SuperpowersReview | null;
  verificationEvidence?: SuperpowersVerificationEvidence[];
  finishBranchDecision?: SuperpowersFinishBranchDecision | null;
  riskAssessment?: TaskRiskAssessment | null;
  approvalCard?: ApprovalCard | null;
  agentEvents?: StructuredAgentEvent[];
};

export function emptyAgentWorkflowState(input: {
  workflowRunId: string;
  projectId: string;
  roomId: string;
  taskId: string;
  userGoal: string;
  projectPath: string;
}): AgentWorkflowState {
  return {
    ...input,
    plan: null,
    workflowPlan: null,
    currentNode: null,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    childTaskPlanIndexes: {},
    supervisorAssignments: [],
    runtimeProfile: 'superpowers',
    superpowersPhase: null,
    activeSuperpowersStage: null,
    draftSpecArtifactVersionId: null,
    approvedSpecArtifactVersionId: null,
    draftPlanArtifactVersionId: null,
    approvedPlanArtifactVersionId: null,
    lightweightPlanArtifactVersionId: null,
    artifactChangeRequestMessageId: null,
    artifactChangeRequestArtifactVersionId: null,
    agentAssignments: [],
    recoveryState: null,
    designDocPath: null,
    designReviewVerdict: null,
    implementationPlanPath: null,
    planReviewVerdict: null,
    worktree: null,
    tddEvidence: [],
    tddExemption: null,
    specComplianceReview: null,
    codeQualityReview: null,
    verificationEvidence: [],
    finishBranchDecision: null,
    riskAssessment: null,
    approvalCard: null,
    agentEvents: [],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'pending',
    status: 'running',
    error: null,
  };
}

export function serializeGraphState(state: AgentWorkflowState): string {
  return JSON.stringify(state);
}

export function parseGraphState(value: string | null): AgentWorkflowState | null {
  if (!value) return null;
  return agentWorkflowStateSchema.parse(JSON.parse(value)) as AgentWorkflowState;
}
