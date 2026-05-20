import type { ParsedPlan, ParsedPlanTask } from '../plan-parser.js';
import { normalizeParsedPlanTaskTitles } from '../plan-parser.js';
import { deriveWorkflowPlanFromParsedPlan } from '../workflow-plan-json.js';
import type { WorkflowPlanJson, WorkflowPlanTaskJson } from '../../types.js';

export interface BuildCoordinatorWorkflowPlanInput {
  workflowName: string;
  sourceMessageId: string;
  workflowPlan?: unknown;
  planArtifactMetadata?: unknown;
  parsedPlan?: ParsedPlan | null;
}

export function buildCoordinatorWorkflowPlan(input: BuildCoordinatorWorkflowPlanInput): WorkflowPlanJson | null {
  if (isWorkflowPlanJson(input.workflowPlan)) return input.workflowPlan;

  const artifactPlan = parseWorkflowPlanFromArtifactMetadata(input.planArtifactMetadata);
  if (artifactPlan) return artifactPlan;

  if (!input.parsedPlan) return null;
  return deriveWorkflowPlanFromParsedPlan({
    workflowName: input.workflowName,
    sourceMessageId: input.sourceMessageId,
    plan: serializeExecutablePlanModes(input.parsedPlan),
  });
}

export function deriveCoordinatorPlanFromProductManagerBackground(input: {
  taskTitle: string;
  taskDescription: string | null | undefined;
}): ParsedPlan | null {
  const background = extractProductManagerBackground(input.taskDescription);
  if (!background) return null;
  const executionIntent = extractTaskExecutionIntent(input.taskDescription);
  if (executionIntent && executionIntent !== 'implementation' && executionIntent !== 'debug_fix') return null;

  const implementationTasks = extractImplementationTasks(background);
  if (implementationTasks.length === 0) {
    implementationTasks.push({
      title: input.taskTitle,
      description: background,
      suggestedRole: 'executor',
      priority: 'normal',
      acceptance: extractAcceptance(background),
      scopeRead: [],
      scopeWrite: [],
      dependsOn: [],
    });
  }

  const assumptions = extractSectionItems(background, ['假设', '约束']);
  const risks = extractSectionItems(background, ['风险', '注意事项']);
  const verification = extractSectionItems(background, ['验证方式', '测试', '验收标准']);

  return normalizeParsedPlanTaskTitles({
    goal: input.taskTitle,
    summary: firstSentence(background) || input.taskTitle,
    assumptions,
    tasks: implementationTasks,
    reviewFocus: ['确认执行结果是否满足产品经理方案背景和用户原始需求。'],
    verification,
    verificationCommands: [],
    risks,
    needsApproval: false,
  }, { parentTitle: input.taskTitle });
}

export function serializeExecutablePlanModes(plan: ParsedPlan): ParsedPlan {
  const previousExecutableTitle = new Map<string, string>();
  let lastExecutableTitle: string | null = null;
  const tasks = plan.tasks.map((task): ParsedPlanTask => {
    const next: ParsedPlanTask = { ...task, dependsOn: [...task.dependsOn] };
    if (task.suggestedRole === 'executor') {
      const mappedDependencies = next.dependsOn
        .map((dependency) => previousExecutableTitle.get(dependency) ?? dependency)
        .filter((dependency) => dependency !== task.title);
      if (lastExecutableTitle && mappedDependencies.length === 0) mappedDependencies.push(lastExecutableTitle);
      next.dependsOn = Array.from(new Set(mappedDependencies));
      previousExecutableTitle.set(task.title, task.title);
      lastExecutableTitle = task.title;
    } else if (lastExecutableTitle) {
      next.dependsOn = Array.from(new Set([...next.dependsOn, lastExecutableTitle]));
    }
    return next;
  });

  return {
    ...plan,
    tasks,
  };
}

