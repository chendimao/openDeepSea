import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type {
  AgentTimelineEvent,
  MessageTrace,
  MessageTraceCommand,
  MessageTraceThinking,
  MessageTraceToolCall,
} from '../lib/types';

const planStatusLabels: Record<string, string> = {
  pending: '待处理',
  running: '进行中',
  completed: '已完成',
  blocked: '已阻塞',
  failed: '失败',
  skipped: '已跳过',
};

const diffLinePattern = /^([+-])(?![+-])/;

export function AgentTimeline({
  events,
  trace,
}: {
  events?: AgentTimelineEvent[];
  trace?: MessageTrace;
}): JSX.Element | null {
  const mergedEvents = mergeTimelineEvents(events, traceToEvents(trace));
  if (mergedEvents.length === 0) return null;

  return (
    <section className="agent-timeline" aria-label="ACP 执行过程">
      <div className="agent-timeline-header">
        <div>
          <div className="agent-timeline-eyebrow">ACP</div>
          <div className="agent-timeline-title">执行过程</div>
        </div>
        <div className="agent-timeline-count">{mergedEvents.length} 条事件</div>
      </div>
      {mergedEvents.map((event, index) => (
        <TimelineItem key={event.id ?? `${event.type}-${index}`} event={event} />
      ))}
    </section>
  );
}

