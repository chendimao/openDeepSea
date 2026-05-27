import type { AgentTimelineEvent, MessageTrace } from '../../lib/types';

export type AgentMessagePhaseKind = 'investigation' | 'changes' | 'verification' | 'summary';

export interface AgentMessagePhase {
  kind: AgentMessagePhaseKind;
  title: string;
  body: string;
  events: AgentTimelineEvent[];
}

const phaseTitles: Record<AgentMessagePhaseKind, string> = {
  investigation: '调查阶段',
  changes: '修改阶段',
  verification: '验证阶段',
  summary: '总结阶段',
};

const phaseOrder: AgentMessagePhaseKind[] = ['investigation', 'changes', 'verification', 'summary'];

export function buildAgentMessagePhases(content: string, trace?: MessageTrace): AgentMessagePhase[] {
  const events = traceToEvents(trace);
  if (!content.trim() && events.length === 0) return [];

  const bodyByPhase = splitContentIntoPhases(content);
  const eventsByPhase = groupEventsByPhase(events);

  return phaseOrder
    .map((kind) => ({
      kind,
      title: phaseTitles[kind],
      body: bodyByPhase.get(kind)?.trim() ?? '',
      events: eventsByPhase.get(kind) ?? [],
    }))
    .filter((phase) => phase.body || phase.events.length > 0);
}

export function hasTraceEvents(trace?: MessageTrace): boolean {
  return traceToEvents(trace).length > 0;
}

function splitContentIntoPhases(content: string): Map<AgentMessagePhaseKind, string> {
  const sections = splitMarkdownSections(content);
  const bodyByPhase = new Map<AgentMessagePhaseKind, string>();
  let matched = false;

  for (const section of sections) {
    const phase = classifyContentHeading(section.heading);
    if (!phase) continue;
    matched = true;
    appendPhaseBody(bodyByPhase, phase, section.body || section.heading);
  }

  if (!matched && content.trim()) {
    bodyByPhase.set('summary', content.trim());
  }

  return bodyByPhase;
}

function splitMarkdownSections(content: string): Array<{ heading: string; body: string }> {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ heading: string; bodyLines: string[] }> = [];
  let current: { heading: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const heading = readPhaseHeading(line);
    if (heading) {
      if (current) sections.push(current);
      current = { heading, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }

  if (current) sections.push(current);
  return sections.map((section) => ({
    heading: section.heading,
    body: section.bodyLines.join('\n').trim(),
  }));
}

function readPhaseHeading(line: string): string | null {
  const trimmed = line.trim();
  const markdownHeading = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (markdownHeading?.[1]) return markdownHeading[1].trim();

  const boldHeading = trimmed.match(/^\*\*(.+?)\*\*[:：]?\s*$/);
  if (boldHeading?.[1]) return boldHeading[1].trim();

  const plainHeading = trimmed.match(/^([^\s:：]{2,10}(?:阶段|结论|总结|验证|测试|修改|实现|调查|分析))[:：]?\s*$/);
  return plainHeading?.[1]?.trim() ?? null;
}

function classifyContentHeading(heading: string): AgentMessagePhaseKind | null {
  if (/(调查|分析|排查|阅读|探索|定位)/.test(heading)) return 'investigation';
  if (/(修改|实现|调整|改动|修复|编辑)/.test(heading)) return 'changes';
  if (/(验证|测试|构建|检查|运行)/.test(heading)) return 'verification';
  if (/(总结|结论|结果|说明)/.test(heading)) return 'summary';
  return null;
}

function appendPhaseBody(map: Map<AgentMessagePhaseKind, string>, phase: AgentMessagePhaseKind, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  const previous = map.get(phase);
  map.set(phase, previous ? `${previous}\n\n${trimmed}` : trimmed);
}

function groupEventsByPhase(events: AgentTimelineEvent[]): Map<AgentMessagePhaseKind, AgentTimelineEvent[]> {
  const map = new Map<AgentMessagePhaseKind, AgentTimelineEvent[]>();
  for (const event of events) {
    const phase = classifyEventPhase(event);
    const list = map.get(phase) ?? [];
    list.push(event);
    map.set(phase, list);
  }
  return map;
}

function classifyEventPhase(event: AgentTimelineEvent): AgentMessagePhaseKind {
  if (event.type === 'file_diff') return 'changes';

  if (event.type === 'command' || event.type === 'command_output') {
    const command = readString(event.payload.command) ?? event.title;
    return isVerificationCommand(command) ? 'verification' : 'changes';
  }

  if (event.type === 'tool_call' || event.type === 'tool_result') {
    const name = readString(event.payload.name) ?? event.title;
    const title = readString(event.payload.title) ?? event.title;
    const text = `${name} ${title}`.toLowerCase();
    if (/(write|edit|patch|apply|move|delete|create|修改|写入|编辑)/i.test(text)) return 'changes';
    if (/(test|build|lint|typecheck|verify|检查|测试|构建|验证)/i.test(text)) return 'verification';
    return 'investigation';
  }

  if (event.type === 'plan_update' || event.type === 'permission_request') return 'changes';
  if (event.type === 'error') return 'verification';
  return 'investigation';
}

function isVerificationCommand(command: string): boolean {
  return /\b(test|build|lint|typecheck|tsc|vitest|jest|playwright|pytest|cargo test|go test|npm run build|npm run test)\b/i.test(command);
}

function traceToEvents(trace?: MessageTrace): AgentTimelineEvent[] {
  if (!trace) return [];
  if (trace.events?.length) return trace.events;
  return [
    ...(trace.thinking ?? []).map((entry, index) => buildLegacyEvent('thinking', index, { text: entry.text })),
    ...(trace.tool_calls ?? []).map((entry, index) => buildLegacyEvent('tool_call', index + 100, {
      name: entry.name,
      input: entry.input,
      ...(entry.output !== undefined ? { output: entry.output } : {}),
    })),
    ...(trace.commands ?? []).map((entry, index) => buildLegacyEvent('command', index + 200, {
      command: entry.command,
      ...(entry.output !== undefined ? { output: entry.output } : {}),
    })),
  ];
}

function buildLegacyEvent(
  type: AgentTimelineEvent['type'],
  index: number,
  payload: Record<string, unknown>,
): AgentTimelineEvent {
  return {
    id: `phase-legacy:${type}:${index}`,
    message_id: 'legacy',
    run_id: 'legacy',
    agent_id: 'legacy',
    seq: index,
    type,
    status: type === 'thinking' ? 'delta' : 'completed',
    title: type === 'thinking' ? '思考过程' : type === 'command' ? `执行命令 ${readString(payload.command) ?? 'unknown'}` : `调用工具 ${readString(payload.name) ?? 'unknown'}`,
    payload,
    created_at: index,
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
