import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { compactMessageTrace } from '../trace-compaction.js';
import type {
  AgentTimelineEvent,
  Message,
  MessageMetadata,
  PlannerDecision,
  MessageTrace,
  MessageType,
  SenderType,
} from '../types.js';

const CLIENT_TRACE_EVENT_LIMIT = 80;

export const messageRepo = {
  listByRoom(roomId: string, limit = 200): Message[] {
    const messages = db
      .prepare(
        `SELECT * FROM messages
         WHERE room_id = ?
           AND COALESCE(json_extract(metadata, '$.internal'), 0) <> 1
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(roomId, limit) as Message[];
    return compactTraceMetadataForList(refreshPlannerMetadataFromContent(messages));
  },

  listForClientByRoom(roomId: string, limit = 200): Message[] {
    return this.listByRoom(roomId, limit).map(compactMessageForClient);
  },

  get(id: string): Message | undefined {
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | undefined;
  },

  create(input: {
    room_id: string;
    sender_type: SenderType;
    sender_id: string;
    sender_name?: string;
    content: string;
    message_type?: MessageType;
    metadata?: Record<string, unknown>;
  }): Message {
    const id = nanoid(16);
    db.prepare(
      `INSERT INTO messages (id, room_id, sender_type, sender_id, sender_name, content, message_type, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.room_id,
      input.sender_type,
      input.sender_id,
      input.sender_name ?? null,
      input.content,
      input.message_type ?? 'text',
      input.metadata ? JSON.stringify(input.metadata) : null,
      now(),
    );
    return this.get(id)!;
  },

  appendChunk(id: string, chunk: string): void {
    db.prepare('UPDATE messages SET content = content || ? WHERE id = ?').run(chunk, id);
  },

  mergeMetadata(id: string, patch: Record<string, unknown>): Message | undefined {
    const message = this.get(id);
    if (!message) return undefined;
    const metadata = parseMetadataObject(message.metadata);
    const nextMetadata = { ...metadata, ...patch };
    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(nextMetadata), id);
    return this.get(id);
  },

  mergeTrace(id: string, patch: Partial<MessageTrace>): Message | undefined {
    const message = this.get(id);
    if (!message) return undefined;
    const metadata = parseMetadataObject(message.metadata);
    const nextTrace = mergeMessageTrace(metadata.trace, patch);
    const nextMetadata = { ...metadata, trace: compactMessageTrace(nextTrace) };
    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(nextMetadata), id);
    return this.get(id);
  },

  markFileAttachmentDeleted(fileId: string): number {
    const messages = db.prepare(
      `SELECT DISTINCT messages.*
       FROM messages
       INNER JOIN message_file_refs ON message_file_refs.message_id = messages.id
       WHERE message_file_refs.file_id = ?`,
    ).all(fileId) as Message[];
    const update = db.prepare('UPDATE messages SET metadata = ? WHERE id = ?');
    let changed = 0;

    const transaction = db.transaction(() => {
      for (const message of messages) {
        const nextMetadata = markMetadataFileDeleted(message.metadata, fileId);
        if (!nextMetadata) continue;
        update.run(JSON.stringify(nextMetadata), message.id);
        changed += 1;
      }
    });
    transaction();
    return changed;
  },
};

function refreshPlannerMetadataFromContent(messages: Message[]): Message[] {
  const refreshed: Message[] = [];
  for (const message of messages) {
    const next = refreshPlannerMessageMetadata(message);
    refreshed.push(next);
  }
  return refreshed;
}

function compactTraceMetadataForList(messages: Message[]): Message[] {
  return messages.map((message) => {
    const metadata = parseMetadataObject(message.metadata);
    if (!isMessageTrace(metadata.trace)) return message;
    const compactTrace = compactMessageTrace(metadata.trace);
    if (compactTrace === metadata.trace) return message;
    return {
      ...message,
      metadata: JSON.stringify({ ...metadata, trace: compactTrace }),
    };
  });
}

