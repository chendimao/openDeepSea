import type { AgentTimelineEvent } from '../../lib/types';

export interface AgentTimelineModel {
  visibleEvents: AgentTimelineEvent[];
  debugEvents: AgentTimelineEvent[];
  diagnostics: AgentTimelineDiagnostics | null;
  visibleCount: number;
}

export interface AgentTimelineDiagnostics {
  protocolEventCounts: Array<{ type: string; count: number }>;
  thoughtStreamStatus: 'received' | 'missing' | 'not_applicable';
  thoughtStreamMessage: string;
  subagentStructureStatus: 'received' | 'missing' | 'not_applicable';
  subagentStructureMessage: string;
}

const DEBUG_RAW_TYPES = new Set(['available_commands_update', 'protocol.stderr', 'usage_update']);
const TOOL_STATUS_PRIORITY: Record<AgentTimelineEvent['status'], number> = {
  started: 0,
  delta: 1,
  completed: 2,
  failed: 3,
};

export function buildAgentTimelineModel(events: AgentTimelineEvent[] = []): AgentTimelineModel {
  const visibleEvents: AgentTimelineEvent[] = [];
  const debugEvents: AgentTimelineEvent[] = [];

  for (const event of events) {
    if (event.type === 'assistant_message') continue;
    if (isDebugEvent(event)) {
      debugEvents.push(event);
      continue;
    }
    visibleEvents.push(event);
  }

  const mergedVisibleEvents = mergeToolLifecycleEvents(visibleEvents);
  const sortedVisibleEvents = stableSortByTimeline(mergedVisibleEvents);
  const sortedDebugEvents = stableSortByTimeline(debugEvents);
  const diagnostics = buildDiagnostics(events);

  return {
    visibleEvents: sortedVisibleEvents,
    debugEvents: sortedDebugEvents,
    diagnostics,
    visibleCount: sortedVisibleEvents.length,
  };
}

function isDebugEvent(event: AgentTimelineEvent): boolean {
  if (event.type !== 'raw') return false;

  const rawType = readString(event.payload.raw_type) ?? readString(event.payload.type) ?? readString(event.raw?.type);
  if (rawType && DEBUG_RAW_TYPES.has(rawType)) return true;

  if (readSessionUpdate(event.raw) === 'available_commands_update') return true;
  if (readString(event.raw?.method) === 'protocol.stderr') return true;

  return false;
}

