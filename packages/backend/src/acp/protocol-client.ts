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

export interface InvokeProtocolSessionArgs {
  backend: AcpBackend;
  server: AcpServerConfig;
  projectPath: string;
  sessionId: string | null;
  prompt: string;
  imagePaths?: string[];
  acpPermissionMode?: AcpPermissionMode | null;
  acpWritableDirs?: string[] | null;
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
  let activeSessionId = args.sessionId;
  let initialized = false;
  let promptStarted = false;
  let eventReceived = false;
  const stageTimeoutMs = args.stageTimeoutMs ?? readProtocolStageTimeoutMs(process.env.OPENCLAW_ACP_STAGE_TIMEOUT_MS);
  const promptTimeoutMs = args.promptTimeoutMs ?? readProtocolTimeoutMs(
    process.env.OPENCLAW_ACP_PROMPT_TIMEOUT_MS,
    DEFAULT_PROTOCOL_PROMPT_TIMEOUT_MS,
  );

  try {
    child = spawn(args.server.command, args.server.args, {
      cwd: args.projectPath,
      env: { ...process.env, ...(args.server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const childExit = waitForChild(child);
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (data: string) => {
      stderr += data;
      args.onChunk({
        stream: 'stderr',
        text: data,
        channel: 'activity',
        rawType: 'protocol.stderr',
      });
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
    const promptResult = await withTimeout(
      connection.prompt({
        sessionId: activeSessionId,
        prompt: buildPromptContent(args.prompt, args.imagePaths ?? []),
      }),
      promptTimeoutMs,
      'ACP prompt timed out',
    );

    await connection.closeSession({ sessionId: activeSessionId }).catch(() => undefined);
    child.kill('SIGTERM');
    const exitCode = await childExit;
    args.signal?.removeEventListener('abort', abortHandler);
    return {
      exitCode: promptResult.stopReason === 'cancelled' ? 130 : exitCode,
      sessionId: activeSessionId,
      stderr,
      fallbackSafe: false,
    };
  } catch (error) {
    child?.kill('SIGTERM');
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: -1,
      sessionId: activeSessionId,
      stderr: stderr ? `${stderr}\n${message}` : message,
      fallbackSafe: !initialized && !promptStarted && !eventReceived,
    };
  }
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
