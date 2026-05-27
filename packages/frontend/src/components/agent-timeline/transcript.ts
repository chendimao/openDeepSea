import type { AgentTimelineEvent, MessageTrace } from '../../lib/types';

export type AgentTranscriptItem =
  | { type: 'text'; id: string; text: string; seq: number }
  | { type: 'event'; id: string; event: AgentTimelineEvent; seq: number };

export interface AgentTranscriptModel {
  items: AgentTranscriptItem[];
  allEvents: AgentTimelineEvent[];
}

export function buildAgentTranscript(trace?: MessageTrace): AgentTranscriptModel | null {
  const events = [...(trace?.events ?? [])].sort(compareEvents);
  if (!events.some((event) => event.type === 'assistant_message')) return null;

  const items: AgentTranscriptItem[] = [];
  let textBuffer = '';
  let textStartSeq = 0;
  let textId = '';

  const flushText = (): void => {
    const text = textBuffer.trim();
    if (!text) {
      textBuffer = '';
      textId = '';
      return;
    }
    items.push({
      type: 'text',
      id: textId || `text:${textStartSeq}`,
      text,
      seq: textStartSeq,
    });
    textBuffer = '';
    textId = '';
  };

  for (const event of events) {
    if (event.type === 'assistant_message') {
      const text = readAssistantText(event);
      if (!text) continue;
      if (!textBuffer) {
        textStartSeq = event.seq;
        textId = `text:${event.id}`;
      }
      textBuffer += text;
      continue;
    }

    if (isHiddenTranscriptEvent(event)) continue;
    flushText();
    items.push({ type: 'event', id: event.id, event, seq: event.seq });
  }

  flushText();
  return { items: mergeTranscriptToolEvents(items), allEvents: events };
}

function mergeTranscriptToolEvents(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  const mergedItems: AgentTranscriptItem[] = [];
  const toolItemIndexById = new Map<string, number>();

  for (const item of items) {
    if (item.type !== 'event' || !isToolLifecycleEvent(item.event)) {
      mergedItems.push(item);
      continue;
    }

    const toolId = readToolLifecycleId(item.event.payload);
    if (!toolId) {
      mergedItems.push(item);
      continue;
    }

    const existingIndex = toolItemIndexById.get(toolId);
    if (existingIndex === undefined) {
      toolItemIndexById.set(toolId, mergedItems.length);
      mergedItems.push(item);
      continue;
    }

    const existing = mergedItems[existingIndex];
    if (!existing || existing.type !== 'event') {
      toolItemIndexById.set(toolId, mergedItems.length);
      mergedItems.push(item);
      continue;
    }

    mergedItems[existingIndex] = {
      ...existing,
      event: mergeToolEvent(existing.event, item.event),
    };
  }

  return mergedItems;
}

function mergeToolEvent(existing: AgentTimelineEvent, incoming: AgentTimelineEvent): AgentTimelineEvent {
  const payload = {
    ...existing.payload,
    ...incoming.payload,
    input: existing.payload.input ?? incoming.payload.input,
    output: incoming.payload.output ?? existing.payload.output,
    title: incoming.payload.title ?? existing.payload.title,
    name: incoming.payload.name ?? existing.payload.name,
    kind: incoming.payload.kind ?? existing.payload.kind,
  };

  return {
    ...existing,
    ...incoming,
    id: existing.id,
    type: existing.type === 'tool_result' || incoming.type === 'tool_result' ? 'tool_result' : 'tool_call',
    status: mergeStatus(existing.status, incoming.status),
    payload,
    seq: Math.min(existing.seq, incoming.seq),
    created_at: Math.max(existing.created_at, incoming.created_at),
    raw: incoming.raw ?? existing.raw,
  };
}

function isHiddenTranscriptEvent(event: AgentTimelineEvent): boolean {
  if (event.type === 'raw') return true;
  if (event.type === 'thinking') return true;
  return false;
}

function readAssistantText(event: AgentTimelineEvent): string | null {
  const text = readString(event.payload.text);
  if (text !== null) return text;

  const content = event.payload.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    if (record.type === 'text') return readString(record.text);
  }
  return null;
}

function isToolLifecycleEvent(event: AgentTimelineEvent): boolean {
  return event.type === 'tool_call' || event.type === 'tool_result';
}

function readToolLifecycleId(payload: Record<string, unknown>): string | null {
  return readString(payload.id) ?? readString(payload.tool_call_id) ?? readString(payload.toolCallId);
}

function mergeStatus(
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

function compareEvents(left: AgentTimelineEvent, right: AgentTimelineEvent): number {
  return left.seq - right.seq || left.created_at - right.created_at || left.id.localeCompare(right.id);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}
