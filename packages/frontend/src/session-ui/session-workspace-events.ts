import type { SessionRun, SessionWorkspacePayload } from '../lib/types';
import type { WsServerEvent } from '../lib/ws';

export function applySessionWorkspaceEvent(
  payload: SessionWorkspacePayload,
  event: WsServerEvent,
): SessionWorkspacePayload {
  if (!isActiveSessionEvent(payload, event)) return payload;
  if (event.type === 'session_message:new') {
    if (payload.activeSession.messages.some((message) => message.id === event.message.id)) return payload;
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
    event.channel === 'thinking' ||
    event.channel === 'tool' ||
    event.channel === 'command' ||
    event.channel === 'event'
  ) {
    return { ...run, activity_log: `${run.activity_log}${event.chunk}`, updated_at: Date.now() };
  }
  return run;
}
