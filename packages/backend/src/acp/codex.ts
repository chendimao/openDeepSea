import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AcpPermissionMode, CliSessionSummary } from '../types.js';
import type { SessionAdapter } from './types.js';
import { emitProtocolFallback, runStreaming } from './claudecode.js';
import { invokeProtocolSession, isAcpStreamDisconnected } from './protocol-client.js';
import { getAcpServerConfig } from './protocol-registry.js';

const CODEX_ACP_NETWORK_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 180_000, 300_000] as const;

async function* walkRolloutFiles(rootDir: string): AsyncGenerator<string> {
  let years: string[] = [];
  try {
    years = await readdir(rootDir);
  } catch {
    return;
  }
  for (const y of years.sort().reverse()) {
    const yDir = join(rootDir, y);
    let months: string[] = [];
    try {
      months = await readdir(yDir);
    } catch {
      continue;
    }
    for (const m of months.sort().reverse()) {
      const mDir = join(yDir, m);
      let days: string[] = [];
      try {
        days = await readdir(mDir);
      } catch {
        continue;
      }
      for (const d of days.sort().reverse()) {
        const dDir = join(mDir, d);
        let files: string[] = [];
        try {
          files = await readdir(dDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.endsWith('.jsonl') && f.startsWith('rollout-')) {
            yield join(dDir, f);
          }
        }
      }
    }
  }
}

async function readMeta(filePath: string): Promise<{
  cwd?: string;
  sessionId?: string;
  firstUser?: string;
  total?: number;
}> {
  const buf = await readFile(filePath, 'utf-8');
  const lines = buf.split('\n').filter(Boolean);
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let firstUser: string | undefined;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (!cwd && typeof obj['cwd'] === 'string') cwd = obj['cwd'] as string;
      if (!sessionId && typeof obj['id'] === 'string' && obj['type'] === 'session_meta')
        sessionId = obj['id'] as string;
      if (!sessionId && typeof obj['session_id'] === 'string') sessionId = obj['session_id'] as string;
      if (!firstUser && obj['type'] === 'message' && (obj['role'] === 'user' || obj['role'] === 'human')) {
        const content = obj['content'];
        if (typeof content === 'string') firstUser = content;
        else if (Array.isArray(content)) {
          const t = content.find((p) => p && (p as { type?: string }).type === 'text');
          firstUser = (t as { text?: string } | undefined)?.text;
        }
      }
      if (cwd && sessionId && firstUser) break;
    } catch {
      // skip malformed line
    }
  }
  return { cwd, sessionId, firstUser, total: lines.length };
}

