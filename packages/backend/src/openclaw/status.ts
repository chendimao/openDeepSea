import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ExecFileException } from 'node:child_process';

const DEFAULT_GATEWAY_HOST = '127.0.0.1';
const DEFAULT_GATEWAY_PORT = 18789;
const TCP_PROBE_TIMEOUT_MS = 1200;

export interface OpenClawGatewayStatus {
  ok: boolean;
  running: boolean;
  pid: number | null;
  rpcOk: boolean;
  capability: string | null;
  source?: 'cli' | 'tcp-probe';
  warning?: string;
  error?: string;
}

interface GatewayStatusJson {
  service?: {
    runtime?: {
      status?: string;
      state?: string;
      pid?: number;
    };
  };
  rpc?: {
    ok?: boolean;
    capability?: string;
  };
}

interface GatewayProbeTarget {
  host: string;
  port: number;
}

interface StatusCheckDeps {
  execGatewayStatus: (
    timeoutMs: number,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => { on: (event: 'error', handler: (error: Error) => void) => void };
  canConnect: (target: GatewayProbeTarget) => Promise<boolean>;
}

export function getOpenClawGatewayStatus(timeoutMs = 6000): Promise<OpenClawGatewayStatus> {
  return getOpenClawGatewayStatusWithDeps(timeoutMs, {
    execGatewayStatus: execOpenClawGatewayStatus,
    canConnect: canConnectTcp,
  });
}

function getOpenClawGatewayStatusWithDeps(
  timeoutMs: number,
  deps: StatusCheckDeps,
): Promise<OpenClawGatewayStatus> {
  return new Promise((resolve) => {
    const child = deps.execGatewayStatus(
      timeoutMs,
      async (error, stdout, stderr) => {
        if (error) {
          resolve(await getTcpProbeStatus(stderr.trim() || error.message, deps.canConnect));
          return;
        }

        try {
          const status = JSON.parse(stdout) as GatewayStatusJson;
          const runtime = status.service?.runtime;
          const running = runtime?.status === 'running' || runtime?.state === 'running';
          const rpcOk = status.rpc?.ok === true;
          resolve({
            ok: running,
            running,
            pid: typeof runtime?.pid === 'number' ? runtime.pid : null,
            rpcOk,
            capability: status.rpc?.capability ?? null,
            source: 'cli',
          });
        } catch (parseError) {
          resolve(await getTcpProbeStatus((parseError as Error).message, deps.canConnect));
        }
      },
    );

    child.on('error', async (error) => {
      resolve(await getTcpProbeStatus(error.message, deps.canConnect));
    });
  });
}

function execOpenClawGatewayStatus(
  timeoutMs: number,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): { on: (event: 'error', handler: (error: Error) => void) => void } {
  return execFile(
    'openclaw',
    ['gateway', 'status', '--json'],
    { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    callback,
  );
}

async function getTcpProbeStatus(
  cliError: string,
  canConnect: StatusCheckDeps['canConnect'],
): Promise<OpenClawGatewayStatus> {
  const target = resolveGatewayProbeTarget();
  const running = await canConnect(target);
  const diagnostic = `openclaw gateway status --json failed: ${cliError}`;

  return {
    ok: running,
    running,
    pid: null,
    rpcOk: false,
    capability: null,
    source: 'tcp-probe',
    ...(running ? { warning: diagnostic } : { error: diagnostic }),
  };
}

function resolveGatewayProbeTarget(): GatewayProbeTarget {
  const cfg = readOpenClawConfig();
  const configuredUrl = process.env.CLAWDBOT_GATEWAY_URL?.trim() || readNestedString(cfg, ['gateway', 'url']);
  if (configuredUrl) {
    const parsed = parseGatewayUrl(configuredUrl);
    if (parsed) return parsed;
  }

  const bind = readNestedString(cfg, ['gateway', 'bind']);
  const configuredPort = Number(process.env.OPENCLAW_GATEWAY_PORT?.trim() || readNestedString(cfg, ['gateway', 'port']));
  const host = normalizeProbeHost(bind);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : DEFAULT_GATEWAY_PORT;
  return { host, port };
}

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

function parseGatewayUrl(value: string): GatewayProbeTarget | null {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    return {
      host: normalizeProbeHost(url.hostname),
      port,
    };
  } catch {
    return null;
  }
}

function normalizeProbeHost(value: string): string {
  if (!value || value === 'loopback' || value === 'all' || value === '0.0.0.0' || value === '::') {
    return DEFAULT_GATEWAY_HOST;
  }
  return value;
}

function canConnectTcp(target: GatewayProbeTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(target);
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(TCP_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export const statusTestInternals = {
  getOpenClawGatewayStatusWithDeps,
};
