import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliSessionSummary } from '../types.js';
import type { SessionAdapter } from './types.js';
import { runStreaming } from './claudecode.js';

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

  async invoke({ projectPath, sessionId, prompt, onChunk, signal }) {
    const args: string[] = ['exec', '--json'];
    if (sessionId) args.push('resume', sessionId);
    args.push(prompt);
    return runStreaming('codex', args, projectPath, onChunk, signal);
  },
};
