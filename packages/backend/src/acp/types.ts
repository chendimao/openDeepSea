import type { AcpBackend, AcpPermissionMode, CliSessionSummary } from '../types.js';

export type AcpStreamChannel = 'answer' | 'activity' | 'thinking' | 'tool' | 'command';

export type AcpStreamTrace =
  | {
    kind: 'thinking';
    text: string;
  }
  | {
    kind: 'tool';
    name: string;
    input: string;
    output?: string;
  }
  | {
    kind: 'command';
    command: string;
    output?: string;
  };

export interface AcpStreamChunk {
  stream: 'stdout' | 'stderr';
  text: string;
  channel?: AcpStreamChannel;
  rawType?: string;
  trace?: AcpStreamTrace;
}

export interface SessionAdapter {
  backend: AcpBackend;
  /** List sessions whose cwd matches the given project path. */
  listSessions(projectPath: string): Promise<CliSessionSummary[]>;
  /**
   * Spawn a CLI invocation that resumes a session and streams output.
   * onChunk receives stdout/stderr chunks as they arrive.
   * stdout chunks may be separated into final answer text and visible activity summaries.
   */
  invoke(args: {
    projectPath: string;
    sessionId: string | null;
    prompt: string;
    imagePaths?: string[];
    acpPermissionMode?: AcpPermissionMode | null;
    /** Final absolute directories allowed for write access. Empty means no additional write scope. */
    acpWritableDirs?: string[] | null;
    onChunk: (chunk: AcpStreamChunk) => void;
    onSession?: (sessionId: string) => void;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number; sessionId: string | null; stderr: string }>;
}
