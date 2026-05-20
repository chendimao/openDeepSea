import { parseMessageMetadata } from '../lib/messageMetadata';
import type { Message, MessageMetadata, TaskExecutionIntent } from '../lib/types';

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

export interface WorkflowEventRenderState {
  key: string | null;
  showTaskCard: boolean;
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
    canGenerateTask: implementationIntent,
    description: implementationIntent
      ? '已具备创建任务的基础信息'
      : '这是方案/分析输出，不会直接启动正式 workflow',
    primaryLabel: implementationIntent ? '开始任务' : '继续沟通',
    pendingLabel: '启动中',
  };
}

export function createWorkflowEventRenderStateMap(messages: Message[]): Map<string, WorkflowEventRenderState> {
  const renderStateByMessageId = new Map<string, WorkflowEventRenderState>();
  const seenKeys = new Set<string>();

  for (const message of [...messages].sort((a, b) => a.created_at - b.created_at)) {
    if (message.sender_type !== 'system') continue;
    const metadata = parseMessageMetadata(message.metadata);
    if (!isWorkflowEventMetadata(metadata)) continue;

    const key = createWorkflowEventAggregationKey(message, metadata);
    const showTaskCard = Boolean(key && !seenKeys.has(key));
    if (key) seenKeys.add(key);
    renderStateByMessageId.set(message.id, { key, showTaskCard });
  }

  return renderStateByMessageId;
}

function isWorkflowEventMetadata(metadata: MessageMetadata): boolean {
  return Boolean(metadata.event_type?.startsWith('workflow_') && (metadata.workflow_run_id || metadata.task_id));
}

function createWorkflowEventAggregationKey(message: Message, metadata: MessageMetadata): string | null {
  if (metadata.workflow_run_id && metadata.task_id) return `workflow:${metadata.workflow_run_id}:task:${metadata.task_id}`;
  if (metadata.workflow_run_id) return `workflow:${metadata.workflow_run_id}`;
  if (metadata.task_id) return `task:${metadata.task_id}`;
  return message.id ? `message:${message.id}` : null;
}

function isReplyableMessage(message: Message): boolean {
  return message.sender_type === 'agent' && Boolean(message.content.trim());
}

function summarizeMessageExcerpt(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '空消息';
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93).trimEnd()}...`;
}
