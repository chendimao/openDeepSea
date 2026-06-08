import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Loader2, Plus, Trash2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CreateProjectDialog } from '../components/CreateProjectDialog';
import { Button } from '../components/ui/Button';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import { Input } from '../components/ui/Input';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type {
  AcpBackend,
  ActiveSessionSummary,
  Project,
  PlatformSkillRef,
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
type SessionSwitcherProject = SessionWorkspacePayload['projectSwitcher']['projects'][number];
type CreateSessionAndSelectInput = {
  targetProjectId: string;
  sourceSession: Pick<Session, 'id' | 'mode' | 'provider' | 'model'>;
  navigationEnabled: boolean;
  createSession: (projectId: string, input: CreateSessionInput) => Promise<Session>;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  requestWorkspace: (input: { projectId: string; sessionId: string }) => void;
  onSessionCreated?: (session: Session) => void;
};

export async function createProjectSessionAndSelect({
  targetProjectId,
  sourceSession,
  navigationEnabled,
  createSession,
  navigate,
  requestWorkspace,
  onSessionCreated,
}: CreateSessionAndSelectInput): Promise<void> {
  const nextSession = await createSession(targetProjectId, {
    title: 'New Session',
    mode: sourceSession.mode,
    provider: sourceSession.provider as AcpBackend | null,
    model: sourceSession.model,
  });
  onSessionCreated?.(nextSession);
  requestWorkspace({ projectId: targetProjectId, sessionId: nextSession.id });
  if (navigationEnabled) {
    navigate(`/projects/${targetProjectId}/sessions/${nextSession.id}`);
    return;
  }
}

export function projectSessionToActiveSummary({
  session,
  project,
}: {
  session: Session;
  project: Pick<Project, 'id' | 'name' | 'path'>;
}): ActiveSessionSummary {
  return {
    id: session.id,
    project_id: session.project_id,
    project_name: project.name,
    project_path: project.path,
    title: session.title,
    status: session.status,
    phase: session.phase,
    provider: session.provider,
    model: session.model,
    pinned_at: session.pinned_at,
    created_at: session.created_at,
    last_viewed_at: session.last_viewed_at,
    updated_at: session.updated_at,
    unread_count: 0,
    active_run_count: 0,
    latest_event_summary: session.current_goal,
  };
}

export function applyProjectSwitcherProjectPatch(
  payload: SessionWorkspacePayload,
  project: Pick<Project, 'id' | 'name' | 'path'>,
): SessionWorkspacePayload {
  return {
    ...payload,
    project: payload.project.id === project.id
      ? { ...payload.project, name: project.name, path: project.path }
      : payload.project,
    projectSwitcher: {
      ...payload.projectSwitcher,
      projects: payload.projectSwitcher.projects.map((item) =>
        item.id === project.id ? { ...item, name: project.name, path: project.path } : item
      ),
    },
    activeSessions: payload.activeSessions.map((session) =>
      session.project_id === project.id
        ? { ...session, project_name: project.name, project_path: project.path }
        : session
    ),
  };
}

export function removeProjectFromWorkspacePayload(
  payload: SessionWorkspacePayload,
  projectId: string,
): SessionWorkspacePayload | null {
  if (payload.activeSession.session.project_id === projectId || payload.project.id === projectId) {
    return null;
  }
  return {
    ...payload,
    projectSwitcher: {
      ...payload.projectSwitcher,
      projects: payload.projectSwitcher.projects.filter((project) => project.id !== projectId),
    },
    activeSessions: payload.activeSessions.filter((session) => session.project_id !== projectId),
  };
}

export function removeProjectFromProjectList(
  projects: Project[] | undefined,
  projectId: string,
): Project[] | undefined {
  return projects?.filter((project) => project.id !== projectId);
}

export function updateActiveSessionPinnedAt(
  payload: SessionWorkspacePayload,
  session: Session,
): SessionWorkspacePayload {
  const existingSummary = payload.activeSessions.find((item) => item.id === session.id);
  const activeSummary = payload.activeSession.session.id === session.id
    ? projectSessionToActiveSummary({ session, project: payload.project })
    : null;
  const nextSummary = existingSummary ?? activeSummary;
  if (!nextSummary) return payload;

  const nextActiveSession = payload.activeSession.session.id === session.id
    ? {
      ...payload.activeSession,
      session: { ...payload.activeSession.session, ...session },
    }
    : payload.activeSession;

  return {
    ...payload,
    activeSession: nextActiveSession,
    activeSessions: upsertActiveSessionSummary(payload.activeSessions, {
      ...nextSummary,
      title: session.title,
      status: session.status,
      phase: session.phase,
      provider: session.provider,
      model: session.model,
      pinned_at: session.pinned_at,
      updated_at: session.updated_at,
      latest_event_summary: session.current_goal,
    }),
  };
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
  const queryClient = useQueryClient();
  const [compactPreview, setCompactPreview] = useState<SessionCompaction | null>(null);
  const [workspacePayload, setWorkspacePayload] = useState<SessionWorkspacePayload | null>(null);
  const [activeSessions, setActiveSessions] = useState<ActiveSessionSummary[] | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [renameProject, setRenameProject] = useState<SessionSwitcherProject | null>(null);
  const [removeProject, setRemoveProject] = useState<SessionSwitcherProject | null>(null);
  const [renameProjectName, setRenameProjectName] = useState('');
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

  const renameProjectMutation = useMutation({
    mutationFn: (input: { projectId: string; name: string }) => api.updateProject(input.projectId, { name: input.name }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setWorkspacePayload((current) => current ? applyProjectSwitcherProjectPatch(current, project) : current);
      setActiveSessions((current) => current?.map((session) =>
        session.project_id === project.id
          ? { ...session, project_name: project.name, project_path: project.path }
          : session
      ) ?? current);
      setRenameProject(null);
      setRenameProjectName('');
      toast.success('项目名称已更新');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '项目名称更新失败');
    },
  });

  const removeProjectMutation = useMutation({
    mutationFn: (projectId: string) => api.deleteProject(projectId),
    onSuccess: (_result, projectId) => {
      const removingActiveProject = workspacePayload?.activeSession.session.project_id === projectId;
      queryClient.setQueryData<Project[] | undefined>(
        ['projects'],
        (current) => removeProjectFromProjectList(current, projectId),
      );
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setWorkspacePayload((current) => current ? removeProjectFromWorkspacePayload(current, projectId) : current);
      setActiveSessions((current) => current?.filter((session) => session.project_id !== projectId) ?? current);
      setRemoveProject(null);
      toast.success('项目已移除');
      if (removingActiveProject && navigationEnabled) navigate('/');
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : '项目移除失败';
      toast.error(message.includes('409') ? '项目仍有运行中的智能体或工作流，请先停止或等待完成。' : message);
    },
  });

  const reorderProjectsMutation = useMutation({
    mutationFn: (input: { ids: string[]; pinned: boolean }) => api.reorderProjects(input),
    onSuccess: (projects) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setWorkspacePayload((current) => current ? {
        ...current,
        projectSwitcher: {
          ...current.projectSwitcher,
          projects: projects.map((project) => {
            const existing = current.projectSwitcher.projects.find((item) => item.id === project.id);
            return {
              id: project.id,
              name: project.name,
              path: project.path,
              active: existing?.active ?? project.id === current.project.id,
              recentSessions: existing?.recentSessions ?? [],
              created_at: project.created_at,
              updated_at: project.updated_at,
              pinned_at: project.pinned_at,
              sort_order: project.sort_order,
            };
          }),
        },
      } : current);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '项目排序失败');
    },
  });

  const toggleSessionPinMutation = useMutation({
    mutationFn: (session: ActiveSessionSummary) =>
      api.updateSession(session.id, { pinned_at: session.pinned_at === null ? Date.now() : null }),
    onSuccess: (session) => {
      setWorkspacePayload((current) =>
        current ? updateActiveSessionPinnedAt(current, session) : current
      );
      setActiveSessions((current) => {
        if (!current) return current;
        const base = current;
        const existing = base.find((item) => item.id === session.id);
        return existing
          ? upsertActiveSessionSummary(base, {
            ...existing,
            title: session.title,
            status: session.status,
            phase: session.phase,
            provider: session.provider,
            model: session.model,
            pinned_at: session.pinned_at,
            updated_at: session.updated_at,
            latest_event_summary: session.current_goal,
          })
          : current;
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '会话置顶更新失败');
    },
  });

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
        onSessionCreated: (session) => {
          const project = findProjectForSessionSummary(workspacePayload, targetProjectId);
          if (!project) return;
          const summary = projectSessionToActiveSummary({ session, project });
          setActiveSessions((current) => upsertActiveSessionSummary(current ?? workspacePayload.activeSessions, summary));
          setWorkspacePayload((current) => current ? {
            ...current,
            activeSessions: upsertActiveSessionSummary(current.activeSessions, summary),
          } : current);
        },
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
      onCreateProject={() => setCreateProjectOpen(true)}
      onRenameProject={(project) => {
        setRenameProject(project);
        setRenameProjectName(project.name);
      }}
      onRemoveProject={(project) => setRemoveProject(project)}
      onReorderProjects={(input) => reorderProjectsMutation.mutate(input)}
      onToggleSessionPin={(session) => toggleSessionPinMutation.mutate(session)}
    />
    <CreateProjectDialog open={createProjectOpen} onOpenChange={setCreateProjectOpen} />
    <Dialog
      open={renameProject !== null}
      onOpenChange={(open) => {
        if (!open) {
          setRenameProject(null);
          setRenameProjectName('');
        }
      }}
    >
      <DialogContent title="编辑项目名称" description={renameProject?.path}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = renameProjectName.trim();
            if (!renameProject || !name) return;
            renameProjectMutation.mutate({ projectId: renameProject.id, name });
          }}
        >
          <label
            htmlFor="session-project-rename"
            className="mb-1.5 block text-[12px] font-medium text-[var(--color-fg-muted)]"
          >
            项目名称
          </label>
          <Input
            id="session-project-rename"
            value={renameProjectName}
            onChange={(event) => setRenameProjectName(event.target.value)}
            autoFocus
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRenameProject(null);
                setRenameProjectName('');
              }}
              disabled={renameProjectMutation.isPending}
            >
              取消
            </Button>
            <Button type="submit" disabled={renameProjectMutation.isPending || renameProjectName.trim().length === 0}>
              {renameProjectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              保存名称
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog
      open={removeProject !== null}
      onOpenChange={(open) => {
        if (!open) setRemoveProject(null);
      }}
    >
      <DialogContent
        title="移除项目"
        description={removeProject ? `将从 OpenDeepSea 中移除「${removeProject.name}」。不会删除本地项目文件夹。` : undefined}
      >
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2.5">
          <div className="text-[11px] font-medium text-[var(--color-fg-muted)]">本地项目文件夹</div>
          <div className="mt-1 break-all font-mono text-[12px] text-[var(--color-fg)]">{removeProject?.path}</div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setRemoveProject(null)}
            disabled={removeProjectMutation.isPending}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              if (removeProject) removeProjectMutation.mutate(removeProject.id);
            }}
            disabled={removeProjectMutation.isPending}
          >
            {removeProjectMutation.isPending
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Trash2 className="h-3.5 w-3.5" />}
            {removeProjectMutation.isPending ? '正在移除' : '移除'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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

function findProjectForSessionSummary(
  payload: SessionWorkspacePayload,
  projectId: string,
): Pick<Project, 'id' | 'name' | 'path'> | null {
  const switcherProject = payload.projectSwitcher.projects.find((project) => project.id === projectId);
  if (switcherProject) {
    return {
      id: switcherProject.id,
      name: switcherProject.name,
      path: switcherProject.path,
    };
  }
  if (payload.project.id === projectId) {
    return {
      id: payload.project.id,
      name: payload.project.name,
      path: payload.project.path,
    };
  }
  return null;
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
      platformSkillRefs?: PlatformSkillRef[];
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
    ...(message.platformSkillRefs && message.platformSkillRefs.length > 0 ? { platformSkillRefs: message.platformSkillRefs } : {}),
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
