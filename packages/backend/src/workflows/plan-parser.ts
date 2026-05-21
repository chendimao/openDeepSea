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

const reviewListItemSchema = z.preprocess(formatReviewListItem, z.string().min(1));

const reviewVerdictSchema = z.object({
  verdict: z.enum(['pass', 'changes_requested', 'failed']),
  findings: z.array(reviewListItemSchema).default([]),
  requiredFixes: z.array(reviewListItemSchema).default([]),
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
  if (modernPlan.success) return normalizeParsedPlanTaskTitles(normalizeLangChainPlan(modernPlan.data));
  if (hasModernPlanShape(parsed)) throw modernPlan.error;
  return normalizeParsedPlanTaskTitles(normalizeLegacyPlan(planSchema.parse(parsed)));
}

export function normalizeParsedPlanTaskTitles(
  plan: ParsedPlan,
  options: { parentTitle?: string | null } = {},
): ParsedPlan {
  const parentTitles = new Set([
    options.parentTitle,
    plan.goal,
  ].map((item) => normalizeTitleKey(item)).filter(Boolean));
  const originalTitleCounts = countTitles(plan.tasks.map((task) => task.title));
  const usedTitles = new Map<string, number>();
  const resolvedTitleByUniqueOriginalTitle = new Map<string, string>();

  const tasks = plan.tasks.map((task, index) => {
    const resolvedTitle = makeUniqueTaskTitle(
      summarizeParsedPlanTaskTitle({
        task,
        index,
        isDuplicateTitle: (originalTitleCounts.get(normalizeTitleKey(task.title)) ?? 0) > 1,
        parentTitles,
      }),
      usedTitles,
    );
    const originalKey = normalizeTitleKey(task.title);
    if (originalKey && originalTitleCounts.get(originalKey) === 1) {
      resolvedTitleByUniqueOriginalTitle.set(originalKey, resolvedTitle);
    }
    return {
      ...task,
      title: resolvedTitle,
    };
  });

  return {
    ...plan,
    tasks: tasks.map((task) => ({
      ...task,
      dependsOn: task.dependsOn.flatMap((dependency) => {
        const dependencyKey = normalizeTitleKey(dependency);
        const resolved = resolvedTitleByUniqueOriginalTitle.get(dependencyKey);
        if (resolved) return [resolved];
        return (originalTitleCounts.get(dependencyKey) ?? 0) > 1 ? [] : [dependency];
      }),
    })),
  };
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

function countTitles(titles: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const key = normalizeTitleKey(title);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function summarizeParsedPlanTaskTitle(input: {
  task: ParsedPlanTask;
  index: number;
  isDuplicateTitle: boolean;
  parentTitles: Set<string>;
}): string {
  const cleanTitle = compactTaskTitle(input.task.title);
  if (cleanTitle && !input.isDuplicateTitle && !isGenericTaskTitle(cleanTitle, input.parentTitles)) {
    return clipTaskTitle(cleanTitle);
  }

  const textCandidates = [
    input.task.description,
    ...input.task.acceptance,
  ];
  for (const candidate of textCandidates) {
    const title = deriveTaskTitleFromText(candidate, input.parentTitles);
    if (title) return title;
  }

  const scopeTitle = deriveTaskTitleFromScope(input.task.scopeWrite);
  if (scopeTitle) return scopeTitle;

  const roleTitle = deriveTaskTitleFromRole(input.task.suggestedRole);
  if (roleTitle) return roleTitle;

  return `${roleTitlePrefix(input.task.suggestedRole)}子任务 ${input.index + 1}`;
}

function makeUniqueTaskTitle(title: string, usedTitles: Map<string, number>): string {
  const base = clipTaskTitle(compactTaskTitle(title) || '执行子任务');
  const key = normalizeTitleKey(base);
  const count = (usedTitles.get(key) ?? 0) + 1;
  usedTitles.set(key, count);
  if (count === 1) return base;
  const suffix = ` ${count}`;
  const prefix = Array.from(base).slice(0, Math.max(1, 24 - Array.from(suffix).length)).join('');
  return `${prefix}${suffix}`;
}

function deriveTaskTitleFromText(text: string, parentTitles: Set<string>): string | null {
  const candidates = text
    .split(/\r?\n|[。；;.!?]/)
    .map((item) => compactTaskTitle(item))
    .map(stripTaskTitleLabel)
    .filter(Boolean);

  for (const candidate of candidates) {
    if (!isGenericTaskTitle(candidate, parentTitles)) return clipTaskTitle(candidate);
  }
  return deriveTaskTitleFromSignals(text, parentTitles);
}

function deriveTaskTitleFromScope(scopeWrite: string[]): string | null {
  if (scopeWrite.length === 0) return null;
  const text = scopeWrite.join('\n').toLowerCase();
  return deriveTaskTitleFromSignals(text, new Set()) ?? '更新工程文件';
}

function deriveTaskTitleFromSignals(text: string, parentTitles: Set<string>): string | null {
  const normalized = compactTaskTitle(text).toLowerCase();
  if (!normalized) return null;

  if (/(审查|review|reviewer|code review)/.test(normalized)) {
    return clipTaskTitle(isGenericTaskTitle('代码审查', parentTitles) ? '代码审查' : '代码审查');
  }
  if (/(验收|accept|acceptance)/.test(normalized)) {
    return clipTaskTitle(isGenericTaskTitle('功能验收', parentTitles) ? '功能验收' : '功能验收');
  }
  if (/(测试|验证|verification|test)/.test(normalized)) {
    return clipTaskTitle(isGenericTaskTitle('验证测试', parentTitles) ? '验证测试' : '验证测试');
  }

  const hasFrontend = /packages\/frontend|src\/components|src\/pages|\.tsx\b|前端|界面|页面|组件|交互|侧边栏|聊天室/.test(normalized);
  const hasBackend = /packages\/backend|src\/repos|src\/routes|\.ts\b|后端|接口|数据库|路由|仓储/.test(normalized);
  const hasDocs = /docs\/|\.md\b|文档|说明/.test(normalized);

  if (hasFrontend && !isGenericTaskTitle('前端交互实现', parentTitles)) return '前端交互实现';
  if (hasFrontend) return '前端交互实现';
  if (hasBackend) return '后端能力实现';
  if (hasDocs) return '文档补充';
  return null;
}

function deriveTaskTitleFromRole(role: WorkflowRole): string | null {
  if (role === 'reviewer') return '代码审查';
  if (role === 'acceptor') return '功能验收';
  return null;
}

function stripTaskTitleLabel(value: string): string {
  return value
    .replace(/^(?:子任务|任务|步骤|step)\s*\d*[\s.、-]*[:：]?\s*/i, '')
    .replace(/^(?:目标|意图|说明|描述|验收|验收标准|成功标准|范围|读范围|写范围|改动|依赖|acceptance|intent|description|scopeWrite|scopeRead|dependsOn)\s*[:：]\s*/i, '')
    .trim();
}

function compactTaskTitle(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[，,；;。.!?\s]+|[，,；;。.!?\s]+$/g, '')
    .trim();
}

function clipTaskTitle(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= 24) return value;
  return chars.slice(0, 24).join('');
}

function isGenericTaskTitle(title: string, parentTitles: Set<string>): boolean {
  const key = normalizeTitleKey(title);
  if (!key) return true;
  if (parentTitles.has(key)) return true;
  return /^(?:确定生成任务|生成任务|启动任务|执行任务|执行|实现|开发|修复|代码审查|子任务|任务|步骤|计划|分析|分配)$/.test(key);
}

function normalizeTitleKey(value: string | null | undefined): string {
  return compactTaskTitle(value)
    .replace(/[「」"“”'‘’\s,，.。:：;；!！?？_-]/g, '')
    .toLowerCase();
}

function roleTitlePrefix(role: WorkflowRole): string {
  if (role === 'reviewer') return '审查';
  if (role === 'acceptor') return '验收';
  if (role === 'planner') return '规划';
  return '执行';
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

function formatReviewListItem(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object' || value === null) return value;

  const record = value as Record<string, unknown>;
  const file = getStringField(record, 'file');
  const severity = getStringField(record, 'severity');
  const issue = getStringField(record, 'issue')
    ?? getStringField(record, 'finding')
    ?? getStringField(record, 'message')
    ?? getStringField(record, 'description')
    ?? getStringField(record, 'fix')
    ?? getStringField(record, 'requiredFix');
  const evidence = getStringField(record, 'behaviorEvidence') ?? getStringField(record, 'evidence');
  const requiredFix = getStringField(record, 'requiredFix') ?? getStringField(record, 'fix');

  const parts: string[] = [];
  if (file && issue) {
    parts.push(severity ? `${file} [${severity}]: ${issue}` : `${file}: ${issue}`);
  } else if (issue) {
    parts.push(severity ? `[${severity}] ${issue}` : issue);
  }
  if (evidence) parts.push(`Evidence: ${evidence}`);
  if (requiredFix && requiredFix !== issue) parts.push(`Required fix: ${requiredFix}`);
  if (parts.length > 0) return parts.join(' ');

  return formatPlanTextValue(value);
}

function getStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
