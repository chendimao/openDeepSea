import type { SessionAgentEvent, SessionRun, SessionWorkspacePayload } from '../lib/types';
import type { WsServerEvent } from '../lib/ws';

export function applySessionWorkspaceEvent(
  payload: SessionWorkspacePayload,
  event: WsServerEvent,
): SessionWorkspacePayload {
  if (!isActiveSessionEvent(payload, event)) return payload;
  if (event.type === 'session:updated') {
    return {
      ...payload,
      activeSession: {
        ...payload.activeSession,
        session: event.session,
      },
      projectSwitcher: {
        ...payload.projectSwitcher,
        projects: payload.projectSwitcher.projects.map((project) => ({
          ...project,
          recentSessions: project.recentSessions.map((session) =>
            session.id === event.session.id ? { ...session, title: event.session.title, updated_at: event.session.updated_at } : session
          ),
        })),
      },
    };
  }
  if (event.type === 'session_message:new') {
    if (payload.activeSession.messages.some((message) => message.id === event.message.id)) {
      return {
        ...payload,
        activeSession: {
          ...payload.activeSession,
          messages: payload.activeSession.messages.map((message) =>
            message.id === event.message.id ? event.message : message
          ),
        },
      };
    }
    return {
      ...payload,
      activeSession: {
        ...payload.activeSession,
        messages: [...payload.activeSession.messages, event.message],
      },
    };
  }
  if (event.type === 'session_run:created') {
    if (payload.activeSession.runs.some((run) => run.id === event.run.id)) return payload;
    return {
      ...payload,
      activeSession: {
        ...payload.activeSession,
        runs: [...payload.activeSession.runs, event.run],
      },
    };
  }
  if (event.type === 'session_run:updated') {
    return {
      ...payload,
      activeSession: {
        ...payload.activeSession,
        runs: payload.activeSession.runs.map((run) => run.id === event.run.id ? event.run : run),
      },
    };
  }
  if (event.type === 'session_run:stream') {
    return {
      ...payload,
      activeSession: {
        ...payload.activeSession,
        runs: payload.activeSession.runs.map((run) => run.id === event.runId ? appendRunChunk(run, event) : run),
        agentEvents: appendStreamAgentEvent(payload.activeSession.agentEvents, event),
      },
    };
  }
  if (event.type === 'session_evidence:new') {
    if (payload.evidence.some((item) => item.id === event.event.id)) return payload;
    return {
      ...payload,
      evidence: [...payload.evidence, event.event],
      activeSession: {
        ...payload.activeSession,
        evidence: [...payload.activeSession.evidence, event.event],
      },
    };
  }
  if (event.type === 'session_inspector:snapshot') {
    return {
      ...payload,
      toolRows: event.toolRows,
      diffRows: event.diffRows,
      activeSession: {
        ...payload.activeSession,
        planItems: event.planItems,
      },
    };
  }
  return payload;
}

export function isActiveSessionEvent(payload: SessionWorkspacePayload, event: WsServerEvent): boolean {
  if (!('sessionId' in event)) return false;
  return event.sessionId === payload.activeSession.session.id;
}

function appendRunChunk(run: SessionRun, event: Extract<WsServerEvent, { type: 'session_run:stream' }>): SessionRun {
  if (event.done || !event.chunk) return run;
  if (event.channel === 'answer') {
    return { ...run, stdout: `${run.stdout}${event.chunk}`, updated_at: Date.now() };
  }
  if (
    event.channel === 'activity' ||
    event.channel === 'thinking' ||
    event.channel === 'tool' ||
    event.channel === 'command' ||
    event.channel === 'event'
  ) {
    return { ...run, activity_log: `${run.activity_log}${event.chunk}`, updated_at: Date.now() };
  }
  return run;
}

function appendStreamAgentEvent(
  events: SessionAgentEvent[],
  event: Extract<WsServerEvent, { type: 'session_run:stream' }>,
): SessionAgentEvent[] {
  if (event.agentEvent) {
    const agentEvent = event.agentEvent;
    if (events.some((item) => item.id === agentEvent.id)) return events;
    return [...events, agentEvent];
  }
  if (event.done || !event.chunk) return events;
  const id = `stream:${event.runId}:${event.seq}`;
  if (events.some((item) => item.id === id)) return events;
  return [...events, {
    id,
    session_id: event.sessionId,
    agent_id: event.agentId,
    run_id: event.runId,
    seq: event.seq,
    channel: event.channel,
    event_type: event.channel,
    content: event.chunk,
    payload_json: null,
    created_at: Date.now(),
  }];
}
