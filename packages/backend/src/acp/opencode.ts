import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliSessionSummary } from '../types.js';
import type { AcpPermissionMode } from '../types.js';
import type { ProviderRuntimeConfig } from '../provider-configs/types.js';
import type { SessionAdapter } from './types.js';
import { emitProtocolFallback, fallbackToProtocolNewSessionAfterCliResumeFailure, runStreaming, withSessionHandoffForNewSession } from './claudecode.js';
import { invokeProtocolSession } from './protocol-client.js';
import { getAcpServerConfig } from './protocol-registry.js';
import type { AcpInvokeResult } from './types.js';

const DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

interface OpenCodeRow {
  id: string;
  title: string | null;
  cwd: string | null;
  created_at: number | null;
  updated_at: number | null;
  message_count: number | null;
  first_user: string | null;
}

export const openCodeAdapter: SessionAdapter = {
  backend: 'opencode',

  async listSessions(projectPath: string): Promise<CliSessionSummary[]> {
    if (!existsSync(DB_PATH)) return [];
    let db: Database.Database;
    try {
      db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    } catch {
      return [];
    }
    try {
      // OpenCode schema varies by version. Try a few likely table/column shapes.
      const candidateQueries = [
        `SELECT id, title, cwd, created_at, updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
                (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY created_at ASC LIMIT 1) AS first_user
         FROM sessions s WHERE cwd = ? ORDER BY updated_at DESC LIMIT 200`,
        `SELECT id, title, directory AS cwd, created_at, updated_at,
                NULL AS message_count, NULL AS first_user
         FROM session WHERE directory = ? ORDER BY updated_at DESC LIMIT 200`,
        `SELECT id, title, cwd, time_created AS created_at, time_updated AS updated_at,
                NULL AS message_count, NULL AS first_user
         FROM session WHERE cwd = ? ORDER BY time_updated DESC LIMIT 200`,
      ];
      let rows: OpenCodeRow[] = [];
      for (const q of candidateQueries) {
        try {
          rows = db.prepare(q).all(projectPath) as OpenCodeRow[];
          if (rows.length >= 0) break;
        } catch {
          // try next
        }
      }
      return rows.map((r) => ({
        backend: 'opencode' as const,
        sessionId: r.id,
        title: r.title?.trim() || (r.first_user ?? '').slice(0, 80) || r.id.slice(0, 8),
        cwd: r.cwd ?? projectPath,
        messageCount: r.message_count ?? 0,
        lastActivity: r.updated_at ?? r.created_at ?? Date.now(),
        firstUserMessage: r.first_user?.slice(0, 200),
      }));
    } finally {
      db.close();
    }
  },

  async invoke({ projectPath, sessionId, prompt, sessionHandoff, sessionHandoffMode, imagePaths, acpPermissionMode, acpWritableDirs, providerRuntimeConfig, envOverrides, onChunk, onSession, signal }) {
    const protocolConfig = getAcpServerConfig('opencode');
    const mergedEnvOverrides = mergeRuntimeEnvOverrides(buildOpenCodeRuntimeEnvOverrides(providerRuntimeConfig), envOverrides);
    let resumeUnavailableResult: AcpInvokeResult | null = null;
    if (protocolConfig.enabled) {
      const protocolResult = await invokeProtocolSession({
        backend: 'opencode',
        server: protocolConfig,
        projectPath,
        sessionId,
        prompt,
        sessionHandoff,
        sessionHandoffMode,
        imagePaths,
        acpPermissionMode,
        acpWritableDirs,
        envOverrides: mergedEnvOverrides,
        onChunk,
        onSession,
        signal,
      });
      if (
        (protocolResult.exitCode === 0 && !protocolResult.resumeUnavailable) ||
        protocolConfig.mode === 'protocol' ||
        protocolResult.fallbackSafe === false
      ) {
        return protocolResult;
      }
      resumeUnavailableResult = protocolResult.resumeUnavailable ? protocolResult : null;
      emitProtocolFallback(onChunk, 'opencode', protocolResult.stderr);
    }

    const legacyPrompt = withSessionHandoffForNewSession(prompt, sessionId, sessionHandoff, sessionHandoffMode);
    const args = buildOpenCodeArgs({
      sessionId,
      prompt: legacyPrompt,
      filePaths: imagePaths ?? [],
      permissionMode: acpPermissionMode ?? 'bypass',
      model: resolveOpenCodeModel(providerRuntimeConfig, process.env.OPENCLAW_OPENCODE_MODEL),
    });
    const cliResult = await runStreaming('opencode', args, projectPath, onChunk, signal, onSession, undefined, mergedEnvOverrides);
    const fakeResumeResult = await fallbackToProtocolNewSessionAfterCliResumeFailure({
      backend: 'opencode',
      protocolConfig,
      protocolResult: resumeUnavailableResult,
      cliResult,
      projectPath,
      prompt,
      previousSessionId: sessionId,
      sessionHandoff,
      imagePaths,
      acpPermissionMode,
      acpWritableDirs,
      envOverrides: mergedEnvOverrides,
      onChunk,
      onSession,
      signal,
    });
    return fakeResumeResult ?? cliResult;
  },
};

export function buildOpenCodeArgs(args: {
  sessionId: string | null;
  prompt: string;
  filePaths?: string[];
  permissionMode: AcpPermissionMode;
  model: string | null;
}): string[] {
  const cliArgs: string[] = ['run'];
  if (args.sessionId) cliArgs.push('--session', args.sessionId);
  cliArgs.push('--format', 'json');
  const model = normalizedString(args.model);
  if (model) cliArgs.push('--model', model);
  if (args.permissionMode === 'bypass') {
    cliArgs.push('--dangerously-skip-permissions');
  }
  for (const filePath of normalizeFilePaths(args.filePaths ?? [])) {
    cliArgs.push('--file', filePath);
  }
  cliArgs.push(args.prompt);
  return cliArgs;
}

function resolveOpenCodeModel(
  providerRuntimeConfig: ProviderRuntimeConfig | null | undefined,
  envModel: string | undefined,
): string | null {
  if (providerRuntimeConfig?.run_overrides_enabled) {
    const runtimeModel = normalizedString(providerRuntimeConfig.model);
    if (runtimeModel) return runtimeModel;
  }
  return normalizedString(envModel);
}

function buildOpenCodeRuntimeEnvOverrides(config?: ProviderRuntimeConfig | null): Record<string, string> {
  if (!config?.run_overrides_enabled) return {};
  return compactEnv({
    OPENAI_BASE_URL: config.base_url,
    OPENAI_API_KEY: config.api_key,
  });
}

function mergeRuntimeEnvOverrides(
  runtimeEnv: Record<string, string>,
  envOverrides?: Record<string, string>,
): Record<string, string> | undefined {
  const merged = { ...(envOverrides ?? {}), ...runtimeEnv };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function compactEnv(input: Record<string, string | null | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = normalizedString(value);
    if (normalized) output[key] = normalized;
  }
  return output;
}

function normalizedString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeFilePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}
