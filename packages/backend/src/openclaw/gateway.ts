import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30000;

export interface OpenClawAgentInfo {
  id: string;
  name?: string;
  description?: string;
  workspace?: string;
}

interface GatewayCallOptions {
  expectFinal?: boolean;
  timeoutMs?: number;
}

function formatGatewayError(stderr: string, errorMessage: string): string {
  const text = stderr.trim() || errorMessage;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const pairingLine = lines.find((line) => /pairing|required|approval|requestId/i.test(line));
  const message = pairingLine ?? lines[0] ?? errorMessage;
  const requestId = message.match(/requestId:\s*([^) \n]+)/i)?.[1];
  if (requestId && /pairing|required|approval/i.test(message)) {
    return `${message}。请在本机运行 openclaw devices approve ${requestId} 后重试。`;
  }
  return message;
}

class OpenClawGatewayClient {
  isConnected(): boolean {
    return false;
  }

  onEvent(_handler: (event: { event: string; payload: unknown }) => void): () => void {
    return () => undefined;
  }

  async connect(): Promise<void> {
    await this.request('health', {}, { timeoutMs: 10000 });
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: GatewayCallOptions = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const args = [
        'gateway',
        'call',
        method,
        '--json',
        '--timeout',
        String(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        '--params',
        JSON.stringify(params),
      ];
      if (options.expectFinal) args.push('--expect-final');

      execFile(
        'openclaw',
        args,
        { timeout: (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 2000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(formatGatewayError(stderr, error.message)));
            return;
          }

          try {
            resolve(JSON.parse(stdout) as T);
          } catch (parseError) {
            reject(new Error(`Failed to parse OpenClaw gateway response: ${(parseError as Error).message}`));
          }
        },
      );
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
      key: args.sessionKey,
      message: { type: 'text', text: args.text },
    });
  }

  async spawnSession(args: { agentId: string; sessionKey: string; cwd: string }): Promise<unknown> {
    return this.request('sessions.create', {
      agentId: args.agentId,
      key: args.sessionKey,
      label: `OpenClaw Room ${args.agentId}`,
    });
  }

  close(): void {
    // Short-lived official CLI calls own their connection lifecycle.
  }
}

export const gatewayClient = new OpenClawGatewayClient();
