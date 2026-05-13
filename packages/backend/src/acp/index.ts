import type { AcpBackend } from '../types.js';
import { claudeCodeAdapter } from './claudecode.js';
import { codexAdapter } from './codex.js';
import { openCodeAdapter } from './opencode.js';
import type { SessionAdapter } from './types.js';

export const adapters: Record<AcpBackend, SessionAdapter> = {
  claudecode: claudeCodeAdapter,
  codex: codexAdapter,
  opencode: openCodeAdapter,
};

export function getAdapter(backend: AcpBackend): SessionAdapter {
  return adapters[backend];
}

export type { SessionAdapter } from './types.js';
