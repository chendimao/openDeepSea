import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AgentCapabilities,
  type Client,
  type ContentBlock,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AcpBackend, AcpPermissionMode } from '../types.js';
import type { AcpInvokeResult, AcpStreamChunk } from './types.js';
import type { AcpServerConfig } from './protocol-registry.js';

const DEFAULT_PROTOCOL_STAGE_TIMEOUT_MS = 30_000;
const DEFAULT_PROTOCOL_PROMPT_TIMEOUT_MS = 180_000;
const PROMPT_TIMEOUT_EVENT_DRAIN_MS = 100;
const PROTOCOL_SHUTDOWN_TIMEOUT_MS = 1_000;
const ACP_STREAM_DISCONNECTED_PATTERN = /ResponseStreamDisconnected|stream disconnected before completion|Transport error|network error|error decoding response body/i;
const ACP_HANDLED_RECONNECT_PATTERN = /Handled error during turn:\s*Reconnecting\.\.\.\s*(\d+)\/(\d+)/i;
const CLAUDE_CODE_MISSING_POST_TOOL_HOOK_PATTERN = /^No onPostToolUseHook found for tool use ID: call_[A-Za-z0-9_-]+$/;
const CLAUDE_ACP_SYSTEM_ROLE_DESERIALIZE_PATTERN = /messages\[\d+\]\.role:\s*unknown variant `system`, expected `user` or `assistant`/i;

export interface InvokeProtocolSessionArgs {
  backend: AcpBackend;
  server: AcpServerConfig;
  projectPath: string;
  sessionId: string | null;
  prompt: string;
  imagePaths?: string[];
  acpPermissionMode?: AcpPermissionMode | null;
  acpWritableDirs?: string[] | null;
  envOverrides?: Record<string, string>;
  onChunk: (chunk: AcpStreamChunk) => void;
  onSession?: (sessionId: string) => void;
  signal?: AbortSignal;
  stageTimeoutMs?: number;
  promptTimeoutMs?: number;
}

