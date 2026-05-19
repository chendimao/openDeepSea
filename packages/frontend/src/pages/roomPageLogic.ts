import type { Message, TaskExecutionIntent } from '../lib/types';

export interface ReplyTarget {
  messageId: string;
  senderName: string;
  excerpt: string;
  explicit: boolean;
}

export interface TaskReadinessActionState {
  canGenerateTask: boolean;
  description: string;
  primaryLabel: string;
  pendingLabel: string;
}

export function createDefaultReplyTarget(
  messages: Message[],
  excludedMessageIds: ReadonlySet<string> = new Set(),
): ReplyTarget | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && excludedMessageIds.has(message.id)) continue;
    if (!message || !isReplyableMessage(message)) continue;
    return createReplyTarget(message, false);
  }
  return null;
}

export function createReplyTarget(message: Message, explicit: boolean): ReplyTarget {
  return {
    messageId: message.id,
    senderName: message.sender_name ?? message.sender_id,
    excerpt: summarizeMessageExcerpt(message.content),
    explicit,
  };
}

export function getTaskReadinessActionState(intent: TaskExecutionIntent | undefined): TaskReadinessActionState {
  const implementationIntent = intent === undefined || intent === 'implementation' || intent === 'debug_fix';
  return {
    canGenerateTask: true,
    description: implementationIntent
      ? '已具备创建任务的基础信息'
      : '这是方案/分析输出，可生成任务但不会直接执行实现',
    primaryLabel: implementationIntent ? '开始任务' : '生成任务',
    pendingLabel: '启动中',
  };
}

function isReplyableMessage(message: Message): boolean {
  return message.sender_type === 'agent' && Boolean(message.content.trim());
}

function summarizeMessageExcerpt(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '空消息';
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93).trimEnd()}...`;
}
