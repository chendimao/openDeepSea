import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { spawn, type IPty } from 'node-pty';
import { projectRepo } from '../repos/projects.js';
import { wsHub } from '../ws-hub.js';
import { parseRestrictedSkillsCommand } from './restricted-skills-shell.js';
import type { CreateTerminalSessionInput, TerminalProfile, TerminalSessionInfo, TerminalStatus } from './types.js';

type RunningMode = 'shell' | 'restricted-prompt' | 'restricted-command';

interface TerminalSession {
  info: TerminalSessionInfo;
  cols: number;
  rows: number;
  pty: IPty | null;
  lineBuffer: string;
  outputLog: string;
  mode: RunningMode;
  killed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, TerminalSession>();
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_LOG_LENGTH = 200_000;
const RESTRICTED_PROMPT = '\r\nskills-install> ';

export const terminalService = {
  create(input: CreateTerminalSessionInput): TerminalSessionInfo {
    const cwd = resolveTerminalCwd(input.profile, input.projectId);
    const now = Date.now();
    const session: TerminalSession = {
      info: {
        id: nanoid(12),
        profile: input.profile,
        cwd,
        status: 'running',
        startedAt: now,
        endedAt: null,
        exitCode: null,
        signal: null,
      },
      cols: clampDimension(input.cols, 20, 240),
      rows: clampDimension(input.rows, 8, 80),
      pty: null,
      lineBuffer: '',
      outputLog: '',
      mode: input.profile === 'skills_install' ? 'restricted-prompt' : 'shell',
      killed: false,
      idleTimer: null,
    };
    sessions.set(session.info.id, session);
    startIdleTimer(session);
    if (input.profile === 'project_shell') {
      spawnShell(session);
    } else {
      send(session, [
        'Skills 安装终端已启动。可运行：',
        '  npx --yes skills find <关键词>',
        '  npx --yes skills add <skill>',
        '  npx --yes skills check',
        '  npx --yes skills update',
        RESTRICTED_PROMPT,
      ].join('\r\n'));
    }
    return { ...session.info };
  },

  get(sessionId: string): TerminalSessionInfo | null {
    const session = sessions.get(sessionId);
    return session ? { ...session.info } : null;
  },

  input(sessionId: string, data: string): void {
    const session = requireSession(sessionId);
    touch(session);
    if (session.info.status !== 'running') return;
    if (session.info.profile === 'project_shell' || session.mode === 'restricted-command') {
      session.pty?.write(data);
      return;
    }
    handleRestrictedPromptInput(session, data);
  },

  resize(sessionId: string, cols: number, rows: number): void {
    const session = requireSession(sessionId);
    session.cols = clampDimension(cols, 20, 240);
    session.rows = clampDimension(rows, 8, 80);
    session.pty?.resize(session.cols, session.rows);
    touch(session);
  },

  kill(sessionId: string): void {
    const session = requireSession(sessionId);
    session.killed = true;
    if (session.pty) {
      session.pty.kill();
      return;
    }
    markEnded(session, 'killed', null, null);
  },

  subscribe(sessionId: string, socket: import('ws').WebSocket): TerminalSessionInfo {
    const session = requireSession(sessionId);
    wsHub.subscribeTerminal(sessionId, socket);
    sendToSocket(socket, { type: 'terminal:ready', sessionId, cwd: session.info.cwd, profile: session.info.profile });
    if (session.outputLog) sendToSocket(socket, { type: 'terminal:output', sessionId, data: session.outputLog });
    sendToSocket(socket, { type: 'terminal:status', sessionId, status: session.info.status });
    return { ...session.info };
  },

  unsubscribe(sessionId: string, socket: import('ws').WebSocket): void {
    wsHub.unsubscribeTerminal(sessionId, socket);
  },

  removeSocket(socket: import('ws').WebSocket): void {
    wsHub.removeTerminalSocket(socket);
  },
};

function resolveTerminalCwd(profile: TerminalProfile, projectId?: string | null): string {
  if (projectId) {
    const project = projectRepo.get(projectId);
    if (!project) throw new Error('project not found');
    return project.path;
  }
  if (profile === 'skills_install') return process.env.OPENDEEPSEA_TERMINAL_CWD || process.cwd();
  return process.env.OPENDEEPSEA_TERMINAL_CWD || process.cwd();
}

function spawnShell(session: TerminalSession): void {
  const shell = process.env.SHELL || '/bin/zsh';
  session.pty = spawn(shell, [], buildPtyOptions(session));
  bindPty(session, false);
}

function spawnRestrictedCommand(session: TerminalSession, file: string, args: string[]): void {
  session.mode = 'restricted-command';
  session.lineBuffer = '';
  session.pty = spawn(file, args, buildPtyOptions(session));
  bindPty(session, true);
}

function buildPtyOptions(session: TerminalSession) {
  return {
    name: 'xterm-256color',
    cols: session.cols,
    rows: session.rows,
    cwd: session.info.cwd,
    env: {
      ...process.env,
      HOME: process.env.HOME || homedir(),
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
    },
  };
}

function bindPty(session: TerminalSession, restrictedCommand: boolean): void {
  session.pty?.onData((data) => {
    touch(session);
    send(session, data);
  });
  session.pty?.onExit(({ exitCode, signal }) => {
    const normalizedSignal = signal === undefined ? null : String(signal);
    session.pty = null;
    if (restrictedCommand && session.info.status === 'running') {
      wsHub.broadcastTerminal(session.info.id, { type: 'platform_skills:refresh_requested' });
      session.mode = 'restricted-prompt';
      if (exitCode !== 0 || normalizedSignal) {
        send(session, `\r\n[skills command exited: ${normalizedSignal ? `signal ${normalizedSignal}` : `code ${exitCode}`}]`);
      }
      send(session, RESTRICTED_PROMPT);
      return;
    }
    markEnded(session, session.killed ? 'killed' : 'exited', exitCode, normalizedSignal);
  });
}

function handleRestrictedPromptInput(session: TerminalSession, data: string): void {
  for (const char of data) {
    if (char === '\u0003') {
      session.lineBuffer = '';
      send(session, '^C' + RESTRICTED_PROMPT);
      continue;
    }
    if (char === '\r' || char === '\n') {
      send(session, '\r\n');
      const command = session.lineBuffer;
      session.lineBuffer = '';
      runRestrictedCommandLine(session, command);
      continue;
    }
    if (char === '\u007f' || char === '\b') {
      if (session.lineBuffer.length > 0) {
        session.lineBuffer = session.lineBuffer.slice(0, -1);
        send(session, '\b \b');
      }
      continue;
    }
    if (char >= ' ') {
      session.lineBuffer += char;
      send(session, char);
    }
  }
}

function runRestrictedCommandLine(session: TerminalSession, commandLine: string): void {
  try {
    const command = parseRestrictedSkillsCommand(commandLine);
    if (command.kind === 'empty') {
      send(session, RESTRICTED_PROMPT);
      return;
    }
    if (command.kind === 'local') {
      runLocalRestrictedCommand(session, command.name);
      return;
    }
    spawnRestrictedCommand(session, command.file, command.args);
  } catch (err) {
    send(session, `\x1b[31m${(err as Error).message}\x1b[0m${RESTRICTED_PROMPT}`);
  }
}

function runLocalRestrictedCommand(session: TerminalSession, name: 'clear' | 'exit' | 'pwd'): void {
  if (name === 'clear') {
    send(session, '\x1b[2J\x1b[H' + RESTRICTED_PROMPT.trimStart());
    return;
  }
  if (name === 'pwd') {
    send(session, `${session.info.cwd}${RESTRICTED_PROMPT}`);
    return;
  }
  markEnded(session, 'exited', 0, null);
}

function markEnded(session: TerminalSession, status: TerminalStatus, exitCode: number | null, signal: string | null): void {
  if (session.info.status !== 'running') return;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  session.info.status = status;
  session.info.endedAt = Date.now();
  session.info.exitCode = exitCode;
  session.info.signal = signal;
  wsHub.broadcastTerminal(session.info.id, { type: 'terminal:status', sessionId: session.info.id, status });
  wsHub.broadcastTerminal(session.info.id, { type: 'terminal:exit', sessionId: session.info.id, exitCode, signal });
}

function send(session: TerminalSession, data: string): void {
  session.outputLog += data;
  if (session.outputLog.length > MAX_OUTPUT_LOG_LENGTH) {
    session.outputLog = session.outputLog.slice(-MAX_OUTPUT_LOG_LENGTH);
  }
  wsHub.broadcastTerminal(session.info.id, { type: 'terminal:output', sessionId: session.info.id, data });
}

function sendToSocket(socket: import('ws').WebSocket, event: import('../types.js').WsServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

function requireSession(sessionId: string): TerminalSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('terminal session not found');
  return session;
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function touch(session: TerminalSession): void {
  startIdleTimer(session);
}

function startIdleTimer(session: TerminalSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.info.status !== 'running') return;
  session.idleTimer = setTimeout(() => {
    session.killed = true;
    session.pty?.kill();
    markEnded(session, 'idle-timeout', null, null);
  }, IDLE_TIMEOUT_MS);
}
