import type { AgentTimelineEvent, AgentTimelineEventStatus } from '../types.js';
import {
  createTimelineEvent,
  normalizeKnownProviderEvent,
  normalizeRawTimelineEvent,
} from './timeline.js';

export function isProtocolEvent(raw: Record<string, unknown>): boolean {
  if (raw['method'] === 'session/update') return true;
  const payload = getProtocolPayload(raw);
  return typeof payload['sessionUpdate'] === 'string';
}

export function normalizeProtocolEvent(args: {
  messageId: string;
  runId: string;
  agentId: string;
  seq: number;
  provider: string;
  raw: Record<string, unknown>;
}): AgentTimelineEvent {
  const payload = getProtocolPayload(args.raw);
  const type = getProtocolType(args.raw, payload, args.provider);
  const sessionUpdate = text(payload['sessionUpdate']);
  const kind = text(payload['kind']) ?? text(args.raw['kind']);

  if (sessionUpdate === 'agent_message_chunk') {
    const messageText = getContentText(payload);
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'assistant_message',
      status: 'delta',
      title: '助手回复',
      payload: {
        text: messageText ?? '',
        content: payload['content'],
      },
      raw: args.raw,
    });
  }

  if (sessionUpdate === 'agent_thought_chunk' || kind === 'thinking' || /thinking|reasoning/i.test(type)) {
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'thinking',
      status: resolveStatus(payload, /completed|done/i.test(type) ? 'completed' : 'delta'),
      title: '思考过程',
      payload: {
        text: text(payload['delta']) ?? text(payload['text']) ?? getContentText(payload) ?? '',
        encrypted: payload['encrypted'] === true,
        content: payload['content'],
      },
      raw: args.raw,
    });
  }

  if (sessionUpdate === 'tool_call' || /tool_call_started|tool.*started|tool_use|^tool_call$/i.test(type)) {
    const name = getToolName(payload, args.raw, 'tool');
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'tool_call',
      status: resolveStatus(payload, 'started'),
      title: `调用工具 ${name}`,
      payload: {
        id: text(payload['id']) ?? text(payload['toolCallId']) ?? text(args.raw['id']),
        name,
        title: text(payload['title']),
        kind: text(payload['kind']),
        input: payload['input'] ?? payload['arguments'] ?? payload['rawInput'] ?? args.raw['input'],
        content: payload['content'],
        locations: payload['locations'],
      },
      raw: args.raw,
    });
  }

  if (sessionUpdate === 'tool_call_update') {
    const name = getToolName(payload, args.raw, 'tool');
    const status = resolveStatus(payload, payload['rawOutput'] !== undefined ? 'completed' : 'delta');
    const hasResult = status === 'completed' || status === 'failed' || payload['rawOutput'] !== undefined;
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: hasResult ? 'tool_result' : 'tool_call',
      status,
      title: hasResult ? `工具结果 ${name}` : `调用工具 ${name}`,
      payload: {
        id: text(payload['id']) ?? text(payload['toolCallId']) ?? text(args.raw['id']),
        name,
        title: text(payload['title']),
        kind: text(payload['kind']),
        input: payload['input'] ?? payload['arguments'] ?? payload['rawInput'] ?? args.raw['input'],
        output: payload['output'] ?? payload['rawOutput'] ?? payload['content'] ?? args.raw['output'],
        content: payload['content'],
        locations: payload['locations'],
      },
      raw: args.raw,
    });
  }

  if (/tool_result|tool_call_completed|tool.*completed|function_call_output/i.test(type)) {
    const name = getToolName(payload, args.raw, 'tool_result');
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'tool_result',
      status: resolveStatus(payload, 'completed'),
      title: `工具结果 ${name}`,
      payload: {
        id: text(payload['id']) ?? text(payload['toolCallId']) ?? text(args.raw['id']),
        name,
        output: payload['output'] ?? payload['content'] ?? args.raw['output'],
      },
      raw: args.raw,
    });
  }

  if (/command_output|stdout|stderr/i.test(type)) {
    const stream = text(payload['stream']) ?? text(args.raw['stream']);
    const output = text(payload['delta']) ?? text(payload['text']) ?? text(payload['content']) ?? '';
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'command_output',
      status: resolveStatus(payload, 'delta'),
      title: '命令输出',
      payload: {
        command: text(payload['command']) ?? text(args.raw['command']),
        ...(stream === 'stderr' ? { stderr: output } : { stdout: output }),
      },
      raw: args.raw,
    });
  }

  if (sessionUpdate === 'plan') {
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'plan_update',
      status: 'completed',
      title: '计划更新',
      payload: {
        entries: Array.isArray(payload['entries']) ? payload['entries'] : [],
      },
      raw: args.raw,
    });
  }

  if (/patch|diff|edit|file|plan|next_steps/i.test(type)) {
    const event = normalizeKnownProviderEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      provider: args.provider,
      raw: toKnownProviderRaw(args.raw, payload, type),
    });

    return {
      ...event,
      raw: args.raw,
    };
  }

  return normalizeRawTimelineEvent({
    messageId: args.messageId,
    runId: args.runId,
    agentId: args.agentId,
    seq: args.seq,
    provider: args.provider,
    rawType: type,
    raw: args.raw,
  });
}

function getProtocolPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const params = record(raw['params']);
  const paramsUpdate = params ? record(params['update']) : null;
  if ((raw['method'] === 'session/update' || raw['type'] === 'session/update') && paramsUpdate) {
    return paramsUpdate;
  }
  return record(raw['update']) ?? record(raw['payload']) ?? raw;
}

function getProtocolType(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
  provider: string,
): string {
  return text(payload['sessionUpdate'])
    ?? text(raw['method'])
    ?? text(payload['type'])
    ?? text(raw['type'])
    ?? provider;
}

function toKnownProviderRaw(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
  type: string,
): Record<string, unknown> {
  if (payload === raw) return raw;
  return {
    type,
    ...payload,
  };
}

function getToolName(
  payload: Record<string, unknown>,
  raw: Record<string, unknown>,
  fallback: string,
): string {
  return text(payload['name'])
    ?? text(payload['toolName'])
    ?? text(payload['kind'])
    ?? text(payload['title'])
    ?? text(raw['name'])
    ?? fallback;
}

function resolveStatus(
  payload: Record<string, unknown>,
  fallback: AgentTimelineEventStatus,
): AgentTimelineEventStatus {
  const status = text(payload['status']);
  if (!status) return fallback;
  if (/fail|error/i.test(status)) return 'failed';
  if (/complete|success|done/i.test(status)) return 'completed';
  if (/pending|start|running|progress/i.test(status)) return 'started';
  return fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function getContentText(payload: Record<string, unknown>): string | null {
  const content = payload['content'];
  if (typeof content === 'string' && content.trim()) return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const contentRecord = content as Record<string, unknown>;
    if (contentRecord['type'] === 'text') return text(contentRecord['text']);
  }
  return null;
}
