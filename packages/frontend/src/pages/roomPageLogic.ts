import { parseMessageMetadata } from '../lib/messageMetadata';
import type {
  AgentTimelineEvent,
  Message,
  MessageMetadata,
  MessageTrace,
  PlannerDecision,
  RoomAgent,
  Task,
  TaskEvent,
  TaskExecutionIntent,
} from '../lib/types';

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

export interface TaskReadinessVisibilityInput {
  isUser: boolean;
  isSystem: boolean;
  isStreaming: boolean;
  ready: boolean;
  hasLaterMessages: boolean;
  intent?: TaskExecutionIntent;
}

export interface WorkflowEventRenderState {
  key: string | null;
  showTaskCard: boolean;
}

export interface TaskEventVisibilityState {
  showWorkflowTaskCard: boolean;
  showInlineTaskEvent: boolean;
  hideMessage: boolean;
}

export interface PlannerDispatchInput {
  source_message_id: string;
  planner_decision: PlannerDecision;
}

export function shouldShowPlannerDecisionPanel(input: {
  isUser: boolean;
  decision?: PlannerDecision;
}): boolean {
  return !input.isUser && Boolean(input.decision?.awaiting_user_confirmation);
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

export function getRoutableActiveTaskId(task: Pick<Task, 'id' | 'status'> | null): string | null {
  if (!task) return null;
  return task.status === 'todo' || task.status === 'in_progress' || task.status === 'review'
    ? task.id
    : null;
}

export function selectChatLayerMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.layer === undefined || message.layer === 'chat');
}

export function selectConversationMessages(messages: Message[]): Message[] {
  return messages.filter((message) =>
    message.layer === undefined ||
    message.layer === 'chat' ||
    isInlineTaskCardMessage(message)
  );
}

export function projectRoomActivityMessages(messages: Message[]): TaskEvent[] {
  return messages
    .filter((message) => message.layer === 'activity')
    .flatMap((message) => {
      const metadata = parseMessageMetadata(message.metadata);
      if (metadata.task_id) return [];
      const type = metadata.event_type ?? 'task_updated';
      const taskId = metadata.task_id ?? `room:${message.room_id}`;
      const sourceMessageId = metadata.message_id;
      return [{
        id: `message:${message.id}`,
        task_id: taskId,
        room_id: message.room_id,
        seq: 0,
        type,
        layer: 'activity',
        payload: {
          ...metadata,
          message_id: sourceMessageId,
          event_message_id: message.id,
          content: message.content,
        },
        source_run_id: null,
        created_at: message.created_at,
      }];
    });
}

export function getTaskReadinessActionState(intent: TaskExecutionIntent | undefined): TaskReadinessActionState {
  const implementationIntent = intent === undefined || intent === 'implementation' || intent === 'debug_fix';
  return {
    canGenerateTask: implementationIntent,
    description: implementationIntent
      ? '已具备创建任务的基础信息'
      : '这是方案/分析输出，不会直接启动正式 workflow',
    primaryLabel: implementationIntent ? '开始任务' : '',
    pendingLabel: '启动中',
  };
}

