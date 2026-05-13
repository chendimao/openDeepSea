import type { AcpBackend, CliSessionSummary } from '../types.js';

export interface SessionAdapter {
  backend: AcpBackend;
  /** List sessions whose cwd matches the given project path. */
  listSessions(projectPath: string): Promise<CliSessionSummary[]>;
  /**
   * Spawn a CLI invocation that resumes a session and streams output.
   * onChunk receives stdout chunks as they arrive.
   */
  invoke(args: {
    projectPath: string;
    sessionId: string | null;
    prompt: string;
    onChunk: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number; sessionId: string | null; stderr: string }>;
}