function compactMessageForClient(message: Message): Message {
  const metadata = parseMetadataObject(message.metadata);
  if (!isMessageTrace(metadata.trace)) return message;
  const compactTrace = compactMessageTraceForClient(metadata.trace);
  return {
    ...message,
    metadata: JSON.stringify({ ...metadata, trace: compactTrace }),
  };
}

function compactMessageTraceForClient(trace: MessageTrace): MessageTrace {
  const events = trace.events ?? [];
  if (events.length <= CLIENT_TRACE_EVENT_LIMIT) return trace;
  const visibleEvents = events
    .filter(isVisibleClientTraceEvent)
    .slice(-CLIENT_TRACE_EVENT_LIMIT);
  return {
    ...trace,
    events: visibleEvents,
    events_total: events.length,
    events_omitted: events.length - visibleEvents.length,
  };
}

function isVisibleClientTraceEvent(event: AgentTimelineEvent): boolean {
  return event.type !== 'assistant_message';
}

function refreshPlannerMessageMetadata(message: Message): Message {
  if (message.sender_type !== 'agent' || message.sender_id !== 'planner') return message;
  const explicitDecision = parseExplicitPlannerDecision(message.content);
  if (!explicitDecision) return message;

  const metadata = parseMetadataObject(message.metadata);
  const currentDecision = readPlannerDecisionObject(metadata.planner_decision);
  if (plannerDecisionMatches(currentDecision, explicitDecision)) return message;

  const nextMetadata = { ...metadata, planner_decision: explicitDecision };
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(nextMetadata), message.id);
  return { ...message, metadata: JSON.stringify(nextMetadata) };
}

function parseExplicitPlannerDecision(content: string): PlannerDecision | null {
  for (const candidate of extractJsonObjectCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const decision = readPlannerDecisionObject(parsed);
      if (decision) return decision;
    } catch {
      // Ignore malformed JSON blocks.
    }
  }
  return null;
}

function extractJsonObjectCandidates(content: string): string[] {
  const fencedBlocks = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item && item.startsWith('{') && item.endsWith('}')));
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return [...fencedBlocks, trimmed];
  }
  return fencedBlocks;
}

function readPlannerDecisionObject(value: unknown): PlannerDecision | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.planner_decision) ? value.planner_decision : value;
  if (
    !isPlannerExecutionMode(candidate.mode) ||
    !isPlannerDecisionStatus(candidate.status) ||
    typeof candidate.summary !== 'string' ||
    !candidate.summary.trim() ||
    typeof candidate.awaiting_user_confirmation !== 'boolean' ||
    !Array.isArray(candidate.next_steps)
  ) {
    return null;
  }

  const next_steps = candidate.next_steps
    .map((step) => {
      if (!isRecord(step)) return null;
      if (
        typeof step.agent_id !== 'string' ||
        !step.agent_id.trim() ||
        typeof step.goal !== 'string' ||
        !step.goal.trim()
      ) {
        return null;
      }
      return {
        agent_id: step.agent_id.trim(),
        goal: step.goal.trim(),
      };
    })
    .filter((step): step is PlannerDecision['next_steps'][number] => Boolean(step));

  return {
    mode: candidate.mode,
    status: candidate.status,
    summary: candidate.summary.trim(),
    next_steps,
    awaiting_user_confirmation: candidate.awaiting_user_confirmation,
  };
}

function isPlannerExecutionMode(value: unknown): value is PlannerDecision['mode'] {
  return value === 'pause_after_suggestion' || value === 'auto_continue';
}

