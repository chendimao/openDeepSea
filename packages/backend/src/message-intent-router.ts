import type {
  MessageIntent,
  MessageIntentResult,
  MessageIntentSuggestedAction,
  RouteResult,
} from './types.js';

const LOW_CONFIDENCE_THRESHOLD = 0.85;

const INTENTS: MessageIntent[] = ['chat', 'light_task', 'debugger', 'brainstorming', 'workflow'];
const ACTIONS: MessageIntentSuggestedAction[] = [
  'reply_in_chat',
  'create_light_task',
  'start_debugger',
  'start_brainstorming',
  'start_workflow',
  'ask_user',
];

const PRIORITY: MessageIntent[] = [
  'debugger',
  'brainstorming',
  'workflow',
  'light_task',
  'chat',
];

const DEBUGGER_PATTERNS = [
  /^debugger[：:\s]/iu,
  /^debug[：:\s]/iu,
  /\bdebug\b/iu,
  /调试/u,
  /报错/u,
  /错误/u,
  /异常/u,
  /堆栈/u,
  /stack trace/iu,
  /\bbug\b/iu,
  /找根因/u,
  /根因/u,
  /没有任何变化/u,
  /没有变化/u,
];

const BRAINSTORMING_PATTERNS = [
  /^头脑风暴[：:\s]/u,
  /^brainstorm(?:ing)?[：:\s]/iu,
  /头脑风暴/u,
  /\bbrainstorm(?:ing)?\b/iu,
  /发散/u,
  /(?:多个|几个|三个|备选|对比)\s*方案/u,
  /选型/u,
];

const WORKFLOW_PATTERNS = [
  /^workflow[：:\s]/iu,
  /\bworkflow\b/iu,
  /工作流/u,
  /writing-plans/iu,
  /\btdd\b/iu,
  /implementation/iu,
  /验收/u,
  /代码审查/u,
  /完整闭环/u,
  /浏览器实际测试/u,
  /自动提交/u,
];

const LIGHT_TASK_PATTERNS = [
  /^新建任务[：:\s]/u,
  /^\/task\b/iu,
  /轻量任务/u,
  /小任务/u,
  /简单(?:改动|任务)/u,
  /快速/u,
  /quick/iu,
  /整理/u,
  /补充/u,
  /微调/u,
  /临时插入/u,
  /一点修改/u,
  /修改/u,
  /改成/u,
  /默认主题/u,
];

const CHAT_PATTERNS = [
  /^\/chat\b/iu,
  /聊/u,
  /讨论/u,
  /请问/u,
  /解释/u,
  /是什么/u,
  /\bhow\b/iu,
  /\bwhy\b/iu,
  /\bwhat\b/iu,
  /为什么/u,
  /思路/u,
];

export type MessageIntentClassifierInvoker = (
  input: Readonly<{
    message: string;
    ruleResult: MessageIntentResult;
  }>
) => Promise<string> | string;

export function classifyMessageIntent(input: { message: string }): MessageIntentResult {
  const message = input.message.trim();
  const explicitIntent = readExplicitIntentOverride(message);
  if (explicitIntent) {
    return {
      intent: explicitIntent.intent,
      confidence: 1,
      source: 'user_override',
      suggestedAction: deriveSuggestedAction(explicitIntent.intent, 1),
      reason: `用户使用显式前缀选择 ${explicitIntent.intent}`,
      signals: [explicitIntent.signal],
    };
  }

  const signals: Record<MessageIntent, string[]> = {
    chat: collectSignals(message, CHAT_PATTERNS),
    light_task: collectSignals(message, LIGHT_TASK_PATTERNS),
    debugger: collectSignals(message, DEBUGGER_PATTERNS),
    brainstorming: collectSignals(message, BRAINSTORMING_PATTERNS),
    workflow: collectSignals(message, WORKFLOW_PATTERNS),
  };
  const signalCount = Object.fromEntries(
    INTENTS.map((intent) => [intent, signals[intent].length]),
  ) as Record<MessageIntent, number>;

  const hasTaskLikeSignal = signalCount.debugger + signalCount.brainstorming + signalCount.workflow + signalCount.light_task > 0;
  const intent = pickIntentByPriority(signalCount, hasTaskLikeSignal);
  const confidence = deriveConfidence(intent, signalCount, hasTaskLikeSignal);
  const suggestedAction = deriveSuggestedAction(intent, confidence);
  const reason = buildRuleReason(intent, signalCount, hasTaskLikeSignal);

  return {
    intent,
    confidence,
    source: 'rule',
    suggestedAction,
    reason,
    signals: signals[intent],
  };
}

export async function classifyMessageIntentWithClassifier(input: {
  message: string;
  classifier?: MessageIntentClassifierInvoker;
}): Promise<MessageIntentResult> {
  const ruleResult = classifyMessageIntent({ message: input.message });
  if (ruleResult.confidence >= LOW_CONFIDENCE_THRESHOLD || !input.classifier) {
    return ruleResult;
  }

  try {
    const output = await input.classifier({
      message: input.message,
      ruleResult,
    });
    return parseClassifierIntentResult(output) ?? ruleResult;
  } catch {
    return ruleResult;
  }
}

export function parseClassifierIntentResult(output: string): MessageIntentResult | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }

  const root = asRecord(parsed);
  if (!root) return null;
  const intent = readIntent(root, 'intent');
  const confidence = readConfidence(root, 'confidence');
  if (!intent || confidence === null) return null;
  const suggestedAction = readSuggestedAction(root) ?? deriveSuggestedAction(intent, confidence);
  const reason = readOptionalReason(root, 'reason') ?? 'classifier provided intent result';
  const signals = readOptionalSignals(root, 'signals');

  return {
    intent,
    confidence,
    source: 'classifier',
    suggestedAction,
    reason,
    ...(signals.length > 0 ? { signals } : {}),
  };
}

