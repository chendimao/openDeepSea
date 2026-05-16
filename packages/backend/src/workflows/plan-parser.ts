import { z } from 'zod';
import type { AcpBackend, TaskPriority, WorkflowRole } from '../types.js';

export const workflowRoleSchema = z.enum(['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor']);
export const acpBackendSchema = z.enum(['claudecode', 'opencode', 'codex']);

export const verificationCommandSchema = z.object({
  command: z.string().min(1),
  reason: z.string().default(''),
  required: z.boolean().default(true),
});

const planTextSchema = z.preprocess(formatPlanTextValue, z.string().min(1));
const flexibleVerificationCommandSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { command: value } : value),
  verificationCommandSchema,
);

const decisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(''),
});

const decisionItemSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    reason: z.string().default(''),
    blocking: z.boolean().default(true),
    recommendedOptionId: z.string().min(1),
    options: z.array(decisionOptionSchema).min(1),
  })
  .refine((item) => item.options.some((option) => option.id === item.recommendedOptionId), {
    message: 'recommendedOptionId must match one option id',
  });

const decisionRequestSchema = z.object({
  decisions: z.array(decisionItemSchema).default([]),
});

const planTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  suggestedRole: workflowRoleSchema.default('executor'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  acceptance: z.array(z.string()).default([]),
});

const planSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(planTaskSchema).min(1),
  reviewFocus: z.array(planTextSchema).default([]),
  verification: z.array(planTextSchema).default([]),
  risks: z.array(planTextSchema).default([]),
});

const langChainPlanStepSchema = z.object({
  title: z.string().min(1),
  intent: z.string().min(1),
  assigneeRole: workflowRoleSchema,
  preferredBackend: acpBackendSchema.optional(),
  scopeRead: z.array(z.string()),
  scopeWrite: z.array(z.string()),
  acceptance: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string()),
});

const langChainPlanSchema = z.object({
  goal: z.string().min(1),
  summary: z.string().min(1),
  assumptions: z.array(planTextSchema),
  steps: z.array(langChainPlanStepSchema).min(1),
  risks: z.array(planTextSchema),
  verification: z.array(flexibleVerificationCommandSchema),
  needsApproval: z.boolean(),
});

const reviewVerdictSchema = z.object({
  verdict: z.enum(['pass', 'changes_requested', 'failed']),
  findings: z.array(z.string()).default([]),
  requiredFixes: z.array(z.string()).default([]),
  riskLevel: z.enum(['low', 'medium', 'high']).default('medium'),
});

const acceptanceVerdictSchema = z.object({
  verdict: z.enum(['pass', 'failed']),
  acceptedCriteria: z.array(z.string()).default([]),
  failedCriteria: z.array(z.string()).default([]),
  notes: z.string().default(''),
});

export interface ParsedPlanTask {
  title: string;
  description: string;
  suggestedRole: WorkflowRole;
  priority: TaskPriority;
  acceptance: string[];
  scopeRead: string[];
  scopeWrite: string[];
  preferredBackend?: AcpBackend;
  dependsOn: string[];
}

export interface ParsedVerificationCommand {
  command: string;
  reason: string;
  required: boolean;
}

export interface ParsedPlan {
  goal: string | null;
  summary: string;
  assumptions: string[];
  tasks: ParsedPlanTask[];
  reviewFocus: string[];
  verification: string[];
  verificationCommands: ParsedVerificationCommand[];
  risks: string[];
  needsApproval: boolean;
}

export type ParsedDecisionOption = z.infer<typeof decisionOptionSchema>;
export type ParsedDecisionItem = z.infer<typeof decisionItemSchema>;
export type ParsedDecisionRequest = z.infer<typeof decisionRequestSchema>;
export type ParsedReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ParsedAcceptanceVerdict = z.infer<typeof acceptanceVerdictSchema>;

