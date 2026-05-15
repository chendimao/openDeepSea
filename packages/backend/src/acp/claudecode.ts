import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliSessionSummary } from '../types.js';
import type { AcpStreamChunk, SessionAdapter } from './types.js';

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

  async invoke({ projectPath, sessionId, prompt, imagePaths, acpPermissionMode, acpWritableDirs, onChunk, onSession, signal }) {
    const args = buildClaudeCodeArgs({
      sessionId,
      prompt,
      imagePaths: imagePaths ?? [],
      permissionMode: acpPermissionMode ?? 'bypass',
      writableDirs: acpWritableDirs ?? [],
    });
    return runStreaming('claude', args, projectPath, onChunk, signal, onSession);
  },
};

export function buildClaudeCodeArgs(args: {
  sessionId: string | null;
  prompt: string;
  imagePaths?: string[];
  permissionMode: 'bypass' | 'workspace-write' | 'read-only';
  writableDirs: string[];
}): string[] {
  const cliArgs = ['--print', '--output-format', 'stream-json', '--verbose'];
  if (args.permissionMode === 'bypass') {
    cliArgs.push('--permission-mode', 'bypassPermissions');
  } else if (args.permissionMode === 'workspace-write') {
    cliArgs.push('--permission-mode', 'acceptEdits');
    for (const dir of normalizeWritableDirs(args.writableDirs)) {
      cliArgs.push('--add-dir', dir);
    }
  } else {
    cliArgs.push('--permission-mode', 'plan');
  }
  if (args.sessionId) cliArgs.push('--resume', args.sessionId);
  cliArgs.push(buildClaudeCodePrompt(args.prompt, args.imagePaths ?? []));
  return cliArgs;
}

export function buildClaudeCodePrompt(prompt: string, imagePaths: string[]): string {
  const normalized = normalizeWritableDirs(imagePaths);
  if (normalized.length === 0) return prompt;
  return [
    prompt,
    '',
    'Claude Code 图片附件：',
    '请直接分析以下本地图片路径；如果需要确认文件存在，可读取这些路径。',
    ...normalized.map((imagePath, index) => `${index + 1}. ${imagePath}`),
  ].join('\n');
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

function runStreaming(
  cmd: string,
  args: string[],
  cwd: string,
  onChunk: (chunk: AcpStreamChunk) => void,
  signal?: AbortSignal,
  onSession?: (sessionId: string) => void,
): Promise<{ exitCode: number; sessionId: string | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let detectedSession: string | null = null;
    let stdoutBuffer = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (data: string) => {
      const parsed = takeCompleteLines(stdoutBuffer + data);
      stdoutBuffer = parsed.rest;
      for (const chunk of normalizeStdoutChunk(parsed.complete)) {
        onChunk({ stream: 'stdout', ...chunk });
      }
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
      if (stdoutBuffer) {
        for (const chunk of normalizeStdoutChunk(stdoutBuffer)) {
          onChunk({ stream: 'stdout', ...chunk });
        }
        stdoutBuffer = '';
      }
      resolve({ exitCode: code ?? 0, sessionId: detectedSession, stderr });
    });
    signal?.addEventListener('abort', () => {
      child.kill('SIGTERM');
    });
  });
}

function takeCompleteLines(data: string): { complete: string; rest: string } {
  const lastNewline = data.lastIndexOf('\n');
  if (lastNewline === -1) return { complete: '', rest: data };
  return {
    complete: data.slice(0, lastNewline + 1),
    rest: data.slice(lastNewline + 1),
  };
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

function normalizeStdoutChunk(data: string): Array<{
  channel: 'answer' | 'activity';
  text: string;
  rawType?: string;
}> {
  const lines = data.split('\n');
  const normalized = lines.map((line, index) => {
    if (!line.trim()) return index === lines.length - 1 ? '' : line;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj['type'] === 'assistant' || obj['type'] === 'result' || isCodexAgentMessage(obj) || isOpenCodeTextEvent(obj)) {
        const text = extractText(obj);
        if (!text) {
          const activity = extractActivityText(obj);
          return activity
            ? {
                channel: 'activity' as const,
                text: activity,
                rawType: typeof obj['type'] === 'string' ? obj['type'] : undefined,
              }
            : '';
        }
        return {
          channel: 'answer' as const,
          text,
          rawType: typeof obj['type'] === 'string' ? obj['type'] : undefined,
        };
      }
      const activity = extractActivityText(obj);
      return activity
        ? {
            channel: 'activity' as const,
            text: activity,
            rawType: typeof obj['type'] === 'string' ? obj['type'] : undefined,
          }
        : '';
    } catch {
      return { channel: 'answer' as const, text: line };
    }
  });
  return normalized.filter(Boolean) as Array<{
    channel: 'answer' | 'activity';
    text: string;
    rawType?: string;
  }>;
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
  const data = obj['data'];
  if (data && typeof data === 'object') {
    const text = extractText(data as Record<string, unknown>);
    if (text) return text;
  }
  const part = obj['part'];
  if (part && typeof part === 'object') {
    const text = extractText(part as Record<string, unknown>);
    if (text) return text;
  }
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