function TimelineItem({ event }: { event: AgentTimelineEvent }): JSX.Element {
  const [open, setOpen] = useState(event.type !== 'thinking' && event.type !== 'raw');
  const eventLabel = getEventLabel(event.type);
  const statusLabel = planStatusLabels[String(event.payload.status ?? event.status)] ?? formatEventStatus(event.status);

  return (
    <details className={`agent-timeline-card is-${event.type}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="agent-timeline-summary">
        <span className="agent-timeline-chevron" aria-hidden="true">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <span className="agent-timeline-kind">{eventLabel}</span>
        <strong>{event.title}</strong>
        <span className="agent-timeline-status">{event.type === 'plan_update' ? statusLabel : formatEventStatus(event.status)}</span>
      </summary>
      <div className="agent-timeline-body">
        {renderEventBody(event)}
      </div>
    </details>
  );
}

function renderEventBody(event: AgentTimelineEvent): ReactNode {
  if (event.type === 'thinking') {
    return <pre className="agent-timeline-pre">{stringifyPayload(event.payload.text ?? event.raw ?? event.payload)}</pre>;
  }

  if (event.type === 'tool_call' || event.type === 'tool_result') {
    return <EventKeyValue payload={event.payload} />;
  }

  if (event.type === 'command' || event.type === 'command_output') {
    return <EventKeyValue payload={event.payload} />;
  }

  if (event.type === 'file_diff') {
    return <FileDiffView patch={readString(event.payload.patch) ?? readString(event.payload.diff) ?? ''} />;
  }

  if (event.type === 'plan_update') {
    return <PlanUpdateView payload={event.payload} />;
  }

  if (event.type === 'raw') {
    return <pre className="agent-timeline-pre">{stringifyJson(event.raw ?? event.payload)}</pre>;
  }

  return <EventKeyValue payload={event.payload} />;
}

function EventKeyValue({ payload }: { payload: Record<string, unknown> }): JSX.Element {
  return (
    <dl className="agent-timeline-kv">
      {Object.entries(payload).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{renderValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function FileDiffView({ patch }: { patch: string }): JSX.Element {
  const lines = patch.split('\n');
  return (
    <div className="agent-timeline-diff">
      {lines.map((line, index) => {
        const className = diffLinePattern.test(line) ? (line.startsWith('+') ? 'diff-line is-added' : 'diff-line is-removed') : 'diff-line';
        return (
          <div key={index} className={className}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

function PlanUpdateView({ payload }: { payload: Record<string, unknown> }): JSX.Element {
  const entries = Array.isArray(payload.entries) ? payload.entries : Array.isArray(payload.plan) ? payload.plan : [];
  return (
    <div className="agent-timeline-plan">
      {entries.length > 0 ? entries.map((entry, index) => (
        <div key={index} className="agent-timeline-plan-item">
          <strong>{formatPlanEntry(entry)}</strong>
        </div>
      )) : <pre className="agent-timeline-pre">{stringifyJson(payload)}</pre>}
    </div>
  );
}

function formatPlanEntry(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  const status = typeof record.status === 'string' ? planStatusLabels[record.status] ?? record.status : null;
  const title = typeof record.title === 'string'
    ? record.title
    : typeof record.goal === 'string'
      ? record.goal
      : typeof record.agent_id === 'string'
        ? record.agent_id
        : '未命名步骤';
  return status ? `${title} · ${status}` : title;
}

function mergeTimelineEvents(
  primary?: AgentTimelineEvent[],
  secondary?: AgentTimelineEvent[],
): AgentTimelineEvent[] {
  const byId = new Map<string, AgentTimelineEvent>();
  for (const event of [...(primary ?? []), ...(secondary ?? [])]) {
    if (!event?.id) continue;
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.created_at - b.created_at);
}

function traceToEvents(trace?: MessageTrace): AgentTimelineEvent[] {
  if (!trace) return [];
  const legacyEvents = [
    ...(trace.thinking ?? []).map((entry, index) => buildLegacyEvent('thinking', index, toThinking(entry))),
    ...(trace.tool_calls ?? []).map((entry, index) => buildLegacyEvent('tool_call', index, toToolCall(entry))),
    ...(trace.commands ?? []).map((entry, index) => buildLegacyEvent('command', index, toCommand(entry))),
  ];
  return mergeTimelineEvents(trace.events, legacyEvents);
}

function buildLegacyEvent(
  type: AgentTimelineEvent['type'],
  index: number,
  payload: Record<string, unknown>,
): AgentTimelineEvent {
  return {
    id: `legacy:${type}:${index}`,
    message_id: 'legacy',
    run_id: 'legacy',
    agent_id: 'legacy',
    seq: index,
    type,
    status: type === 'thinking' ? 'delta' : 'completed',
    title: getLegacyTitle(type, payload),
    payload,
    created_at: index,
  };
}

function getLegacyTitle(type: AgentTimelineEvent['type'], payload: Record<string, unknown>): string {
  if (type === 'thinking') return '思考过程';
  if (type === 'tool_call') return `调用工具 ${readString(payload.name) ?? 'unknown'}`;
  if (type === 'command') return `执行命令 ${readString(payload.command) ?? 'unknown'}`;
  return '原始事件';
}

function toThinking(entry: MessageTraceThinking): Record<string, unknown> {
  return { text: entry.text };
}

function toToolCall(entry: MessageTraceToolCall): Record<string, unknown> {
  return {
    name: entry.name,
    input: entry.input,
    ...(entry.output !== undefined ? { output: entry.output } : {}),
  };
}

function toCommand(entry: MessageTraceCommand): Record<string, unknown> {
  return {
    command: entry.command,
    ...(entry.output !== undefined ? { output: entry.output } : {}),
  };
}

function formatEventStatus(status: AgentTimelineEvent['status']): string {
  if (status === 'started') return '开始';
  if (status === 'delta') return '增量';
  if (status === 'completed') return '完成';
  return '失败';
}

function getEventLabel(type: AgentTimelineEvent['type']): string {
  switch (type) {
    case 'thinking':
      return '思考';
    case 'tool_call':
      return '工具';
    case 'tool_result':
      return '工具结果';
    case 'command':
      return '命令';
    case 'command_output':
      return '命令输出';
    case 'file_diff':
      return '文件差异';
    case 'plan_update':
      return '计划';
    case 'raw':
      return '原始 JSON';
    default:
      return type;
  }
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stringifyJson(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringifyPayload(value: unknown): string {
  return typeof value === 'string' ? value : stringifyJson(value);
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