export const codexAdapter: SessionAdapter = {
  backend: 'codex',

  async listSessions(projectPath: string): Promise<CliSessionSummary[]> {
    const root = join(homedir(), '.codex', 'sessions');
    const summaries: CliSessionSummary[] = [];
    let count = 0;
    const SCAN_LIMIT = 200;
    for await (const file of walkRolloutFiles(root)) {
      if (count++ > SCAN_LIMIT) break;
      try {
        const meta = await readMeta(file);
        if (meta.cwd !== projectPath) continue;
        const st = await stat(file);
        const fileName = file.split('/').pop() ?? '';
        const uuidMatch = fileName.match(/rollout-[\dT-]+-([a-f0-9-]+)\.jsonl/);
        const sessionId = meta.sessionId ?? uuidMatch?.[1] ?? fileName.replace(/\.jsonl$/, '');
        summaries.push({
          backend: 'codex',
          sessionId,
          title: (meta.firstUser ?? '').slice(0, 80) || sessionId.slice(0, 8),
          cwd: projectPath,
          messageCount: meta.total ?? 0,
          lastActivity: st.mtimeMs,
          firstUserMessage: meta.firstUser?.slice(0, 200),
        });
      } catch {
        // skip
      }
    }
    summaries.sort((a, b) => b.lastActivity - a.lastActivity);
    return summaries;
  },

  async invoke({ projectPath, sessionId, prompt, imagePaths, acpPermissionMode, acpWritableDirs, envOverrides, onChunk, onSession, signal }) {
    const protocolConfig = getAcpServerConfig('codex');
    if (protocolConfig.enabled) {
      let protocolResult = await invokeProtocolSession({
        backend: 'codex',
        server: protocolConfig,
        projectPath,
        sessionId,
        prompt,
        imagePaths,
        acpPermissionMode,
        acpWritableDirs,
        envOverrides,
        onChunk,
        onSession,
        signal,
      });
      const retryDelaysMs = readCodexAcpRetryDelaysMs(process.env.OPENCLAW_ACP_CODEX_RETRY_DELAYS_MS);
      for (let attempt = 1; shouldRetryCodexAcp(protocolResult.stderr, protocolResult.retrySafe) && attempt <= retryDelaysMs.length; attempt += 1) {
        const delayMs = retryDelaysMs[attempt - 1] ?? 0;
        onChunk({
          stream: 'stderr',
          channel: 'activity',
          text: `[ACP retry] Codex ACP stream disconnected before output, retrying ${attempt}/${retryDelaysMs.length} after ${formatRetryDelay(delayMs)}.\n`,
          rawType: 'protocol.retry',
        });
        if (delayMs > 0) {
          await delay(delayMs, signal);
        }
        protocolResult = await invokeProtocolSession({
          backend: 'codex',
          server: protocolConfig,
          projectPath,
          sessionId: protocolResult.sessionId ?? sessionId,
          prompt,
          imagePaths,
          acpPermissionMode,
          acpWritableDirs,
          onChunk,
          onSession,
          signal,
        });
      }
      if (protocolResult.exitCode === 0 || protocolConfig.mode === 'protocol' || protocolResult.fallbackSafe === false) {
        return protocolResult;
      }
      emitProtocolFallback(onChunk, 'codex', protocolResult.stderr);
    }

    const invocation = buildCodexExecInvocation({
      sessionId,
      prompt,
      imagePaths: imagePaths ?? [],
      permissionMode: acpPermissionMode ?? 'bypass',
      writableDirs: acpWritableDirs ?? [],
    });
    return runStreaming('codex', invocation.args, projectPath, onChunk, signal, onSession, invocation.stdin, envOverrides);
  },
};

function shouldRetryCodexAcp(stderr: string, retrySafe?: boolean): boolean {
  if (!retrySafe) return false;
  return isAcpStreamDisconnected(stderr);
}

function readCodexAcpRetryDelaysMs(value: string | undefined): number[] {
  if (!value?.trim()) return [...CODEX_ACP_NETWORK_RETRY_DELAYS_MS];
  const parsed = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return parsed.length > 0 ? parsed : [...CODEX_ACP_NETWORK_RETRY_DELAYS_MS];
}

function formatRetryDelay(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes}m` : `${seconds}s`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('ACP retry cancelled'));
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (timeout) clearTimeout(timeout);
      reject(new Error('ACP retry cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
  });
}

export function buildCodexExecInvocation(args: {
  sessionId: string | null;
  prompt: string;
  imagePaths?: string[];
  permissionMode: AcpPermissionMode;
  writableDirs: string[];
}): { args: string[]; stdin: string } {
  const cliArgs: string[] = ['exec', '--json', '--skip-git-repo-check'];

  if (args.permissionMode === 'bypass') {
    cliArgs.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    cliArgs.push('--sandbox', args.permissionMode);
    if (args.permissionMode === 'workspace-write') {
      for (const dir of normalizeWritableDirs(args.writableDirs)) {
        cliArgs.push('--add-dir', dir);
      }
    }
  }

  for (const imagePath of normalizeWritableDirs(args.imagePaths ?? [])) {
    cliArgs.push('--image', imagePath);
  }
  if (args.sessionId) cliArgs.push('resume', args.sessionId);
  cliArgs.push('-');
  return { args: cliArgs, stdin: args.prompt };
}

export function buildCodexExecArgs(args: {
  sessionId: string | null;
  prompt: string;
  imagePaths?: string[];
  permissionMode: AcpPermissionMode;
  writableDirs: string[];
}): string[] {
  return buildCodexExecInvocation(args).args;
}

function normalizeWritableDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of dirs) {
    const dir = raw.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    normalized.push(dir);
  }
  return normalized;
}
