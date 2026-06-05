import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  const queryClient = useQueryClient();
  const [compactPreview, setCompactPreview] = useState<SessionCompaction | null>(null);
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const activeProjectId = projectId || projects[0]?.id || '';

  useEffect(() => {
    if (!projectId && activeProjectId) navigate(`/projects/${activeProjectId}`, { replace: true });
  }, [activeProjectId, navigate, projectId]);

  const workspace = useQuery({
    queryKey: ['session-workspace', activeProjectId, sessionId ?? 'active'],
    queryFn: () => api.getSessionWorkspace(activeProjectId, { sessionId }),
    enabled: Boolean(activeProjectId),
  });

  useEffect(() => {
    const sessionId = workspace.data?.activeSession.session.id;
    if (!sessionId) return;
    sessionSocket.subscribeSession(sessionId);
    return () => sessionSocket.unsubscribeSession(sessionId);
  }, [workspace.data?.activeSession.session.id]);

  useEffect(() => {
    return sessionSocket.on((event: WsServerEvent) => {
      if (!isSessionWorkspaceEvent(event)) return;
      void queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] });
    });
  }, [activeProjectId, queryClient]);

  const runCommand = useMutation({
    mutationFn: (content: string) => runSessionCommand(content, workspace.data!),
    onSuccess: (result) => {
      if (!result) return queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] });
      if (result.kind === 'workspace') {
        const nextSessionId = result.payload.activeSession.session.id;
        queryClient.setQueryData(['session-workspace', result.payload.project.id, nextSessionId], result.payload);
        if (nextSessionId !== sessionId || result.payload.project.id !== activeProjectId) {
          navigate(`/projects/${result.payload.project.id}/sessions/${nextSessionId}`);
        }
        return queryClient.invalidateQueries({ queryKey: ['session-workspace', result.payload.project.id] });
      }
      if (result.kind === 'compact') {
        setCompactPreview(result.compaction);
        return undefined;
      }
      if (result.kind === 'status') {
        queryClient.setQueryData<SessionWorkspacePayload>(
          ['session-workspace', activeProjectId, sessionId ?? 'active'],
          (current) => current ? { ...current, status: result.status } : current,
        );
        return undefined;
      }
      if (result.kind === 'context') {
        queryClient.setQueryData<SessionWorkspacePayload>(
          ['session-workspace', activeProjectId, sessionId ?? 'active'],
          (current) => current ? { ...current, context: result.context } : current,
        );
        return undefined;
      }
      return undefined;
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const applyCompact = useMutation({
    mutationFn: (summary: string) =>
      api.applyCompact(workspace.data!.activeSession.session.id, compactPreview!.id, {
        applied_summary: summary,
        user_edited: summary !== compactPreview!.preview_summary,
      }),
    onSuccess: () => {
      setCompactPreview(null);
      return queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] });
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const discardCompact = useMutation({
    mutationFn: (compactionId: string) => api.discardCompact(workspace.data!.activeSession.session.id, compactionId),
    onSuccess: () => {
      setCompactPreview(null);
      return queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] });
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const cancelRun = useMutation({
    mutationFn: api.cancelSessionRun,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] }),
    onError: (error) => toast.error((error as Error).message),
  });

  const retryRun = useMutation({
    mutationFn: api.retrySessionRun,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] }),
    onError: (error) => toast.error((error as Error).message),
  });

  const saveContract = useMutation({
    mutationFn: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) =>
      api.updateSessionContract(workspace.data!.activeSession.session.id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] }),
    onError: (error) => toast.error((error as Error).message),
  });

  const filterHistory = useMutation({
    mutationFn: (filters: { q?: string; status?: HistoryRecordStatus | 'all'; mode?: SessionMode | 'all' }) =>
      api.listHistoryRecords(activeProjectId, filters),
    onSuccess: (records) => {
      queryClient.setQueryData<SessionWorkspacePayload>(
        ['session-workspace', activeProjectId, sessionId ?? 'active'],
        (current) => current ? { ...current, historyRecords: records } : current,
      );
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
  if (!workspace.data) {
    return (
      <div className="session-shell">
        <div className="session-loading">加载 Session</div>
      </div>
    );
  }

  return (
    <>
    <SessionShell
      payload={workspace.data}
      onSendMessage={(content) => runCommand.mutate(content)}
      onCommand={(command) => {
        if (command === '/compact') {
          void api.previewCompact(workspace.data.activeSession.session.id).then(setCompactPreview).catch((error) => {
            toast.error((error as Error).message);
          });
          return;
        }
        runCommand.mutate(command);
      }}
      onCancelRun={(runId) => cancelRun.mutate(runId)}
      onRetryRun={(runId) => retryRun.mutate(runId)}
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

function isSessionWorkspaceEvent(event: WsServerEvent): boolean {
  return event.type.startsWith('session_') || event.type === 'session:updated' || event.type === 'history_record:new';
}

type SessionCommandResult =
  | { kind: 'workspace'; payload: SessionWorkspacePayload }
  | { kind: 'compact'; compaction: SessionCompaction }
  | { kind: 'status'; status: StatusSnapshot }
  | { kind: 'context'; context: SessionContextManifest }
  | { kind: 'noop' };

export async function runSessionCommand(content: string, payload: SessionWorkspacePayload): Promise<SessionCommandResult | null> {
  const sessionId = payload.activeSession.session.id;
  const trimmed = content.trim();
  if (trimmed === '/new') return { kind: 'workspace', payload: await api.newSessionFromCurrent(sessionId) };
  if (trimmed.startsWith('/new ')) {
    return { kind: 'workspace', payload: await api.sendSessionMessage(sessionId, { content }) as SessionWorkspacePayload };
  }
  if (trimmed === '/compact') return { kind: 'compact', compaction: await api.previewCompact(sessionId) };
  if (trimmed.startsWith('/compact ')) {
    const response = await api.sendSessionMessage(sessionId, { content });
    return isSessionCompaction(response) ? { kind: 'compact', compaction: response } : null;
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
  await api.sendSessionMessage(sessionId, { content });
  return null;
}

function isSessionCompaction(value: unknown): value is SessionCompaction {
  return typeof value === 'object' &&
    value !== null &&
    'preview_summary' in value &&
    'status' in value &&
    !('activeSession' in value);
}
