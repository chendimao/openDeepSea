import React, { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { sessionSocket, type WsServerEvent } from '../lib/ws';
import { SessionShell } from '../session-ui/SessionShell';

export function SessionWorkspacePage(): JSX.Element {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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

  const sendMessage = useMutation({
    mutationFn: (content: string) => api.sendSessionMessage(workspace.data!.activeSession.session.id, { content }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session-workspace', activeProjectId] }),
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
    <SessionShell
      payload={workspace.data}
      onSendMessage={(content) => sendMessage.mutate(content)}
      onCommand={(command) => sendMessage.mutate(command)}
    />
  );
}

function isSessionWorkspaceEvent(event: WsServerEvent): boolean {
  return event.type.startsWith('session_') || event.type === 'session:updated' || event.type === 'history_record:new';
}
