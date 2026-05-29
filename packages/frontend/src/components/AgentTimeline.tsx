import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { api } from '../lib/api';
import type {
  AgentTimelineEvent,
  MessageTrace,
  MessageTraceCommand,
  MessageTraceThinking,
  MessageTraceToolCall,
} from '../lib/types';
import { buildAgentTimelineModel, type AgentTimelineDiagnostics } from './agent-timeline/model';

const planStatusLabels: Record<string, string> = {
  pending: '待处理',
  in_progress: '进行中',
  running: '进行中',
  completed: '已完成',
  blocked: '已阻塞',
  failed: '失败',
  skipped: '已跳过',
};

const fieldLabels: Record<string, string> = {
  id: 'ID',
  name: '名称',
  title: '标题',
  kind: '类型',
  input: '输入',
  output: '输出',
  content: '内容',
  text: '文本',
  command: '命令',
  stdout: '标准输出',
  stderr: '错误输出',
  path: '文件',
  patch: '差异',
  diff: '差异',
  additions: '新增行',
  deletions: '删除行',
  entries: '步骤',
  locations: '位置',
  provider: '提供方',
  backend: '后端',
  raw_type: '原始类型',
  reason: '原因',
  status: '状态',
  encrypted: '加密',
};

const diffLinePattern = /^([+-])(?![+-])/;

export function AgentTimeline({
  events,
  trace,
  roomId,
}: {
  events?: AgentTimelineEvent[];
  trace?: MessageTrace;
  roomId?: string;
}): JSX.Element | null {
  const mergedEvents = mergeTimelineEvents(events, traceToEvents(trace));
  const model = buildAgentTimelineModel(mergedEvents);
  if (model.visibleEvents.length === 0 && model.debugEvents.length === 0 && !model.diagnostics) return null;

  return (
    <section className="agent-timeline" aria-label={model.visibleEvents.length > 0 ? 'ACP 执行过程' : 'ACP 协议调试'}>
      {model.visibleEvents.length > 0 ? (
        <>
          <div className="agent-timeline-header">
            <div>
              <div className="agent-timeline-eyebrow">ACP</div>
              <div className="agent-timeline-title">执行过程</div>
            </div>
            <div className="agent-timeline-count">{model.visibleCount} 条事件</div>
          </div>
          {model.visibleEvents.map((event, index) => (
            <AgentTimelineItem key={event.id ?? `${event.type}-${index}`} event={event} roomId={roomId} />
          ))}
        </>
      ) : null}
      {model.debugEvents.length > 0 || model.diagnostics ? (
        <DebugEventsPanel events={model.debugEvents} diagnostics={model.diagnostics} />
      ) : null}
    </section>
  );
}