export async function invokeProtocolSession(
  args: InvokeProtocolSessionArgs,
): Promise<AcpInvokeResult> {
  let child: ChildProcessWithoutNullStreams | null = null;
  let stderr = '';
  let rawStderr = '';
  let activeSessionId = args.sessionId;
  let initialized = false;
  let promptStarted = false;
  let eventReceived = false;
  let answerReceived = false;
  let rejectStreamDisconnect: ((error: Error) => void) | null = null;
  const stageTimeoutMs = args.stageTimeoutMs ?? readProtocolStageTimeoutMs(process.env.OPENCLAW_ACP_STAGE_TIMEOUT_MS);
  const promptTimeoutMs = args.promptTimeoutMs ?? readProtocolTimeoutMs(
    process.env.OPENCLAW_ACP_PROMPT_TIMEOUT_MS,
    DEFAULT_PROTOCOL_PROMPT_TIMEOUT_MS,
  );

  try {
    child = spawn(args.server.command, args.server.args, {
      cwd: args.projectPath,
      env: { ...process.env, ...(args.server.env ?? {}), ...(args.envOverrides ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const childExit = waitForChild(child);
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (data: string) => {
      rawStderr += data;
      const reportableData = filterProtocolStderr(args.backend, data);
      if (!reportableData) return;
      if (isAcpHandledReconnect(data)) {
        args.onChunk({
          stream: 'stderr',
          text: formatHandledReconnectActivity(data, args.backend),
          channel: 'activity',
          rawType: 'protocol.retry',
        });
        return;
      }
      stderr += reportableData;
      args.onChunk({
        stream: 'stderr',
        text: reportableData,
        channel: 'activity',
        rawType: 'protocol.stderr',
      });
      if (isAcpStreamDisconnected(reportableData)) {
        rejectStreamDisconnect?.(new Error('ACP stream disconnected before completion'));
      }
    });

    child.on('error', (error) => {
      stderr += `\n[protocol spawn error] ${error.message}`;
    });
    const spawnFailure = new Promise<never>((_, reject) => {
      child?.once('error', reject);
    });

    const additionalDirectories = normalizeAdditionalDirectories(args.acpWritableDirs ?? [], args.projectPath);
    const client = createProtocolClient({
      projectPath: args.projectPath,
      allowedRoots: [args.projectPath, ...additionalDirectories],
      permissionMode: args.acpPermissionMode ?? 'bypass',
      onChunk: args.onChunk,
      onSessionUpdate: (notification) => {
        eventReceived = true;
        const rawEvent = {
          method: 'session/update',
          params: notification as unknown as Record<string, unknown>,
        };
        args.onChunk({
          stream: 'stdout',
          text: '',
          channel: 'event',
          rawType: notification.update.sessionUpdate,
          rawEvent,
        });

        const answerText = extractAgentText(notification);
        if (answerText) {
          answerReceived = true;
          args.onChunk({
            stream: 'stdout',
            text: answerText,
            channel: 'answer',
            rawType: notification.update.sessionUpdate,
          });
        }
      },
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(() => client, stream);

    const abortHandler = (): void => {
      if (activeSessionId) {
        void connection.cancel({ sessionId: activeSessionId }).catch(() => undefined);
      }
      child?.kill('SIGTERM');
    };
    args.signal?.addEventListener('abort', abortHandler, { once: true });

    const initializeResult = await withTimeout(
      Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: {
            name: 'openclaw-room',
            title: 'OpenClaw Room',
            version: '0.1.0',
          },
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: false,
          },
        }),
        spawnFailure,
      ]),
      stageTimeoutMs,
      'ACP initialize timed out',
    );
    initialized = true;
    const agentCapabilities = initializeResult.agentCapabilities;

    if (activeSessionId && canResumeSession(agentCapabilities)) {
      await withTimeout(
        connection.resumeSession({
          sessionId: activeSessionId,
          cwd: args.projectPath,
          mcpServers: [],
          additionalDirectories,
        }),
        stageTimeoutMs,
        'ACP resumeSession timed out',
      );
    } else {
      const newSession = await withTimeout(
        connection.newSession({
          cwd: args.projectPath,
          mcpServers: [],
          additionalDirectories,
        }),
        stageTimeoutMs,
        'ACP newSession timed out',
      );
      activeSessionId = newSession.sessionId;
      args.onSession?.(activeSessionId);
    }

    promptStarted = true;
    const streamDisconnect = new Promise<never>((_, reject) => {
      rejectStreamDisconnect = reject;
    });
    let promptResult = await promptActiveSession({
      connection,
      sessionId: activeSessionId,
      prompt: args.prompt,
      imagePaths: args.imagePaths ?? [],
      promptTimeoutMs,
      streamDisconnect,
    }).catch(async (error) => {
      if (
        args.backend !== 'claudecode' ||
        !args.sessionId ||
        eventReceived ||
        !isClaudeAcpSystemRoleDeserializeError(`${error instanceof Error ? error.message : String(error)}\n${rawStderr}`)
      ) {
        throw error;
      }

      await connection.closeSession({ sessionId: activeSessionId! }).catch(() => undefined);
      const newSession = await withTimeout(
        connection.newSession({
          cwd: args.projectPath,
          mcpServers: [],
          additionalDirectories,
        }),
        stageTimeoutMs,
        'ACP newSession timed out',
      );
      activeSessionId = newSession.sessionId;
      args.onSession?.(activeSessionId);
      args.onChunk({
        stream: 'stdout',
        text: '[ACP session reset] Claude Code ACP could not resume the previous session because its history contains unsupported system-role messages; started a fresh session.\n',
        channel: 'activity',
        rawType: 'protocol.session_reset',
      });
      return promptActiveSession({
        connection,
        sessionId: activeSessionId,
        prompt: args.prompt,
        imagePaths: args.imagePaths ?? [],
        promptTimeoutMs,
        streamDisconnect,
      });
    });
    rejectStreamDisconnect = null;

    args.signal?.removeEventListener('abort', abortHandler);
    const shutdownExitCode = await shutdownProtocolChild({
      child,
      childExit,
      closeSession: () => connection.closeSession({ sessionId: activeSessionId! }),
    });
    const exitCode = promptResult.stopReason === 'cancelled' ? 130 : shutdownExitCode;
    return {
      exitCode,
      sessionId: activeSessionId,
      stderr,
      fallbackSafe: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (activeSessionId && (message === 'ACP prompt timed out' || isAcpStreamDisconnected(message))) {
      if (message === 'ACP prompt timed out') {
        await delay(PROMPT_TIMEOUT_EVENT_DRAIN_MS);
      }
      if (answerReceived) {
        child?.kill('SIGTERM');
        return {
          exitCode: 0,
          sessionId: activeSessionId,
          stderr,
          fallbackSafe: false,
          retrySafe: false,
        };
      }
    }
    child?.kill('SIGTERM');
    const retrySafe = initialized && promptStarted && !eventReceived;
    return {
      exitCode: -1,
      sessionId: activeSessionId,
      stderr: stderr ? `${stderr}\n${message}` : message,
      fallbackSafe: !initialized && !promptStarted && !eventReceived,
      retrySafe,
    };
  }
}

async function promptActiveSession(args: {
  connection: ClientSideConnection;
  sessionId: string;
  prompt: string;
  imagePaths: string[];
  promptTimeoutMs: number;
  streamDisconnect: Promise<never>;
}) {
  return withTimeout(
    Promise.race([
      args.connection.prompt({
        sessionId: args.sessionId,
        prompt: buildPromptContent(args.prompt, args.imagePaths),
      }),
      args.streamDisconnect,
    ]),
    args.promptTimeoutMs,
    'ACP prompt timed out',
  );
}

export function filterProtocolStderr(backend: AcpBackend, data: string): string {
  if (backend !== 'claudecode') return data;
  if (CLAUDE_ACP_SYSTEM_ROLE_DESERIALIZE_PATTERN.test(data)) return '';
  const newline = data.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = data.endsWith('\n');
  const lines = data.split(/\r?\n/);
  if (endsWithNewline) lines.pop();
  const kept = lines.filter((line) => !CLAUDE_CODE_MISSING_POST_TOOL_HOOK_PATTERN.test(line.trim()));
  if (kept.length === 0) return '';
  return `${kept.join(newline)}${endsWithNewline ? newline : ''}`;
}

function createProtocolClient(args: {
  projectPath: string;
  allowedRoots: string[];
  permissionMode: AcpPermissionMode;
  onChunk: (chunk: AcpStreamChunk) => void;
  onSessionUpdate: (notification: SessionNotification) => void;
}): Client {
  return {
    async sessionUpdate(params) {
      args.onSessionUpdate(params);
    },

    async requestPermission(params) {
      if (args.permissionMode === 'read-only') {
        return {
          outcome: {
            outcome: 'cancelled',
          },
        };
      }

      const allowOption = params.options.find((option) => option.kind === 'allow_once')
        ?? params.options.find((option) => option.kind === 'allow_always');

      if (!allowOption) {
        return {
          outcome: {
            outcome: 'cancelled',
          },
        };
      }

    if (args.permissionMode === 'workspace-write' && !isWorkspaceWritablePermission(params.toolCall)) {
      args.onChunk({
        stream: 'stdout',
        text: '',
        channel: 'event',
        rawType: 'permission_request',
        rawEvent: {
          type: 'permission_request',
          outcome: 'cancelled',
          reason: 'unsupported_workspace_write_tool',
          toolCall: params.toolCall,
        },
      });
      return {
        outcome: {
          outcome: 'cancelled',
          },
        };
      }

      args.onChunk({
        stream: 'stdout',
        text: '',
        channel: 'event',
        rawType: 'permission_request',
        rawEvent: {
          type: 'permission_request',
          outcome: 'selected',
          optionId: allowOption.optionId,
          toolCall: params.toolCall,
        },
      });

      return {
        outcome: {
          outcome: 'selected',
          optionId: allowOption.optionId,
        },
      };
    },

    async readTextFile(params) {
      await assertReadableInsideAllowedRoots(params.path, args.allowedRoots);
      return {
        content: await readFile(params.path, 'utf-8'),
      };
    },

    async writeTextFile(params) {
      await assertWritableInsideAllowedRoots(params.path, args.allowedRoots);
      if (args.permissionMode === 'read-only') {
        throw new Error('ACP client is in read-only mode');
      }
      await writeFile(params.path, params.content, 'utf-8');
      return {};
    },
  };
}

function buildPromptContent(prompt: string, imagePaths: string[]): ContentBlock[] {
  const content: ContentBlock[] = [
    {
      type: 'text',
      text: prompt,
    },
  ];

  for (const imagePath of normalizeAdditionalDirectories(imagePaths, '')) {
    content.push({
      type: 'resource_link',
      name: imagePath.split('/').pop() || imagePath,
      uri: `file://${imagePath}`,
    });
  }

  return content;
}

function extractAgentText(notification: SessionNotification): string | null {
  const update = notification.update;
  if (update.sessionUpdate !== 'agent_message_chunk') return null;
  const content = update.content;
  return content.type === 'text' && content.text ? content.text : null;
}

function normalizeAdditionalDirectories(paths: string[], exclude: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path || path === exclude || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}

async function assertReadableInsideAllowedRoots(path: string, roots: string[]): Promise<void> {
  await assertResolvedPathInsideAllowedRoots(await realpath(path), roots);
}

async function assertWritableInsideAllowedRoots(path: string, roots: string[]): Promise<void> {
  const target = resolve(path);
  const existingTarget = await realpath(target).catch(() => null);
  if (existingTarget) {
    await assertResolvedPathInsideAllowedRoots(existingTarget, roots);
    return;
  }
  await assertResolvedPathInsideAllowedRoots(await realpath(dirname(target)), roots);
}

async function assertResolvedPathInsideAllowedRoots(path: string, roots: string[]): Promise<void> {
  const normalizedPath = resolve(path);
  const normalizedRoots = await Promise.all(roots.map(async (root) => realpath(root).catch(() => resolve(root))));
  if (normalizedRoots.some((root) => isPathInsideRoot(normalizedPath, root))) return;
  throw new Error(`ACP file access outside allowed roots is not allowed: ${path}`);
}

function isPathInsideRoot(path: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  const rel = relative(normalizedRoot, path);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function waitForChild(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve) => {
    child.on('close', (code) => {
      resolve(code ?? 0);
    });
  });
}

