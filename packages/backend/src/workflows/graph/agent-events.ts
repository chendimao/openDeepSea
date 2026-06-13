import { structuredAgentEventSchema, type StructuredAgentEvent } from './state.js';

export type { StructuredAgentEvent } from './state.js';

export function parseStructuredAgentEvent(value: unknown): StructuredAgentEvent {
  return structuredAgentEventSchema.parse(parseStructuredAgentEventInput(value));
}

export function extractStructuredAgentEvents(output: string): StructuredAgentEvent[] {
  const text = output.trim();
  if (!text) return [];

  const events: StructuredAgentEvent[] = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) addCandidate(item);
      return;
    }
    const parsed = structuredAgentEventSchema.safeParse(candidate);
    if (!parsed.success) return;
    const key = JSON.stringify(parsed.data);
    if (seen.has(key)) return;
    seen.add(key);
    events.push(parsed.data);
  };
  const tryAddJson = (candidateText: string) => {
    try {
      addCandidate(JSON.parse(candidateText));
    } catch {
      // Agent output can be plain text with embedded JSON; invalid fragments are ignored.
    }
  };

  tryAddJson(text);

  const fencedJsonPattern = /```(?:json|jsonc)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fencedJsonPattern)) {
    if (match[1]) tryAddJson(match[1].trim());
  }

  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate.startsWith('{') || candidate.startsWith('[')) {
      tryAddJson(candidate);
    }
  }

  return events;
}

export function isWorkflowChangeRequestEvent(event: StructuredAgentEvent): boolean {
  return event.type === 'scope_change_request' ||
    event.type === 'plan_change_request' ||
    event.type === 'decision_request';
}

export function toTaskEventMetadata(event: StructuredAgentEvent): Record<string, unknown> {
  return {
    timeline_type: `agent_${event.type}`,
    timeline_status: event.type === 'failed' || event.type === 'blocked'
      ? 'failed'
      : event.type === 'completed'
        ? 'completed'
        : 'running',
    agent_event: event,
    workflow_run_id: event.workflowRunId,
    workflow_step_id: event.stepId,
    agent_run_id: event.agentRunId,
  };
}

function parseStructuredAgentEventInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}
