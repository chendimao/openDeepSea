import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type {
  HistoryRecordStatus,
  SessionCompaction,
  SessionMode,
  SessionWorkspacePayload,
} from '../lib/types';
import { sessionSocket, type WsServerEvent } from '../lib/ws';
import { CompactPreviewSurface } from '../session-ui/CompactPreviewSurface';
import { SessionShell } from '../session-ui/SessionShell';
import { applySessionWorkspaceEvent } from '../session-ui/session-workspace-events';

export function SessionWorkspacePage(): JSX.Element {
  const { projectId = '', sessionId } = useParams();
  const navigate = useNavigate();
  const [compactPreview, setCompactPreview] = useState<SessionCompaction | null>(null);
  const [workspacePayload, setWorkspacePayload] = useState<SessionWorkspacePayload | null>(null);
  const previousSessionIdRef = useRef<string | null>(null);
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const activeProjectId = projectId || projects[0]?.id || '';

  useEffect(() => {
    if (!projectId && activeProjectId) navigate(`/projects/${activeProjectId}`, { replace: true });
  }, [activeProjectId, navigate, projectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    sessionSocket.requestSessionWorkspace({ projectId: activeProjectId, sessionId });
  }, [activeProjectId, sessionId]);

  useEffect(() => {
    const activeSessionId = workspacePayload?.activeSession.session.id;
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
        setWorkspacePayload(event.payload);
        const nextNavigation = getSnapshotNavigation(event.projectId, event.payload.activeSession.session.id, sessionId);
        if (nextNavigation) {
          navigate(nextNavigation.to, { replace: nextNavigation.replace });
        }
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
        setCompactPreview(event.compaction);
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
  }, [activeProjectId, navigate, sessionId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
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
  }, [workspacePayload?.activeSession.runs]);

  if (!activeProjectId) {
    return (
      <div className="session-shell">
        <div className="session-empty">创建项目后开始 Session</div>
      </div>
    );
  }
  if (!workspacePayload) {
    return (
      <div className="session-shell">
        <div className="session-loading">加载 Session</div>
      </div>
    );
  }

  return (
    <>
    <SessionShell
      payload={workspacePayload}
      onSendMessage={(content) => runSessionCommand(content, workspacePayload, {
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
      onFilterHistory={(filters) => {
        sessionSocket.filterHistoryRecords({ projectId: activeProjectId, ...filters });
      }}
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
): { to: string; replace: boolean } | null {
  if (!nextSessionId || nextSessionId === currentSessionId) return null;
  return {
    to: `/projects/${projectId}/sessions/${nextSessionId}`,
    replace: !currentSessionId,
  };
}

function isSessionWorkspaceEvent(event: WsServerEvent): boolean {
  return event.type.startsWith('session_') || event.type === 'session:updated' || event.type === 'history_record:new';
}

type SessionCommandResult = { kind: 'noop' } | null;

export function runSessionCommand(
  content: string,
  payload: SessionWorkspacePayload,
  input: {
    sendMessage: (message: { sessionId: string; content: string; agentId?: string; mode?: SessionMode }) => void;
    runCommand: (message: { sessionId: string; command: string }) => void;
  },
): SessionCommandResult {
  const sessionId = payload.activeSession.session.id;
  const trimmed = content.trim();
  if (trimmed === '/resume' || trimmed === '/history') return { kind: 'noop' };
  if (trimmed.startsWith('/')) {
    input.runCommand({ sessionId, command: trimmed });
    return null;
  }
  input.sendMessage({ sessionId, content, agentId: 'planner', mode: payload.activeSession.session.mode });
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