async function shutdownProtocolChild(args: {
  child: ChildProcessWithoutNullStreams;
  childExit: Promise<number>;
  closeSession: () => Promise<unknown>;
}): Promise<number> {
  await withTimeout(
    args.closeSession().catch(() => undefined),
    PROTOCOL_SHUTDOWN_TIMEOUT_MS,
    'ACP closeSession timed out',
  ).catch(() => undefined);

  if (!args.child.killed) {
    args.child.kill('SIGTERM');
  }

  const exitCode = await Promise.race([
    args.childExit,
    delay(PROTOCOL_SHUTDOWN_TIMEOUT_MS).then(() => null),
  ]);
  if (exitCode !== null) return exitCode;

  args.child.kill('SIGKILL');
  await Promise.race([
    args.childExit,
    delay(PROTOCOL_SHUTDOWN_TIMEOUT_MS),
  ]);
  return 0;
}

function isWorkspaceWritablePermission(toolCall: { kind?: string | null; title?: string | null }): boolean {
  const kind = toolCall.kind ?? '';
  if (kind === 'read' || kind === 'edit' || kind === 'delete' || kind === 'move' || kind === 'search') return true;
  const title = (toolCall.title ?? '').toLowerCase();
  return /read|search|edit|write|delete|move|patch|file/.test(title);
}

function canResumeSession(capabilities: AgentCapabilities | undefined): boolean {
  return !!capabilities?.sessionCapabilities?.resume;
}

function readProtocolStageTimeoutMs(value: string | undefined): number {
  return readProtocolTimeoutMs(value, DEFAULT_PROTOCOL_STAGE_TIMEOUT_MS);
}

function readProtocolTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isAcpStreamDisconnected(value: string): boolean {
  return ACP_STREAM_DISCONNECTED_PATTERN.test(value);
}

export function isAcpHandledReconnect(value: string): boolean {
  return ACP_HANDLED_RECONNECT_PATTERN.test(value);
}

function isClaudeAcpSystemRoleDeserializeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CLAUDE_ACP_SYSTEM_ROLE_DESERIALIZE_PATTERN.test(message);
}

function formatHandledReconnectActivity(value: string, backend: AcpBackend): string {
  const match = value.match(ACP_HANDLED_RECONNECT_PATTERN);
  const attempt = match?.[1];
  const total = match?.[2];
  const retryLabel = attempt && total ? ` ${attempt}/${total}` : '';
  return `[ACP retry] ${backend} ACP stream disconnected; provider reconnecting${retryLabel}.\n`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
