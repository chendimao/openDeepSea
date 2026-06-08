import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Power, TerminalSquare, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { TerminalProfile, TerminalSessionInfo, TerminalStatus } from '../lib/types';
import { cn } from '../lib/utils';
import { roomSocket, type WsServerEvent } from '../lib/ws';
import { Button } from './ui/Button';

export interface TerminalPanelProps {
  profile: TerminalProfile;
  projectId?: string;
  title: string;
  initialInput?: string;
  className?: string;
  onClose?: () => void;
  onRefreshRequested?: () => void;
}

type TerminalRuntimeStatus = 'initializing' | TerminalStatus | 'killing' | 'error';

type XtermDisposable = { dispose: () => void };
type TerminalSize = { cols: number; rows: number };

const defaultSize: TerminalSize = { cols: 80, rows: 24 };

const statusLabels: Record<TerminalRuntimeStatus, string> = {
  initializing: '连接中',
  running: '运行中',
  killing: '终止中',
  exited: '已退出',
  failed: '失败',
  killed: '已终止',
  'idle-timeout': '已超时',
  error: '异常',
};

const statusClasses: Record<TerminalRuntimeStatus, string> = {
  initializing: 'border-[rgba(148,163,184,0.45)] text-[var(--color-fg-muted)]',
  running: 'border-[rgba(34,197,94,0.42)] bg-[rgba(34,197,94,0.08)] text-[rgb(22,101,52)]',
  killing: 'border-[rgba(245,158,11,0.48)] bg-[rgba(245,158,11,0.10)] text-[rgb(146,64,14)]',
  exited: 'border-[rgba(148,163,184,0.45)] text-[var(--color-fg-muted)]',
  failed: 'border-[rgba(239,68,68,0.45)] bg-[rgba(239,68,68,0.08)] text-[rgb(185,28,28)]',
  killed: 'border-[rgba(148,163,184,0.45)] text-[var(--color-fg-muted)]',
  'idle-timeout': 'border-[rgba(245,158,11,0.48)] bg-[rgba(245,158,11,0.10)] text-[rgb(146,64,14)]',
  error: 'border-[rgba(239,68,68,0.45)] bg-[rgba(239,68,68,0.08)] text-[rgb(185,28,28)]',
};

