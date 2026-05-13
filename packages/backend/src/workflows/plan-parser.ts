import { z } from 'zod';
import type { TaskPriority, WorkflowRole } from '../types.js';

const planTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  suggestedRole: z.enum(['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor']).default('executor'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  acceptance: z.array(z.string()).default([]),
});

const planSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(planTaskSchema).min(1),
  reviewFocus: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
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
}

export interface ParsedPlan {
  summary: string;
  tasks: ParsedPlanTask[];
  reviewFocus: string[];
  verification: string[];
  risks: string[];
}

export type ParsedReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ParsedAcceptanceVerdict = z.infer<typeof acceptanceVerdictSchema>;

export function parsePlanArtifact(output: string): ParsedPlan {
  const jsonText = extractJson(output);
  const parsed = JSON.parse(jsonText) as unknown;
  return planSchema.parse(parsed);
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

function extractJson(output: string): string {
  const fenced = output.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start >= 0 && end > start) return output.slice(start, end + 1);
  throw new Error('Planner output did not contain a JSON object');
}
