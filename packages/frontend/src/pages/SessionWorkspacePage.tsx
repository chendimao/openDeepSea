import React, { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type {
  HistoryRecordStatus,
  SessionCompaction,
  SessionContextManifest,
  SessionMode,
  SessionWorkspacePayload,
  StatusSnapshot,
} from '../lib/types';
import { sessionSocket, type WsServerEvent } from '../lib/ws';
import { CompactPreviewSurface } from '../session-ui/CompactPreviewSurface';
import { SessionShell } from '../session-ui/SessionShell';

export function SessionWorkspacePage(): JSX.Element {
  const { projectId = '', sessionId } = useParams();
  const navigate = useNavigate();
  const [compactPreview, setCompactPreview] = useState<SessionCompaction | null>(null);
  const [workspacePayload, setWorkspacePayload] = useState<SessionWorkspacePayload | null>(null);
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
    sessionSocket.subscribeSession(activeSessionId);
    return () => sessionSocket.unsubscribeSession(activeSessionId);
  }, [workspacePayload?.activeSession.session.id]);

  useEffect(() => {
    return sessionSocket.on((event: WsServerEvent) => {
      if (event.type === 'session_workspace:snapshot') {
        if (event.projectId !== activeProjectId) return;
        setWorkspacePayload(event.payload);
        return;
      }
      if (event.type === 'session_error') {
        toast.error(event.error);
        return;
      }
      if (!activeProjectId || !workspacePayload) return;
      if (!shouldRefreshSessionWorkspace(event)) return;
      if ('sessionId' in event && event.sessionId !== workspacePayload.activeSession.session.id) return;
      sessionSocket.requestSessionWorkspace({
        projectId: activeProjectId,
        sessionId: workspacePayload.activeSession.session.id,
      });
    });
  }, [activeProjectId, workspacePayload]);

  const runCommand = useMutation({
    mutationFn: (content: string) => runSessionCommand(content, workspacePayload!, {
      sendMessage: (message) => sessionSocket.sendSessionMessage(message),
    }),
    onSuccess: (result) => {
      if (!result) return undefined;
      if (result.kind === 'workspace') {
        const nextSessionId = result.payload.activeSession.session.id;
        setWorkspacePayload(result.payload);
        if (nextSessionId !== sessionId || result.payload.project.id !== activeProjectId) {
          navigate(`/projects/${result.payload.project.id}/sessions/${nextSessionId}`);
        }
        return undefined;
      }
      if (result.kind === 'compact') {
        setCompactPreview(result.compaction);
        return undefined;
      }
      if (result.kind === 'status') {
        setWorkspacePayload((current) => current ? { ...current, status: result.status } : current);
        return undefined;
      }
      if (result.kind === 'context') {
        setWorkspacePayload((current) => current ? { ...current, context: result.context } : current);
        return undefined;
      }
      return undefined;
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const applyCompact = useMutation({
    mutationFn: (summary: string) =>
      api.applyCompact(workspacePayload!.activeSession.session.id, compactPreview!.id, {
        applied_summary: summary,
        user_edited: summary !== compactPreview!.preview_summary,
      }),
    onSuccess: () => {
      setCompactPreview(null);
      requestActiveWorkspaceSnapshot(activeProjectId, workspacePayload);
      return undefined;
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const discardCompact = useMutation({
    mutationFn: (compactionId: string) => api.discardCompact(workspacePayload!.activeSession.session.id, compactionId),
    onSuccess: () => {
      setCompactPreview(null);
      requestActiveWorkspaceSnapshot(activeProjectId, workspacePayload);
      return undefined;
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const saveContract = useMutation({
    mutationFn: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) =>
      api.updateSessionContract(workspacePayload!.activeSession.session.id, input),
    onSuccess: () => {
      requestActiveWorkspaceSnapshot(activeProjectId, workspacePayload);
      return undefined;
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const filterHistory = useMutation({
    mutationFn: (filters: { q?: string; status?: HistoryRecordStatus | 'all'; mode?: SessionMode | 'all' }) =>
      api.listHistoryRecords(activeProjectId, filters),
    onSuccess: (records) => {
      setWorkspacePayload((current) => current ? { ...current, historyRecords: records } : current);
    },
    onError: (error) => toast.error((error as Error).message),
  });

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
      onSendMessage={(content) => runCommand.mutate(content)}
      onCommand={(command) => {
        if (command === '/compact') {
          void api.previewCompact(workspacePayload.activeSession.session.id).then(setCompactPreview).catch((error) => {
            toast.error((error as Error).message);
          });
          return;
        }
        runCommand.mutate(command);
      }}
      onCancelRun={(runId) => runSessionControl(workspacePayload, runId, 'agent.run.cancel')}
      onRetryRun={(runId) => runSessionControl(workspacePayload, runId, 'agent.run.retry')}
      onSaveContract={(input) => saveContract.mutate(input)}
      onFilterHistory={(filters) => filterHistory.mutate(filters)}
    />
    {compactPreview && (
      <div className="session-overlay" role="dialog" aria-label="Compact Preview">
        <CompactPreviewSurface
          compaction={compactPreview}
          onApply={(summary) => applyCompact.mutate(summary)}
          onDiscard={() => discardCompact.mutate(compactPreview.id)}
        />
      </div>
    )}
    </>
  );
}

export function shouldRefreshSessionWorkspace(event: WsServerEvent): boolean {
  if (!isSessionWorkspaceEvent(event)) return false;
  if (event.type === 'session_workspace:snapshot') return false;
  if (event.type === 'session_run:stream' && !event.done) return false;
  return true;
}

function isSessionWorkspaceEvent(event: WsServerEvent): boolean {
  return event.type.startsWith('session_') || event.type === 'session:updated' || event.type === 'history_record:new';
}

type SessionCommandResult =
  | { kind: 'workspace'; payload: SessionWorkspacePayload }
  | { kind: 'compact'; compaction: SessionCompaction }
  | { kind: 'status'; status: StatusSnapshot }
  | { kind: 'context'; context: SessionContextManifest }
  | { kind: 'noop' };

export async function runSessionCommand(
  content: string,
  payload: SessionWorkspacePayload,
  input: {
    sendMessage: (message: { sessionId: string; content: string; agentId?: string; mode?: SessionMode }) => void;
  },
): Promise<SessionCommandResult | null> {
  const sessionId = payload.activeSession.session.id;
  const trimmed = content.trim();
  if (trimmed === '/new') return { kind: 'workspace', payload: await api.newSessionFromCurrent(sessionId) };
  if (trimmed.startsWith('/new ')) {
    return { kind: 'workspace', payload: await api.newSessionFromCurrent(sessionId, parseNewCommand(trimmed)) };
  }
  if (trimmed === '/compact') return { kind: 'compact', compaction: await api.previewCompact(sessionId) };
  if (trimmed.startsWith('/compact ')) {
    return { kind: 'compact', compaction: await api.previewCompact(sessionId, parseCompactCommand(trimmed)) };
  }
  if (trimmed === '/status') {
    return { kind: 'status', status: await api.getSessionStatus(sessionId) };
  }
  if (trimmed === '/context') {
    return { kind: 'context', context: await api.getSessionContext(sessionId) };
  }
  if (trimmed === '/fork') return { kind: 'workspace', payload: await api.forkSession(sessionId) };
  if (trimmed === '/resume' || trimmed === '/history') return { kind: 'noop' };
  if (trimmed.startsWith('/resume ')) {
    const historyRecordId = trimmed.replace('/resume ', '').trim();
    return historyRecordId ? { kind: 'workspace', payload: await api.resumeHistoryRecord(historyRecordId) } : { kind: 'noop' };
  }
  if (trimmed.startsWith('/fork history:')) {
    const historyRecordId = trimmed.replace('/fork history:', '').trim();
    return historyRecordId ? { kind: 'workspace', payload: await api.forkHistoryRecord(historyRecordId) } : { kind: 'noop' };
  }
  input.sendMessage({ sessionId, content, agentId: 'planner', mode: payload.activeSession.session.mode });
  return null;
}

function requestActiveWorkspaceSnapshot(
  activeProjectId: string,
  payload: SessionWorkspacePayload | null,
): void {
  if (!activeProjectId || !payload) return;
  sessionSocket.requestSessionWorkspace({
    projectId: activeProjectId,
    sessionId: payload.activeSession.session.id,
  });
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

function parseNewCommand(command: string): { title?: string; blank?: boolean } {
  const body = command.replace(/^\/new\s*/, '').trim();
  return {
    ...(body.startsWith('title:') ? { title: body.replace(/^title:\s*/, '').trim() } : {}),
    ...(body === 'blank' || body.includes('blank:true') ? { blank: true } : {}),
  };
}

function parseCompactCommand(command: string): { focus?: string } {
  const body = command.replace(/^\/compact\s*/, '').trim();
  return body.startsWith('focus:')
    ? { focus: body.replace(/^focus:\s*/, '').trim() }
    : body
      ? { focus: body }
      : {};
}