export function shouldShowTaskReadinessActions(input: TaskReadinessVisibilityInput): boolean {
  if (input.isUser || input.isSystem || input.isStreaming || input.hasLaterMessages || !input.ready) return false;
  return getTaskReadinessActionState(input.intent).canGenerateTask;
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

export function getTaskEventVisibilityState(input: {
  hasWorkflowRun: boolean;
  showWorkflowTaskCard: boolean;
  canRetryWorkflowEvent: boolean;
}): TaskEventVisibilityState {
  if (!input.hasWorkflowRun) {
    return {
      showWorkflowTaskCard: false,
      showInlineTaskEvent: true,
      hideMessage: false,
    };
  }

  if (input.canRetryWorkflowEvent) {
    return {
      showWorkflowTaskCard: input.showWorkflowTaskCard,
      showInlineTaskEvent: true,
      hideMessage: false,
    };
  }

  return {
    showWorkflowTaskCard: input.showWorkflowTaskCard,
    showInlineTaskEvent: false,
    hideMessage: !input.showWorkflowTaskCard,
  };
}

export function createPlannerDispatchInput(
  message: Message,
  metadata: MessageMetadata = parseMessageMetadata(message.metadata),
): PlannerDispatchInput | null {
  if (!metadata.planner_decision) return null;
  return {
    source_message_id: metadata.source_message_id ?? message.id,
    planner_decision: metadata.planner_decision,
  };
}

export function createTaskPlannerDispatchInput(
  task: Task,
  messages: Message[],
  roomAgents: RoomAgent[] = [],
): PlannerDispatchInput | null {
  if (!task.source_message_id) return null;
  const plannerSourceMessageId = task.source_message_id;
  const dispatchSourceMessageId = findTaskScopedDispatchSourceMessageId(task, messages) ?? plannerSourceMessageId;
  const plannerMessage = [...messages]
    .reverse()
    .find((message) => {
      const metadata = parseMessageMetadata(message.metadata);
      return metadata.source_message_id === plannerSourceMessageId &&
        Boolean(metadata.planner_decision && hasDispatchablePlannerSteps(metadata.planner_decision));
    });

  if (plannerMessage) {
    const input = createPlannerDispatchInput(plannerMessage);
    if (input) {
      return {
        source_message_id: dispatchSourceMessageId,
        planner_decision: input.planner_decision,
      };
    }
  }

  return {
    source_message_id: dispatchSourceMessageId,
    planner_decision: createFallbackTaskPlannerDecision(task, roomAgents),
  };
}

export function hasDispatchablePlannerSteps(decision: PlannerDecision): boolean {
  const isDispatchableMode = decision.mode === 'pause_after_suggestion' || decision.mode === 'dispatch_next';
  const isDispatchableStatus = decision.status === 'suggested' || decision.status === 'needs_fix';
  return isDispatchableMode &&
    isDispatchableStatus &&
    decision.awaiting_user_confirmation &&
    decision.next_steps.length > 0;
}

function createFallbackTaskPlannerDecision(task: Task, roomAgents: RoomAgent[]): PlannerDecision {
  const agentId = resolveTaskExecutorAgentId(task, roomAgents);
  return {
    mode: 'pause_after_suggestion',
    status: 'suggested',
    summary: `启动任务：${task.title}`,
    next_steps: [{
      agent_id: agentId,
      goal: createTaskDispatchGoal(task),
    }],
    awaiting_user_confirmation: true,
  };
}

function findTaskScopedDispatchSourceMessageId(task: Task, messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const metadata = parseMessageMetadata(message.metadata);
    if (metadata.task_id === task.id) return message.id;
  }
  return null;
}

function resolveTaskExecutorAgentId(task: Task, roomAgents: RoomAgent[]): string {
  if (task.assigned_agent_id) {
    const assigned = roomAgents.find((agent) =>
      agent.id === task.assigned_agent_id ||
      agent.agent_id === task.assigned_agent_id
    );
    if (assigned && assigned.agent_id !== 'planner') return assigned.agent_id;
  }

  const text = `${task.title}\n${task.description ?? ''}`.toLowerCase();
  if (/前端|frontend|front-end|react|vite|css|ui|页面|组件|header|menu|菜单|导航/u.test(text)) {
    return 'frontend-executor';
  }
  if (/后端|backend|server|api|接口|route|路由|database|sqlite|数据库/u.test(text)) {
    return 'backend-executor';
  }
  if (/测试|验证|test|qa|e2e|playwright/u.test(text)) {
    return 'qa-tester';
  }
  return 'computer-assistant';
}

function createTaskDispatchGoal(task: Task): string {
  const description = task.description?.trim();
  const content = description
    ? `执行任务「${task.title}」。任务描述：${description}`
    : `执行任务「${task.title}」。`;
  return content.length <= 600 ? content : `${content.slice(0, 597).trimEnd()}...`;
}

export type StreamTraceChannel = 'thinking' | 'tool' | 'command' | 'event';
export type MessageStreamChannel = 'answer' | StreamTraceChannel;