export function shouldAskUserForIntent(intentResult: MessageIntentResult): boolean {
  return intentResult.suggestedAction === 'ask_user' || intentResult.confidence < LOW_CONFIDENCE_THRESHOLD;
}

export function applyIntentToRouteResult(routeResult: RouteResult, intentResult: MessageIntentResult): RouteResult {
  if (shouldAskUserForIntent(intentResult)) return routeResult;
  if (!isTaskLikeIntent(intentResult.intent)) return routeResult;
  if (routeResult.reason_code === 'explicit_task' ||
    routeResult.reason_code === 'explicit_task_terminal' ||
    routeResult.reason_code === 'explicit_task_not_found' ||
    routeResult.reason_code === 'reply_to_task') {
    return routeResult;
  }
  if (routeResult.action === 'create_task') return routeResult;

  return {
    ...routeResult,
    taskId: null,
    action: 'create_task',
    confidence: Math.max(routeResult.confidence, intentResult.confidence),
    reason: `${routeResult.reason}；高置信意图判定为 ${intentResult.intent}，建议创建任务`,
    reason_code: 'create_task_intent',
  };
}

export function buildIntentActivityContent(intentResult: MessageIntentResult): string {
  const confidence = Math.round(intentResult.confidence * 100);
  return `无法确定消息类型：当前判断为 ${intentResult.intent}（${confidence}%），来源：${intentResult.source}，建议：${intentResult.suggestedAction}。${intentResult.reason}`;
}

function pickIntentByPriority(
  signalCount: Record<MessageIntent, number>,
  hasTaskLikeSignal: boolean,
): MessageIntent {
  for (const intent of PRIORITY) {
    if (intent === 'chat' && !hasTaskLikeSignal) return 'chat';
    if (intent !== 'chat' && signalCount[intent] > 0) return intent;
  }
  return 'chat';
}

function deriveConfidence(
  intent: MessageIntent,
  signalCount: Record<MessageIntent, number>,
  hasTaskLikeSignal: boolean,
): number {
  if (intent === 'chat') {
    if (!hasTaskLikeSignal && signalCount.chat === 0) return 0.6;
    return signalCount.chat > 0 ? 0.88 : 0.72;
  }

  const hitCount = signalCount[intent];
  return Math.min(0.97, 0.86 + hitCount * 0.06);
}

function deriveSuggestedAction(intent: MessageIntent, confidence: number): MessageIntentSuggestedAction {
  if (confidence < LOW_CONFIDENCE_THRESHOLD) return 'ask_user';
  if (intent === 'chat') return 'reply_in_chat';
  if (intent === 'light_task') return 'create_light_task';
  if (intent === 'debugger') return 'start_debugger';
  if (intent === 'brainstorming') return 'start_brainstorming';
  return 'start_workflow';
}

function isTaskLikeIntent(intent: MessageIntent): boolean {
  return intent !== 'chat';
}

function readExplicitIntentOverride(message: string): { intent: MessageIntent; signal: string } | null {
  const patterns: Array<{ intent: MessageIntent; pattern: RegExp }> = [
    { intent: 'chat', pattern: /^\/chat\b/iu },
    { intent: 'light_task', pattern: /^新建任务[：:\s]/u },
    { intent: 'light_task', pattern: /^\/task\b/iu },
    { intent: 'debugger', pattern: /^debugger[：:\s]/iu },
    { intent: 'debugger', pattern: /^debug[：:\s]/iu },
    { intent: 'brainstorming', pattern: /^头脑风暴[：:\s]/u },
    { intent: 'brainstorming', pattern: /^brainstorm(?:ing)?[：:\s]/iu },
    { intent: 'workflow', pattern: /^workflow[：:\s]/iu },
  ];

  for (const { intent, pattern } of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(message);
    if (match?.[0]) return { intent, signal: match[0].trim() };
  }
  return null;
}

function buildRuleReason(
  intent: MessageIntent,
  signalCount: Record<MessageIntent, number>,
  hasTaskLikeSignal: boolean,
): string {
  if (intent === 'chat' && !hasTaskLikeSignal && signalCount.chat === 0) {
    return '未命中明确任务类信号，按聊天意图处理';
  }
  return `命中 ${intent} 规则信号`;
}

function collectSignals(message: string, patterns: RegExp[]): string[] {
  return patterns.reduce<string[]>((matches, pattern) => {
    pattern.lastIndex = 0;
    const match = pattern.exec(message);
    if (!match?.[0]) return matches;
    matches.push(match[0].trim());
    return matches;
  }, []);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readIntent(source: Record<string, unknown>, field: string): MessageIntent | null {
  const value = source[field];
  if (typeof value !== 'string' || !INTENTS.includes(value as MessageIntent)) {
    return null;
  }
  return value as MessageIntent;
}

function readConfidence(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0 || value > 1) {
    return null;
  }
  return value;
}

function readSuggestedAction(source: Record<string, unknown>): MessageIntentSuggestedAction | null {
  const value = typeof source.suggestedAction === 'string'
    ? source.suggestedAction
    : typeof source.suggested_action === 'string'
      ? source.suggested_action
      : undefined;
  if (value === undefined || !ACTIONS.includes(value as MessageIntentSuggestedAction)) {
    return null;
  }
  return value as MessageIntentSuggestedAction;
}

function readOptionalReason(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function readOptionalSignals(source: Record<string, unknown>, field: string): string[] {
  const value = source[field];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}