export function parseWorkflowPlanFromArtifactMetadata(metadata: unknown): WorkflowPlanJson | null {
  try {
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) as unknown : metadata;
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = (parsed as { workflow_plan_json?: unknown }).workflow_plan_json;
    return isWorkflowPlanJson(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function isWorkflowPlanJson(value: unknown): value is WorkflowPlanJson {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as WorkflowPlanJson;
  return (
    typeof candidate.workflow_name === 'string' &&
    typeof candidate.source_message_id === 'string' &&
    typeof candidate.goal === 'string' &&
    typeof candidate.summary === 'string' &&
    Array.isArray(candidate.tasks) &&
    candidate.tasks.every(isWorkflowPlanTaskJson)
  );
}

function isWorkflowPlanTaskJson(value: unknown): value is WorkflowPlanTaskJson {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as WorkflowPlanTaskJson;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.description === 'string' &&
    ['planner', 'executor', 'reviewer', 'acceptor'].includes(candidate.role) &&
    (typeof candidate.agent_id === 'string' || candidate.agent_id === null) &&
    (candidate.mode === 'parallel' || candidate.mode === 'serial') &&
    Array.isArray(candidate.depends_on) &&
    candidate.depends_on.every((dependency) => typeof dependency === 'string') &&
    ['pending', 'running', 'completed', 'blocked', 'failed'].includes(candidate.status) &&
    typeof candidate.progress === 'number' &&
    candidate.progress >= 0 &&
    candidate.progress <= 100 &&
    Array.isArray(candidate.result_refs) &&
    candidate.result_refs.every((resultRef) => typeof resultRef === 'string')
  );
}

function extractProductManagerBackground(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = description.match(/产品经理方案背景：\s*([\s\S]*?)(?:\n{2,}任务意图：|$)/);
  const background = match?.[1]?.trim();
  return background || null;
}

function extractTaskExecutionIntent(description: string | null | undefined): string | null {
  if (!description) return null;
  return description.match(/任务意图：([a-z_]+)/)?.[1] ?? null;
}

function extractImplementationTasks(background: string): ParsedPlanTask[] {
  const lines = background.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tasks: ParsedPlanTask[] = [];
  let current: ParsedPlanTask | null = null;

  for (const line of lines) {
    const title = parseTaskTitle(line);
    if (title) {
      if (current) tasks.push(current);
      current = {
        title,
        description: '',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: [],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      };
      continue;
    }

    if (!current) continue;
    const content = stripListMarker(line);
    if (/^(验收|验收标准|成功标准|acceptance)[:：]/i.test(content)) {
      current.acceptance.push(cleanLabelValue(content));
    } else if (/^(范围|读范围|scopeRead)[:：]/i.test(content)) {
      current.scopeRead.push(...splitScopeValues(cleanLabelValue(content)));
    } else if (/^(改动|写范围|scopeWrite)[:：]/i.test(content)) {
      current.scopeWrite.push(...splitScopeValues(cleanLabelValue(content)));
    } else if (/^(依赖|dependsOn)[:：]/i.test(content)) {
      current.dependsOn.push(...splitScopeValues(cleanLabelValue(content)));
    } else {
      current.description = current.description ? `${current.description}\n${content}` : content;
    }
  }

  if (current) tasks.push(current);
  const parsedTasks = tasks
    .filter((task) => isExecutableBackgroundTask(task))
    .map((task) => ({
      ...task,
      description: task.description || task.title,
      acceptance: task.acceptance.length > 0 ? task.acceptance : extractAcceptance(`${task.title}\n${task.description}`),
    }));
  return parsedTasks.length > 0 ? parsedTasks : extractInlineImplementationTasks(background);
}

function parseTaskTitle(line: string): string | null {
  const normalized = stripListMarker(line);
  const taskMatch = normalized.match(/^(?:子任务|任务|步骤|step)\s*\d*[\s.、-]*[:：]?\s*(.+)$/i);
  if (taskMatch?.[1]) return taskMatch[1].trim();
  const numbered = line.match(/^\d+[.、]\s*(.+)$/);
  return numbered?.[1]?.trim() ?? null;
}

function isExecutableBackgroundTask(task: ParsedPlanTask): boolean {
  const text = `${task.title}\n${task.description}\n${task.scopeWrite.join('\n')}`.toLowerCase();
  if (/^(梳理|分析|确认|冻结|评审|审查|验收)/.test(task.title)) return false;
  return [
    '实现',
    '改造',
    '补充',
    '开发',
    '修复',
    '接入',
    '新增',
    '更新',
    '修改',
    'frontend',
    'backend',
    'packages/',
    'src/',
    '前端',
    '后端',
    '接口',
    '组件',
    '数据库',
  ].some((signal) => text.includes(signal));
}

function extractInlineImplementationTasks(background: string): ParsedPlanTask[] {
  const acceptance = extractAcceptance(background);
  const clauses = background
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (!/^(?:实施计划|执行计划|开发计划|实现计划)[:：]/.test(line)) return [];
      return splitInlinePlanClauses(cleanLabelValue(line));
    });

  const seen = new Set<string>();
  return clauses
    .map((title) => ({
      title,
      description: title,
      suggestedRole: 'executor' as const,
      priority: 'normal' as const,
      acceptance,
      scopeRead: [],
      scopeWrite: [],
      dependsOn: [],
    }))
    .filter((task) => {
      if (seen.has(task.title) || !isExecutableBackgroundTask(task)) return false;
      seen.add(task.title);
      return true;
    });
}

function splitInlinePlanClauses(value: string): string[] {
  return value
    .split(/[，,；;。]/)
    .map((item) => item.trim().replace(/[.。；;，,]+$/, ''))
    .filter(Boolean)
    .filter((item) => !/^(验收|验收标准|成功标准|acceptance)[:：]/i.test(item));
}

function extractAcceptance(text: string): string[] {
  const items = extractSectionItems(text, ['验收标准', '成功标准', '验收']);
  return items.length > 0 ? items : ['实现结果满足产品经理方案背景和用户原始需求。'];
}

function extractSectionItems(text: string, labels: string[]): string[] {
  const lines = text.split(/\r?\n/);
  const items: string[] = [];
  let collecting = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const label = labels.find((item) => line.startsWith(`${item}：`) || line.startsWith(`${item}:`));
    if (label) {
      collecting = true;
      const value = line.slice(label.length + 1).trim();
      if (value) items.push(stripListMarker(value));
      continue;
    }
    if (collecting && /^[-*]\s+/.test(line)) {
      items.push(stripListMarker(line));
      continue;
    }
    if (/^[\u4e00-\u9fa5A-Za-z ]{2,12}[:：]/.test(line)) collecting = false;
  }
  return Array.from(new Set(items.filter(Boolean)));
}

function firstSentence(text: string): string {
  return text.split(/[\n。.!?]/).map((item) => item.trim()).find(Boolean) ?? '';
}

function stripListMarker(line: string): string {
  return line.replace(/^[-*]\s+/, '').trim();
}

function cleanLabelValue(line: string): string {
  return line.replace(/^[^:：]+[:：]\s*/, '').trim();
}

function splitScopeValues(value: string): string[] {
  return value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
}
