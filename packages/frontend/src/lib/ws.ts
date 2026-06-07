import type {
  HistoryRecord,
  HistoryRecordStatus,
  Session,
  SessionAgentEvent,
  SessionEvidenceEvent,
  SessionMessage,
  SessionMode,
  SessionRun,
  SessionWorkspacePayload,
  Task,
} from './types';

export type WsServerEvent =
  | { type: 'session_workspace:snapshot'; projectId: string; sessionId: string; payload: SessionWorkspacePayload }
  | { type: 'session_error'; sessionId: string; error: string }
  | { type: 'session_status:snapshot'; sessionId: string; status: import('./types').StatusSnapshot }
  | { type: 'session_context:snapshot'; sessionId: string; context: import('./types').SessionContextManifest | null }
  | { type: 'session_compact:preview'; sessionId: string; compaction: import('./types').SessionCompaction }
  | { type: 'history_records:snapshot'; projectId: string; records: HistoryRecord[] }
  | { type: 'session:updated'; sessionId: string; session: Session }
  | { type: 'session_message:new'; sessionId: string; message: SessionMessage }
  | { type: 'session_run:created'; sessionId: string; run: SessionRun }
  | { type: 'session_run:updated'; sessionId: string; run: SessionRun }
  | {
      type: 'session_run:stream';
      sessionId: string;
      agentId: string;
      runId: string;
      seq: number;
      chunk: string;
      channel: 'answer' | 'thinking' | 'tool' | 'command' | 'event';
      done: boolean;
      agentEvent?: SessionAgentEvent;
    }
  | { type: 'session_evidence:new'; sessionId: string; event: SessionEvidenceEvent }
  | { type: 'history_record:new'; projectId: string; record: HistoryRecord }
  | { type: 'task:created'; task: Task }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:deleted'; taskId: string };

export type WsClientEvent =
  | { type: 'session:subscribe'; sessionId: string }
  | { type: 'session:unsubscribe'; sessionId: string }
  | { type: 'session.workspace.request'; projectId: string; sessionId?: string }
  | { type: 'session.message.send'; sessionId: string; content: string; agentId?: string; mode?: SessionMode }
  | { type: 'agent.run.pause'; sessionId: string; agentId: string; runId: string }
  | { type: 'agent.run.resume'; sessionId: string; agentId: string; runId: string; content?: string }
  | { type: 'agent.run.cancel'; sessionId: string; agentId: string; runId: string }
  | { type: 'agent.run.retry'; sessionId: string; agentId: string; runId: string }
  | { type: 'session.command.run'; sessionId: string; command: string }
  | { type: 'session.compact.apply'; sessionId: string; compactionId: string; appliedSummary: string; userEdited?: boolean }
  | { type: 'session.compact.discard'; sessionId: string; compactionId: string }
  | {
      type: 'session.contract.save';
      sessionId: string;
      scope?: string | null;
      risks?: string[];
      acceptanceCriteria?: string[];
    }
  | { type: 'history_records.filter'; projectId: string; q?: string; status?: HistoryRecordStatus | 'all'; mode?: SessionMode | 'all' };

type Listener = (event: WsServerEvent) => void;

class SessionSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscribedSessions = new Set<string>();
  private pendingClientEvents: WsClientEvent[] = [];
  private retry = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closeWhenOpen = false;

  connect(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retry = 0;
      if (
        this.closeWhenOpen &&
        this.subscribedSessions.size === 0 &&
        this.pendingClientEvents.length === 0
      ) {
        this.closeWhenOpen = false;
        setTimeout(() => {
          if (
            this.ws !== ws ||
            this.subscribedSessions.size > 0 ||
            this.pendingClientEvents.length > 0
          ) return;
          this.ws = null;
          ws.close();
        }, 0);
        return;
      }
      this.closeWhenOpen = false;
      for (const id of this.subscribedSessions) ws.send(JSON.stringify({ type: 'session:subscribe', sessionId: id }));
      const pending = this.pendingClientEvents.splice(0);
      for (const event of pending) ws.send(JSON.stringify(event));
    });
    ws.addEventListener('message', (e) => {
      try {
        const event = JSON.parse(e.data) as WsServerEvent;
        for (const l of this.listeners) l(event);
      } catch {
        // ignore
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.closeWhenOpen = false;
      if (
        this.subscribedSessions.size === 0 &&
        this.pendingClientEvents.length === 0
      ) return;
      this.retry++;
      const delay = Math.min(1000 * 2 ** this.retry, 10000);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
    ws.addEventListener('error', () => ws.close());
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connectSoon(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.connectTimer) return;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (
        this.subscribedSessions.size === 0 &&
        this.pendingClientEvents.length === 0
      ) return;
      this.connect();
    }, 0);
  }

  subscribeSession(sessionId: string): void {
    this.closeWhenOpen = false;
    this.subscribedSessions.add(sessionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session:subscribe', sessionId }));
    } else {
      this.connectSoon();
    }
  }

  unsubscribeSession(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session:unsubscribe', sessionId }));
    }
    this.closeIfIdle();
  }

  replaceSessionSubscription(previousSessionId: string | null | undefined, nextSessionId: string): void {
    this.closeWhenOpen = false;
    if (previousSessionId && previousSessionId !== nextSessionId) {
      this.subscribedSessions.delete(previousSessionId);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'session:unsubscribe', sessionId: previousSessionId }));
      }
    }
    this.subscribedSessions.add(nextSessionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session:subscribe', sessionId: nextSessionId }));
    } else {
      this.connectSoon();
    }
  }

  requestSessionWorkspace(input: { projectId: string; sessionId?: string | null }): void {
    this.sendOrQueue({
      type: 'session.workspace.request',
      projectId: input.projectId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  }

  sendSessionMessage(input: { sessionId: string; content: string; agentId?: string; mode?: SessionMode }): void {
    this.sendOrQueue({
      type: 'session.message.send',
      sessionId: input.sessionId,
      content: input.content,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
  }

  runSessionControl(input:
    | { type: 'agent.run.pause'; sessionId: string; agentId: string; runId: string }
    | { type: 'agent.run.resume'; sessionId: string; agentId: string; runId: string; content?: string }
    | { type: 'agent.run.cancel'; sessionId: string; agentId: string; runId: string }
    | { type: 'agent.run.retry'; sessionId: string; agentId: string; runId: string }
  ): void {
    this.sendOrQueue(input);
  }

  runSessionCommand(input: { sessionId: string; command: string }): void {
    this.sendOrQueue({ type: 'session.command.run', ...input });
  }

  applySessionCompact(input: { sessionId: string; compactionId: string; appliedSummary: string; userEdited?: boolean }): void {
    this.sendOrQueue({ type: 'session.compact.apply', ...input });
  }

  discardSessionCompact(input: { sessionId: string; compactionId: string }): void {
    this.sendOrQueue({ type: 'session.compact.discard', ...input });
  }

  saveSessionContract(input: {
    sessionId: string;
    scope?: string | null;
    risks?: string[];
    acceptanceCriteria?: string[];
  }): void {
    this.sendOrQueue({ type: 'session.contract.save', ...input });
  }

  filterHistoryRecords(input: {
    projectId: string;
    q?: string;
    status?: HistoryRecordStatus | 'all';
    mode?: SessionMode | 'all';
  }): void {
    this.sendOrQueue({ type: 'history_records.filter', ...input });
  }

  destroy(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connectTimer = null;
    this.pendingClientEvents = [];
    this.ws?.close();
    this.ws = null;
  }

  private sendOrQueue(event: WsClientEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      return;
    }
    this.pendingClientEvents.push(event);
    this.connectSoon();
  }

  private closeIfIdle(): void {
    if (this.subscribedSessions.size > 0 || this.pendingClientEvents.length > 0) return;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.closeWhenOpen = true;
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      const socket = this.ws;
      this.ws = null;
      socket.close();
    }
  }
}

export const sessionSocket = new SessionSocket();
