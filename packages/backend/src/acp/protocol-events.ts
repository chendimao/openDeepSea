import type { AgentTimelineEvent, AgentTimelineEventStatus } from '../types.js';
import {
  createTimelineEvent,
  normalizeKnownProviderEvent,
  normalizeRawTimelineEvent,
} from './timeline.js';
import { compactTimelineEvent } from '../trace-compaction.js';

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
  const diffContent = extractDiffContent(payload);

  if (diffContent) {
    const oldText = text(diffContent['oldText']) ?? '';
    const newText = text(diffContent['newText']) ?? '';
    const patch = createUnifiedDiffPatch(diffContent.path, oldText, newText);
    return compactTimelineEvent(createTimelineEvent({
      messageId: args.messageId,
      runId: args.runId,
      agentId: args.agentId,
      seq: args.seq,
      type: 'file_diff',
      status: 'completed',
      title: `修改文件 ${diffContent.path}`,
      payload: {
        path: diffContent.path,
        patch,
        oldText,
        newText,
        additions: countTextLines(newText),
        deletions: countTextLines(oldText),
        tool_call_id: text(payload['toolCallId']) ?? text(payload['id']),
        title: text(payload['title']),
      },
      raw: args.raw,
    }));
  }

  if (sessionUpdate === 'agent_message_chunk') {
    const messageText = getContentText(payload);
    return compactTimelineEvent(createTimelineEvent({
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
    }));
  }

  if (sessionUpdate === 'agent_thought_chunk' || kind === 'thinking' || /thinking|reasoning/i.test(type)) {
    return compactTimelineEvent(createTimelineEvent({
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
    }));
  }

  if (sessionUpdate === 'tool_call' || /tool_call_started|tool.*started|tool_use|^tool_call$/i.test(type)) {
    const name = getToolName(payload, args.raw, 'tool');
    if (isSubagentToolName(name)) {
      return buildSubagentTimelineEvent({
        messageId: args.messageId,
        runId: args.runId,
        agentId: args.agentId,
        seq: args.seq,
        type: 'subagent_started',
        status: 'started',
        title: '子代理启动',
        payload,
        raw: args.raw,
        name,
        source: payload['input'] ?? payload['arguments'] ?? payload['rawInput'] ?? args.raw['input'],
      });
    }
    return compactTimelineEvent(createTimelineEvent({
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
    }));
  }

  if (sessionUpdate === 'tool_call_update') {
    const name = getToolName(payload, args.raw, 'tool');
    const status = resolveStatus(payload, payload['rawOutput'] !== undefined ? 'completed' : 'delta');
    const hasResult = status === 'completed' || status === 'failed' || payload['rawOutput'] !== undefined;
    if (isSubagentToolName(name)) {
      const output = payload['output'] ?? payload['rawOutput'] ?? payload['content'] ?? args.raw['output'];
      return buildSubagentTimelineEvent({
        messageId: args.messageId,
        runId: args.runId,
        agentId: args.agentId,
        seq: args.seq,
        type: status === 'failed' ? 'subagent_failed' : hasResult ? 'subagent_completed' : 'subagent_progress',
        status: hasResult ? status : 'started',
        title: status === 'failed' ? '子代理失败' : hasResult ? '子代理完成' : '子代理进度',
        payload,
        raw: args.raw,
        name,
        source: output,
      });
    }
    return compactTimelineEvent(createTimelineEvent({
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
    }));
  }

  if (/tool_result|tool_call_completed|tool.*completed|function_call_output/i.test(type)) {
    const name = getToolName(payload, args.raw, 'tool_result');
    if (isSubagentToolName(name)) {
      const output = payload['output'] ?? payload['rawOutput'] ?? payload['content'] ?? args.raw['output'];
      const status = resolveStatus(payload, 'completed');
      return buildSubagentTimelineEvent({
        messageId: args.messageId,
        runId: args.runId,
        agentId: args.agentId,
        seq: args.seq,
        type: status === 'failed' ? 'subagent_failed' : 'subagent_completed',
        status,
        title: status === 'failed' ? '子代理失败' : '子代理完成',
        payload,
        raw: args.raw,
        name,
        source: output,
      });
    }
    return compactTimelineEvent(createTimelineEvent({
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
    }));
  }

  if (/command_output|stdout|stderr/i.test(type)) {
    const stream = text(payload['stream']) ?? text(args.raw['stream']);
    const output = text(payload['delta']) ?? text(payload['text']) ?? text(payload['content']) ?? '';
    return compactTimelineEvent(createTimelineEvent({
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
    }));
  }

  if (sessionUpdate === 'plan') {
    return compactTimelineEvent(createTimelineEvent({
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
    }));
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

    return compactTimelineEvent({
      ...event,
      raw: args.raw,
    });
  }

  return compactTimelineEvent(normalizeRawTimelineEvent({
    messageId: args.messageId,
    runId: args.runId,
    agentId: args.agentId,
    seq: args.seq,
    provider: args.provider,
    rawType: type,
    raw: args.raw,
  }));
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
    ?? text(payload['title'])
    ?? text(payload['kind'])
    ?? text(raw['name'])
    ?? fallback;
}