export interface MessageStreamUpdate {
  messageId: string;
  runId?: string;
  chunk: string;
  done: boolean;
  channel?: MessageStreamChannel;
  event?: AgentTimelineEvent;
  message?: Message;
}

export interface MessageStreamUpdateResult {
  messages: Message[] | undefined;
  matched: boolean;
  fullContent: string;
}

export interface MessageStreamBatchResult extends MessageStreamUpdateResult {
  finalizedMessageIds: Set<string>;
  finalizedRunIds: Set<string>;
}

export function applyMessageStreamUpdate(
  messages: Message[] | undefined,
  update: MessageStreamUpdate,
): MessageStreamUpdateResult {
  let matched = false;
  let fullContent = update.message?.content ?? '';
  const list = messages ?? [];

  const next = list.map((message) => {
    if (message.id !== update.messageId) return message;
    matched = true;

    if (update.done && update.message) {
      fullContent = update.message.content;
      return mergeStreamMessage(message, update.message, update.event);
    }

    if (update.channel === 'event' && update.event) {
      return mergeMessageStreamEvent(message, update.event);
    }

    if (update.channel === 'thinking' || update.channel === 'tool' || update.channel === 'command') {
      return mergeMessageStreamTrace(message, update.channel, update.chunk);
    }

    fullContent = `${message.content}${update.chunk}`;
    return { ...message, content: fullContent };
  });

  if (!matched && update.message) {
    matched = true;
    next.push(update.message);
  }

  return {
    messages: messages || matched ? dedupeAndSortMessages(next) : undefined,
    matched,
    fullContent,
  };
}

export function applyMessageStreamBatch(
  messages: Message[] | undefined,
  updates: MessageStreamUpdate[],
): MessageStreamBatchResult {
  let current = messages;
  let matched = false;
  let fullContent = '';
  const finalizedMessageIds = new Set<string>();
  const finalizedRunIds = new Set<string>();

  for (const update of updates) {
    if (finalizedMessageIds.has(update.messageId) && !(update.done && update.message)) continue;

    const result = applyMessageStreamUpdate(current, update);
    current = result.messages;
    matched = matched || result.matched;
    fullContent = result.fullContent || fullContent;

    if (update.done) {
      finalizedMessageIds.add(update.messageId);
      if (update.runId) finalizedRunIds.add(update.runId);
    }
  }

  return {
    messages: current,
    matched,
    fullContent,
    finalizedMessageIds,
    finalizedRunIds,
  };
}

export function mergeMessageStreamTrace(message: Message, channel: Exclude<StreamTraceChannel, 'event'>, chunk: string): Message {
  if (!chunk) return message;
  const metadata = parseMessageMetadata(message.metadata);
  const trace = appendTraceChunk(metadata.trace, channel, chunk);
  return {
    ...message,
    metadata: JSON.stringify({ ...metadata, trace }),
  };
}

function dedupeAndSortMessages(messages: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
}

export function mergeMessageStreamEvent(message: Message, event: AgentTimelineEvent): Message {
  const metadata = parseMessageMetadata(message.metadata);
  const traceEvents = mergeTraceEvents(metadata.trace?.events, [event]);
  return {
    ...message,
    metadata: JSON.stringify({
      ...metadata,
      trace: {
        ...(metadata.trace ?? {}),
        events: traceEvents,
      },
    }),
  };
}

export function mergeStreamMessage(
  message: Message,
  finalMessage: Message,
  timelineEvent?: AgentTimelineEvent,
): Message {
  const mergedMetadata = mergeFinalTraceMetadata(message.metadata, finalMessage.metadata, timelineEvent);
  return {
    ...finalMessage,
    metadata: mergedMetadata,
  };
}

function mergeFinalTraceMetadata(
  currentMetadata: string | null,
  nextMetadata: string | null,
  timelineEvent?: AgentTimelineEvent,
): string | null {
  const current = parseMessageMetadata(currentMetadata);
  const next = parseMessageMetadata(nextMetadata);
  const currentEvents = current.trace?.events ?? [];
  const nextEvents = next.trace?.events ?? [];
  const mergedEvents = mergeTraceEvents(currentEvents, [...nextEvents, ...(timelineEvent ? [timelineEvent] : [])]);
  if (!current.trace && !next.trace && !timelineEvent) return nextMetadata;
  return JSON.stringify({
    ...current,
    ...next,
    trace: {
      ...(current.trace ?? {}),
      ...(next.trace ?? {}),
      events: mergedEvents,
    },
  });
}