export function parseDecisionRequest(output: string): ParsedDecisionRequest {
  try {
    const jsonText = extractJsonByKey(output, 'decisions');
    const parsed = JSON.parse(jsonText) as unknown;
    return decisionRequestSchema.parse(parsed);
  } catch {
    return { decisions: [] };
  }
}

export function parsePlanArtifact(output: string): ParsedPlan {
  const jsonText = extractJson(output);
  const parsed = JSON.parse(jsonText) as unknown;
  const modernPlan = langChainPlanSchema.safeParse(parsed);
  if (modernPlan.success) return normalizeLangChainPlan(modernPlan.data);
  if (hasModernPlanShape(parsed)) throw modernPlan.error;
  return normalizeLegacyPlan(planSchema.parse(parsed));
}

export function parseReviewVerdict(output: string): ParsedReviewVerdict {
  const jsonText = extractJson(output);
  const parsed = JSON.parse(jsonText) as unknown;
  return reviewVerdictSchema.parse(parsed);
}

export function parseAcceptanceVerdict(output: string): ParsedAcceptanceVerdict {
  const jsonText = extractJson(output);
  const parsed = JSON.parse(jsonText) as unknown;
  return acceptanceVerdictSchema.parse(parsed);
}

function normalizeLangChainPlan(plan: z.infer<typeof langChainPlanSchema>): ParsedPlan {
  return {
    goal: plan.goal,
    summary: plan.summary,
    assumptions: plan.assumptions,
    tasks: plan.steps.map((step) => {
      const task: ParsedPlanTask = {
        title: step.title,
        description: step.intent,
        suggestedRole: step.assigneeRole,
        priority: 'normal',
        acceptance: step.acceptance,
        scopeRead: step.scopeRead,
        scopeWrite: step.scopeWrite,
        dependsOn: step.dependsOn,
      };
      if (step.preferredBackend) task.preferredBackend = step.preferredBackend;
      return task;
    }),
    reviewFocus: [],
    verification: plan.verification.map((command) => command.command),
    verificationCommands: plan.verification.map((command) => ({
      command: command.command,
      reason: command.reason,
      required: command.required,
    })),
    risks: plan.risks,
    needsApproval: plan.needsApproval,
  };
}

function normalizeLegacyPlan(plan: z.infer<typeof planSchema>): ParsedPlan {
  return {
    goal: null,
    summary: plan.summary,
    assumptions: [],
    tasks: plan.tasks.map((task) => ({
      ...task,
      scopeRead: [],
      scopeWrite: [],
      dependsOn: [],
    })),
    reviewFocus: plan.reviewFocus,
    verification: plan.verification,
    verificationCommands: plan.verification.map((command) => ({
      command,
      reason: '',
      required: true,
    })),
    risks: plan.risks,
    needsApproval: true,
  };
}

function hasModernPlanShape(parsed: unknown): boolean {
  return typeof parsed === 'object' && parsed !== null && 'steps' in parsed;
}

function extractJson(output: string): string {
  const fenced = output.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start >= 0 && end > start) return output.slice(start, end + 1);
  throw new Error('Planner output did not contain a JSON object');
}

function extractJsonByKey(output: string, key: string): string {
  const fencedBlocks = Array.from(output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) => match[1]?.trim() ?? '');
  for (const block of fencedBlocks) {
    if (!block.includes(`"${key}"`)) continue;
    JSON.parse(block);
    return block;
  }
  const keyIndex = output.indexOf(`"${key}"`);
  if (keyIndex < 0) throw new Error(`Output did not contain ${key}`);
  let start = keyIndex;
  while (start >= 0 && output[start] !== '{') start--;
  if (start < 0) throw new Error(`Output did not contain ${key} object`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index++) {
    const char = output[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return output.slice(start, index + 1);
    }
  }
  throw new Error(`Output did not contain complete ${key} object`);
}

function formatPlanTextValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object' || value === null) return value;

  const entries = Object.entries(value)
    .filter(([, item]) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
    .map(([key, item]) => `${key}: ${String(item)}`);
  if (entries.length > 0) return entries.join('; ');

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
