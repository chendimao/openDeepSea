import { structuredAgentEventSchema, type StructuredAgentEvent } from './state.js';

export type { StructuredAgentEvent } from './state.js';

export function parseStructuredAgentEvent(value: unknown): StructuredAgentEvent {
  return structuredAgentEventSchema.parse(value);
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
