import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliSessionSummary } from '../types.js';
import type { AcpStreamChannel, AcpStreamChunk, AcpStreamTrace, SessionAdapter } from './types.js';
import { invokeProtocolSession } from './protocol-client.js';
import { getAcpServerConfig } from './protocol-registry.js';

type NormalizedStdoutChunk = {
  channel: AcpStreamChannel;
  text: string;
  rawType?: string;
  trace?: AcpStreamTrace;
  rawEvent?: Record<string, unknown>;
};

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
    const protocolConfig = getAcpServerConfig('claudecode');
    if (protocolConfig.enabled) {
      const protocolResult = await invokeProtocolSession({
        backend: 'claudecode',
        server: protocolConfig,
        projectPath,
        sessionId,
        prompt,
        imagePaths,
        acpPermissionMode,
        acpWritableDirs,
        onChunk,
        onSession,
        signal,
      });
      if (protocolResult.exitCode === 0 || protocolConfig.mode === 'protocol' || protocolResult.fallbackSafe === false) {
        return protocolResult;
      }
      emitProtocolFallback(onChunk, 'claudecode', protocolResult.stderr);
    }

    const invocation = buildClaudeCodeInvocation({
      sessionId,
      prompt,
      imagePaths: imagePaths ?? [],
      permissionMode: acpPermissionMode ?? 'bypass',
      writableDirs: acpWritableDirs ?? [],
    });
    return runStreaming('claude', invocation.args, projectPath, onChunk, signal, onSession, invocation.stdin);
  },
};

export function buildClaudeCodeInvocation(args: {
  sessionId: string | null;
  prompt: string;
  imagePaths?: string[];
  permissionMode: 'bypass' | 'workspace-write' | 'read-only';
  writableDirs: string[];
}): { args: string[]; stdin: string } {
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
  return { args: cliArgs, stdin: buildClaudeCodePrompt(args.prompt, args.imagePaths ?? []) };
}

