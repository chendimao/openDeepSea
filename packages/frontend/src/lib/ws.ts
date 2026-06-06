import type {
  AgentRun,
  AgentRunStatus,
  AgentTimelineEvent,
  HistoryRecord,
  Message,
  RoomAgent,
  Session,
  SessionEvidenceEvent,
  SessionMessage,
  SessionRun,
  Task,
  TaskArtifact,
  TaskEvent,
  WorkflowRun,
  WorkflowStep,
} from './types';

export type WsServerEvent =
  | { type: 'message:new'; roomId: string; message: Message }
  | { type: 'task_event:new'; roomId: string; event: TaskEvent }
  | { type: 'task:activated'; roomId: string; taskId: string }
  | {
      type: 'message:stream';
      roomId: string;
      messageId: string;
      chunk: string;
      done: boolean;
      seq?: number;
      runId?: string;
      channel?: 'answer' | 'thinking' | 'tool' | 'command' | 'event';
      event?: AgentTimelineEvent;
      status?: 'streaming' | AgentRunStatus;
      error?: string | null;
      message?: Message;
    }
  | { type: 'agent_run:created'; roomId: string; run: AgentRun }
  | { type: 'agent_run:updated'; roomId: string; run: AgentRun }
  | { type: 'room:agent_joined'; roomId: string; agent: RoomAgent }
  | { type: 'room:agent_left'; roomId: string; roomAgentId: string }
  | { type: 'workflow:created'; roomId: string; workflow: WorkflowRun }
  | { type: 'workflow:updated'; roomId: string; workflow: WorkflowRun }
  | { type: 'workflow_step:created'; roomId: string; step: WorkflowStep }
  | { type: 'workflow_step:updated'; roomId: string; step: WorkflowStep }
  | { type: 'workflow_artifact:created'; roomId: string; artifact: TaskArtifact }
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
    }
  | { type: 'session_evidence:new'; sessionId: string; event: SessionEvidenceEvent }
  | { type: 'history_record:new'; projectId: string; record: HistoryRecord }
  | { type: 'task:created'; task: Task }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:deleted'; taskId: string };

type Listener = (event: WsServerEvent) => void;

class RoomSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscribed = new Set<string>();
  private subscribedSessions = new Set<string>();
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
      if (this.closeWhenOpen && this.subscribed.size === 0 && this.subscribedSessions.size === 0) {
        this.closeWhenOpen = false;
        setTimeout(() => {
          if (this.ws !== ws || this.subscribed.size > 0 || this.subscribedSessions.size > 0) return;
          this.ws = null;
          ws.close();
        }, 0);
        return;
      }
      this.closeWhenOpen = false;
      for (const id of this.subscribed) ws.send(JSON.stringify({ type: 'subscribe', roomId: id }));
      for (const id of this.subscribedSessions) ws.send(JSON.stringify({ type: 'session:subscribe', sessionId: id }));
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
      if (this.subscribed.size === 0 && this.subscribedSessions.size === 0) return;
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
      if (this.subscribed.size === 0 && this.subscribedSessions.size === 0) return;
      this.connect();
    }, 0);
  }

  subscribe(roomId: string): void {
    this.closeWhenOpen = false;
    this.subscribed.add(roomId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', roomId }));
    } else {
      this.connectSoon();
    }
  }

  unsubscribe(roomId: string): void {
    this.subscribed.delete(roomId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', roomId }));
    }
    this.closeIfIdle();
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

  destroy(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private closeIfIdle(): void {
    if (this.subscribed.size > 0 || this.subscribedSessions.size > 0) return;
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

export const roomSocket = new RoomSocket();
export const sessionSocket = roomSocket;