function buildDiagnostics(events: AgentTimelineEvent[]): AgentTimelineDiagnostics | null {
  const protocolCounts = new Map<string, number>();
  let hasProtocolEvent = false;
  let hasAssistantOrToolStream = false;
  let hasThinking = false;
  let hasStructuredSubagent = false;
  let hasTextOnlySubagentClaim = false;

  for (const event of events) {
    if (event.type === 'thinking') hasThinking = true;
    if (event.type.startsWith('subagent_')) hasStructuredSubagent = true;
    if (
      event.type === 'assistant_message' &&
      /子代理已派发|等待子代理|子代理已返回|subagent/i.test(String(event.payload.text ?? ''))
    ) {
      hasTextOnlySubagentClaim = true;
    }
    if (event.type === 'assistant_message' || event.type === 'tool_call' || event.type === 'tool_result') {
      hasAssistantOrToolStream = true;
    }

    const sessionUpdate = readSessionUpdate(event.raw);
    const protocolType = sessionUpdate
      ?? readString(event.payload.raw_type)
      ?? readString(event.payload.type)
      ?? readString(event.raw?.type);
    if (!protocolType) continue;

    hasProtocolEvent = true;
    protocolCounts.set(protocolType, (protocolCounts.get(protocolType) ?? 0) + 1);
    if (protocolType === 'agent_thought_chunk' || /thinking|reasoning/i.test(protocolType)) {
      hasThinking = true;
    }
  }

  if (!hasProtocolEvent && !hasTextOnlySubagentClaim) return null;

  const thoughtStreamStatus = hasThinking
    ? 'received'
    : hasAssistantOrToolStream
      ? 'missing'
      : 'not_applicable';
  const subagentStructureStatus = hasStructuredSubagent
    ? 'received'
    : hasTextOnlySubagentClaim
      ? 'missing'
      : 'not_applicable';

  return {
    protocolEventCounts: [...protocolCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
    thoughtStreamStatus,
    thoughtStreamMessage: formatThoughtStreamMessage(thoughtStreamStatus),
    subagentStructureStatus,
    subagentStructureMessage: formatSubagentStructureMessage(subagentStructureStatus),
  };
}

function formatThoughtStreamMessage(status: AgentTimelineDiagnostics['thoughtStreamStatus']): string {
  if (status === 'received') return '已收到 thinking/reasoning 流。';
  if (status === 'missing') return '本轮 ACP 返回了正文或工具事件，但 provider 没有返回 thinking/reasoning 流。';
  return '本轮未观察到可判断 thinking 流的 ACP 消息事件。';
}

function formatSubagentStructureMessage(status: AgentTimelineDiagnostics['subagentStructureStatus']): string {
  if (status === 'received') return '已收到结构化子代理 ACP 事件或子代理 run。';
  if (status === 'missing') return '检测到文本中的子代理声明，但没有收到结构化子代理事件或子代理 run。';
  return '本轮未观察到子代理声明。';
}

function readSessionUpdate(raw: Record<string, unknown> | undefined): string | null {
  const params = asRecord(raw?.params);
  const update = asRecord(params?.update);
  return readString(update?.sessionUpdate);
}

function mergeToolLifecycleEvents(events: AgentTimelineEvent[]): AgentTimelineEvent[] {
  const mergedEvents: AgentTimelineEvent[] = [];
  const toolEventIndexById = new Map<string, number>();

  for (const event of events) {
    if (!isToolLifecycleEvent(event)) {
      mergedEvents.push(event);
      continue;
    }

    const toolId = readToolLifecycleId(event.payload);
    if (!toolId) {
      mergedEvents.push(event);
      continue;
    }

    const existingIndex = toolEventIndexById.get(toolId);
    if (existingIndex === undefined) {
      toolEventIndexById.set(toolId, mergedEvents.length);
      mergedEvents.push(event);
      continue;
    }

    const existing = mergedEvents[existingIndex];
    if (!existing) {
      toolEventIndexById.set(toolId, mergedEvents.length);
      mergedEvents.push(event);
      continue;
    }
    mergedEvents[existingIndex] = mergeToolEvent(existing, event);
  }

  return mergedEvents;
}

function isToolLifecycleEvent(event: AgentTimelineEvent): boolean {
  return event.type === 'tool_call' || event.type === 'tool_result';
}

function readToolLifecycleId(payload: Record<string, unknown>): string | null {
  const id = payload.id ?? payload.tool_call_id ?? payload.toolCallId;
  return readString(id);
}

function mergeToolEvent(existing: AgentTimelineEvent, incoming: AgentTimelineEvent): AgentTimelineEvent {
  const existingPayload = existing.payload;
  const incomingPayload = incoming.payload;

  const payload: Record<string, unknown> = {
    ...existingPayload,
    ...incomingPayload,
    input: pickFirstDefined(existingPayload.input, incomingPayload.input),
    output: pickFirstDefined(incomingPayload.output, existingPayload.output),
    title: pickFirstDefined(incomingPayload.title, existingPayload.title),
    name: pickFirstDefined(incomingPayload.name, existingPayload.name),
    kind: pickFirstDefined(incomingPayload.kind, existingPayload.kind),
  };

  return {
    ...existing,
    ...incoming,
    id: existing.id,
    type: existing.type === 'tool_result' || incoming.type === 'tool_result' ? 'tool_result' : 'tool_call',
    status: mergeToolStatus(existing.status, incoming.status),
    title: readString(incoming.title) ?? existing.title,
    payload,
    seq: Math.min(existing.seq, incoming.seq),
    created_at: Math.max(existing.created_at, incoming.created_at),
    raw: incoming.raw ?? existing.raw,
  };
}

function mergeToolStatus(
  current: AgentTimelineEvent['status'],
  next: AgentTimelineEvent['status'],
): AgentTimelineEvent['status'] {
  return TOOL_STATUS_PRIORITY[next] >= TOOL_STATUS_PRIORITY[current] ? next : current;
}

function stableSortByTimeline(events: AgentTimelineEvent[]): AgentTimelineEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const bySeq = left.event.seq - right.event.seq;
      if (bySeq !== 0) return bySeq;
      const byCreatedAt = left.event.created_at - right.event.created_at;
      if (byCreatedAt !== 0) return byCreatedAt;
      return left.index - right.index;
    })
    .map((item) => item.event);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function pickFirstDefined<T>(preferred: T | undefined, fallback: T | undefined): T | undefined {
  return preferred ?? fallback;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
