import type {
  AgentTimelineEvent,
  AgentTimelineEventStatus,
  AgentTimelineEventType,
} from '../types.js';
import type { AcpStreamTrace } from './types.js';

export function createTimelineEvent(args: {
  messageId: string;
  runId: string;
  agentId: string;
  seq: number;
  type: AgentTimelineEventType;
  status: AgentTimelineEventStatus;
  title: string;
  payload?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}): AgentTimelineEvent {
  return {
    id: `${args.runId}:${args.seq}`,
    message_id: args.messageId,
    run_id: args.runId,
    agent_id: args.agentId,
    seq: args.seq,
    type: args.type,
    status: args.status,
    title: args.title,
    payload: args.payload ?? {},
    ...(args.raw ? { raw: args.raw } : {}),
    created_at: Date.now(),
  };
}

export function normalizeTimelineEventFromTrace(args: {
  messageId: string;
  runId: string;
  agentId: string;
  seq: number;
  channel: 'thinking' | 'tool' | 'command';
  text: string;
  trace?: AcpStreamTrace;
}): AgentTimelineEvent {
  if (args.trace?.kind === 'thinking') {
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'thinking',
      status: 'delta',
      title: '思考过程',
      payload: { text: args.trace.text, encrypted: args.trace.encrypted === true },
    });
  }

  if (args.trace?.kind === 'tool') {
    const isResult = Boolean(args.trace.output) || args.trace.name === 'tool_result';
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: isResult ? 'tool_result' : 'tool_call',
      status: 'completed',
      title: isResult ? `工具结果 ${args.trace.name}` : `调用工具 ${args.trace.name}`,
      payload: {
        name: args.trace.name,
        input: args.trace.input,
        output: args.trace.output,
      },
    });
  }

  if (args.trace?.kind === 'command') {
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'command',
      status: 'completed',
      title: `执行命令 ${args.trace.command}`,
      payload: {
        command: args.trace.command,
        output: args.trace.output,
      },
    });
  }

  return createTimelineEvent({
    messageId: args.messageId,
    runId: args.runId,
    agentId: args.agentId,
    seq: args.seq,
    type: args.channel === 'thinking' ? 'thinking' : args.channel === 'tool' ? 'tool_call' : 'command',
    status: args.channel === 'thinking' ? 'delta' : 'completed',
    title: args.channel === 'thinking' ? '思考过程' : args.channel === 'tool' ? '工具调用' : '命令执行',
    payload: { text: args.text },
  });
}

export function normalizeRawTimelineEvent(args: {
  messageId: string;
  runId: string;
  agentId: string;
  seq: number;
  provider: string;
  rawType?: string;
  raw: Record<string, unknown>;
}): AgentTimelineEvent {
  return createTimelineEvent({
    messageId: args.messageId,
    runId: args.runId,
    agentId: args.agentId,
    seq: args.seq,
    type: 'raw',
    status: 'completed',
    title: `原始事件 ${args.rawType ?? args.provider}`,
    payload: {
      provider: args.provider,
      raw_type: args.rawType,
    },
    raw: args.raw,
  });
}

export function normalizeKnownProviderEvent(args: {
  messageId: string;
  runId: string;
  agentId: string;
  seq: number;
  provider: string;
  raw: Record<string, unknown>;
}): AgentTimelineEvent {
  const rawType = typeof args.raw['type'] === 'string' ? args.raw['type'] : undefined;
  const payload = getProviderPayload(args.raw);

  const diffPayload = extractDiffPayload(args.raw, payload);
  if (diffPayload) {
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'file_diff',
      status: 'completed',
      title: `修改文件 ${diffPayload.path}`,
      payload: diffPayload,
      raw: args.raw,
    });
  }

  const planEntries = extractPlanEntries(args.raw, payload);
  if (planEntries) {
    return createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'plan_update',
      status: 'completed',
      title: '计划更新',
      payload: { entries: planEntries },
      raw: args.raw,
    });
  }

  return normalizeRawTimelineEvent({
    messageId: args.messageId,
    runId: args.runId,
    agentId: args.agentId,
    seq: args.seq,
    provider: args.provider,
    rawType,
    raw: args.raw,
  });
}

function getProviderPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const payload = raw['payload'];
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : raw;
}

function extractDiffPayload(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): { path: string; patch: string; additions: number; deletions: number } | null {
  const rawType = typeof raw['type'] === 'string' ? raw['type'] : '';
  const path = firstString(payload['path'], payload['file'], payload['file_path'], payload['filePath']);
  const patch = firstString(payload['patch'], payload['diff'], payload['unified_diff'], payload['unifiedDiff']);
  if (!path || !patch) return null;
  if (!/patch|diff|edit|apply_patch|file/i.test(rawType)) return null;
  return {
    path,
    patch,
    additions: firstNumber(payload['additions']) ?? countPatchLines(patch, '+'),
    deletions: firstNumber(payload['deletions']) ?? countPatchLines(patch, '-'),
  };
}

function extractPlanEntries(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): unknown[] | null {
  const rawType = typeof raw['type'] === 'string' ? raw['type'] : '';
  if (!/plan|next_steps/i.test(rawType)) return null;
  if (Array.isArray(payload['entries'])) return payload['entries'];
  if (Array.isArray(payload['plan'])) return payload['plan'];
  if (Array.isArray(payload['next_steps'])) return payload['next_steps'];
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function countPatchLines(patch: string, prefix: '+' | '-'): number {
  return patch
    .split('\n')
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length;
}
