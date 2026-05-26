import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AcpBackend, AcpPermissionMode } from '../types.js';
import type { AcpInvokeResult, AcpStreamChunk } from './types.js';
import type { AcpServerConfig } from './protocol-registry.js';

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

    await Promise.race([
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
    ]);
    initialized = true;

    if (activeSessionId) {
      await connection.resumeSession({
        sessionId: activeSessionId,
        cwd: args.projectPath,
        mcpServers: [],
        additionalDirectories,
      });
    } else {
      const newSession = await connection.newSession({
        cwd: args.projectPath,
        mcpServers: [],
        additionalDirectories,
      });
      activeSessionId = newSession.sessionId;
      args.onSession?.(activeSessionId);
    }

    promptStarted = true;
    const promptResult = await connection.prompt({
      sessionId: activeSessionId,
      prompt: buildPromptContent(args.prompt, args.imagePaths ?? []),
    });

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
  onSessionUpdate: (notification: SessionNotification) => void;
}): Client {
  return {
    async sessionUpdate(params) {
      args.onSessionUpdate(params);
    },

    async requestPermission(params) {
      if (args.permissionMode !== 'bypass') {
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
