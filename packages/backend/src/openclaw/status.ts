import { execFile } from 'node:child_process';

export interface OpenClawGatewayStatus {
  ok: boolean;
  running: boolean;
  pid: number | null;
  rpcOk: boolean;
  capability: string | null;
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

export function getOpenClawGatewayStatus(timeoutMs = 6000): Promise<OpenClawGatewayStatus> {
  return new Promise((resolve) => {
    const child = execFile(
      'openclaw',
      ['gateway', 'status', '--json'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            running: false,
            pid: null,
            rpcOk: false,
            capability: null,
            error: stderr.trim() || error.message,
          });
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
          });
        } catch (parseError) {
          resolve({
            ok: false,
            running: false,
            pid: null,
            rpcOk: false,
            capability: null,
            error: (parseError as Error).message,
          });
        }
      },
    );

    child.on('error', (error) => {
      resolve({
        ok: false,
        running: false,
        pid: null,
        rpcOk: false,
        capability: null,
        error: error.message,
      });
    });
  });
}
