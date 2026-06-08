import type {
  ActiveSessionSummary,
  AgentRun,
  AgentRunStatus,
  AgentTimelineEvent,
  HistoryRecord,
  HistoryRecordStatus,
  Message,
  PlatformSkillRef,
  RoomAgent,
  Session,
  SessionAgentEvent,
  SessionAgentEventChannel,
  SessionDiffRow,
  SessionEvidenceEvent,
  SessionMessage,
  SessionMode,
  SessionPlanItem,
  SessionRun,
  SessionToolRow,
  SessionBottomStatus,
  SessionWorkspacePayload,
  Task,
  TaskArtifact,
  TaskEvent,
  TerminalProfile,
  TerminalStatus,
  WorkflowRun,
  WorkflowStep,
} from './types';

export type WsServerEvent =
  | { type: 'message:new'; roomId: string; message: Message }
  | { type: 'task_event:new'; roomId: string; event: TaskEvent }
  | { type: 'task:activated'; roomId: string; taskId: string }
  | {
      type: 'message:stream';
      roomId: string;
      messageId: string;
      chunk: string;
      done: boolean;
      seq?: number;
      runId?: string;
      channel?: SessionAgentEventChannel;
      event?: AgentTimelineEvent;
      status?: 'streaming' | AgentRunStatus;
      error?: string | null;
      message?: Message;
    }
  | { type: 'agent_run:created'; roomId: string; run: AgentRun }
  | { type: 'agent_run:updated'; roomId: string; run: AgentRun }
  | { type: 'room:agent_joined'; roomId: string; agent: RoomAgent }
  | { type: 'room:agent_left'; roomId: string; roomAgentId: string }
  | { type: 'workflow:created'; roomId: string; workflow: WorkflowRun }
  | { type: 'workflow:updated'; roomId: string; workflow: WorkflowRun }
  | { type: 'workflow_step:created'; roomId: string; step: WorkflowStep }
  | { type: 'workflow_step:updated'; roomId: string; step: WorkflowStep }
  | { type: 'workflow_artifact:created'; roomId: string; artifact: TaskArtifact }
  | { type: 'active_sessions:snapshot'; sessions: ActiveSessionSummary[] }
  | { type: 'active_session:upsert'; session: ActiveSessionSummary }
  | { type: 'active_session:remove'; sessionId: string }
  | { type: 'session_workspace:snapshot'; projectId: string; sessionId: string; payload: SessionWorkspacePayload }
  | { type: 'session_error'; sessionId: string; error: string }
  | { type: 'session_status:snapshot'; sessionId: string; status: import('./types').StatusSnapshot }
  | { type: 'session_context:snapshot'; sessionId: string; context: import('./types').SessionContextManifest | null }
  | { type: 'session_compact:preview'; sessionId: string; compaction: import('./types').SessionCompaction }
  | { type: 'history_records:snapshot'; projectId: string; records: HistoryRecord[] }
  | { type: 'session:updated'; sessionId: string; session: Session }
  | { type: 'session_message:new'; sessionId: string; message: SessionMessage }
  | { type: 'session_run:created'; sessionId: string; run: SessionRun }
  | { type: 'session_run:updated'; sessionId: string; run: SessionRun }
  | { type: 'session_bottom_status:snapshot'; sessionId: string; bottomStatus: SessionBottomStatus }
  | {
      type: 'session_run:stream';
      sessionId: string;
      agentId: string;
      runId: string;
      seq: number;
      chunk: string;
      channel: SessionAgentEventChannel;
      done: boolean;
      agentEvent?: SessionAgentEvent;
    }
  | { type: 'session_evidence:new'; sessionId: string; event: SessionEvidenceEvent }
  | {
      type: 'session_inspector:snapshot';
      sessionId: string;
      planItems: SessionPlanItem[];
      toolRows: SessionToolRow[];
      diffRows: SessionDiffRow[];
    }
  | { type: 'history_record:new'; projectId: string; record: HistoryRecord }
  | { type: 'terminal:ready'; sessionId: string; cwd: string; profile: TerminalProfile }
  | { type: 'terminal:output'; sessionId: string; data: string }
  | { type: 'terminal:status'; sessionId: string; status: TerminalStatus }
  | { type: 'terminal:exit'; sessionId: string; exitCode: number | null; signal: string | null }
  | { type: 'platform_skills:refresh_requested' }
  | { type: 'task:created'; task: Task }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:deleted'; taskId: string };