function extractActivityText(obj: Record<string, unknown>): string | null {
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';
  if (type === 'system') return null;

  if (type === 'user') {
    const message = asRecord(obj['message']);
    const content = message ? message['content'] : obj['content'];
    const summary = extractToolResultSummary(content);
    return summary ? `工具结果：${summary}` : null;
  }

  if (type === 'item.started' || type === 'item.completed') {
    const item = asRecord(obj['item']);
    if (!item) return null;
    return extractItemActivity(item, type === 'item.started' ? '开始' : '完成');
  }

  if (type === 'assistant') {
    const message = asRecord(obj['message']);
    const content = message ? message['content'] : obj['content'];
    return extractAssistantActivity(content);
  }

  return null;
}

function extractItemActivity(item: Record<string, unknown>, phase: '开始' | '完成'): string | null {
  const itemType = typeof item['type'] === 'string' ? item['type'] : '';
  if (itemType === 'reasoning') {
    const summary = extractReasoningSummary(item);
    return summary ? `推理摘要：${summary}` : `推理${phase}`;
  }
  if (itemType === 'function_call') {
    const name = typeof item['name'] === 'string' ? item['name'] : 'tool';
    const args = summarizeJsonText(item['arguments']);
    return args ? `${phase}工具：${name} ${args}` : `${phase}工具：${name}`;
  }
  if (itemType === 'function_call_output') {
    const summary = summarizeJsonText(item['output']);
    return summary ? `工具输出：${summary}` : `工具输出${phase}`;
  }
  if (itemType === 'command_execution' || itemType === 'local_shell_call') {
    const command = summarizeCommand(item);
    return command ? `${phase}命令：${command}` : `${phase}命令执行`;
  }
  return null;
}

function extractAssistantActivity(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const p = part as Record<string, unknown>;
      const type = typeof p['type'] === 'string' ? p['type'] : '';
      if (type === 'tool_use') {
        const name = typeof p['name'] === 'string' ? p['name'] : 'tool';
        const input = summarizeJsonText(p['input']);
        return input ? `调用工具：${name} ${input}` : `调用工具：${name}`;
      }
      if (type === 'thinking' || type === 'reasoning') {
        const summary = extractReasoningSummary(p);
        return summary ? `推理摘要：${summary}` : '';
      }
      return '';
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

function extractReasoningSummary(obj: Record<string, unknown>): string | null {
  const summary = obj['summary'];
  if (typeof summary === 'string') return oneLine(summary);
  if (Array.isArray(summary)) {
    const text = summary
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const record = item as Record<string, unknown>;
        return typeof record['text'] === 'string' ? record['text'] : '';
      })
      .filter(Boolean)
      .join(' ');
    return text ? oneLine(text) : null;
  }
  if (typeof obj['text'] === 'string' && obj['is_summary'] === true) return oneLine(obj['text']);
  return null;
}

function extractToolResultSummary(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const p = part as Record<string, unknown>;
      const type = typeof p['type'] === 'string' ? p['type'] : '';
      if (type !== 'tool_result') return '';
      if (typeof p['content'] === 'string') return oneLine(p['content']);
      return summarizeJsonText(p['content']);
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

function summarizeCommand(item: Record<string, unknown>): string | null {
  const command = item['command'];
  if (Array.isArray(command)) return oneLine(command.map(String).join(' '), 160);
  if (typeof command === 'string') return oneLine(command, 160);
  const cmd = typeof item['cmd'] === 'string' ? item['cmd'] : '';
  return cmd ? oneLine(cmd, 160) : null;
}

function summarizeJsonText(value: unknown): string {
  if (typeof value === 'string') return oneLine(value, 180);
  if (value === null || value === undefined) return '';
  try {
    return oneLine(JSON.stringify(value), 180);
  } catch {
    return '';
  }
}

function oneLine(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function isCodexAgentMessage(obj: Record<string, unknown>): boolean {
  if (obj['type'] !== 'item.completed') return false;
  const item = obj['item'];
  return !!item && typeof item === 'object' && (item as Record<string, unknown>)['type'] === 'agent_message';
}

function isOpenCodeTextEvent(obj: Record<string, unknown>): boolean {
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';
  if (type !== 'message.part.updated') return false;

  const data = asRecord(obj['data']) ?? asRecord(obj['properties']) ?? asRecord(obj['payload']) ?? obj;
  const part = asRecord(data['part']) ?? data;
  const metadata = asRecord(part['metadata']);
  const openai = metadata ? asRecord(metadata['openai']) : null;
  return part['type'] === 'text' && openai?.['phase'] === 'final_answer';
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