function isSubagentToolName(name: string): boolean {
  return /^(spawn_agent|dispatch_agent|wait_agent|subagent_result|agent_result|Task)$/i.test(name)
    || /subagent/i.test(name);
}

function buildSubagentTimelineEvent(input: {
  messageId: string;
  runId: string;
  agentId: string;
  seq: number;
  type: Extract<AgentTimelineEvent['type'], 'subagent_started' | 'subagent_progress' | 'subagent_completed' | 'subagent_failed'>;
  status: AgentTimelineEventStatus;
  title: string;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
  name: string;
  source: unknown;
}): AgentTimelineEvent {
  return compactTimelineEvent(createTimelineEvent({
    messageId: input.messageId,
    runId: input.runId,
    agentId: input.agentId,
    seq: input.seq,
    type: input.type,
    status: input.status,
    title: input.title,
    payload: buildSubagentPayload({
      payload: input.payload,
      raw: input.raw,
      name: input.name,
      parentRunId: input.runId,
      source: input.source,
    }),
    raw: input.raw,
  }));
}

function buildSubagentPayload(input: {
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
  name: string;
  parentRunId: string;
  source: unknown;
}): Record<string, unknown> {
  const source = record(input.source) ?? {};
  const toolCallId = text(input.payload['toolCallId'])
    ?? text(input.payload['id'])
    ?? text(input.raw['id']);
  const childAgentId = text(source['agent_id'])
    ?? text(source['child_agent_id'])
    ?? text(source['agentId'])
    ?? text(source['target_agent'])
    ?? text(input.payload['agent_id'])
    ?? input.name;
  return {
    tool_call_id: toolCallId,
    parent_run_id: input.parentRunId,
    child_agent_id: childAgentId,
    model: text(source['model']) ?? text(input.payload['model']),
    reasoning_effort: text(source['reasoning_effort']) ?? text(source['reasoningEffort']) ?? text(input.payload['reasoning_effort']),
    summary: text(source['target'])
      ?? text(source['summary'])
      ?? text(source['description'])
      ?? text(input.payload['title'])
      ?? input.name,
    result: text(source['result']) ?? text(source['output']) ?? text(input.payload['result']),
    status: text(source['status']) ?? text(input.payload['status']),
    raw_input: input.source,
  };
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

function extractDiffContent(payload: Record<string, unknown>): { path: string; oldText?: string; newText: string } | null {
  const content = payload['content'];
  const entries = Array.isArray(content) ? content : content ? [content] : [];
  for (const entry of entries) {
    const item = record(entry);
    if (!item || item['type'] !== 'diff') continue;
    const path = text(item['path']);
    const newText = text(item['newText']);
    if (!path || newText === null) continue;
    return {
      path,
      oldText: text(item['oldText']) ?? undefined,
      newText,
    };
  }
  return null;
}

function createUnifiedDiffPatch(path: string, oldText: string, newText: string): string {
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@',
    ...oldText.split('\n').filter((line) => line.length > 0).map((line) => `-${line}`),
    ...newText.split('\n').filter((line) => line.length > 0).map((line) => `+${line}`),
  ].join('\n');
}

function countTextLines(value: string): number {
  if (!value) return 0;
  return value.split('\n').filter((line) => line.length > 0).length;
}
