import type {
  ActiveSessionSummary,
  HistoryRecord,
  HistoryRecordStatus,
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
  SessionWorkspacePayload,
  Task,
} from './types';

type ImageGenerationJob = {
  id: string;
  project_id: string;
  room_id: string | null;
  session_id: string | null;
  source_message_id: string | null;
  source_agent_id: string | null;
  source_task_id: string | null;
  provider_profile_id: string;
  workflow: 'generate' | 'image-to-image';
  prompt: string;
  count: number;
  quality: string;
  size: string;
  status: 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'canceled';
  message: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
};

type ImageGenerationOutput = {
  id: string;
  job_id: string;
  file_id: string;
  slot: number;
  name: string;
  url: string;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
};

type ImageGenerationWsEvent =
  | {
      type: 'image_job:created' | 'image_job:updated' | 'image_job:failed' | 'image_job:canceled';
      projectId: string;
      sessionId?: string | null;
      roomId?: string | null;
      job: ImageGenerationJob;
    }
  | {
      type: 'image_job:output_added';
      projectId: string;
      sessionId?: string | null;
      roomId?: string | null;
      jobId: string;
      output: ImageGenerationOutput;
    }
  | {
      type: 'image_job:completed';
      projectId: string;
      sessionId?: string | null;
      roomId?: string | null;
      job: ImageGenerationJob;
      outputs: ImageGenerationOutput[];
    };

export type WsServerEvent =
  | ImageGenerationWsEvent
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
  | { type: 'task:created'; task: Task }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:deleted'; taskId: string };

export type WsClientEvent =
  | { type: 'active_sessions:subscribe' }
  | { type: 'active_sessions:unsubscribe' }
  | { type: 'project:subscribe'; projectId: string }
  | { type: 'project:unsubscribe'; projectId: string }
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
  | { type: 'history_records.filter'; projectId: string; q?: string; status?: HistoryRecordStatus | 'all'; mode?: SessionMode | 'all' };

type Listener = (event: WsServerEvent) => void;

class SessionSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscribedSessions = new Set<string>();
  private subscribedProjects = new Set<string>();
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
        this.subscribedSessions.size === 0 &&
        this.subscribedProjects.size === 0 &&
        !this.subscribedActiveSessions &&
        this.pendingClientEvents.length === 0
      ) {
        this.closeWhenOpen = false;
        setTimeout(() => {
          if (
            this.ws !== ws ||
            this.subscribedSessions.size > 0 ||
            this.subscribedProjects.size > 0 ||
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
      for (const id of this.subscribedSessions) ws.send(JSON.stringify({ type: 'session:subscribe', sessionId: id }));
      for (const id of this.subscribedProjects) ws.send(JSON.stringify({ type: 'project:subscribe', projectId: id }));
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
        this.subscribedSessions.size === 0 &&
        this.subscribedProjects.size === 0 &&
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
        this.subscribedSessions.size === 0 &&
        this.subscribedProjects.size === 0 &&
        !this.subscribedActiveSessions &&
        this.pendingClientEvents.length === 0
      ) return;
      this.connect();
    }, 0);
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

  subscribeProject(projectId: string): void {
    this.closeWhenOpen = false;
    this.subscribedProjects.add(projectId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'project:subscribe', projectId }));
    } else {
      this.connectSoon();
    }
  }

  unsubscribeProject(projectId: string): void {
    this.subscribedProjects.delete(projectId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'project:unsubscribe', projectId }));
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
  }): void {
    this.sendOrQueue({
      type: 'session.message.send',
      sessionId: input.sessionId,
      content: input.content,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.workspaceFileRefs && input.workspaceFileRefs.length > 0 ? { workspaceFileRefs: input.workspaceFileRefs } : {}),
      ...(input.libraryFileRefs && input.libraryFileRefs.length > 0 ? { libraryFileRefs: input.libraryFileRefs } : {}),
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

  destroy(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connectTimer = null;
    this.retryTimer = null;
    this.subscribedSessions.clear();
    this.subscribedProjects.clear();
    this.subscribedActiveSessions = false;
    this.closeWhenOpen = false;
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
      this.subscribedSessions.size > 0 ||
      this.subscribedProjects.size > 0 ||
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

export const sessionSocket = new SessionSocket();
