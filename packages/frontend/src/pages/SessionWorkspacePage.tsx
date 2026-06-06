import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderPlus, Plus } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CreateProjectDialog } from '../components/CreateProjectDialog';
import { Button } from '../components/ui/Button';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type {
  AcpBackend,
  ActiveSessionSummary,
  Session,
  SessionCompaction,
  SessionMode,
  SessionWorkspacePayload,
} from '../lib/types';
import { sessionSocket, type WsServerEvent } from '../lib/ws';
import { CompactPreviewSurface } from '../session-ui/CompactPreviewSurface';
import { SessionShell } from '../session-ui/SessionShell';
import { applySessionWorkspaceEvent } from '../session-ui/session-workspace-events';
import type { SessionComposerSubmit } from '../session-ui/session-file-composer-model';

type SessionWorkspacePageProps = {
  projectIdOverride?: string;
  sessionIdOverride?: string;
  navigationEnabled?: boolean;
};

type CreateSessionInput = NonNullable<Parameters<typeof api.createSession>[1]>;
type CreateSessionAndSelectInput = {
  targetProjectId: string;
  sourceSession: Pick<Session, 'id' | 'mode' | 'provider' | 'model'>;
  navigationEnabled: boolean;
  createSession: (projectId: string, input: CreateSessionInput) => Promise<{ id: string }>;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  requestWorkspace: (input: { projectId: string; sessionId: string }) => void;
};

export async function createProjectSessionAndSelect({
  targetProjectId,
  sourceSession,
  navigationEnabled,
  createSession,
  navigate,
  requestWorkspace,
}: CreateSessionAndSelectInput): Promise<void> {
  const nextSession = await createSession(targetProjectId, {
    title: 'New Session',
    mode: sourceSession.mode,
    provider: sourceSession.provider as AcpBackend | null,
    model: sourceSession.model,
  });
  if (navigationEnabled) {
    navigate(`/projects/${targetProjectId}/sessions/${nextSession.id}`);
    return;
  }
  requestWorkspace({ projectId: targetProjectId, sessionId: nextSession.id });
}

