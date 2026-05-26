import type { AgentRun, AgentRunStatus, Message, RoomAgent, Task, TaskArtifact, WorkflowRun, WorkflowStep } from './types';

export type WsServerEvent =
  | { type: 'message:new'; roomId: string; message: Message }
  | {
      type: 'message:stream';
      roomId: string;
      messageId: string;
      chunk: string;
      done: boolean;
      seq?: number;
      runId?: string;
      channel?: 'answer' | 'thinking' | 'tool' | 'command';
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
  | { type: 'task:created'; task: Task }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:deleted'; taskId: string };

type Listener = (event: WsServerEvent) => void;

class RoomSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscribed = new Set<string>();
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retry = 0;
      for (const id of this.subscribed) ws.send(JSON.stringify({ type: 'subscribe', roomId: id }));
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
      this.ws = null;
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

  subscribe(roomId: string): void {
    this.subscribed.add(roomId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', roomId }));
    } else {
      this.connect();
    }
  }

  unsubscribe(roomId: string): void {
    this.subscribed.delete(roomId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', roomId }));
    }
  }

  destroy(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }
}

export const roomSocket = new RoomSocket();
