import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliSessionSummary } from '../types.js';
import type { SessionAdapter } from './types.js';

/** Encode an absolute path the way Claude Code stores project dirs. */
function encodeProjectPath(p: string): string {
  return p.replace(/\//g, '-');
}

async function readJsonl(path: string, maxLines = 60): Promise<Record<string, unknown>[]> {
  const buf = await readFile(path, 'utf-8');
  const lines = buf.split('\n').filter(Boolean);
  const sample = lines.length > maxLines ? [...lines.slice(0, 2), ...lines.slice(-maxLines + 2)] : lines;
  return sample
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, unknown>[];
}

export const claudeCodeAdapter: SessionAdapter = {
  backend: 'claudecode',

  async listSessions(projectPath: string): Promise<CliSessionSummary[]> {
    const encoded = encodeProjectPath(projectPath);
    const baseDir = join(homedir(), '.claude', 'projects', encoded);
    let entries: string[] = [];
    try {
      entries = await readdir(baseDir);
    } catch {
      return [];
    }
    const jsonl = entries.filter((f) => f.endsWith('.jsonl'));
    const summaries: CliSessionSummary[] = [];

    for (const file of jsonl) {
      try {
        const filePath = join(baseDir, file);
        const st = await stat(filePath);
        const records = await readJsonl(filePath);
        const sessionId = file.replace(/\.jsonl$/, '');
        const firstUser = records.find(
          (r) => r['type'] === 'user' && typeof r['message'] === 'object',
        ) as { message?: { content?: unknown } } | undefined;
        const summaryRecord = records.find((r) => r['type'] === 'summary') as
          | { summary?: string }
          | undefined;
        let title = summaryRecord?.summary ?? '';
        let firstUserMessage = '';
        if (firstUser?.message?.content) {
          const c = firstUser.message.content;
          if (typeof c === 'string') firstUserMessage = c;
          else if (Array.isArray(c)) {
            const txt = c.find(
              (part) => typeof part === 'object' && part && (part as { type?: string }).type === 'text',
            ) as { text?: string } | undefined;
            firstUserMessage = txt?.text ?? '';
          }
        }
        if (!title) title = firstUserMessage.slice(0, 80) || sessionId.slice(0, 8);
        summaries.push({
          backend: 'claudecode',
          sessionId,
          title,
          cwd: projectPath,
          messageCount: records.length,
          lastActivity: st.mtimeMs,
          firstUserMessage: firstUserMessage.slice(0, 200),
        });
      } catch {
        // Skip unreadable session files
      }
    }
    summaries.sort((a, b) => b.lastActivity - a.lastActivity);
    return summaries;
  },

  async invoke({ projectPath, sessionId, prompt, onChunk, onSession, signal }) {
    const args = ['--print', '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);
    args.push(prompt);
    return runStreaming('claude', args, projectPath, onChunk, signal, onSession);
  },
};

function runStreaming(
  cmd: string,
  args: string[],
  cwd: string,
  onChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
  signal?: AbortSignal,
  onSession?: (sessionId: string) => void,
): Promise<{ exitCode: number; sessionId: string | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let detectedSession: string | null = null;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (data: string) => {
      onChunk({ stream: 'stdout', text: normalizeStdoutChunk(data) });
      const m = data.match(/"session_id"\s*:\s*"([^"]+)"/);
      if (m && m[1]) detectedSession = rememberSession(m[1], detectedSession, onSession);
      for (const obj of parseJsonLines(data)) {
        if (typeof obj['session_id'] === 'string') detectedSession = rememberSession(obj['session_id'], detectedSession, onSession);
        if (typeof obj['thread_id'] === 'string') detectedSession = rememberSession(obj['thread_id'], detectedSession, onSession);
      }
    });
    child.stderr.on('data', (data: string) => {
      const filtered = filterStderr(data);
      stderr += filtered;
      if (filtered) onChunk({ stream: 'stderr', text: filtered });
    });
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${(err as Error).message}`;
      onChunk({ stream: 'stderr', text: `\n[spawn error] ${(err as Error).message}` });
      resolve({ exitCode: -1, sessionId: detectedSession, stderr });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 0, sessionId: detectedSession, stderr });
    });
    signal?.addEventListener('abort', () => {
      child.kill('SIGTERM');
    });
  });
}

function rememberSession(
  sessionId: string,
  current: string | null,
  onSession: ((sessionId: string) => void) | undefined,
): string {
  if (sessionId !== current) onSession?.(sessionId);
  return sessionId;
}

function filterStderr(data: string): string {
  return data
    .split('\n')
    .filter((line) => line.trim() !== 'Reading additional input from stdin...')
    .join('\n');
}

function normalizeStdoutChunk(data: string): string {
  const lines = data.split('\n');
  const normalized = lines.map((line, index) => {
    if (!line.trim()) return index === lines.length - 1 ? '' : line;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj['type'] === 'assistant' || obj['type'] === 'result' || isCodexAgentMessage(obj)) {
        return extractText(obj) ?? line;
      }
      return '';
    } catch {
      return line;
    }
  });
  return normalized.filter(Boolean).join('\n');
}

function parseJsonLines(data: string): Record<string, unknown>[] {
  return data
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, unknown>[];
}

function extractText(obj: Record<string, unknown>): string | null {
  if (typeof obj['result'] === 'string') return obj['result'];
  if (typeof obj['text'] === 'string') return obj['text'];
  const item = obj['item'];
  if (item && typeof item === 'object') {
    const text = extractText(item as Record<string, unknown>);
    if (text) return text;
  }
  const message = obj['message'];
  if (message && typeof message === 'object') {
    return extractContentText((message as Record<string, unknown>)['content']);
  }
  return extractContentText(obj['content']);
}

function isCodexAgentMessage(obj: Record<string, unknown>): boolean {
  if (obj['type'] !== 'item.completed') return false;
  const item = obj['item'];
  return !!item && typeof item === 'object' && (item as Record<string, unknown>)['type'] === 'agent_message';
}

function extractContentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const p = part as Record<string, unknown>;
      return p['type'] === 'text' && typeof p['text'] === 'string' ? p['text'] : '';
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

export { runStreaming };
