import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GatewayClient } from 'openclaw/plugin-sdk/gateway-runtime';

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
const DEFAULT_RPC_TIMEOUT_MS = 30000;

export interface OpenClawAgentInfo {
  id: string;
  name?: string;
  description?: string;
  workspace?: string;
}

export interface GatewayEvent {
  event: string;
  payload: unknown;
  seq?: number;
  stateVersion?: number;
}

interface GatewayConfig {
  url: string;
  token?: string;
  password?: string;
}

type GatewayEventHandler = (event: GatewayEvent) => void;

function readOpenClawConfig(): Record<string, unknown> {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readNestedString(root: Record<string, unknown>, keys: string[]): string {
  let current: unknown = root;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === 'number') return String(current);
  return typeof current === 'string' ? current.trim() : '';
}

function getGatewayConfig(): GatewayConfig {
  const cfg = readOpenClawConfig();
  const bind = readNestedString(cfg, ['gateway', 'bind']);
  const port = readNestedString(cfg, ['gateway', 'port']);
  const host = bind === 'loopback' || bind === '' ? '127.0.0.1' : bind === 'all' ? '0.0.0.0' : bind;
  const configuredUrl =
    readNestedString(cfg, ['gateway', 'url']) ||
    (port ? `ws://${host}:${port}` : '');

  return {
    url: process.env.CLAWDBOT_GATEWAY_URL?.trim() || configuredUrl || DEFAULT_GATEWAY_URL,
    token:
      process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
      readNestedString(cfg, ['gateway', 'auth', 'token']) ||
      undefined,
    password:
      process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
      readNestedString(cfg, ['gateway', 'auth', 'password']) ||
      undefined,
  };
}

function normalizeGatewayError(error: Error): Error {
  const message = error.message;
  if (/pending|pairing|required|approval|scope upgrade/i.test(message)) {
    return new Error(
      `${message}。请在本机运行 openclaw devices list --json 查看 requestId，并执行 openclaw devices approve <requestId> 后重试。`,
    );
  }
  return error;
}

class OpenClawGatewayClient {
  private client: GatewayClient | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private eventHandlers = new Set<GatewayEventHandler>();

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(handler: GatewayEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.open();
    try {
      await this.connecting;
    } catch (err) {
      this.client?.stop();
      this.client = null;
      this.connected = false;
      throw normalizeGatewayError(err as Error);
    } finally {
      this.connecting = null;
    }
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number; expectFinal?: boolean } = {},
  ): Promise<T> {
    await this.connect();
    if (!this.client) throw new Error('Gateway client is not initialized');
    return this.client.request<T>(method, params, {
      timeoutMs: options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
      expectFinal: options.expectFinal,
    });
  }

  async listAgents(): Promise<OpenClawAgentInfo[]> {
    const res = await this.request<{ agents?: OpenClawAgentInfo[] } | OpenClawAgentInfo[]>('agents.list');
    if (Array.isArray(res)) return res;
    return res.agents ?? [];
  }

  async sendToAgent(args: {
    agentId: string;
    sessionKey: string;
    text: string;
    idempotencyKey?: string;
  }): Promise<{ runId?: string; status?: string }> {
    return this.request(
      'chat.send',
      {
        sessionKey: args.sessionKey,
        message: args.text,
        deliver: false,
        timeoutMs: 120000,
        idempotencyKey: args.idempotencyKey ?? randomUUID(),
      },
      { timeoutMs: 125000 },
    );
  }

  async abortChat(args: { sessionKey: string; runId?: string }): Promise<unknown> {
    return this.request('chat.abort', {
      sessionKey: args.sessionKey,
      ...(args.runId ? { runId: args.runId } : {}),
    });
  }

  async subscribeSessionEvents(): Promise<unknown> {
    return this.request('sessions.subscribe');
  }

  async spawnSession(args: { agentId: string; sessionKey: string }): Promise<unknown> {
    return this.request('sessions.create', {
      agentId: args.agentId,
      key: args.sessionKey,
      label: `OpenClaw Room ${args.agentId}`,
    });
  }

  close(): void {
    this.connected = false;
    this.connecting = null;
    this.client?.stop();
    this.client = null;
  }

  private open(): Promise<void> {
    const config = getGatewayConfig();
    if (!config.token && !config.password) {
      return Promise.reject(
        new Error(
          'Missing gateway auth. Set CLAWDBOT_GATEWAY_TOKEN or configure gateway.auth.token in ~/.openclaw/openclaw.json.',
        ),
      );
    }

    this.client?.stop();
    this.connected = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Gateway connect timeout'));
      }, 10000);

      const client = new GatewayClient({
        url: config.url,
        token: config.token,
        password: config.password,
        requestTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
        clientName: 'gateway-client',
        clientDisplayName: 'OpenClaw Room',
        clientVersion: process.env.npm_package_version ?? 'dev',
        platform: process.platform,
        mode: 'backend',
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals', 'operator.pairing'],
        caps: ['tool-events'],
        instanceId: randomUUID(),
        minProtocol: 3,
        maxProtocol: 3,
        onHelloOk: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.connected = true;
          resolve();
        },
        onEvent: (evt) => {
          const event: GatewayEvent = {
            event: evt.event,
            payload: evt.payload ?? {},
            seq: evt.seq,
            stateVersion: 'stateVersion' in evt && typeof evt.stateVersion === 'number' ? evt.stateVersion : undefined,
          };
          for (const handler of this.eventHandlers) {
            try {
              handler(event);
            } catch {
              // Event subscribers must not break gateway consumption.
            }
          }
        },
        onConnectError: (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(err);
          }
        },
        onReconnectPaused: (info) => {
          this.connected = false;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`Gateway reconnect paused (${info.code}): ${info.reason}`));
          }
        },
        onClose: () => {
          this.connected = false;
        },
      });

      this.client = client;
      client.start();
    });
  }
}

export const gatewayClient = new OpenClawGatewayClient();