export function AgentTimelineItem({ event, roomId }: { event: AgentTimelineEvent; roomId?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [detailEvent, setDetailEvent] = useState<AgentTimelineEvent | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const eventLabel = getTranscriptAction(event);
  const statusLabel = planStatusLabels[String(event.payload.status ?? event.status)] ?? formatEventStatus(event.status);
  const summary = getEventSummary(event);
  const displayEvent = detailEvent ?? event;
  const shouldLoadDetail = shouldLoadEventDetail(event, roomId);

  const loadDetail = async (): Promise<void> => {
    if (!roomId || detailEvent || detailLoading) return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetailEvent(await api.getMessageTraceEvent(roomId, event.message_id, getEventDetailId(event)));
    } catch (err) {
      setDetailError((err as Error).message || '加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleToggle = (e: SyntheticEvent<HTMLDetailsElement>): void => {
    const nextOpen = e.currentTarget.open;
    setOpen(nextOpen);
    if (nextOpen && shouldLoadDetail) void loadDetail();
  };

  return (
    <details className={`agent-timeline-card is-${event.type}`} open={open} onToggle={handleToggle}>
      <summary className="agent-timeline-summary">
        <span className="agent-timeline-chevron" aria-hidden="true">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <span className="agent-timeline-kind">{eventLabel}</span>
        <strong title={summary}>{summary}</strong>
        <span className="agent-timeline-status">{event.type === 'plan_update' ? statusLabel : formatEventStatus(event.status)}</span>
      </summary>
      <div className="agent-timeline-body">
        {shouldLoadDetail && !detailEvent ? (
          <DeferredEventDetail
            loading={detailLoading}
            error={detailError}
            onRetry={() => void loadDetail()}
          />
        ) : renderEventBody(displayEvent)}
      </div>
    </details>
  );
}

function shouldLoadEventDetail(event: AgentTimelineEvent, roomId: string | undefined): boolean {
  if (!roomId || event.payload.detail_omitted !== true) return false;
  return event.type === 'tool_call'
    || event.type === 'tool_result'
    || event.type === 'command_output'
    || event.type === 'file_diff';
}

function getEventDetailId(event: AgentTimelineEvent): string {
  return readString(event.payload.detail_event_id) ?? event.id;
}

function DeferredEventDetail({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}): JSX.Element {
  if (error) {
    return (
      <div className="agent-timeline-detail-state">
        <span>详情加载失败：{error}</span>
        <button type="button" onClick={onRetry}>重试</button>
      </div>
    );
  }
  return (
    <div className="agent-timeline-detail-state">
      {loading ? '正在加载完整详情...' : '展开后加载完整详情'}
    </div>
  );
}

function DebugEventsPanel({
  events,
  diagnostics,
}: {
  events: AgentTimelineEvent[];
  diagnostics: AgentTimelineDiagnostics | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const hiddenCount = events.length + (diagnostics ? 1 : 0);
  return (
    <details className="agent-timeline-card is-debug" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="agent-timeline-summary">
        <span className="agent-timeline-chevron" aria-hidden="true">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <span className="agent-timeline-kind">Debug</span>
        <strong>协议调试</strong>
        <span className="agent-timeline-status">{hiddenCount} 条隐藏事件</span>
      </summary>
      <div className="agent-timeline-body">
        {diagnostics ? <ProtocolDiagnosticsView diagnostics={diagnostics} /> : null}
        {events.length > 0 ? (
          <pre className="agent-timeline-pre">{stringifyJson(events.map((event) => event.raw ?? event.payload))}</pre>
        ) : null}
      </div>
    </details>
  );
}

function ProtocolDiagnosticsView({ diagnostics }: { diagnostics: AgentTimelineDiagnostics }): JSX.Element {
  return (
    <div className="agent-timeline-protocol-diagnostics">
      <div className={`agent-timeline-diagnostic-badge is-${diagnostics.thoughtStreamStatus}`}>
        {diagnostics.thoughtStreamStatus === 'received' ? 'thinking 已收到' : diagnostics.thoughtStreamStatus === 'missing' ? 'thinking 未返回' : 'thinking 未判断'}
      </div>
      <p>{diagnostics.thoughtStreamMessage}</p>
      <dl className="agent-timeline-kv">
        {diagnostics.protocolEventCounts.map((entry) => (
          <div key={entry.type}>
            <dt>{entry.type}</dt>
            <dd>{entry.count} 次</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function renderEventBody(event: AgentTimelineEvent): ReactNode {
  if (event.type === 'thinking') {
    return <pre className="agent-timeline-pre">{stringifyPayload(event.payload.text ?? event.raw ?? event.payload)}</pre>;
  }

  if (event.type === 'assistant_message') {
    return <pre className="agent-timeline-pre">{stringifyPayload(event.payload.text ?? event.payload.content ?? event.payload)}</pre>;
  }

  if (event.type === 'tool_call' || event.type === 'tool_result') {
    return <EventKeyValue payload={event.payload} />;
  }

  if (event.type === 'command' || event.type === 'command_output') {
    return <EventKeyValue payload={event.payload} />;
  }

  if (event.type === 'file_diff') {
    return <FileDiffView payload={event.payload} />;
  }

  if (event.type === 'plan_update') {
    return <PlanUpdateView payload={event.payload} />;
  }

  if (event.type === 'raw') {
    return <EventKeyValue payload={{ ...event.payload, ...(event.raw ?? {}) }} />;
  }

  return <EventKeyValue payload={event.payload} />;
}

function EventKeyValue({ payload }: { payload: Record<string, unknown> }): JSX.Element {
  return (
    <dl className="agent-timeline-kv">
      {Object.entries(payload).map(([key, value]) => (
        <div key={key}>
          <dt>{formatFieldLabel(key)}</dt>
          <dd>{renderValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function FileDiffView({ payload }: { payload: Record<string, unknown> }): JSX.Element {
  const patch = readString(payload.patch) ?? readString(payload.diff) ?? '';
  const path = readString(payload.path);
  const additions = typeof payload.additions === 'number' ? payload.additions : null;
  const deletions = typeof payload.deletions === 'number' ? payload.deletions : null;
  const lines = patch.split('\n');
  return (
    <div className="agent-timeline-diff-wrap">
      <dl className="agent-timeline-kv agent-timeline-diff-meta">
        {path ? (
          <div>
            <dt>文件</dt>
            <dd>{path}</dd>
          </div>
        ) : null}
        {additions !== null ? (
          <div>
            <dt>新增行</dt>
            <dd>{String(additions)}</dd>
          </div>
        ) : null}
        {deletions !== null ? (
          <div>
            <dt>删除行</dt>
            <dd>{String(deletions)}</dd>
          </div>
        ) : null}
      </dl>
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
  const title = typeof record.content === 'string'
    ? record.content
    : typeof record.title === 'string'
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
  if (trace.events?.length) return trace.events;
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

function getTranscriptAction(event: AgentTimelineEvent): string {
  switch (event.type) {
    case 'thinking':
      return 'Thinking';
    case 'tool_call':
    case 'tool_result':
      return 'Explored';
    case 'command':
    case 'command_output':
      return 'Ran';
    case 'file_diff':
      return 'Edited';
    case 'plan_update':
      return 'Plan';
    case 'permission_request':
      return 'Permission';
    case 'web_search':
      return 'Searched';
    case 'error':
      return 'Error';
    case 'assistant_message':
      return 'Answer';
    case 'raw':
      return 'Raw';
    default:
      return getEventLabel(event.type);
  }
}

function getEventSummary(event: AgentTimelineEvent): string {
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    const name = readString(event.payload.name);
    const title = readString(event.payload.title);
    const locationSummary = summarizeLocations(event.payload.locations);
    const inputSummary = summarizeToolInput(event.payload.input);
    const pathSummary = readString(event.payload.path);
    return compactJoin([normalizeToolTitle(title ?? event.title, name), inputSummary, pathSummary, locationSummary], ' · ');
  }

  if (event.type === 'command' || event.type === 'command_output') {
    return readString(event.payload.command) ?? event.title;
  }

  if (event.type === 'file_diff') {
    const path = readString(event.payload.path);
    const additions = typeof event.payload.additions === 'number' ? `+${event.payload.additions}` : null;
    const deletions = typeof event.payload.deletions === 'number' ? `-${event.payload.deletions}` : null;
    return compactJoin([path ? `修改文件 ${path}` : event.title, compactJoin([additions, deletions], ' / ')], ' · ');
  }

  if (event.type === 'plan_update') {
    const entries = Array.isArray(event.payload.entries) ? event.payload.entries : [];
    return entries.length > 0 ? `计划更新 · ${entries.length} 项` : event.title;
  }

  return event.title;
}

function summarizeLocations(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const labels = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const path = readString(record.path) ?? readString(record.file) ?? readString(record.uri);
      if (!path) return null;
      const line = typeof record.line === 'number' ? record.line : typeof record.lineNumber === 'number' ? record.lineNumber : null;
      return line ? `${path}:${line}` : path;
    })
    .filter((entry): entry is string => entry !== null);
  if (labels.length === 0) return null;
  const suffix = labels.length > 2 ? ` +${labels.length - 2}` : '';
  return `${labels.slice(0, 2).join(', ')}${suffix}`;
}

function summarizeToolInput(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return summarizeToolInput(JSON.parse(trimmed) as unknown) ?? trimmed.slice(0, 120);
    } catch {
      return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return readString(record.path)
    ?? readString(record.file)
    ?? readString(record.pattern)
    ?? readString(record.command)
    ?? null;
}

function normalizeToolTitle(title: string, name: string | null): string {
  if (!name) return title;
  const normalized = title
    .replace(/^调用工具\s+/u, '')
    .replace(/^工具结果\s+/u, '')
    .trim();
  return normalized || name;
}

function compactJoin(values: Array<string | null>, separator: string): string {
  return values.filter((value): value is string => Boolean(value?.trim())).join(separator);
}

function getEventLabel(type: AgentTimelineEvent['type']): string {
  switch (type) {
    case 'thinking':
      return '思考';
    case 'assistant_message':
      return '回复';
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
      return '原始事件';
    default:
      return type;
  }
}

function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') return formatKnownValue(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return <pre className="agent-timeline-pre is-inline-json">{stringifyJson(value)}</pre>;
}

function formatFieldLabel(key: string): string {
  return fieldLabels[key] ?? key;
}

function formatKnownValue(value: string): string {
  return planStatusLabels[value] ?? value;
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
