import type {
  MessageIntent,
  MessageIntentResult,
  MessageIntentSuggestedAction,
  RouteResult,
} from './types.js';

const LOW_CONFIDENCE_THRESHOLD = 0.85;

const PRIORITY: MessageIntent[] = [
  'debugger',
  'brainstorming',
  'workflow',
  'light_task',
  'chat',
];

const DEBUGGER_PATTERNS = [
  /\bdebug\b/iu,
  /调试/u,
  /报错/u,
  /错误/u,
  /异常/u,
  /堆栈/u,
  /stack trace/iu,
  /\bbug\b/iu,
];

const BRAINSTORMING_PATTERNS = [
  /头脑风暴/u,
  /\bbrainstorm(?:ing)?\b/iu,
  /发散/u,
  /方案/u,
  /选型/u,
];

const WORKFLOW_PATTERNS = [
  /\bworkflow\b/iu,
  /工作流/u,
  /writing-plans/iu,
  /\btdd\b/iu,
  /implementation/iu,
  /验收/u,
  /代码审查/u,
];

const LIGHT_TASK_PATTERNS = [
  /轻量任务/u,
  /小任务/u,
  /简单(?:改动|任务)/u,
  /快速/u,
  /quick/iu,
  /整理/u,
  /补充/u,
  /微调/u,
];

const CHAT_PATTERNS = [
  /聊/u,
  /讨论/u,
  /请问/u,
  /\bhow\b/iu,
  /\bwhy\b/iu,
  /\bwhat\b/iu,
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
  const signalCount: Record<MessageIntent, number> = {
    chat: countSignals(message, CHAT_PATTERNS),
    light_task: countSignals(message, LIGHT_TASK_PATTERNS),
    debugger: countSignals(message, DEBUGGER_PATTERNS),
    brainstorming: countSignals(message, BRAINSTORMING_PATTERNS),
    workflow: countSignals(message, WORKFLOW_PATTERNS),
  };

  const hasTaskLikeSignal = signalCount.debugger + signalCount.brainstorming + signalCount.workflow + signalCount.light_task > 0;
  const intent = pickIntentByPriority(signalCount, hasTaskLikeSignal);
  const confidence = deriveConfidence(intent, signalCount, hasTaskLikeSignal);
  const suggestedAction = deriveSuggestedAction(intent, confidence);
  const reason = buildRuleReason(intent, signalCount, hasTaskLikeSignal);

  return {
    intent,
    confidence,
    source: 'rule',
    suggested_action: suggestedAction,
    reason,
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
    return parseClassifierIntentResult(output);
  } catch {
    return ruleResult;
  }
}

export function parseClassifierIntentResult(output: string): MessageIntentResult {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('classifier intent result must be a raw JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(`classifier intent result is not valid JSON: ${(error as Error).message}`);
  }

  const root = asRecord(parsed, 'classifier intent result');
  const intent = readIntent(root, 'intent');
  const confidence = readConfidence(root, 'confidence');
  const suggestedAction = readSuggestedAction(root, 'suggested_action') ?? deriveSuggestedAction(intent, confidence);
  const reason = readOptionalReason(root, 'reason') ?? 'classifier provided intent result';

  return {
    intent,
    confidence,
    source: 'classifier',
    suggested_action: suggestedAction,
    reason,
  };
}

export function shouldAskUserForIntent(intentResult: MessageIntentResult): boolean {
  return intentResult.confidence < LOW_CONFIDENCE_THRESHOLD;
}

export function applyIntentToRouteResult(routeResult: RouteResult, intentResult: MessageIntentResult): RouteResult {
  if (routeResult.action !== 'ask_user') return routeResult;
  if (shouldAskUserForIntent(intentResult)) return routeResult;
  if (!isTaskLikeIntent(intentResult.intent)) return routeResult;

  return {
    ...routeResult,
    action: 'create_task',
    confidence: Math.max(routeResult.confidence, intentResult.confidence),
    reason: `${routeResult.reason}；高置信意图判定为 ${intentResult.intent}，建议创建任务`,
  };
}

export function buildIntentActivityContent(intentResult: MessageIntentResult): string {
  const confidence = Math.round(intentResult.confidence * 100);
  return `消息意图：${intentResult.intent}（${confidence}%）来源：${intentResult.source}，建议：${intentResult.suggested_action}。${intentResult.reason}`;
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
  if (!isTaskLikeIntent(intent)) return 'keep_route';
  return 'create_task';
}

function isTaskLikeIntent(intent: MessageIntent): boolean {
  return intent !== 'chat';
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

function countSignals(message: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => (pattern.test(message) ? count + 1 : count), 0);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readIntent(source: Record<string, unknown>, field: string): MessageIntent {
  const value = source[field];
  const intents: MessageIntent[] = ['chat', 'light_task', 'debugger', 'brainstorming', 'workflow'];
  if (typeof value !== 'string' || !intents.includes(value as MessageIntent)) {
    throw new Error(`${field} must be one of ${intents.join(', ')}`);
  }
  return value as MessageIntent;
}

function readConfidence(source: Record<string, unknown>, field: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return value;
}

function readSuggestedAction(
  source: Record<string, unknown>,
  field: string,
): MessageIntentSuggestedAction | null {
  const value = source[field];
  if (value === undefined) return null;
  const actions: MessageIntentSuggestedAction[] = ['keep_route', 'create_task', 'ask_user'];
  if (typeof value !== 'string' || !actions.includes(value as MessageIntentSuggestedAction)) {
    throw new Error(`${field} must be one of ${actions.join(', ')}`);
  }
  return value as MessageIntentSuggestedAction;
}

function readOptionalReason(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string`);
  return trimmed;
}
