import { z } from 'zod';
import type { GraphNodeName, WorkflowStatus } from '../../types.js';
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

export const agentWorkflowStateSchema = z.object({
  workflowRunId: z.string(),
  projectId: z.string(),
  roomId: z.string(),
  taskId: z.string(),
  userGoal: z.string(),
  projectPath: z.string(),
  plan: parsedPlanSchema.nullable(),
  currentNode: workflowGraphNodeNameSchema.nullable(),
  currentStepId: z.string().nullable(),
  activeAgentRunId: z.string().nullable(),
  childTaskIds: z.array(z.string()),
  reviewFindings: z.array(z.string()),
  reviewVerdict: z.enum(['pass', 'changes_requested', 'failed']).nullable().default(null),
  verificationResults: z.array(verificationResultSchema),
  repairAttempts: z.number().int().min(0),
  approval: z.enum(['not_required', 'pending', 'approved', 'rejected']),
  status: workflowStatusSchema,
  error: z.string().nullable(),
});

export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type AgentWorkflowState = Omit<z.infer<typeof agentWorkflowStateSchema>, 'plan' | 'currentNode' | 'status'> & {
  plan: ParsedPlan | null;
  currentNode: GraphNodeName | null;
  status: WorkflowStatus;
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
    currentNode: null,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
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
