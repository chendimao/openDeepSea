import type { SessionAdapter } from './acp/types.js';
import type {
  MessageIntentResult,
  RouteResult,
  RoomAgent,
  TaskExecutionIntent,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 45_000;

export type TaskAnalysisTaskType = 'chat' | 'light_task' | 'debugger' | 'brainstorming' | 'workflow';
export type TaskAnalysisNextAction = 'reply_in_chat' | 'ask_user' | 'create_task';

export interface TaskAnalysisResult {
  task_type: TaskAnalysisTaskType;
  execution_intent: TaskExecutionIntent;
  confidence: number;
  title: string;
  description: string;
  acceptance: string[];
  missing_questions: string[];
  recommended_next_action: TaskAnalysisNextAction;
  requires_confirmation: boolean;
}

export type TaskAnalyzerInvoker = (input: Readonly<{
  message: string;
  intentResult: MessageIntentResult;
  routeResult: RouteResult;
}>) => Promise<TaskAnalysisResult>;

export function createAcpTaskAnalyzer(input: {
  projectPath: string;
  agent: RoomAgent;
  adapter: SessionAdapter;
  timeoutMs?: number;
}): TaskAnalyzerInvoker {
  return async ({ message, intentResult, routeResult }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let answer = '';
    try {
      await input.adapter.invoke({
        projectPath: input.projectPath,
        sessionId: null,
        prompt: buildAcpTaskAnalyzerPrompt({ message, intentResult, routeResult, agent: input.agent }),
        acpPermissionMode: 'read-only',
        acpWritableDirs: [],
        envOverrides: {
          OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER: 'project',
          OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER: 'project',
          OPENCLAW_SUPERPOWERS_DISABLED: '1',
          OPENDEEPSEA_SUPERPOWERS_DISABLED: '1',
        },
        onChunk: (chunk) => {
          if (chunk.stream === 'stdout' && (chunk.channel === 'tool' || chunk.channel === 'command')) {
            controller.abort(new Error('ACP task analyzer attempted to execute a tool or command'));
            return;
          }
          if (chunk.stream === 'stdout' && chunk.channel === 'answer') {
            answer += chunk.text;
          }
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const parsed = parseTaskAnalysisResult(answer);
    if (!parsed) {
      throw new Error('ACP task analyzer returned invalid JSON');
    }
    return parsed;
  };
}

export function parseTaskAnalysisResult(output: string): TaskAnalysisResult | null {
  const candidate = extractJsonObject(output);
  if (!candidate) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const root = isRecord(parsed.task_analysis) ? parsed.task_analysis : parsed;
  const taskType = readTaskType(root.task_type);
  const executionIntent = readExecutionIntent(root.execution_intent);
  const confidence = readConfidence(root.confidence);
  const title = readString(root.title);
  const description = readString(root.description);
  const nextAction = readNextAction(root.recommended_next_action);
  if (!taskType || !executionIntent || confidence === null || !title || !description || !nextAction) {
    return null;
  }
  return {
    task_type: taskType,
    execution_intent: executionIntent,
    confidence,
    title,
    description,
    acceptance: readStringArray(root.acceptance),
    missing_questions: readStringArray(root.missing_questions),
    recommended_next_action: nextAction,
    requires_confirmation: typeof root.requires_confirmation === 'boolean' ? root.requires_confirmation : false,
  };
}

function buildAcpTaskAnalyzerPrompt(input: {
  message: string;
  intentResult: MessageIntentResult;
  routeResult: RouteResult;
  agent: RoomAgent;
}): string {
  return [
    '你是 OpenClaw Room 的任务分析器。你只能判断任务类型并输出结构化任务信息。',
    '硬性限制：不要执行用户请求，不要修改文件，不要调用工具，不要运行命令，不要创建计划文档。',
    '本轮 ACP 权限是 read-only；如果需要执行，也只能在 JSON 中表达为后续动作。',
    `当前用于分析的 ACP 智能体：${input.agent.agent_name}（${input.agent.agent_id}）。`,
    '',
    '请只输出严格 JSON，不要 Markdown，不要代码块，不要额外解释。',
    'JSON 字段固定为：',
    '{"task_type":"light_task","execution_intent":"implementation","confidence":0.9,"title":"一句话任务标题","description":"任务目标、边界和上下文","acceptance":["验收标准"],"missing_questions":[],"recommended_next_action":"create_task","requires_confirmation":false}',
    '',
    '字段约束：',
    '- task_type: chat | light_task | debugger | brainstorming | workflow',
    '- execution_intent: analysis_only | planning_only | documentation_only | implementation | debug_fix | review_only',
    '- recommended_next_action: reply_in_chat | ask_user | create_task',
    '- 如果信息不足，recommended_next_action 使用 ask_user，并在 missing_questions 中给出问题。',
    '- 如果是实现、修复、开发、删除 UI 入口等可执行请求，只返回 create_task，不要执行。',
    '',
    `规则意图结果：${JSON.stringify(input.intentResult)}`,
    `路由结果：${JSON.stringify(input.routeResult)}`,
    `用户消息：${input.message}`,
  ].join('\n');
}

function extractJsonObject(output: string): string | null {
  const trimmed = output.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return fenced && fenced.startsWith('{') && fenced.endsWith('}') ? fenced : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function readConfidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

function readTaskType(value: unknown): TaskAnalysisTaskType | null {
  return value === 'chat' ||
    value === 'light_task' ||
    value === 'debugger' ||
    value === 'brainstorming' ||
    value === 'workflow'
    ? value
    : null;
}

function readNextAction(value: unknown): TaskAnalysisNextAction | null {
  return value === 'reply_in_chat' || value === 'ask_user' || value === 'create_task' ? value : null;
}

function readExecutionIntent(value: unknown): TaskExecutionIntent | null {
  return value === 'analysis_only' ||
    value === 'planning_only' ||
    value === 'documentation_only' ||
    value === 'implementation' ||
    value === 'debug_fix' ||
    value === 'review_only'
    ? value
    : null;
}