export function SessionWorkspacePage({
  projectIdOverride,
  sessionIdOverride,
  navigationEnabled = true,
}: SessionWorkspacePageProps = {}): JSX.Element {
  const { projectId: routeProjectId = '', sessionId: routeSessionId } = useParams();
  const projectId = projectIdOverride ?? routeProjectId;
  const sessionId = sessionIdOverride ?? routeSessionId;
  const navigate = useNavigate();
  const { t } = useI18n();
  const [compactPreview, setCompactPreview] = useState<SessionCompaction | null>(null);
  const [workspacePayload, setWorkspacePayload] = useState<SessionWorkspacePayload | null>(null);
  const [activeSessions, setActiveSessions] = useState<ActiveSessionSummary[] | null>(null);
  const previousSessionIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const { data: projects = [], isLoading: projectsLoading } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const activeProjectId = projectId || projects[0]?.id || '';

  useEffect(() => {
    if (!navigationEnabled) return;
    if (!projectId && activeProjectId) navigate(`/projects/${activeProjectId}`, { replace: true });
  }, [activeProjectId, navigate, navigationEnabled, projectId]);

  useEffect(() => {
    sessionSocket.subscribeActiveSessions();
    return () => sessionSocket.unsubscribeActiveSessions();
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    sessionSocket.requestSessionWorkspace({ projectId: activeProjectId, sessionId });
  }, [activeProjectId, sessionId]);

  useEffect(() => {
    const activeSessionId = workspacePayload?.activeSession.session.id;
    activeSessionIdRef.current = activeSessionId ?? null;
    if (!activeSessionId) return;
    sessionSocket.replaceSessionSubscription(previousSessionIdRef.current, activeSessionId);
    previousSessionIdRef.current = activeSessionId;
  }, [workspacePayload?.activeSession.session.id]);

  useEffect(() => {
    return () => {
      if (!previousSessionIdRef.current) return;
      sessionSocket.unsubscribeSession(previousSessionIdRef.current);
      previousSessionIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    return sessionSocket.on((event: WsServerEvent) => {
      if (event.type === 'session_workspace:snapshot') {
        if (event.projectId !== activeProjectId) return;
        setActiveSessions(event.payload.activeSessions);
        setWorkspacePayload(event.payload);
        const nextNavigation = getSnapshotNavigation(
          event.projectId,
          event.payload.activeSession.session.id,
          sessionId,
          navigationEnabled,
        );
        if (nextNavigation) {
          navigate(nextNavigation.to, { replace: nextNavigation.replace });
        }
        return;
      }
      if (event.type === 'active_sessions:snapshot') {
        setActiveSessions(event.sessions);
        setWorkspacePayload((current) => current ? { ...current, activeSessions: event.sessions } : current);
        return;
      }
      if (event.type === 'active_session:upsert') {
        setActiveSessions((current) => upsertActiveSessionSummary(current ?? [], event.session));
        setWorkspacePayload((current) => {
          if (!current) return current;
          return {
            ...current,
            activeSessions: upsertActiveSessionSummary(current.activeSessions, event.session),
          };
        });
        return;
      }
      if (event.type === 'active_session:remove') {
        setActiveSessions((current) => (current ?? []).filter((session) => session.id !== event.sessionId));
        setWorkspacePayload((current) => {
          if (!current) return current;
          return {
            ...current,
            activeSessions: current.activeSessions.filter((session) => session.id !== event.sessionId),
          };
        });
        return;
      }
      if (event.type === 'session_error') {
        toast.error(event.error);
        return;
      }
      if (event.type === 'session_status:snapshot') {
        setWorkspacePayload((current) => current && current.activeSession.session.id === event.sessionId
          ? { ...current, status: event.status }
          : current);
        return;
      }
      if (event.type === 'session_context:snapshot') {
        setWorkspacePayload((current) => current && current.activeSession.session.id === event.sessionId
          ? { ...current, context: event.context }
          : current);
        return;
      }
      if (event.type === 'session_compact:preview') {
        if (isCompactPreviewForActiveSession(activeSessionIdRef.current, event)) {
          setCompactPreview(event.compaction);
        }
        return;
      }
      if (event.type === 'history_records:snapshot') {
        setWorkspacePayload((current) => current && current.project.id === event.projectId
          ? { ...current, historyRecords: event.records }
          : current);
        return;
      }
      if (!isSessionWorkspaceEvent(event)) return;
      setWorkspacePayload((current) => current ? applySessionWorkspaceEvent(current, event) : current);
    });
  }, [activeProjectId, navigate, navigationEnabled, sessionId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!navigationEnabled || event.key !== 'Escape') return;
      const activeRun = [...(workspacePayload?.activeSession.runs ?? [])].reverse().find((run) =>
        run.status === 'queued' || run.status === 'running' || run.status === 'retrying'
      );
      if (!activeRun) return;
      event.preventDefault();
      sessionSocket.runSessionControl({
        type: 'agent.run.pause',
        sessionId: activeRun.session_id,
        agentId: activeRun.agent_id,
        runId: activeRun.id,
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigationEnabled, workspacePayload?.activeSession.runs]);

  if (!activeProjectId) {
    return (
      <div className="session-shell session-shell--empty">
        {projectsLoading ? (
          <div className="session-loading">{t('sessionWorkspace.loadingProjects')}</div>
        ) : (
          <div className="session-onboarding">
            <WorkspaceEmptyState
              icon={<FolderPlus className="session-onboarding-icon" strokeWidth={1.5} />}
              title={t('sessionWorkspace.noProjectTitle')}
              description={t('sessionWorkspace.noProjectDescription')}
              action={
                <CreateProjectDialog>
                  <Button variant="primary">
                    <Plus className="h-4 w-4" />
                    {t('sessionWorkspace.createProject')}
                  </Button>
                </CreateProjectDialog>
              }
            />
          </div>
        )}
      </div>
    );
  }
  if (!workspacePayload) {
    return (
      <div className="session-shell session-shell--empty">
        <div className="session-loading">加载 Session</div>
      </div>
    );
  }

  const createProjectSession = async (targetProjectId: string): Promise<void> => {
    try {
      await createProjectSessionAndSelect({
        targetProjectId,
        sourceSession: workspacePayload.activeSession.session,
        navigationEnabled,
        createSession: api.createSession,
        navigate: (to, options) => navigate(to, options),
        requestWorkspace: (input) => sessionSocket.requestSessionWorkspace(input),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '新建会话失败');
    }
  };

  return (
    <>
    <SessionShell
      payload={{
        ...workspacePayload,
        activeSessions: activeSessions ?? workspacePayload.activeSessions,
      }}
      onSendMessage={(message) => runSessionCommand(message, workspacePayload, {
        sendMessage: (message) => sessionSocket.sendSessionMessage(message),
        runCommand: (message) => sessionSocket.runSessionCommand(message),
      })}
      onCommand={(command) => runSessionCommand(command, workspacePayload, {
        sendMessage: (message) => sessionSocket.sendSessionMessage(message),
        runCommand: (message) => sessionSocket.runSessionCommand(message),
      })}
      onCancelRun={(runId) => runSessionControl(workspacePayload, runId, 'agent.run.cancel')}
      onRetryRun={(runId) => runSessionControl(workspacePayload, runId, 'agent.run.retry')}
      onSaveContract={(input) => {
        sessionSocket.saveSessionContract({ sessionId: workspacePayload.activeSession.session.id, ...input });
      }}
      onOpenSession={(projectId, sessionId) => {
        if (navigationEnabled) {
          navigate(`/projects/${projectId}/sessions/${sessionId}`);
          return;
        }
        sessionSocket.requestSessionWorkspace({ projectId, sessionId });
      }}
      onCreateSession={createProjectSession}
    />
    {compactPreview && (
      <div className="session-overlay" role="dialog" aria-label="Compact Preview">
        <CompactPreviewSurface
          compaction={compactPreview}
          onApply={(summary) => {
            sessionSocket.applySessionCompact({
              sessionId: workspacePayload.activeSession.session.id,
              compactionId: compactPreview.id,
              appliedSummary: summary,
              userEdited: summary !== compactPreview.preview_summary,
            });
            setCompactPreview(null);
          }}
          onDiscard={() => {
            sessionSocket.discardSessionCompact({
              sessionId: workspacePayload.activeSession.session.id,
              compactionId: compactPreview.id,
            });
            setCompactPreview(null);
          }}
        />
      </div>
    )}
    </>
  );
}

export function shouldRefreshSessionWorkspace(event: WsServerEvent): boolean {
  if (!isSessionWorkspaceEvent(event)) return false;
  return false;
}

export function getSnapshotNavigation(
  projectId: string,
  nextSessionId: string,
  currentSessionId?: string,
  navigationEnabled = true,
): { to: string; replace: boolean } | null {
  if (!navigationEnabled) return null;
  if (!nextSessionId || nextSessionId === currentSessionId) return null;
  return {
    to: `/projects/${projectId}/sessions/${nextSessionId}`,
    replace: !currentSessionId,
  };
}

export function isCompactPreviewForActiveSession(
  activeSessionId: string | null | undefined,
  event: Extract<WsServerEvent, { type: 'session_compact:preview' }>,
): boolean {
  return Boolean(activeSessionId && activeSessionId === event.sessionId);
}

function isSessionWorkspaceEvent(event: WsServerEvent): boolean {
  return event.type.startsWith('session_') || event.type === 'session:updated' || event.type === 'history_record:new';
}

export function upsertActiveSessionSummary(
  sessions: ActiveSessionSummary[],
  session: ActiveSessionSummary,
): ActiveSessionSummary[] {
  return [session, ...sessions.filter((item) => item.id !== session.id)]
    .sort((left, right) =>
      Number(left.pinned_at === null) - Number(right.pinned_at === null) ||
      (right.pinned_at ?? 0) - (left.pinned_at ?? 0) ||
      right.updated_at - left.updated_at
    );
}

type SessionCommandResult = { kind: 'noop' } | null;

export function runSessionCommand(
  input: string | SessionComposerSubmit,
  payload: SessionWorkspacePayload,
  handlers: {
    sendMessage: (message: {
      sessionId: string;
      content: string;
      agentId?: string;
      mode?: SessionMode;
      workspaceFileRefs?: string[];
      libraryFileRefs?: string[];
    }) => void;
    runCommand: (message: { sessionId: string; command: string }) => void;
  },
): SessionCommandResult {
  const sessionId = payload.activeSession.session.id;
  const message = typeof input === 'string' ? { content: input } : input;
  const trimmed = message.content.trim();
  if (trimmed === '/resume' || trimmed === '/history') return { kind: 'noop' };
  if (trimmed.startsWith('/')) {
    handlers.runCommand({ sessionId, command: trimmed });
    return null;
  }
  handlers.sendMessage({
    sessionId,
    content: message.content,
    agentId: 'planner',
    mode: payload.activeSession.session.mode,
    ...(message.workspaceFileRefs && message.workspaceFileRefs.length > 0 ? { workspaceFileRefs: message.workspaceFileRefs } : {}),
    ...(message.libraryFileRefs && message.libraryFileRefs.length > 0 ? { libraryFileRefs: message.libraryFileRefs } : {}),
  });
  return null;
}

function runSessionControl(
  payload: SessionWorkspacePayload,
  runId: string,
  type: 'agent.run.cancel' | 'agent.run.retry',
): void {
  const run = payload.activeSession.runs.find((item) => item.id === runId);
  const agentId = run?.agent_id || 'planner';
  sessionSocket.runSessionControl({
    type,
    sessionId: payload.activeSession.session.id,
    agentId,
    runId,
  });
}