export function TerminalPanel({
  profile,
  projectId,
  title,
  initialInput,
  className,
  onClose,
  onRefreshRequested,
}: TerminalPanelProps): JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const onRefreshRequestedRef = useRef(onRefreshRequested);
  const initialInputSentRef = useRef(false);
  const lastSentSizeRef = useRef<TerminalSize | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<TerminalRuntimeStatus>('initializing');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    onRefreshRequestedRef.current = onRefreshRequested;
  }, [onRefreshRequested]);

  const statusText = useMemo(() => statusLabels[status], [status]);
  const canKill = Boolean(sessionId) && status === 'running';

  const killSession = useCallback(() => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return;

    setStatus('killing');
    setMessage(null);

    try {
      roomSocket.killTerminal(currentSessionId);
    } catch (error) {
      setMessage(formatError(error));
    }

    void api.killTerminalSession(currentSessionId).catch((error: unknown) => {
      setStatus('error');
      setMessage(formatError(error));
    });
  }, []);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return undefined;

    let disposed = false;
    let resizeFrame: number | null = null;
    const disposables: XtermDisposable[] = [];

    setStatus('initializing');
    setMessage(null);
    setSessionId(null);
    sessionIdRef.current = null;
    initialInputSentRef.current = false;
    lastSentSizeRef.current = null;

    const terminal = new XTerm({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: '#071018',
        black: '#0f172a',
        blue: '#60a5fa',
        brightBlack: '#475569',
        brightBlue: '#93c5fd',
        brightCyan: '#67e8f9',
        brightGreen: '#86efac',
        brightMagenta: '#f0abfc',
        brightRed: '#fca5a5',
        brightWhite: '#f8fafc',
        brightYellow: '#fde68a',
        cursor: '#d7ff7a',
        cyan: '#22d3ee',
        foreground: '#d7e5ee',
        green: '#4ade80',
        magenta: '#e879f9',
        red: '#fb7185',
        selectionBackground: '#1d4ed866',
        white: '#e2e8f0',
        yellow: '#facc15',
      },
    });
    const fitAddon = new FitAddon();

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    const fitAndMaybeNotify = (notifyServer: boolean) => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (disposed) return;

        const size = fitTerminal(terminal, fitAddon);
        if (!notifyServer || !sessionIdRef.current) return;
        if (isSameSize(lastSentSizeRef.current, size)) return;

        lastSentSizeRef.current = size;
        roomSocket.resizeTerminal(sessionIdRef.current, size.cols, size.rows);
      });
    };

    disposables.push(terminal.onData((data) => {
      if (!sessionIdRef.current) return;
      roomSocket.sendTerminalInput(sessionIdRef.current, data);
    }));

    const unsubscribeEvents = roomSocket.on((event) => {
      if (event.type === 'platform_skills:refresh_requested') {
        onRefreshRequestedRef.current?.();
        return;
      }

      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId || !isEventForSession(event, currentSessionId)) return;

      if (event.type === 'terminal:output') {
        if (event.data) terminal.write(event.data);
        return;
      }

      if (event.type === 'terminal:status') {
        setStatus(normalizeStatus(event.status));
        setMessage(null);
        return;
      }

      if (event.type === 'terminal:exit') {
        setStatus((previous) => (
          previous === 'killed' || previous === 'failed' || previous === 'idle-timeout'
            ? previous
            : 'exited'
        ));
        setMessage(formatExitMessage(event));
      }
    });

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => fitAndMaybeNotify(true));
    resizeObserver?.observe(host);

    fitAndMaybeNotify(false);
    const initialSize = getTerminalSize(terminal);
    void api.createTerminalSession({
      profile,
      ...(projectId ? { projectId } : {}),
      ...initialSize,
    }).then((result) => {
      const nextSessionId = result.id;
      if (!nextSessionId) throw new Error('Terminal session response did not include an id');

      if (disposed) {
        roomSocket.unsubscribeTerminal(nextSessionId);
        return;
      }

      sessionIdRef.current = nextSessionId;
      setSessionId(nextSessionId);
      setStatus(normalizeStatus(result.status));
      roomSocket.subscribeTerminal(nextSessionId);

      const currentSize = getTerminalSize(terminal);
      lastSentSizeRef.current = currentSize;
      roomSocket.resizeTerminal(nextSessionId, currentSize.cols, currentSize.rows);
      const command = initialInput?.trim();
      if (command && !initialInputSentRef.current) {
        initialInputSentRef.current = true;
        roomSocket.sendTerminalInput(nextSessionId, command);
      }
      terminal.focus();
    }).catch((error: unknown) => {
      if (disposed) return;
      const errorMessage = formatError(error);
      setStatus('error');
      setMessage(errorMessage);
      terminal.writeln(`\r\n${errorMessage}`);
    });

    return () => {
      disposed = true;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      unsubscribeEvents();

      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) roomSocket.unsubscribeTerminal(currentSessionId);

      for (const disposable of disposables) disposable.dispose();
      terminal.dispose();

      xtermRef.current = null;
      fitAddonRef.current = null;
      sessionIdRef.current = null;
      initialInputSentRef.current = false;
      lastSentSizeRef.current = null;
    };
  }, [profile, projectId, initialInput]);

  return (
    <section
      className={cn(
        'flex min-h-[320px] flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]',
        className,
      )}
      aria-label={title}
    >
      <header className="flex min-h-11 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-popover)] px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <TerminalSquare className="h-4 w-4 shrink-0 text-[var(--color-primary)]" strokeWidth={1.8} />
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold text-[var(--color-fg)]">{title}</h2>
            <p className="truncate text-[11px] text-[var(--color-fg-muted)]">
              {profile}{sessionId ? ` · ${sessionId}` : ''}
            </p>
          </div>
        </div>

        <span
          className={cn(
            'hidden shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium sm:inline-flex',
            statusClasses[status],
          )}
        >
          {statusText}
        </span>

        <Button
          type="button"
          variant="danger"
          size="sm"
          className="shrink-0 px-2"
          title="终止终端会话"
          aria-label="终止终端会话"
          disabled={!canKill}
          onClick={killSession}
        >
          <Power className="h-4 w-4" strokeWidth={1.8} />
          <span className="hidden sm:inline">终止</span>
        </Button>

        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 px-2"
            title="关闭终端面板"
            aria-label="关闭终端面板"
            onClick={onClose}
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </Button>
        ) : null}
      </header>

      {message ? (
        <div className="border-b border-[var(--color-border)] bg-[rgba(245,158,11,0.10)] px-3 py-2 text-[12px] text-[var(--color-fg)]">
          {message}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 bg-[#071018] p-2">
        <div ref={terminalHostRef} className="h-full min-h-[260px] w-full overflow-hidden" />
      </div>
    </section>
  );
}

function fitTerminal(terminal: XTerm, fitAddon: FitAddon): TerminalSize {
  try {
    fitAddon.fit();
  } catch {
    return getTerminalSize(terminal);
  }
  return getTerminalSize(terminal);
}

function getTerminalSize(terminal: XTerm): TerminalSize {
  return {
    cols: terminal.cols || defaultSize.cols,
    rows: terminal.rows || defaultSize.rows,
  };
}

function isSameSize(previous: TerminalSize | null, next: TerminalSize): boolean {
  return previous?.cols === next.cols && previous.rows === next.rows;
}

function isEventForSession(event: WsServerEvent, sessionId: string): event is Extract<WsServerEvent, { sessionId: string }> {
  return 'sessionId' in event && event.sessionId === sessionId;
}

function normalizeStatus(
  status: TerminalSessionInfo['status'] | undefined,
  fallback: TerminalRuntimeStatus = 'running',
): TerminalRuntimeStatus {
  if (
    status === 'running' ||
    status === 'exited' ||
    status === 'failed' ||
    status === 'killed' ||
    status === 'idle-timeout'
  ) {
    return status;
  }
  return fallback;
}

function formatExitMessage(event: Extract<WsServerEvent, { type: 'terminal:exit' }>): string {
  if (typeof event.exitCode === 'number') return `进程已退出，exit code ${event.exitCode}`;
  if (event.signal) return `进程已被信号 ${event.signal} 终止`;
  return '终端会话已退出';
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return '终端会话请求失败';
}