export function mergeTraceEvents(
  current: AgentTimelineEvent[] | undefined,
  incoming: AgentTimelineEvent[],
): AgentTimelineEvent[] {
  const byId = new Map<string, AgentTimelineEvent>();
  for (const event of current ?? []) {
    if (!event?.id) continue;
    byId.set(event.id, event);
  }
  for (const event of incoming) {
    if (!event?.id) continue;
    const existing = byId.get(event.id);
    byId.set(event.id, existing ? mergeTimelineEvent(existing, event) : event);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.created_at - b.created_at);
}

export function mergeTimelineEvent(existing: AgentTimelineEvent, incoming: AgentTimelineEvent): AgentTimelineEvent {
  return {
    ...existing,
    ...incoming,
    payload: mergeTimelineEventPayload(existing.payload, incoming.payload),
    raw: incoming.raw ?? existing.raw,
    created_at: incoming.created_at ?? existing.created_at,
  };
}

export function mergeTimelineEventPayload(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing, ...incoming };
  for (const key of ['text', 'output', 'stdout', 'stderr']) {
    const existingValue = existing[key];
    const incomingValue = incoming[key];
    if (typeof existingValue === 'string' && typeof incomingValue === 'string' && incomingValue.startsWith(existingValue)) {
      next[key] = incomingValue;
      continue;
    }
    if (typeof existingValue === 'string' && typeof incomingValue === 'string' && existingValue.startsWith(incomingValue)) {
      next[key] = existingValue;
      continue;
    }
    if (typeof existingValue === 'string' && typeof incomingValue === 'string' && incomingValue.length >= existingValue.length) {
      next[key] = incomingValue;
      continue;
    }
    if (typeof existingValue === 'string' && typeof incomingValue === 'string') {
      next[key] = `${existingValue}${incomingValue}`;
    }
  }
  return next;
}

function appendTraceChunk(
  trace: MessageTrace | undefined,
  channel: Exclude<StreamTraceChannel, 'event'>,
  chunk: string,
): MessageTrace {
  if (channel === 'thinking') {
    const thinking = [...(trace?.thinking ?? [])];
    const last = thinking[thinking.length - 1];
    if (last) {
      thinking[thinking.length - 1] = { text: `${last.text}${chunk}` };
    } else {
      thinking.push({ text: chunk });
    }
    return { ...trace, thinking };
  }

  if (channel === 'tool') {
    const tool_calls = [...(trace?.tool_calls ?? [])];
    const last = tool_calls[tool_calls.length - 1];
    if (last && last.name === 'stream') {
      tool_calls[tool_calls.length - 1] = { ...last, input: `${last.input}${chunk}` };
    } else {
      tool_calls.push({ name: 'stream', input: chunk });
    }
    return { ...trace, tool_calls };
  }

  const commands = [...(trace?.commands ?? [])];
  const last = commands[commands.length - 1];
  if (last && last.command === 'stream') {
    commands[commands.length - 1] = { ...last, output: `${last.output ?? ''}${chunk}` };
  } else {
    commands.push({ command: 'stream', output: chunk });
  }
  return { ...trace, commands };
}

function isWorkflowEventMetadata(metadata: MessageMetadata): boolean {
  return Boolean(metadata.event_type?.startsWith('workflow_') && (metadata.workflow_run_id || metadata.task_id));
}

function isInlineTaskCardMessage(message: Message): boolean {
  if (message.sender_type !== 'system' || message.layer !== 'activity') return false;
  const metadata = parseMessageMetadata(message.metadata);
  return Boolean(metadata.task_id && (
    metadata.event_type === 'task_created' ||
    metadata.event_type === 'task_status_changed'
  ));
}

function createWorkflowEventAggregationKey(message: Message, metadata: MessageMetadata): string | null {
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
