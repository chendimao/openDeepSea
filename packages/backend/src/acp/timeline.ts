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
