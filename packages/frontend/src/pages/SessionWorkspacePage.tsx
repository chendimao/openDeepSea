import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type { SessionCompaction, SessionWorkspacePayload } from '../lib/types';
import { sessionSocket, type WsServerEvent } from '../lib/ws';
import { CompactPreviewSurface } from '../session-ui/CompactPreviewSurface';
import { SessionShell } from '../session-ui/SessionShell';

export function SessionWorkspacePage(): JSX.Element {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [compactPreview, setCompactPreview] = useState<SessionCompaction | null>(null);
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const activeProjectId = projectId || projects[0]?.id || '';

  useEffect(() => {
    if (!projectId && activeProjectId) navigate(`/projects/${activeProjectId}`, { replace: true });
  }, [activeProjectId, navigate, projectId]);

  const workspace = useQuery({
    queryKey: ['session-workspace', activeProjectId],
    queryFn: () => api.getSessionWorkspace(activeProjectId),
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
    onSuccess: (payload) => {
      if (payload) {
        queryClient.setQueryData(['session-workspace', activeProjectId], payload);
      }
      return queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] });
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
    />
    {compactPreview && (
      <div className="session-overlay" role="dialog" aria-label="Compact Preview">
        <CompactPreviewSurface
          compaction={compactPreview}
          onApply={(summary) => applyCompact.mutate(summary)}
          onDiscard={() => setCompactPreview(null)}
        />
      </div>
    )}
    </>
  );
}

function isSessionWorkspaceEvent(event: WsServerEvent): boolean {
  return event.type.startsWith('session_') || event.type === 'session:updated' || event.type === 'history_record:new';
}

async function runSessionCommand(content: string, payload: SessionWorkspacePayload): Promise<SessionWorkspacePayload | null> {
  const sessionId = payload.activeSession.session.id;
  const trimmed = content.trim();
  if (trimmed === '/new') return api.newSessionFromCurrent(sessionId);
  if (trimmed === '/status') {
    await api.getSessionStatus(sessionId);
    return null;
  }
  if (trimmed === '/context') {
    await api.getSessionContext(sessionId);
    return null;
  }
  if (trimmed === '/fork') return api.forkSession(sessionId);
  if (trimmed.startsWith('/resume ')) {
    const historyRecordId = trimmed.replace('/resume ', '').trim();
    return historyRecordId ? api.resumeHistoryRecord(historyRecordId) : null;
  }
  if (trimmed.startsWith('/fork history:')) {
    const historyRecordId = trimmed.replace('/fork history:', '').trim();
    return historyRecordId ? api.forkHistoryRecord(historyRecordId) : null;
  }
  await api.sendSessionMessage(sessionId, { content });
  return null;
}