export type WsClientEvent =
  | { type: 'subscribe'; roomId: string }
  | { type: 'unsubscribe'; roomId: string }
  | { type: 'active_sessions:subscribe' }
  | { type: 'active_sessions:unsubscribe' }
  | { type: 'session:subscribe'; sessionId: string }
  | { type: 'session:unsubscribe'; sessionId: string }
  | { type: 'session.workspace.request'; projectId: string; sessionId?: string }
  | {
      type: 'session.message.send';
      sessionId: string;
      content: string;
      agentId?: string;
      mode?: SessionMode;
      workspaceFileRefs?: string[];
      libraryFileRefs?: string[];
      platformSkillRefs?: PlatformSkillRef[];
    }
  | { type: 'agent.run.pause'; sessionId: string; agentId: string; runId: string }
  | { type: 'agent.run.resume'; sessionId: string; agentId: string; runId: string; content?: string }
  | { type: 'agent.run.cancel'; sessionId: string; agentId: string; runId: string }
  | { type: 'agent.run.retry'; sessionId: string; agentId: string; runId: string }
  | { type: 'session.command.run'; sessionId: string; command: string }
  | { type: 'session.compact.apply'; sessionId: string; compactionId: string; appliedSummary: string; userEdited?: boolean }
  | { type: 'session.compact.discard'; sessionId: string; compactionId: string }
  | {
      type: 'session.contract.save';
      sessionId: string;
      scope?: string | null;
      risks?: string[];
      acceptanceCriteria?: string[];
    }
  | { type: 'history_records.filter'; projectId: string; q?: string; status?: HistoryRecordStatus | 'all'; mode?: SessionMode | 'all' }
  | { type: 'terminal:subscribe'; sessionId: string }
  | { type: 'terminal:unsubscribe'; sessionId: string }
  | { type: 'terminal:input'; sessionId: string; data: string }
  | { type: 'terminal:resize'; sessionId: string; cols: number; rows: number }
  | { type: 'terminal:kill'; sessionId: string };

type Listener = (event: WsServerEvent) => void;

class RoomSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscribed = new Set<string>();
  private subscribedSessions = new Set<string>();
  private subscribedTerminals = new Set<string>();
  private subscribedActiveSessions = false;
  private pendingClientEvents: WsClientEvent[] = [];
  private retry = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closeWhenOpen = false;

  connect(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retry = 0;
      if (
        this.closeWhenOpen &&
        this.subscribed.size === 0 &&
        this.subscribedSessions.size === 0 &&
        this.subscribedTerminals.size === 0 &&
        !this.subscribedActiveSessions &&
        this.pendingClientEvents.length === 0
      ) {
        this.closeWhenOpen = false;
        setTimeout(() => {
          if (
            this.ws !== ws ||
            this.subscribed.size > 0 ||
            this.subscribedSessions.size > 0 ||
            this.subscribedTerminals.size > 0 ||
            this.subscribedActiveSessions ||
            this.pendingClientEvents.length > 0
          ) return;
          this.ws = null;
          ws.close();
        }, 0);
        return;
      }
      this.closeWhenOpen = false;
      if (this.subscribedActiveSessions) ws.send(JSON.stringify({ type: 'active_sessions:subscribe' }));
      for (const id of this.subscribed) ws.send(JSON.stringify({ type: 'subscribe', roomId: id }));
      for (const id of this.subscribedSessions) ws.send(JSON.stringify({ type: 'session:subscribe', sessionId: id }));
      for (const id of this.subscribedTerminals) ws.send(JSON.stringify({ type: 'terminal:subscribe', sessionId: id }));
      const pending = this.pendingClientEvents.splice(0);
      for (const event of pending) ws.send(JSON.stringify(event));
    });
    ws.addEventListener('message', (e) => {
      try {
        const event = JSON.parse(e.data) as WsServerEvent;
        for (const l of this.listeners) l(event);
      } catch {
        // ignore
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.closeWhenOpen = false;
      if (
        this.subscribed.size === 0 &&
        this.subscribedSessions.size === 0 &&
        this.subscribedTerminals.size === 0 &&
        !this.subscribedActiveSessions &&
        this.pendingClientEvents.length === 0
      ) return;
      this.retry++;
      const delay = Math.min(1000 * 2 ** this.retry, 10000);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
    ws.addEventListener('error', () => ws.close());
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connectSoon(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.connectTimer) return;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (
        this.subscribed.size === 0 &&
        this.subscribedSessions.size === 0 &&
        this.subscribedTerminals.size === 0 &&
        !this.subscribedActiveSessions &&
        this.pendingClientEvents.length === 0
      ) return;
      this.connect();
    }, 0);
  }

  subscribe(roomId: string): void {
    this.closeWhenOpen = false;
    this.subscribed.add(roomId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', roomId }));
    } else {
      this.connectSoon();
    }
  }

  unsubscribe(roomId: string): void {
    this.subscribed.delete(roomId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', roomId }));
    }
    this.closeIfIdle();
  }

  subscribeSession(sessionId: string): void {
    this.closeWhenOpen = false;
    this.subscribedSessions.add(sessionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session:subscribe', sessionId }));
    } else {
      this.connectSoon();
    }
  }

  unsubscribeSession(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session:unsubscribe', sessionId }));
    }
    this.closeIfIdle();
  }

  subscribeActiveSessions(): void {
    this.closeWhenOpen = false;
    this.subscribedActiveSessions = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'active_sessions:subscribe' }));
    } else {
      this.connectSoon();
    }
  }

  unsubscribeActiveSessions(): void {
    this.subscribedActiveSessions = false;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'active_sessions:unsubscribe' }));
    }
    this.closeIfIdle();
  }

  replaceSessionSubscription(previousSessionId: string | null | undefined, nextSessionId: string): void {
    this.closeWhenOpen = false;
    if (previousSessionId && previousSessionId !== nextSessionId) {
      this.subscribedSessions.delete(previousSessionId);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'session:unsubscribe', sessionId: previousSessionId }));
      }
    }
    this.subscribedSessions.add(nextSessionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session:subscribe', sessionId: nextSessionId }));
    } else {
      this.connectSoon();
    }
  }

  requestSessionWorkspace(input: { projectId: string; sessionId?: string | null }): void {
    this.sendOrQueue({
      type: 'session.workspace.request',
      projectId: input.projectId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  }

  sendSessionMessage(input: {
    sessionId: string;
    content: string;
    agentId?: string;
    mode?: SessionMode;
    workspaceFileRefs?: string[];
    libraryFileRefs?: string[];
    platformSkillRefs?: PlatformSkillRef[];
  }): void {
    this.sendOrQueue({
      type: 'session.message.send',
      sessionId: input.sessionId,
      content: input.content,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.workspaceFileRefs && input.workspaceFileRefs.length > 0 ? { workspaceFileRefs: input.workspaceFileRefs } : {}),
      ...(input.libraryFileRefs && input.libraryFileRefs.length > 0 ? { libraryFileRefs: input.libraryFileRefs } : {}),
      ...(input.platformSkillRefs && input.platformSkillRefs.length > 0 ? { platformSkillRefs: input.platformSkillRefs } : {}),
    });
  }

  runSessionControl(input:
    | { type: 'agent.run.pause'; sessionId: string; agentId: string; runId: string }
    | { type: 'agent.run.resume'; sessionId: string; agentId: string; runId: string; content?: string }
    | { type: 'agent.run.cancel'; sessionId: string; agentId: string; runId: string }
    | { type: 'agent.run.retry'; sessionId: string; agentId: string; runId: string }
  ): void {
    this.sendOrQueue(input);
  }

  runSessionCommand(input: { sessionId: string; command: string }): void {
    this.sendOrQueue({ type: 'session.command.run', ...input });
  }

  applySessionCompact(input: { sessionId: string; compactionId: string; appliedSummary: string; userEdited?: boolean }): void {
    this.sendOrQueue({ type: 'session.compact.apply', ...input });
  }

  discardSessionCompact(input: { sessionId: string; compactionId: string }): void {
    this.sendOrQueue({ type: 'session.compact.discard', ...input });
  }

  saveSessionContract(input: {
    sessionId: string;
    scope?: string | null;
    risks?: string[];
    acceptanceCriteria?: string[];
  }): void {
    this.sendOrQueue({ type: 'session.contract.save', ...input });
  }

  filterHistoryRecords(input: {
    projectId: string;
    q?: string;
    status?: HistoryRecordStatus | 'all';
    mode?: SessionMode | 'all';
  }): void {
    this.sendOrQueue({ type: 'history_records.filter', ...input });
  }

  subscribeTerminal(sessionId: string): void {
    this.closeWhenOpen = false;
    this.subscribedTerminals.add(sessionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'terminal:subscribe', sessionId }));
    } else {
      this.connectSoon();
    }
  }

  unsubscribeTerminal(sessionId: string): void {
    this.subscribedTerminals.delete(sessionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'terminal:unsubscribe', sessionId }));
    }
    this.closeIfIdle();
  }

  sendTerminalInput(sessionId: string, data: string): void {
    this.sendOrQueue({ type: 'terminal:input', sessionId, data });
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    this.sendOrQueue({ type: 'terminal:resize', sessionId, cols, rows });
  }

  killTerminal(sessionId: string): void {
    this.sendOrQueue({ type: 'terminal:kill', sessionId });
  }

  destroy(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connectTimer = null;
    this.pendingClientEvents = [];
    this.ws?.close();
    this.ws = null;
  }

  private sendOrQueue(event: WsClientEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      return;
    }
    this.pendingClientEvents.push(event);
    this.connectSoon();
  }

  private closeIfIdle(): void {
    if (
      this.subscribed.size > 0 ||
      this.subscribedSessions.size > 0 ||
      this.subscribedTerminals.size > 0 ||
      this.subscribedActiveSessions ||
      this.pendingClientEvents.length > 0
    ) return;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.closeWhenOpen = true;
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      const socket = this.ws;
      this.ws = null;
      socket.close();
    }
  }
}

export const roomSocket = new RoomSocket();
export const sessionSocket = roomSocket;
