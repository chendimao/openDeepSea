export type TerminalProfile = 'project_shell' | 'skills_install';
export type TerminalStatus = 'running' | 'exited' | 'failed' | 'killed' | 'idle-timeout';

export interface TerminalSessionInfo {
  id: string;
  profile: TerminalProfile;
  cwd: string;
  status: TerminalStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
}

export interface CreateTerminalSessionInput {
  profile: TerminalProfile;
  projectId?: string | null;
  cols: number;
  rows: number;
}

export type TerminalServerEvent =
  | { type: 'terminal:ready'; sessionId: string; cwd: string; profile: TerminalProfile }
  | { type: 'terminal:output'; sessionId: string; data: string }
  | { type: 'terminal:status'; sessionId: string; status: TerminalStatus }
  | { type: 'terminal:exit'; sessionId: string; exitCode: number | null; signal: string | null }
  | { type: 'platform_skills:refresh_requested' };

export type TerminalClientEvent =
  | { type: 'terminal:subscribe'; sessionId: string }
  | { type: 'terminal:unsubscribe'; sessionId: string }
  | { type: 'terminal:input'; sessionId: string; data: string }
  | { type: 'terminal:resize'; sessionId: string; cols: number; rows: number }
  | { type: 'terminal:kill'; sessionId: string };
