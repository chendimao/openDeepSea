import { z } from 'zod';
import type { WorkflowPlanJson, WorkflowPlanTaskJson, WorkflowPlanTaskMode } from '../types.js';
import type { ParsedPlan } from './plan-parser.js';

export type WorkflowPlanTaskInput = Partial<Pick<WorkflowPlanTaskJson, 'mode' | 'status' | 'progress' | 'result_refs'>> & {
  id: string;
  title: string;
  description: string;
  role: WorkflowPlanTaskJson['role'];
  agent_id?: string | null;
  depends_on?: string[];
};

export interface WorkflowPlanInput {
  workflow_name: string;
  source_message_id: string;
  goal: string;
  summary: string;
  tasks: WorkflowPlanTaskInput[];
}

const workflowPlanTaskInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  role: z.enum(['planner', 'executor', 'reviewer', 'acceptor']),
  agent_id: z.string().min(1).nullable().optional(),
  mode: z.enum(['parallel', 'serial']).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  status: z.enum(['pending', 'running', 'completed', 'blocked', 'failed']).optional(),
  progress: z.number().min(0).max(100).optional(),
  result_refs: z.array(z.string().min(1)).optional(),
});

const workflowPlanInputSchema = z.object({
  workflow_name: z.string().min(1),
  source_message_id: z.string().min(1),
  goal: z.string().min(1),
  summary: z.string().min(1),
  tasks: z.array(workflowPlanTaskInputSchema).min(1),
});

export function normalizeWorkflowPlanMarkdown(markdown: string): WorkflowPlanJson {
  const parsed = JSON.parse(extractJson(markdown)) as unknown;
  return normalizeWorkflowPlanObject(parsed);
}

export function normalizeWorkflowPlanObject(input: unknown): WorkflowPlanJson {
  const parsed = workflowPlanInputSchema.parse(input);
  validateTaskIds(parsed.tasks);
  validateDependencies(parsed.tasks);

  return {
    workflow_name: parsed.workflow_name,
    source_message_id: parsed.source_message_id,
    goal: parsed.goal,
    summary: parsed.summary,
    tasks: parsed.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      role: task.role,
      agent_id: task.agent_id ?? null,
      mode: deriveMode(task.depends_on ?? []),
      depends_on: task.depends_on ?? [],
      status: task.status ?? 'pending',
      progress: task.progress ?? 0,
      result_refs: task.result_refs ?? [],
    })),
  };
}

export function deriveWorkflowPlanFromParsedPlan(input: {
  workflowName: string;
  sourceMessageId: string;
  plan: ParsedPlan;
}): WorkflowPlanJson {
  const taskIdsByTitle = new Map<string, string>();
  let previousTaskId: string | null = null;
  const tasks = input.plan.tasks.map((task, index): WorkflowPlanTaskInput => {
    const id = `task-${index + 1}-${slugTaskId(task.title)}`;
    taskIdsByTitle.set(task.title, id);
    const depends_on = previousTaskId ? [previousTaskId] : [];
    previousTaskId = id;
    return {
      id,
      title: task.title,
      description: task.description,
      role: normalizeTaskRole(task.suggestedRole),
      agent_id: null,
      depends_on,
    };
  });

  for (const [index, task] of input.plan.tasks.entries()) {
    tasks[index]!.depends_on = task.dependsOn.length > 0
      ? task.dependsOn.map((dependency) => taskIdsByTitle.get(dependency) ?? dependency)
      : tasks[index]!.depends_on;
  }

  return normalizeWorkflowPlanObject({
    workflow_name: input.workflowName,
    source_message_id: input.sourceMessageId,
    goal: input.plan.goal ?? input.plan.summary,
    summary: input.plan.summary,
    tasks,
  });
}

function deriveMode(dependsOn: string[]): WorkflowPlanTaskMode {
  return dependsOn.length > 0 ? 'serial' : 'parallel';
}

function validateTaskIds(tasks: WorkflowPlanTaskInput[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
}

function validateDependencies(tasks: WorkflowPlanTaskInput[]): void {
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.depends_on ?? []) {
      if (!taskIds.has(dependency)) {
        throw new Error(`unknown dependency "${dependency}" for task "${task.id}"`);
      }
      if (dependency === task.id) {
        throw new Error(`task "${task.id}" cannot depend on itself`);
      }
    }
  }
}

function normalizeTaskRole(role: ParsedPlan['tasks'][number]['suggestedRole']): WorkflowPlanTaskJson['role'] {
  if (role === 'planner' || role === 'reviewer' || role === 'acceptor') return role;
  return 'executor';
}

function slugTaskId(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, 48) || 'task';
}

function extractJson(output: string): string {
  const fencedBlocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item));
  for (const block of fencedBlocks) {
    if (looksLikeJsonObject(block)) return block;
  }
  const direct = output.trim();
  if (looksLikeJsonObject(direct)) return direct;
  throw new Error('workflow plan json not found');
}

function looksLikeJsonObject(value: string): boolean {
  return value.startsWith('{') && value.endsWith('}');
}
