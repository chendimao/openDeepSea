import type { AgentTimelineEvent, MessageTrace } from './types.js';

const MAX_TRACE_PAYLOAD_BYTES = 12_000;
const MAX_TRACE_STRING_CHARS = 4_000;
const MAX_TRACE_ARRAY_ITEMS = 50;
const MAX_TRACE_OBJECT_KEYS = 40;

export function compactTimelineEvent(event: AgentTimelineEvent): AgentTimelineEvent {
  const baseEvent = compactTimelineEventForStorage(event);
  const payloadBytes = jsonByteLength(baseEvent.payload);
  const payload = payloadBytes > MAX_TRACE_PAYLOAD_BYTES
    ? compactPayload(baseEvent.payload, payloadBytes)
    : baseEvent.payload;

  return {
    ...baseEvent,
    payload,
  };
}

export function compactMessageTrace(trace: MessageTrace): MessageTrace {
  return {
    ...(trace.events ? { events: compactTimelineEvents(trace.events) } : {}),
  };
}

function compactTimelineEvents(events: AgentTimelineEvent[]): AgentTimelineEvent[] {
  const compacted: AgentTimelineEvent[] = [];
  let pendingAssistant: AgentTimelineEvent | null = null;

  const flushAssistant = (): void => {
    if (!pendingAssistant) return;
    compacted.push(pendingAssistant);
    pendingAssistant = null;
  };

  for (const event of events) {
    if (event.type === 'thinking' || event.type === 'raw') continue;
    const compactedEvent = compactTimelineEvent(event);
    if (compactedEvent.type === 'assistant_message') {
      if (pendingAssistant) {
        pendingAssistant = mergeAssistantEvents(pendingAssistant, compactedEvent);
      } else if (readNonEmptyString(compactedEvent.payload.text)) {
        pendingAssistant = compactedEvent;
      }
      continue;
    }
    flushAssistant();
    compacted.push(compactedEvent);
  }

  flushAssistant();
  return compacted;
}

function compactTimelineEventForStorage(event: AgentTimelineEvent): AgentTimelineEvent {
  return {
    id: event.id,
    message_id: event.message_id,
    run_id: event.run_id,
    agent_id: event.agent_id,
    seq: event.seq,
    type: event.type,
    status: event.status,
    title: event.title,
    payload: compactPayloadForStorage(event),
    created_at: event.created_at,
  };
}

function compactPayloadForStorage(event: AgentTimelineEvent): Record<string, unknown> {
  if (event.type === 'thinking' || event.type === 'raw') return {};
  if (event.type === 'assistant_message') {
    const text = readAssistantText(event.payload);
    return text ? { text } : {};
  }
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    return pickPayload(event.payload, [
      'id',
      'name',
      'title',
      'kind',
      'status',
      'path',
      'tool_call_id',
      'toolCallId',
      'locations',
    ]);
  }
  if (event.type === 'command' || event.type === 'command_output') {
    return pickPayload(event.payload, ['command', 'status']);
  }
  if (event.type === 'file_diff') {
    return pickPayload(event.payload, [
      'path',
      'additions',
      'deletions',
      'title',
      'status',
      'tool_call_id',
      'toolCallId',
    ]);
  }
  if (event.type === 'plan_update') {
    return pickPayload(event.payload, ['entries', 'status']);
  }
  if (event.type === 'web_search') {
    return pickPayload(event.payload, ['query', 'title', 'url', 'status']);
  }
  if (event.type === 'permission_request') {
    return pickPayload(event.payload, ['id', 'title', 'status', 'reason']);
  }
  if (event.type === 'error') {
    return pickPayload(event.payload, ['message', 'code', 'status']);
  }
  return compactRecord(event.payload);
}

function pickPayload(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (payload[key] !== undefined) picked[key] = payload[key];
  }
  return picked;
}

function readAssistantText(payload: Record<string, unknown>): string | null {
  const directText = readNonEmptyString(payload.text);
  if (directText !== null) return directText;
  const content = payload.content;
  if (typeof content === 'string' && content.length > 0) return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return readNonEmptyString((content as Record<string, unknown>).text);
  }
  return null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}

function mergeAssistantEvents(current: AgentTimelineEvent, next: AgentTimelineEvent): AgentTimelineEvent {
  return {
    ...current,
    status: mergeTimelineStatus(current.status, next.status),
    payload: {
      text: `${readNonEmptyString(current.payload.text) ?? ''}${readNonEmptyString(next.payload.text) ?? ''}`,
    },
    created_at: next.created_at,
  };
}

function mergeTimelineStatus(
  current: AgentTimelineEvent['status'],
  next: AgentTimelineEvent['status'],
): AgentTimelineEvent['status'] {
  const priority: Record<AgentTimelineEvent['status'], number> = {
    started: 0,
    delta: 1,
    completed: 2,
    failed: 3,
  };
  return priority[next] >= priority[current] ? next : current;
}

function compactPayload(payload: Record<string, unknown>, originalBytes: number): Record<string, unknown> {
  return {
    ...compactRecord(payload),
    truncated: true,
    original_bytes: originalBytes,
  };
}

function compactValue(value: unknown): unknown {
  if (typeof value === 'string') return compactString(value);
  if (Array.isArray(value)) {
    const compacted = value.slice(0, MAX_TRACE_ARRAY_ITEMS).map(compactValue);
    if (value.length > MAX_TRACE_ARRAY_ITEMS) {
      compacted.push(`[truncated ${value.length - MAX_TRACE_ARRAY_ITEMS} items]`);
    }
    return compacted;
  }
  if (value && typeof value === 'object') return compactRecord(value as Record<string, unknown>);
  return value;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(value);
  const compacted: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MAX_TRACE_OBJECT_KEYS)) {
    compacted[key] = compactValue(item);
  }
  if (entries.length > MAX_TRACE_OBJECT_KEYS) {
    compacted.__truncated_keys = entries.length - MAX_TRACE_OBJECT_KEYS;
  }
  return compacted;
}

function compactString(value: string): string {
  if (value.length <= MAX_TRACE_STRING_CHARS) return value;
  return `${value.slice(0, MAX_TRACE_STRING_CHARS)}\n...[truncated ${value.length - MAX_TRACE_STRING_CHARS} chars]`;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
