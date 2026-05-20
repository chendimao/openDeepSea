import { z } from 'zod';
import type { GraphNodeName, WorkflowPlanJson, WorkflowRole, WorkflowStage, WorkflowStatus } from '../../types.js';
import type { ParsedPlan } from '../plan-parser.js';

export const workflowGraphNodeNameSchema = z.enum([
  'context',
  'planning',
  'approval',
  'dispatch',
  'execute',
  'review',
  'repair_decision',
  'verify',
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
  decision: z.enum(['merge', 'pull_request', 'defer']),
  reason: z.string(),
  decidedAt: z.string().nullable().default(null),
});

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
> & {
  plan: ParsedPlan | null;
  workflowPlan?: WorkflowPlanJson | null;
  currentNode: GraphNodeName | null;
  status: WorkflowStatus;
  supervisorAssignments?: SupervisorAssignmentHint[];
  childTaskPlanIndexes?: Record<string, number>;
  runtimeProfile?: 'superpowers';
  superpowersPhase?: string | null;
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