export function buildClaudeCodeArgs(args: {
  sessionId: string | null;
  prompt: string;
  imagePaths?: string[];
  permissionMode: 'bypass' | 'workspace-write' | 'read-only';
  writableDirs: string[];
}): string[] {
  return buildClaudeCodeInvocation(args).args;
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
  stdin?: string,
): Promise<{ exitCode: number; sessionId: string | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let detectedSession: string | null = null;
    let stdoutBuffer = '';
    const normalizeStdout = createStdoutNormalizer();
    if (!child.stdout || !child.stderr) {
      resolve({ exitCode: -1, sessionId: detectedSession, stderr: 'failed to open child process streams' });
      return;
    }
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin);
    }
    const stdout = child.stdout;
    const stderrStream = child.stderr;
    stdout.setEncoding('utf-8');
    stderrStream.setEncoding('utf-8');
    stdout.on('data', (data: string) => {
      const parsed = takeCompleteLines(stdoutBuffer + data);
      stdoutBuffer = parsed.rest;
      for (const chunk of normalizeStdout(parsed.complete)) {
        onChunk({ stream: 'stdout', ...chunk });
      }
      const m = data.match(/"session_id"\s*:\s*"([^"]+)"/);
      if (m && m[1]) detectedSession = rememberSession(m[1], detectedSession, onSession);
      for (const obj of parseJsonLines(data)) {
        if (typeof obj['session_id'] === 'string') detectedSession = rememberSession(obj['session_id'], detectedSession, onSession);
        if (typeof obj['thread_id'] === 'string') detectedSession = rememberSession(obj['thread_id'], detectedSession, onSession);
      }
    });
    stderrStream.on('data', (data: string) => {
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
        for (const chunk of normalizeStdout(stdoutBuffer)) {
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

export function emitProtocolFallback(
  onChunk: (chunk: AcpStreamChunk) => void,
  backend: string,
  reason: string,
): void {
  const message = `[ACP fallback] ${backend} protocol server unavailable, using legacy CLI. ${reason}`;
  onChunk({
    stream: 'stderr',
    text: `${message}\n`,
    channel: 'activity',
    rawType: 'protocol_fallback',
  });
  onChunk({
    stream: 'stdout',
    text: '',
    channel: 'event',
    rawType: 'protocol_fallback',
    rawEvent: {
      type: 'protocol_fallback',
      backend,
      reason,
    },
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

export function filterStderr(data: string): string {
  return data
    .split('\n')
    .filter((line) => {
      const text = line.trim();
      return text !== 'Reading prompt from stdin...' && text !== 'Reading additional input from stdin...';
    })
    .join('\n');
}

export function normalizeStdoutChunk(data: string): Array<{
  channel: AcpStreamChannel;
  text: string;
  rawType?: string;
  trace?: AcpStreamTrace;
  rawEvent?: Record<string, unknown>;
}> {
  return createStdoutNormalizer()(data);
}

export function createStdoutNormalizer(): (data: string) => Array<{
  channel: AcpStreamChannel;
  text: string;
  rawType?: string;
  trace?: AcpStreamTrace;
  rawEvent?: Record<string, unknown>;
}> {
  const snapshots = new Map<string, string>();
  return (data: string) => normalizeStdoutChunkWithSnapshots(data, snapshots);
}

function normalizeStdoutChunkWithSnapshots(
  data: string,
  snapshots: Map<string, string>,
): NormalizedStdoutChunk[] {
  const lines = data.split('\n');
  const normalized = lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const rawObj = JSON.parse(line) as Record<string, unknown>;
      const obj = normalizeCliEventObject(rawObj);
      const traceChunks = extractTraceChunks(obj);
      const rawType = typeof rawObj['type'] === 'string' ? rawObj['type'] : undefined;
      if (
        obj['type'] === 'assistant' ||
        obj['type'] === 'message' ||
        obj['type'] === 'agent_message' ||
        obj['type'] === 'result' ||
        isCodexAgentMessage(obj) ||
        isOpenCodeTextEvent(obj)
      ) {
        const text = extractText(obj);
        if (!text) {
          const activity = extractActivityText(obj);
          const activityChunk = activity
            ? {
                channel: 'activity' as const,
                text: activity,
                rawType,
              }
            : null;
          if (activityChunk) return [...traceChunks, activityChunk];
          return traceChunks;
        }
        const delta = toAnswerTextDelta(obj, text, snapshots);
        if (!delta) return traceChunks;
        return [...traceChunks, {
          channel: 'answer' as const,
          text: delta,
          rawType,
        }];
      }
      const activity = extractActivityText(obj);
      const activityChunk = activity
        ? {
            channel: 'activity' as const,
            text: activity,
            rawType,
          }
        : null;
      if (activityChunk) return [...traceChunks, activityChunk];
      if (traceChunks.length > 0) return traceChunks;
      if (!shouldEmitRawFallback(rawObj)) return [];
      return [{
        channel: 'event' as const,
        text: '',
        rawType,
        rawEvent: rawObj,
      }];
    } catch {
      const snapshotText = index === lines.length - 1 ? line : `${line}\n`;
      const delta = toPlainTextDelta(snapshotText, snapshots);
      if (!delta) return [];
      const displayText = index === lines.length - 1 ? delta : delta.replace(/\n$/, '');
      return displayText ? [{ channel: 'answer' as const, text: displayText }] : [];
    }
  });
  return normalized;
}

function extractTraceChunks(obj: Record<string, unknown>): NormalizedStdoutChunk[] {
  const rawType = typeof obj['type'] === 'string' ? obj['type'] : undefined;
  const chunks: NormalizedStdoutChunk[] = [];

  if (obj['type'] === 'reasoning' || obj['type'] === 'function_call' || obj['type'] === 'function_call_output') {
    chunks.push(...extractItemTraceChunks(obj, rawType));
  }

  if (obj['type'] === 'item.started' || obj['type'] === 'item.completed') {
    const item = asRecord(obj['item']);
    if (item) chunks.push(...extractItemTraceChunks(item, rawType));
  }

  if (obj['type'] === 'assistant') {
    const message = asRecord(obj['message']);
    const content = message ? message['content'] : obj['content'];
    chunks.push(...extractAssistantTraceChunks(content, rawType));
  }

  if (obj['type'] === 'user') {
    const message = asRecord(obj['message']);
    const content = message ? message['content'] : obj['content'];
    chunks.push(...extractToolResultTraceChunks(content, rawType));
  }

  return chunks;
}

function extractItemTraceChunks(item: Record<string, unknown>, rawType?: string): NormalizedStdoutChunk[] {
  const itemType = typeof item['type'] === 'string' ? item['type'] : '';
  if (itemType === 'reasoning') {
    const text = extractReasoningText(item);
    if (text) return [buildTraceChunk('thinking', text, rawType, { kind: 'thinking', text })];
    if (typeof item['encrypted_content'] === 'string' && item['encrypted_content']) {
      const encryptedText = 'Codex 返回了加密 reasoning 内容，当前运行环境无法解密显示原文。';
      return [buildTraceChunk('thinking', encryptedText, rawType, { kind: 'thinking', text: encryptedText, encrypted: true })];
    }
    return [];
  }
  if (itemType === 'function_call') {
    const rawName = item['name'];
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : 'tool';
    const input = stringifyTraceValue(item['arguments']);
    const text = input ? `${name} ${input}` : name;
    return [buildTraceChunk('tool', text, rawType, { kind: 'tool', name, input })];
  }
  if (itemType === 'function_call_output') {
    const output = stringifyTraceValue(item['output']);
    if (!output) return [];
    return [buildTraceChunk('tool', output, rawType, { kind: 'tool', name: 'tool_result', input: '', output })];
  }
  if (itemType === 'command_execution' || itemType === 'local_shell_call') {
    const command = extractCommandText(item);
    const output = stringifyTraceValue(item['output']);
    if (!command && !output) return [];
    const text = [command, output].filter(Boolean).join('\n');
    return [buildTraceChunk('command', text, rawType, { kind: 'command', command: command || 'command', output: output || undefined })];
  }
  return [];
}

function extractAssistantTraceChunks(content: unknown, rawType?: string): NormalizedStdoutChunk[] {
  if (!Array.isArray(content)) return [];
  const chunks: NormalizedStdoutChunk[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    const type = typeof p['type'] === 'string' ? p['type'] : '';
    if (type === 'thinking' || type === 'reasoning') {
      const text = extractReasoningText(p);
      if (text) chunks.push(buildTraceChunk('thinking', text, rawType, { kind: 'thinking', text }));
    }
    if (type === 'tool_use') {
      const rawName = p['name'];
      const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : 'tool';
      const input = stringifyTraceValue(p['input']);
      const text = input ? `${name} ${input}` : name;
      chunks.push(buildTraceChunk('tool', text, rawType, { kind: 'tool', name, input }));
    }
  }
  return chunks;
}

function extractToolResultTraceChunks(content: unknown, rawType?: string): NormalizedStdoutChunk[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return null;
      const p = part as Record<string, unknown>;
      if (p['type'] !== 'tool_result') return null;
      const output = stringifyTraceValue(p['content']);
      if (!output) return null;
      return buildTraceChunk('tool', output, rawType, {
        kind: 'tool',
        name: typeof p['tool_name'] === 'string' && p['tool_name'].trim() ? p['tool_name'].trim() : 'tool_result',
        input: '',
        output,
      });
    })
    .filter((chunk): chunk is NormalizedStdoutChunk => Boolean(chunk));
}

function buildTraceChunk(
  channel: Extract<AcpStreamChannel, 'thinking' | 'tool' | 'command'>,
  text: string,
  rawType: string | undefined,
  trace: AcpStreamTrace,
): NormalizedStdoutChunk {
  return { channel, text, rawType, trace };
}

function toAnswerTextDelta(obj: Record<string, unknown>, text: string, snapshots: Map<string, string>): string {
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';
  if (type === 'message.part.updated') {
    const part = getOpenCodeTextPart(obj);
    const partId = typeof part?.['id'] === 'string' ? part.id : null;
    return partId ? toSnapshotDelta(`opencode:${partId}`, text, snapshots) : text;
  }
  if (!isFullAnswerSnapshot(obj)) return text;
  return toSnapshotDelta('answer', text, snapshots);
}

function normalizeCliEventObject(obj: Record<string, unknown>): Record<string, unknown> {
  const payload = asRecord(obj['payload']);
  if (!payload) return obj;
  const outerType = typeof obj['type'] === 'string' ? obj['type'] : '';
  if (outerType === 'response_item' || outerType === 'event_msg') return payload;
  return obj;
}

function toSnapshotDelta(key: string, text: string, snapshots: Map<string, string>): string {
  const previous = snapshots.get(key) ?? '';
  snapshots.set(key, text);
  return text.startsWith(previous) ? text.slice(previous.length) : text;
}

function toPlainTextDelta(text: string, snapshots: Map<string, string>): string {
  const previous = snapshots.get('answer') ?? '';
  if (text.startsWith(previous)) {
    snapshots.set('answer', text);
    return text.slice(previous.length);
  }
  if (previous.endsWith('\n')) {
    const previousWithoutTrailingNewline = previous.slice(0, -1);
    if (text.startsWith(previousWithoutTrailingNewline)) {
      snapshots.set('answer', text);
      return text.slice(previousWithoutTrailingNewline.length);
    }
  }
  if (previous.length >= 3 && text.includes(previous)) {
    snapshots.set('answer', text);
    return text;
  }
  const overlapPrefixLength = findOverlapPrefixLength(previous, text);
  if (overlapPrefixLength > 0) {
    snapshots.set('answer', text);
    return text.slice(overlapPrefixLength);
  }
  snapshots.set('answer', previous + text);
  return text;
}

function findOverlapPrefixLength(previous: string, text: string): number {
  const maxLength = Math.min(previous.length, text.length);
  for (let length = maxLength; length >= 4; length--) {
    if (previous.endsWith(text.slice(0, length))) return length;
  }
  return 0;
}

function isFullAnswerSnapshot(obj: Record<string, unknown>): boolean {
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';
  return type === 'assistant' || type === 'message' || type === 'agent_message' || type === 'result' || isCodexAgentMessage(obj);
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
  if (typeof obj['message'] === 'string') return obj['message'];
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

function extractReasoningText(obj: Record<string, unknown>): string | null {
  const directText = typeof obj['text'] === 'string' ? obj['text'].trim() : '';
  if (directText) return directText;
  const contentText = extractContentText(obj['content']);
  if (contentText?.trim()) return contentText.trim();
  const summary = obj['summary'];
  if (typeof summary === 'string') return summary.trim() || null;
  if (Array.isArray(summary)) {
    const text = summary
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const record = item as Record<string, unknown>;
        return typeof record['text'] === 'string' ? record['text'] : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    return text || null;
  }
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

function extractCommandText(item: Record<string, unknown>): string {
  const command = item['command'];
  if (Array.isArray(command)) return command.map(String).join(' ').trim();
  if (typeof command === 'string') return command.trim();
  const cmd = typeof item['cmd'] === 'string' ? item['cmd'].trim() : '';
  if (cmd) return cmd;
  const args = item['args'];
  if (Array.isArray(args)) return args.map(String).join(' ').trim();
  return '';
}

function stringifyTraceValue(value: unknown): string {
  if (typeof value === 'string') return normalizeEscapedTraceText(value);
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeEscapedTraceText(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
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
  if (type !== 'text' && type !== 'message.part.updated') return false;

  const part = getOpenCodeTextPart(obj);
  if (part['type'] !== 'text' || typeof part['text'] !== 'string') return false;
  const metadata = asRecord(part['metadata']);
  const openai = metadata ? asRecord(metadata['openai']) : null;
  if (openai?.['phase'] === 'final_answer') return true;
  if (openai?.['phase'] !== undefined) return false;
  return type === 'message.part.updated' || !!asRecord(part['time']);
}

function getOpenCodeTextPart(obj: Record<string, unknown>): Record<string, unknown> {
  const data = asRecord(obj['data']) ?? asRecord(obj['properties']) ?? asRecord(obj['payload']) ?? obj;
  return asRecord(data['part']) ?? data;
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

function shouldEmitRawFallback(rawObj: Record<string, unknown>): boolean {
  const type = typeof rawObj['type'] === 'string' ? rawObj['type'] : '';
  if (!type) return true;
  if (type === 'text' || type === 'message.part.updated') return false;
  if (type === 'assistant' || type === 'message' || type === 'agent_message' || type === 'result') return false;
  if (type === 'system' || type === 'user' || type === 'item.started' || type === 'item.completed') return false;
  return true;
}

export { runStreaming };