function isPlannerDecisionStatus(value: unknown): value is PlannerDecision['status'] {
  return value === 'suggested' || value === 'dispatching' || value === 'completed' || value === 'blocked';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function plannerDecisionMatches(a: PlannerDecision | null, b: PlannerDecision): boolean {
  if (!a) return false;
  if (plannerDecisionFieldsEqual(a, b)) return true;
  if (a.mode !== 'auto_continue' || b.status !== 'suggested') return false;
  if (a.status === 'blocked') return true;
  return plannerDecisionFieldsEqual(a, {
    ...b,
    mode: 'auto_continue',
    awaiting_user_confirmation: false,
  });
}

function plannerDecisionFieldsEqual(a: PlannerDecision, b: PlannerDecision): boolean {
  return a.mode === b.mode &&
    a.status === b.status &&
    a.summary === b.summary &&
    a.awaiting_user_confirmation === b.awaiting_user_confirmation &&
    plannerNextStepsEqual(a.next_steps, b.next_steps);
}

function plannerNextStepsEqual(a: PlannerDecision['next_steps'], b: PlannerDecision['next_steps']): boolean {
  if (a.length !== b.length) return false;
  return a.every((step, index) =>
    step.agent_id === b[index]?.agent_id &&
    step.goal === b[index]?.goal,
  );
}

function parseMetadataObject(rawMetadata: string | null): Record<string, unknown> {
  if (!rawMetadata) return {};
  try {
    const parsed = JSON.parse(rawMetadata) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mergeMessageTrace(existing: unknown, patch: Partial<MessageTrace>): MessageTrace {
  const current = isMessageTrace(existing) ? existing : {};
  const mergedEvents = mergeTraceEvents(current.events, patch.events);
  return {
    ...current,
    ...(patch.thinking ? {
      thinking: [...(current.thinking ?? []), ...patch.thinking],
    } : {}),
    ...(patch.tool_calls ? {
      tool_calls: [...(current.tool_calls ?? []), ...patch.tool_calls],
    } : {}),
    ...(patch.commands ? {
      commands: [...(current.commands ?? []), ...patch.commands],
    } : {}),
    ...(mergedEvents ? { events: mergedEvents } : {}),
  };
}

function isMessageTrace(value: unknown): value is MessageTrace {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeTraceEvents(
  existingEvents: AgentTimelineEvent[] | undefined,
  patchEvents: AgentTimelineEvent[] | undefined,
): AgentTimelineEvent[] | undefined {
  if (!existingEvents && !patchEvents) return undefined;
  if (!patchEvents || patchEvents.length === 0) return existingEvents ?? [];
  if (!existingEvents || existingEvents.length === 0) return [...patchEvents];

  const merged = [...existingEvents];
  const indexById = new Map<string, number>();
  merged.forEach((event, index) => indexById.set(event.id, index));

  for (const nextEvent of patchEvents) {
    const existingIndex = indexById.get(nextEvent.id);
    if (existingIndex === undefined) {
      indexById.set(nextEvent.id, merged.length);
      merged.push(nextEvent);
      continue;
    }
    const existingEvent = merged[existingIndex];
    if (!existingEvent) {
      merged[existingIndex] = nextEvent;
      continue;
    }
    merged[existingIndex] = mergeTimelineEvent(existingEvent, nextEvent);
  }
  return merged;
}

function mergeTimelineEvent(existing: AgentTimelineEvent, patch: AgentTimelineEvent): AgentTimelineEvent {
  return {
    ...existing,
    ...patch,
    payload: mergeTimelinePayload(existing.payload, patch.payload),
  };
}

function mergeTimelinePayload(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...patch };
  for (const key of ['text', 'output', 'stdout', 'stderr']) {
    const currentValue = existing[key];
    const nextValue = patch[key];
    if (typeof currentValue === 'string' && typeof nextValue === 'string') {
      merged[key] = currentValue + nextValue;
    }
  }
  return merged;
}

function markMetadataFileDeleted(rawMetadata: string | null, fileId: string): MessageMetadata | null {
  if (!rawMetadata) return null;

  let metadata: MessageMetadata;
  try {
    metadata = JSON.parse(rawMetadata) as MessageMetadata;
  } catch {
    return null;
  }

  if (!Array.isArray(metadata.attachments)) return null;
  let changed = false;
  const attachments = metadata.attachments.map((attachment) => {
    if (attachment.fileId !== fileId || attachment.deleted) return attachment;
    changed = true;
    return { ...attachment, deleted: true };
  });

  return changed ? { ...metadata, attachments } : null;
}
