import { WebSocket } from 'ws';
import { nanoid } from 'nanoid';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
const CONNECT_TIMEOUT_MS = 5000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface OpenClawAgentInfo {
  id: string;
  name?: string;
  description?: string;
  workspace?: string;
}

class OpenClawGatewayClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private connected = false;
  private listeners = new Set<(event: { event: string; payload: unknown }) => void>();

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(handler: (event: { event: string; payload: unknown }) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(GATEWAY_URL);
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(err);
      };
      const connectTimer = setTimeout(() => {
        ws.terminate();
        settleReject(new Error(`gateway connect timeout: ${GATEWAY_URL}`));
      }, CONNECT_TIMEOUT_MS);
      const onOpen = () => {
        const connectFrame = {
          type: 'connect',
          challenge: nanoid(16),
          params: GATEWAY_TOKEN ? { auth: { token: GATEWAY_TOKEN } } : {},
          role: 'client',
        };
        ws.send(JSON.stringify(connectFrame));
      };
      const onMessage = (data: WebSocket.RawData) => {
        try {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (frame['type'] === 'hello-ok' || frame['type'] === 'connect-ok') {
            this.connected = true;
            this.ws = ws;
            settleResolve();
            return;
          }
          if (frame['type'] === 'res' && typeof frame['id'] === 'string') {
            const id = frame['id'] as string;
            const pend = this.pending.get(id);
            if (pend) {
              clearTimeout(pend.timer);
              this.pending.delete(id);
              if (frame['ok']) pend.resolve(frame['payload']);
              else pend.reject(new Error(JSON.stringify(frame['error'] ?? 'gateway error')));
            }
            return;
          }
          if (frame['type'] === 'event') {
            for (const l of this.listeners) {
              l({ event: String(frame['event']), payload: frame['payload'] });
            }
          }
        } catch {
          // ignore malformed
        }
      };
      const onError = (err: Error) => {
        if (!this.connected) settleReject(err);
      };
      const onClose = () => {
        this.connected = false;
        this.ws = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('gateway connection closed'));
        }
        this.pending.clear();
        this.connecting = null;
      };
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
    });
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    if (!this.connected) await this.connect();
    if (!this.ws) throw new Error('not connected');
    const id = nanoid(12);
    const frame = { type: 'req', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  async listAgents(): Promise<OpenClawAgentInfo[]> {
    try {
      const res = await this.request<{ agents?: OpenClawAgentInfo[] } | OpenClawAgentInfo[]>(
        'agents.list',
      );
      if (Array.isArray(res)) return res;
      return res?.agents ?? [];
    } catch {
      return [];
    }
  }

  async sendToAgent(args: {
    agentId: string;
    sessionKey: string;
    text: string;
  }): Promise<unknown> {
    return this.request('sessions.send', {
      agentId: args.agentId,
      sessionKey: args.sessionKey,
      message: { type: 'text', text: args.text },
    });
  }

  async spawnSession(args: { agentId: string; sessionKey: string; cwd: string }): Promise<unknown> {
    return this.request('sessions.spawn', {
      agentId: args.agentId,
      sessionKey: args.sessionKey,
      cwd: args.cwd,
    });
  }

  close(): void {
    this.ws?.close();
  }
}

export const gatewayClient = new OpenClawGatewayClient();
