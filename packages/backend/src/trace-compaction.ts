import type { AgentTimelineEvent, MessageTrace } from './types.js';

const MAX_TRACE_PAYLOAD_BYTES = 12_000;
const MAX_TRACE_RAW_BYTES = 12_000;
const MAX_TRACE_STRING_CHARS = 4_000;
const MAX_TRACE_ARRAY_ITEMS = 50;
const MAX_TRACE_OBJECT_KEYS = 40;

export function compactTimelineEvent(event: AgentTimelineEvent): AgentTimelineEvent {
  const { raw, ...baseEvent } = event;
  const payloadBytes = jsonByteLength(event.payload);
  const rawBytes = raw ? jsonByteLength(raw) : 0;
  const payload = payloadBytes > MAX_TRACE_PAYLOAD_BYTES
    ? compactPayload(event.payload, payloadBytes)
    : event.payload;

  return {
    ...baseEvent,
    payload,
    ...(raw && rawBytes <= MAX_TRACE_RAW_BYTES ? { raw } : {}),
  };
}

export function compactMessageTrace(trace: MessageTrace): MessageTrace {
  return {
    ...trace,
    ...(trace.thinking ? {
      thinking: trace.thinking.map((item) => ({
        ...item,
        text: compactString(item.text),
      })),
    } : {}),
    ...(trace.tool_calls ? {
      tool_calls: trace.tool_calls.map((item) => ({
        ...item,
        name: compactString(item.name),
        input: compactString(item.input),
        ...(item.output ? { output: compactString(item.output) } : {}),
      })),
    } : {}),
    ...(trace.commands ? {
      commands: trace.commands.map((item) => ({
        ...item,
        command: compactString(item.command),
        ...(item.output ? { output: compactString(item.output) } : {}),
      })),
    } : {}),
    ...(trace.events ? { events: trace.events.map(compactTimelineEvent) } : {}),
  };
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
