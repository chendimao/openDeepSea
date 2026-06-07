import {
  Brain,
  CheckCircle2,
  ChevronDown,
  Edit3,
  Ellipsis,
  FileText,
  Filter,
  FolderOpen,
  FolderPlus,
  GitFork,
  MessageSquare,
  Minimize2,
  Pin,
  RefreshCcw,
  Repeat2,
  Search,
  Settings,
  ShieldCheck,
  Square,
  SquarePen,
  StopCircle,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type {
  ActiveSessionSummary,
  ProjectUsedAgentsPayload,
  Session,
  SessionContract,
  SessionDetail,
  SessionDiffRow,
  SessionAgentEvent,
  SessionEvidenceEvent,
  SessionMessage,
  SessionPlanItem,
  SessionRun,
  SessionToolRow,
  SessionWorkspacePayload,
  StatusSnapshot,
} from '../lib/types';
import { api } from '../lib/api';
import { parseMessageMetadata } from '../lib/messageMetadata';
import { isPinnedItem, layerIds, reorderWithinLayer } from '../lib/sortableItems';
import { MessageContent } from '../components/MessageContent';
import {
  MarkdownDisplaySwitch,
  SessionMessageBubble,
  type SessionMessageDisplayMode,
} from './SessionMessageBubble';
import { ProjectAgentStrip } from './ProjectAgentStrip';
import { SessionFileComposer } from './SessionFileComposer';
import type { SessionComposerSubmit } from './session-file-composer-model';

export function SessionShellView({
  payload,
  onSendMessage,
  onCommand,
  onCancelRun,
  onRetryRun,
  onSaveContract,
  onOpenSession,
  onCreateSession,
  onRenameProject,
  onRemoveProject,
  onReorderProjects,
  onToggleSessionPin,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (message: SessionComposerSubmit) => void;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onCreateSession?: (projectId: string) => void | Promise<void>;
  onRenameProject?: (project: ProjectSwitcherProject) => void;
  onRemoveProject?: (project: ProjectSwitcherProject) => void;
  onReorderProjects?: (input: { ids: string[]; pinned: boolean }) => void;
  onToggleSessionPin?: (session: ActiveSessionSummary) => void;
}): JSX.Element {
  const activeRun = getActiveRun(payload.activeSession);
  const forkTarget = payload.historyRecords[0]?.id;

  return (
    <section className="session-shell deepsea-shell" aria-label="Session Operations Console">
      <main className="deepsea-main">
        <ProjectSessionTreeRail
          projects={payload.projectSwitcher.projects}
          sessions={payload.activeSessions}
          currentSession={payload.activeSession.session}
          currentProjectId={payload.project.id}
          currentProjectName={payload.project.name}
          onCommand={onCommand}
          onOpenSession={onOpenSession}
          onCreateSession={onCreateSession}
          onRenameProject={onRenameProject}
          onRemoveProject={onRemoveProject}
          onReorderProjects={onReorderProjects}
          onToggleSessionPin={onToggleSessionPin}
        />
        <TranscriptCanvas
          detail={payload.activeSession}
          evidence={payload.evidence}
          projectId={payload.project.id}
          onSendMessage={onSendMessage}
        />
        <IntegratedInspector
          payload={payload}
          activeRun={activeRun}
          onCommand={onCommand}
          onCancelRun={onCancelRun}
          onRetryRun={onRetryRun}
          onSaveContract={onSaveContract}
        />
      </main>
      <BottomStatusBar
        payload={payload}
        forkTarget={forkTarget}
        onCommand={onCommand}
      />
    </section>
  );
}

function BottomStatusBar({
  payload,
  onCommand,
  forkTarget,
}: {
  payload: SessionWorkspacePayload;
  onCommand: (command: string) => void;
  forkTarget?: string;
}): JSX.Element {
  const status = payload.bottomStatus;
  const pressure = contextPressurePercent(payload.status.context.pressure);

  return (
    <footer className="deepsea-bottom-status" aria-label="Session status bar">
      <div className="deepsea-bottom-status__path" aria-label="当前会话路径">
        <GitFork aria-hidden="true" />
        <span className="deepsea-mono">workspace</span>
        <span>/</span>
        <strong>{payload.project.name}</strong>
        <span>/</span>
        <span title={payload.activeSession.session.title}>
          {formatCompactSessionTitle(payload.activeSession.session.title, 28)}
        </span>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <StopCircle aria-hidden="true" />
        <span className="deepsea-bottom-status__label">响应耗时</span>
        <strong>{formatResponseTime(status.lastResponseMs)}</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <ShieldCheck aria-hidden="true" />
        <span className="deepsea-bottom-status__label">错误率</span>
        <strong>{formatErrorRate(status.errorRate)}</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <RefreshCcw aria-hidden="true" />
        <span className="deepsea-bottom-status__label">网络延迟</span>
        <strong>{status.networkLatencyMs === null ? '--' : `${status.networkLatencyMs}ms`}</strong>
      </div>
      <div className="deepsea-bottom-status__spacer" />
      <div className="deepsea-bottom-status__commands">
        <div className="deepsea-command-group" aria-label="Session command actions">
          <CommandPill label="压缩" kbd="⌘P" icon={Minimize2} command="/compact" onCommand={onCommand} />
          <CommandPill
            label="分叉"
            kbd="⌘B"
            icon={GitFork}
            command={forkTarget ? `/fork history:${forkTarget}` : '/fork'}
            onCommand={onCommand}
          />
          <span className="deepsea-strip-divider" />
          <ContextPressure pressure={pressure} compact />
          <button type="button" className="deepsea-strip-settings" aria-label="工作区设置">
            <Settings aria-hidden="true" />
          </button>
        </div>
        <ProjectAgentStrip project={payload.project} />
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <FileText aria-hidden="true" />
        <span className="deepsea-bottom-status__label">API 消耗</span>
        <strong>{status.tokenUsage ? `${status.tokenUsage.total.toLocaleString()} tokens` : '--'}</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <button type="button" className="deepsea-bottom-status__export">
        <FileText aria-hidden="true" />
        导出
      </button>
    </footer>
  );
}

function CommandPill({
  label,
  kbd,
  icon: Icon,
  command,
  onCommand,
  primary = false,
}: {
  label: string;
  kbd: string;
  icon: LucideIcon;
  command: string;
  onCommand: (command: string) => void;
  primary?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className="deepsea-command-pill"
      data-primary={primary ? 'true' : undefined}
      data-command={command}
      onClick={() => onCommand(command)}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <kbd>{kbd}</kbd>
    </button>
  );
}

function ContextPressure({ pressure, compact = false }: { pressure: number; compact?: boolean }): JSX.Element {
  const active = Math.max(1, Math.round(pressure / 10));
  return (
    <div className="deepsea-pressure" data-compact={compact ? 'true' : undefined} aria-label="上下文压力">
      <div>
        <span>上下文压力</span>
        <strong>{pressure}%</strong>
      </div>
      <div className="deepsea-pressure__bars">
        {Array.from({ length: 10 }, (_, index) => (
          <span data-active={index < active ? 'true' : undefined} key={index} />
        ))}
      </div>
    </div>
  );
}

type ProjectSessionTreeProject = {
  id: string;
  name: string;
  path: string;
  active: boolean;
  created_at?: number;
  pinned_at?: number | null;
  sort_order?: number | null;
  recentSessions: ProjectSwitcherProject['recentSessions'];
  sessions: ActiveSessionSummary[];
};

type ProjectSwitcherProject = SessionWorkspacePayload['projectSwitcher']['projects'][number];

const projectActionMenuItems: Array<{
  label: '编辑名称' | '移除';
  icon: LucideIcon;
  danger?: boolean;
}> = [
  { label: '编辑名称', icon: SquarePen },
  { label: '移除', icon: Trash2, danger: true },
];

export function buildProjectReorderInput(
  projects: ProjectSwitcherProject[],
  activeId: string,
  overId: string,
): { ids: string[]; pinned: boolean } | null {
  const sortableProjects = projects.map((project, index) => ({
    ...project,
    created_at: project.created_at ?? -index,
    pinned_at: project.pinned_at ?? null,
    sort_order: project.sort_order ?? null,
  }));
  const next = reorderWithinLayer(sortableProjects, activeId, overId);
  const moved = next.find((project) => project.id === activeId);
  if (!moved) return null;
  const pinned = isPinnedItem(moved);
  const ids = layerIds(next, pinned);
  return ids.length > 0 ? { ids, pinned } : null;
}

function ProjectSessionTreeRail({
  projects = [],
  sessions = [],
  currentSession,
  currentProjectId,
  currentProjectName,
  onCommand,
  onOpenSession,
  onCreateSession,
  onRenameProject,
  onRemoveProject,
  onReorderProjects,
  onToggleSessionPin,
}: {
  projects?: ProjectSwitcherProject[];
  sessions?: ActiveSessionSummary[];
  currentSession: Session;
  currentProjectId: string;
  currentProjectName: string;
  onCommand: (command: string) => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onCreateSession?: (projectId: string) => void | Promise<void>;
  onRenameProject?: (project: ProjectSwitcherProject) => void;
  onRemoveProject?: (project: ProjectSwitcherProject) => void;
  onReorderProjects?: (input: { ids: string[]; pinned: boolean }) => void;
  onToggleSessionPin?: (session: ActiveSessionSummary) => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const normalizedQuery = q.trim().toLowerCase();
  const tree = buildProjectSessionTree({
    projects,
    sessions,
    currentSession,
    currentProjectId,
    currentProjectName,
  });
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(tree.map((project) => [project.id, project.id === currentProjectId]))
  );
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [dropProjectId, setDropProjectId] = useState<string | null>(null);
  const visibleProjects = filterProjectSessionTree(tree, normalizedQuery);
  const createSessionForProject = (projectId: string) => {
    setExpandedProjectIds((current) => ({ ...current, [projectId]: true }));
    setOpenProjectMenuId(null);
    if (onCreateSession) {
      void onCreateSession(projectId);
      return;
    }
    onCommand('/new');
  };
  const resetDragState = () => {
    setDraggingProjectId(null);
    setDropProjectId(null);
  };
  const handleProjectDrop = (event: DragEvent<HTMLElement>, targetProjectId: string) => {
    event.preventDefault();
    if (!draggingProjectId || draggingProjectId === targetProjectId) {
      resetDragState();
      return;
    }
    const input = buildProjectReorderInput(tree, draggingProjectId, targetProjectId);
    if (input) onReorderProjects?.(input);
    resetDragState();
  };

  return (
    <aside className="deepsea-history" aria-label="Project Sessions">
      <div className="deepsea-history__header">
        <div className="deepsea-project-tree-actions">
          <button
            type="button"
            className="deepsea-project-tree-action-row"
            data-project-create-session={currentProjectId}
            onClick={() => createSessionForProject(currentProjectId)}
          >
            <span>
              <Edit3 aria-hidden="true" />
              新建会话
            </span>
            <kbd>⌘N</kbd>
          </button>
          <form
            className="deepsea-project-tree-search-row"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <Search aria-hidden="true" />
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.currentTarget.value)}
              placeholder="搜索"
            />
          </form>
        </div>
      </div>

      <div className="deepsea-history__list deepsea-project-tree">
        <div className="deepsea-project-tree-heading">
          <span>项目</span>
          <div>
            <button type="button" aria-label="筛选项目">
              <Filter aria-hidden="true" />
            </button>
            <button type="button" aria-label="新建项目文件夹">
              <FolderPlus aria-hidden="true" />
            </button>
          </div>
        </div>
        {visibleProjects.length === 0 ? (
          <div className="deepsea-empty">没有匹配的项目或会话。</div>
        ) : visibleProjects.map((project) => {
          const expanded = normalizedQuery
            ? true
            : expandedProjectIds[project.id] ?? project.id === currentProjectId;
          const projectMenuOpen = openProjectMenuId === project.id;
          return (
            <section
              className="deepsea-project-tree-section"
              data-active={project.active ? 'true' : undefined}
              data-dragging={draggingProjectId === project.id ? 'true' : undefined}
              data-drop-target={dropProjectId === project.id ? 'true' : undefined}
              data-empty={project.sessions.length === 0 ? 'true' : undefined}
              draggable
              key={project.id}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', project.id);
                setDraggingProjectId(project.id);
              }}
              onDragOver={(event) => {
                if (!draggingProjectId || draggingProjectId === project.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropProjectId(project.id);
              }}
              onDragLeave={() => {
                if (dropProjectId === project.id) setDropProjectId(null);
              }}
              onDrop={(event) => handleProjectDrop(event, project.id)}
              onDragEnd={resetDragState}
            >
              <div className="deepsea-project-node">
                <button
                  type="button"
                  className="deepsea-project-node__button"
                  aria-expanded={expanded}
                  aria-label={`切换 ${project.name} 项目展开状态`}
                  onClick={() =>
                    setExpandedProjectIds((current) => ({
                      ...current,
                      [project.id]: !(current[project.id] ?? project.id === currentProjectId),
                    }))
                  }
                >
                  <FolderOpen aria-hidden="true" />
                  <span className="deepsea-project-node__label">
                    <strong>{project.name}</strong>
                  </span>
                </button>
                <div className="deepsea-project-node__actions">
                  <button
                    type="button"
                    className="deepsea-project-node__icon-button"
                    aria-expanded={projectMenuOpen}
                    aria-haspopup="menu"
                    aria-label={`打开 ${project.name} 项目操作菜单`}
                    onClick={() => setOpenProjectMenuId((current) => (current === project.id ? null : project.id))}
                  >
                    <Ellipsis aria-hidden="true" />
                  </button>
                  <div
                    className="deepsea-project-node__menu"
                    data-state={projectMenuOpen ? 'open' : 'closed'}
                    role="menu"
                    aria-hidden={projectMenuOpen ? undefined : true}
                    aria-label={`${project.name} 项目操作`}
                  >
                    {projectActionMenuItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          type="button"
                          className="deepsea-project-node__menu-item"
                          data-danger={item.danger ? 'true' : undefined}
                          data-project-menu-item={item.label}
                          key={item.label}
                          onClick={() => {
                            setOpenProjectMenuId(null);
                            if (item.label === '编辑名称') onRenameProject?.(project);
                            else onRemoveProject?.(project);
                          }}
                          role="menuitem"
                        >
                          <Icon aria-hidden="true" />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="deepsea-project-node__icon-button"
                    data-project-create-session={project.id}
                    aria-label={`新建 ${project.name} 会话`}
                    onClick={() => createSessionForProject(project.id)}
                  >
                    <SquarePen aria-hidden="true" />
                  </button>
                </div>
              </div>
              {expanded && (
                <div className="deepsea-project-node__sessions">
                  {project.sessions.length === 0 ? (
                    <div className="deepsea-project-session-empty">暂无活跃会话</div>
                  ) : project.sessions.map((session) => (
                    <ProjectSessionRow
                      currentSessionId={currentSession.id}
                      key={session.id}
                      onOpenSession={onOpenSession}
                      onToggleSessionPin={onToggleSessionPin}
                      session={session}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function ProjectSessionRow({
  session,
  currentSessionId,
  onOpenSession,
  onToggleSessionPin,
}: {
  session: ActiveSessionSummary;
  currentSessionId: string;
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onToggleSessionPin?: (session: ActiveSessionSummary) => void;
}): JSX.Element {
  const isCurrent = session.id === currentSessionId;
  return (
    <div
      className="deepsea-project-session-row-wrap"
      data-current={isCurrent ? 'true' : undefined}
      data-pinned={session.pinned_at !== null ? 'true' : 'false'}
    >
      <button
        type="button"
        className="deepsea-project-session-pin"
        data-session-pin-button="true"
        data-pinned={session.pinned_at !== null ? 'true' : 'false'}
        aria-label={`${session.pinned_at !== null ? '取消置顶会话' : '置顶会话'}：${session.title}`}
        aria-pressed={session.pinned_at !== null}
        onClick={(event) => {
          event.stopPropagation();
          onToggleSessionPin?.(session);
        }}
      >
        <Pin aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-current={isCurrent ? 'true' : undefined}
        className="deepsea-project-session-row"
        data-current={isCurrent ? 'true' : undefined}
        data-project-session-row="true"
        data-running={session.active_run_count > 0 ? 'true' : undefined}
        data-status={session.status}
        onClick={() => onOpenSession?.(session.project_id, session.id)}
      >
        <span className="deepsea-project-session-row__title" title={session.title}>
          {formatCompactSessionTitle(session.title, 31)}
        </span>
        <time className="deepsea-project-session-row__time">{formatRelativeTime(Date.now(), session.updated_at)}</time>
      </button>
    </div>
  );
}

function buildProjectSessionTree(input: {
  projects: ProjectSwitcherProject[];
  sessions: ActiveSessionSummary[];
  currentSession: Session;
  currentProjectId: string;
  currentProjectName: string;
}): ProjectSessionTreeProject[] {
  const activeSessions = ensureCurrentActiveSessionSummary(
    input.sessions,
    input.currentSession,
    input.currentProjectId,
    input.currentProjectName,
  ).filter((session) => session.status !== 'archived');
  const sessionsByProjectId = new Map<string, ActiveSessionSummary[]>();
  for (const session of activeSessions) {
    const bucket = sessionsByProjectId.get(session.project_id) ?? [];
    bucket.push(session);
    sessionsByProjectId.set(session.project_id, bucket);
  }

  const knownProjectIds = new Set(input.projects.map((project) => project.id));
  const projectNodes: ProjectSessionTreeProject[] = input.projects.map((project) => ({
    id: project.id,
    name: project.name,
    path: project.path,
    active: project.active,
    created_at: project.created_at,
    pinned_at: project.pinned_at,
    sort_order: project.sort_order,
    recentSessions: project.recentSessions,
    sessions: sessionsByProjectId.get(project.id) ?? [],
  }));

  const orphanProjects = new Map<string, ProjectSessionTreeProject>();
  for (const session of activeSessions) {
    if (knownProjectIds.has(session.project_id)) continue;
    const orphanId = `orphan:${session.project_id || session.project_name || session.project_path}`;
    const orphanProject = orphanProjects.get(orphanId) ?? {
      id: orphanId,
      name: session.project_name || '其他项目',
      path: session.project_path,
      active: false,
      recentSessions: [],
      sessions: [],
    };
    orphanProject.sessions.push(session);
    orphanProjects.set(orphanId, orphanProject);
  }

  return [...projectNodes, ...orphanProjects.values()];
}

function filterProjectSessionTree(
  tree: ProjectSessionTreeProject[],
  normalizedQuery: string,
): ProjectSessionTreeProject[] {
  if (!normalizedQuery) return tree;
  return tree.flatMap((project) => {
    const projectMatches = [project.name, project.path].some((value) =>
      value.toLowerCase().includes(normalizedQuery)
    );
    const matchingSessions = project.sessions.filter((session) =>
      [
        session.title,
        session.project_name,
        session.project_path,
        session.latest_event_summary ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedQuery))
    );
    if (!projectMatches && matchingSessions.length === 0) return [];
    return [{
      ...project,
      sessions: projectMatches ? project.sessions : matchingSessions,
    }];
  });
}

function TranscriptCanvas({
  detail,
  evidence,
  projectId,
  onSendMessage,
}: {
  detail: SessionDetail;
  evidence: SessionEvidenceEvent[];
  projectId: string;
  onSendMessage: (message: SessionComposerSubmit) => void;
}): JSX.Element {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const followTranscriptRef = useRef(true);
  const { data: projectAgents } = useQuery({
    queryKey: ['project-used-agents', projectId],
    queryFn: () => api.getProjectUsedAgents(projectId),
    staleTime: 20_000,
  });
  const timeline = buildTranscriptTimeline(detail).slice(-36);
  const timelineEndKey = timeline.at(-1)?.key ?? 'empty';
  const timelineFollowKey = useMemo(
    () => buildTranscriptFollowKey({
      agentEvents: detail.agentEvents,
      runs: detail.runs,
      timelineEndKey,
    }),
    [detail.agentEvents, detail.runs, timelineEndKey],
  );
  const latestUserMessageKey = useMemo(() => getLatestUserMessageKey(detail.messages), [detail.messages]);
  const [displayModes, setDisplayModes] = useState<Record<string, SessionMessageDisplayMode>>({});
  const displayModeFor = (key: string): SessionMessageDisplayMode => displayModes[key] ?? 'preview';
  const setDisplayModeFor = (key: string, mode: SessionMessageDisplayMode) => {
    setDisplayModes((current) => ({ ...current, [key]: mode }));
  };
  const agentNamesById = buildAgentNamesById(detail.messages, projectAgents);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return undefined;

    const updateFollowState = () => {
      followTranscriptRef.current = isTranscriptNearBottom(transcript);
    };

    updateFollowState();
    transcript.addEventListener('scroll', updateFollowState, { passive: true });
    return () => transcript.removeEventListener('scroll', updateFollowState);
  }, []);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const composer = composerRef.current;
    if (!transcript || !composer) return undefined;

    const updateComposerSpace = () => {
      const composerRect = composer.getBoundingClientRect();
      const transcriptRect = transcript.getBoundingClientRect();
      const overlap = Math.max(0, transcriptRect.bottom - composerRect.top);
      const nextSpace = Math.ceil(Math.max(160, overlap + 24));
      transcript.style.setProperty('--deepsea-composer-space', `${nextSpace}px`);
    };

    updateComposerSpace();
    if (typeof ResizeObserver === 'undefined') return undefined;

    const resizeObserver = new ResizeObserver(updateComposerSpace);
    resizeObserver.observe(composer);
    resizeObserver.observe(transcript);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const transcriptEnd = transcriptEndRef.current;
    if (!transcript || !transcriptEnd) return;

    followTranscriptRef.current = true;
    transcriptEnd.scrollIntoView({ block: 'end' });
  }, [latestUserMessageKey]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const transcriptEnd = transcriptEndRef.current;
    if (!transcript || !transcriptEnd) return;

    if (!followTranscriptRef.current) return;
    transcriptEnd.scrollIntoView({ block: 'end' });
  }, [timelineFollowKey]);

  return (
    <section className="deepsea-transcript" aria-label="Active Session">
      <div className="deepsea-transcript__scroll" data-transcript-scroll="true" ref={transcriptRef}>
        <div className="deepsea-transcript__heading">
          <h2>
            <MessageSquare aria-hidden="true" />
            3. 对话记录 <span>(Transcript)</span>
          </h2>
          <button type="button">
            全部展开
            <ChevronDown aria-hidden="true" />
          </button>
        </div>

        {timeline.length === 0 ? (
          <div className="deepsea-empty deepsea-empty--center">发送第一条消息开始当前会话。</div>
        ) : timeline.map((item) => {
          if (item.kind === 'message') {
            const displayMode = displayModeFor(item.key);
            return (
              <TranscriptMessage
                key={item.key}
                message={item.message}
                displayMode={displayMode}
                onDisplayModeChange={(mode) => setDisplayModeFor(item.key, mode)}
              />
            );
          }
          const runEvidence = evidence.filter((event) => event.source_run_id === item.run.id);
          const runAgentEvents = (detail.agentEvents ?? []).filter((event) => event.run_id === item.run.id);
          const output = runOutputText(item.run);
          const displayMode = displayModeFor(item.key);
          const runLabel = agentNamesById.get(item.run.agent_id) ?? item.run.agent_id;
          return (
            <React.Fragment key={item.key}>
              <AgentThoughtPanel run={item.run} evidence={runEvidence} agentEvents={runAgentEvents} />
              <article className="deepsea-run-log">
                <div>
                  <span className="deepsea-status-chip" data-tone={item.run.status === 'failed' ? 'danger' : 'ok'}>
                    {runLabel}
                  </span>
                  <time className="deepsea-mono">{formatClock(item.run.started_at)}</time>
                  <ThinkingDurationBadge run={item.run} />
                  <RunStatusBadge status={item.run.status} />
                  <MarkdownDisplaySwitch
                    content={output}
                    mode={displayMode}
                    onModeChange={(mode) => setDisplayModeFor(item.key, mode)}
                  />
                </div>
                <div className="deepsea-run-log-body">
                  {displayMode === 'source' ? (
                    <MessageContent content={output} mode={displayMode} suppressTraceEvents />
                  ) : (
                    <SessionRunTimeline events={runAgentEvents} fallbackText={output} />
                  )}
                </div>
              </article>
            </React.Fragment>
          );
        })}
        <div aria-hidden="true" className="deepsea-transcript__end" data-transcript-end="true" ref={transcriptEndRef} />
      </div>
      <div className="deepsea-composer-anchor" ref={composerRef}>
        <DeepseaComposer projectId={detail.session.project_id} onSendMessage={onSendMessage} />
      </div>
    </section>
  );
}

type TranscriptTimelineItem =
  | { kind: 'message'; key: string; timestamp: number; message: SessionMessage }
  | { kind: 'run'; key: string; timestamp: number; run: SessionRun };

function buildTranscriptTimeline(detail: SessionDetail): TranscriptTimelineItem[] {
  return [
    ...detail.messages.map((message) => ({
      kind: 'message' as const,
      key: `message:${message.id}`,
      timestamp: message.created_at,
      message,
    })),
    ...detail.runs.map((run) => ({
      kind: 'run' as const,
      key: `run:${run.id}`,
      timestamp: run.started_at,
      run,
    })),
  ].sort((left, right) => left.timestamp - right.timestamp || left.key.localeCompare(right.key));
}

const TRANSCRIPT_FOLLOW_THRESHOLD_PX = 220;

export function isTranscriptNearBottom(
  transcript: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>,
): boolean {
  const distanceFromBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  return distanceFromBottom <= TRANSCRIPT_FOLLOW_THRESHOLD_PX;
}

export function getLatestUserMessageKey(messages: SessionMessage[]): string {
  const latestUserMessage = [...messages]
    .filter((message) => message.role === 'user')
    .sort((left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id))[0];
  return latestUserMessage ? `${latestUserMessage.id}:${latestUserMessage.created_at}` : 'none';
}

export function buildTranscriptFollowKey({
  agentEvents,
  runs,
  timelineEndKey,
}: {
  agentEvents?: SessionAgentEvent[];
  runs: SessionRun[];
  timelineEndKey: string;
}): string {
  const latestRun = [...runs].sort((left, right) =>
    right.updated_at - left.updated_at || right.id.localeCompare(left.id)
  )[0];
  const latestAgentEvent = [...(agentEvents ?? [])].sort((left, right) =>
    right.seq - left.seq || right.created_at - left.created_at || right.id.localeCompare(left.id)
  )[0];
  return [
    timelineEndKey,
    latestRun?.id ?? 'no-run',
    latestRun?.status ?? 'no-status',
    latestRun?.updated_at ?? 0,
    latestRun?.stdout.length ?? 0,
    latestRun?.stderr.length ?? 0,
    latestRun?.activity_log.length ?? 0,
    latestAgentEvent?.id ?? 'no-event',
    latestAgentEvent?.seq ?? 0,
    latestAgentEvent?.content.length ?? 0,
  ].join(':');
}

function TranscriptMessage({
  message,
  displayMode,
  onDisplayModeChange,
}: {
  message: SessionMessage;
  displayMode: SessionMessageDisplayMode;
  onDisplayModeChange: (mode: SessionMessageDisplayMode) => void;
}): JSX.Element {
  const metadata = parseMessageMetadata(message.metadata);
  return (
    <SessionMessageBubble
      role={message.role}
      content={message.content}
      timeLabel={formatClock(message.created_at)}
      statusLabel={message.status === 'queued' || message.status === 'streaming' ? '思考中' : null}
      roleLabel={message.sender_name ?? message.sender_id}
      attachments={metadata.attachments}
      displayMode={displayMode}
      onDisplayModeChange={onDisplayModeChange}
    />
  );
}

function buildAgentNamesById(
  messages: SessionMessage[],
  projectAgents?: ProjectUsedAgentsPayload,
): Map<string, string> {
  const names = new Map<string, string>();
  if (projectAgents) {
    names.set(projectAgents.planner.agent_id, projectAgents.planner.name);
    for (const agent of projectAgents.agents) {
      names.set(agent.agent_id, agent.name);
    }
  }
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.sender_name) continue;
    names.set(message.sender_id, message.sender_name);
  }
  return names;
}

export type SessionRunTranscriptItem =
  | { type: 'text'; id: string; text: string }
  | { type: 'event'; id: string; label: string; detail: string | null; created_at: number };

function SessionRunTimeline({
  events,
  fallbackText,
}: {
  events: SessionAgentEvent[];
  fallbackText: string;
}): JSX.Element {
  const items = buildSessionRunTranscriptItems(events, fallbackText);
  return (
    <div className="deepsea-run-timeline">
      {items.map((item) => item.type === 'text' ? (
        <div key={item.id} className="deepsea-run-timeline__text">
          <MessageContent content={item.text} mode="preview" suppressTraceEvents />
        </div>
      ) : (
        <div key={item.id} className="deepsea-run-timeline__event">
          <span>[{item.label}]</span>
          {item.detail && <small>{item.detail}</small>}
        </div>
      ))}
    </div>
  );
}

export function buildSessionRunTranscriptItems(
  events: SessionAgentEvent[],
  fallbackText: string,
): SessionRunTranscriptItem[] {
  const items: SessionRunTranscriptItem[] = [];
  const sortedEvents = [...events].sort((left, right) => left.seq - right.seq || left.created_at - right.created_at);
  let textBuffer = '';
  let textIndex = 0;

  const flushText = () => {
    const text = textBuffer.trim();
    textBuffer = '';
    if (!text) return;
    items.push({ type: 'text', id: `text-${textIndex}`, text });
    textIndex += 1;
  };

  for (const event of sortedEvents) {
    if (isAnswerTextEvent(event)) {
      textBuffer += event.content;
    }
  }

  flushText();
  if (items.length === 0) {
    const text = fallbackText.trim();
    return text ? [{ type: 'text', id: 'text-fallback', text }] : [];
  }
  return items;
}

function isAnswerTextEvent(event: SessionAgentEvent): boolean {
  return event.channel === 'answer' && event.content.length > 0;
}

function runEventMarker(event: SessionAgentEvent): { label: string; detail: string | null } | null {
  if (event.channel === 'thinking' && event.content.trim()) {
    return { label: 'Thinking', detail: trimTimelineDetail(event.content) };
  }

  if (event.channel === 'command' || /command/i.test(event.event_type)) {
    return { label: 'Run Command', detail: eventCommandDetail(event) };
  }

  if (/file_diff|patch/i.test(event.event_type)) {
    return { label: 'Patch', detail: eventCommandDetail(event) };
  }

  if (event.event_type === 'tool_call' || event.channel === 'tool') {
    return commandToolMarker(event);
  }

  return null;
}

function commandToolMarker(event: SessionAgentEvent): { label: string; detail: string | null } {
  const toolName = eventToolName(event);
  const command = eventCommandDetail(event);
  if (toolName && /^(?:read)$/i.test(toolName)) return { label: 'Read File', detail: command ?? toolName };
  if (toolName && /^(?:grep|glob|search)$/i.test(toolName)) return { label: 'Search', detail: command ?? toolName };
  if (toolName && /^(?:edit|multiedit|write)$/i.test(toolName)) return { label: 'Edit', detail: command ?? toolName };
  if (toolName && /^(?:patch|apply_patch)$/i.test(toolName)) return { label: 'Patch', detail: command ?? toolName };
  if (command && /\b(?:sed|cat|nl|less|head|tail)\b/.test(command)) return { label: 'Read File', detail: command };
  if (command && /\b(?:rg|grep|find)\b/.test(command)) return { label: 'Search', detail: command };
  if (command && /\b(?:apply_patch)\b/.test(command)) return { label: 'Patch', detail: command };
  if (command && /\b(?:npm|pnpm|yarn|node|tsx|tsc|vite|git)\b/.test(command)) return { label: 'Run Command', detail: command };
  if (command) return { label: 'Run Command', detail: command };
  return { label: 'Tool', detail: toolName ?? trimTimelineDetail(event.content) };
}

function eventToolName(event: SessionAgentEvent): string | null {
  const payload = parseAgentEventPayload(event.payload_json);
  return readNestedString(payload, [
    ['trace', 'name'],
    ['event', 'payload', 'name'],
    ['event', 'payload', 'toolName'],
    ['rawEvent', 'params', 'update', 'name'],
    ['rawEvent', 'params', 'update', 'toolName'],
    ['rawEvent', 'params', 'update', 'rawInput', 'name'],
    ['rawEvent', 'params', 'update', 'rawInput', 'toolName'],
    ['name'],
    ['toolName'],
  ]);
}

function eventCommandDetail(event: SessionAgentEvent): string | null {
  const payload = parseAgentEventPayload(event.payload_json);
  const command = readNestedCommand(payload);
  return command ?? trimTimelineDetail(event.content);
}

function parseAgentEventPayload(payloadJson: string | null): unknown {
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
}

function readNestedCommand(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  if (typeof command === 'string' && command.trim()) return command.trim();
  if (Array.isArray(command)) return command.map(String).join(' ').trim() || null;

  const rawInput = record.rawInput;
  if (rawInput && typeof rawInput === 'object') {
    const rawCommand = (rawInput as Record<string, unknown>).command;
    if (typeof rawCommand === 'string' && rawCommand.trim()) return rawCommand.trim();
    if (Array.isArray(rawCommand)) return rawCommand.map(String).join(' ').trim() || null;
  }

  for (const key of ['event', 'rawEvent', 'update', 'params']) {
    const nested = readNestedCommand(record[key]);
    if (nested) return nested;
  }
  return null;
}

function readNestedString(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let cursor = value;
    for (const key of path) {
      if (!cursor || typeof cursor !== 'object') {
        cursor = null;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor === 'string' && cursor.trim()) return cursor.trim();
  }
  return null;
}

function trimTimelineDetail(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return null;
  return text.length > 120 ? `${text.slice(0, 120).trimEnd()}...` : text;
}

function ThinkingDurationBadge({ run }: { run: SessionRun }): JSX.Element | null {
  const duration = getSessionRunThinkingDuration(run);
  if (!duration) return null;
  return (
    <span className="deepsea-thinking-duration" data-active={duration.active ? 'true' : 'false'}>
      <Timer aria-hidden="true" />
      {duration.label}
    </span>
  );
}

function RunStatusBadge({ status }: { status: SessionRun['status'] }): JSX.Element {
  const view = runStatusView(status);
  return (
    <span className="deepsea-run-status" data-tone={view.tone}>
      {view.label}
    </span>
  );
}

function runStatusView(status: SessionRun['status']): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (status === 'failed' || status === 'interrupted') return { label: '失败', tone: 'danger' };
  if (status === 'completed') return { label: '完成', tone: 'ok' };
  if (status === 'paused') return { label: '已暂停', tone: 'muted' };
  if (status === 'cancelled') return { label: '已取消', tone: 'muted' };
  return { label: '运行中', tone: 'warn' };
}

function RunStatusIcon({ tone }: { tone: ReturnType<typeof runStatusView>['tone'] }): JSX.Element {
  if (tone === 'ok') return <CheckCircle2 aria-hidden="true" />;
  if (tone === 'warn') return <Ellipsis aria-hidden="true" />;
  if (tone === 'danger') return <X aria-hidden="true" />;
  return <Square aria-hidden="true" />;
}

function AgentThoughtPanel({
  run,
  evidence,
  agentEvents,
}: {
  run: SessionRun;
  evidence: SessionEvidenceEvent[];
  agentEvents: SessionAgentEvent[];
}): JSX.Element | null {
  const thought = agentThoughtText(run, evidence, agentEvents);
  const defaultOpen = isRunThoughtOpenByDefault(run.status);
  const [openState, setOpenState] = useState(() => ({
    runId: run.id,
    status: run.status,
    open: defaultOpen,
  }));
  const open = openState.runId === run.id && openState.status === run.status ? openState.open : defaultOpen;

  if (!thought) return null;
  const status = runThoughtStatusLabel(run.status);
  return (
    <details
      className="deepsea-agent-thought"
      aria-label="智能体思考过程"
      data-active={defaultOpen ? 'true' : 'false'}
      open={open}
      onToggle={(event) => setOpenState({
        runId: run.id,
        status: run.status,
        open: event.currentTarget.open,
      })}
    >
      <summary
        className="deepsea-agent-thought__header"
        aria-label={open ? '收起智能体思考过程' : '展开智能体思考过程'}
      >
        <span className="deepsea-agent-thought__title">
          <Brain aria-hidden="true" />
          <strong>智能体思考过程</strong>
          <em>Agent Thought Process</em>
        </span>
        <span className="deepsea-agent-thought__meta">
          <mark>{status}</mark>
          <span className="deepsea-agent-thought__toggle">
            <ChevronDown aria-hidden="true" />
            <span>{open ? '收起' : '展开'}</span>
          </span>
        </span>
      </summary>
      <p>{thought}</p>
    </details>
  );
}

function isRunThoughtOpenByDefault(status: SessionRun['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'retrying' || status === 'paused';
}

function DeepseaComposer({
  projectId,
  onSendMessage,
}: {
  projectId: string;
  onSendMessage: (message: SessionComposerSubmit) => void;
}): JSX.Element {
  return <SessionFileComposer projectId={projectId} onSendMessage={onSendMessage} />;
}

function IntegratedInspector({
  payload,
  activeRun,
  onCommand,
  onCancelRun,
  onRetryRun,
  onSaveContract,
}: {
  payload: SessionWorkspacePayload;
  activeRun: SessionRun | null;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
}): JSX.Element {
  return (
    <aside className="deepsea-inspector" aria-label="Session Inspector">
      <div className="deepsea-tabs" role="tablist" aria-label="Inspector tabs">
        {['状态', '契约', '运行', '工具', '计划'].map((tab) => (
          <button type="button" key={tab}>
            {tab}
          </button>
        ))}
      </div>
      <div className="deepsea-inspector__scroll">
        <ContractModule contract={payload.contract} onSaveContract={onSaveContract} />
        <PlanModule items={payload.activeSession.planItems} />
        <RunModule
          run={activeRun}
          onCancelRun={onCancelRun}
          onRetryRun={onRetryRun}
        />
        <ToolsModule rows={payload.toolRows} />
        <DiffModule rows={payload.diffRows} onCommand={onCommand} />
      </div>
    </aside>
  );
}

function ContractModule({
  contract,
  onSaveContract,
}: {
  contract: SessionContract;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState(contract.scope ?? '');
  const [risks, setRisks] = useState(contract.risks.join('\n'));
  const [criteria, setCriteria] = useState(contract.acceptanceCriteria.join('\n'));
  const save = () => {
    onSaveContract?.({
      scope: scope.trim() || null,
      risks: splitLines(risks),
      acceptanceCriteria: splitLines(criteria),
    });
    setEditing(false);
  };

  return (
    <section className="deepsea-glass-card">
      <div className="deepsea-module-title">
        <h3>
          <FileText aria-hidden="true" />
          目标契约 (Contract)
        </h3>
        {editing ? (
          <button type="button" onClick={save}>保存</button>
        ) : (
          <button type="button" onClick={() => setEditing(true)}>编辑</button>
        )}
      </div>
      <div className="deepsea-contract-list">
        <div>
          <span>目标 (Objective)</span>
          <p>{contract.objective}</p>
        </div>
        <div>
          <span>边界 (Scope)</span>
          {editing ? (
            <textarea value={scope} onChange={(event) => setScope(event.currentTarget.value)} />
          ) : (
            <p>{contract.scope ?? '未设置范围'}</p>
          )}
        </div>
        <div>
          <span>风险 (Risks)</span>
          {editing ? (
            <textarea value={risks} onChange={(event) => setRisks(event.currentTarget.value)} />
          ) : contract.risks.length === 0 ? (
            <p><i /> 暂无风险记录</p>
          ) : (
            contract.risks.map((risk) => <p key={risk}><i /> {risk}</p>)
          )}
        </div>
        <div>
          <span>验收 (Acceptance)</span>
          {editing ? (
            <textarea value={criteria} onChange={(event) => setCriteria(event.currentTarget.value)} />
          ) : contract.acceptanceCriteria.length === 0 ? (
            <p>暂无验收标准</p>
          ) : (
            contract.acceptanceCriteria.map((item) => <p key={item}>{item}</p>)
          )}
        </div>
      </div>
    </section>
  );
}

function RunModule({
  run,
  onCancelRun,
  onRetryRun,
}: {
  run: SessionRun | null;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
}): JSX.Element {
  if (!run) {
    return (
      <section className="deepsea-inspector-section deepsea-run-section">
        <div className="deepsea-module-title">
          <h3>代理运行 (Active Run)</h3>
          <span>0 条记录</span>
        </div>
        <div className="deepsea-empty">暂无代理运行</div>
      </section>
    );
  }

  const provider = run.provider;
  const model = run.model;
  const status = runStatusView(run.status);
  const cancellable = run.status === 'queued' || run.status === 'running' || run.status === 'retrying';
  return (
    <section className="deepsea-inspector-section deepsea-run-section">
      <div className="deepsea-module-title">
        <h3>代理运行 (Active Run)</h3>
        <span>1 条记录</span>
      </div>
      <div className="deepsea-run-table">
        <div data-tone={status.tone}>
          <strong>{status.label}</strong>
          <p className="deepsea-mono">{formatProviderModel(provider, model)}</p>
          <span className="deepsea-run-row-duration">{formatDuration(run.started_at, run.completed_at ?? Date.now())}</span>
          <span className="deepsea-run-row-time">{formatRelativeTime(Date.now(), run.started_at)}</span>
          <span className="deepsea-run-row-state" aria-label={`运行状态：${status.label}`}>
            <RunStatusIcon tone={status.tone} />
          </span>
          <div className="deepsea-run-row-actions">
            <button
              type="button"
              aria-label="停止运行"
              disabled={!cancellable}
              onClick={() => run && onCancelRun?.(run.id)}
            >
              <StopCircle aria-hidden="true" />
            </button>
            <button type="button" aria-label="重新执行" onClick={() => onRetryRun?.(run.id)}>
              <Repeat2 aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function runOutputText(run: SessionRun): string {
  const output = run.stdout.trim() || run.stderr.trim();
  if (output) return output;
  if (run.status === 'completed') return '未返回可展示回复。';
  if (run.status === 'failed') return run.error ?? '运行失败，暂无错误详情。';
  if (run.status === 'cancelled') return '运行已取消。';
  if (run.status === 'paused') return '运行已暂停。';
  if (run.status === 'interrupted') return '运行已中断。';
  return '等待智能体输出...';
}

function runThoughtStatusLabel(status: SessionRun['status']): string {
  if (status === 'failed' || status === 'interrupted') return 'RISK';
  if (status === 'completed') return 'VERIFIED';
  if (status === 'cancelled') return 'CANCELLED';
  if (status === 'paused') return 'PAUSED';
  return 'RUNNING';
}

export function getSessionRunThinkingDuration(
  run: Pick<SessionRun, 'status' | 'started_at' | 'updated_at' | 'completed_at'>,
  now = Date.now(),
): { label: string; active: boolean } | null {
  if (!Number.isFinite(run.started_at) || run.started_at <= 0) return null;
  const active = run.status === 'queued' || run.status === 'running' || run.status === 'retrying' || run.status === 'paused';
  const endAt = active ? now : run.completed_at ?? run.updated_at ?? now;
  const durationMs = Math.max(0, endAt - run.started_at);
  return {
    label: `${active ? '思考中' : '思考'} ${formatSessionDuration(durationMs)}`,
    active,
  };
}

function formatSessionDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function agentThoughtText(run: SessionRun, evidence: SessionEvidenceEvent[], agentEvents: SessionAgentEvent[]): string | null {
  const activity = trimDisplayText(run.activity_log);
  const structuredThoughts = agentEvents
    .filter((event) => event.channel === 'thinking' || event.channel === 'activity')
    .map((event) => trimDisplayText(event.content))
    .filter(Boolean);
  const thoughtParts = uniqueDisplayParts([activity, ...structuredThoughts]);
  if (thoughtParts.length > 0) return thoughtParts.join('\n');
  const evidenceText = evidence
    .map((event) => trimDisplayText(event.summary ?? event.title))
    .filter(Boolean)
    .slice(0, 3)
    .join('\n');
  return evidenceText || null;
}

function uniqueDisplayParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text || seen.has(text) || unique.some((existing) => existing.includes(text))) continue;
    for (let index = unique.length - 1; index >= 0; index -= 1) {
      if (!text.includes(unique[index] ?? '')) continue;
      seen.delete(unique[index] ?? '');
      unique.splice(index, 1);
    }
    seen.add(text);
    unique.push(text);
  }
  return unique;
}

function trimDisplayText(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (text.length <= 1200) return text;
  return `${text.slice(0, 1200).trimEnd()}\n...`;
}

function ToolsModule({ rows }: { rows: SessionToolRow[] }): JSX.Element {
  const [selectedRow, setSelectedRow] = useState<SessionToolRow | null>(null);

  useEffect(() => {
    if (!selectedRow) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedRow(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedRow]);

  return (
    <section className="deepsea-inspector-section">
      <div className="deepsea-module-title">
        <h3>工具调用 (TOOLS)</h3>
        <span>{rows.length} 条记录</span>
      </div>
      {rows.length === 0 ? (
        <div className="deepsea-empty">暂无工具调用</div>
      ) : (
      <div className="deepsea-tool-table">
        {rows.map((row) => (
          <button
            type="button"
            key={row.id}
            data-tone={toolRowTone(row)}
            data-tool-row-button="true"
            aria-label={`查看工具调用详情：${row.target}`}
            onClick={() => setSelectedRow(row)}
          >
            <strong>{toolActionLabel(row.action)}</strong>
            <p>{row.target}</p>
            <span className="deepsea-tool-row-duration">{formatToolDisplayDuration(row)}</span>
            <span className="deepsea-tool-row-time">{formatRelativeTime(Date.now(), row.created_at)}</span>
            <span
              className="deepsea-tool-row-state"
              data-tool-row-status={row.status}
              aria-label={`工具调用状态：${toolStatusLabel(row.status)}`}
            >
              <ToolStatusIcon status={row.status} />
            </span>
          </button>
        ))}
      </div>
      )}
      {selectedRow ? <ToolDetailDialog row={selectedRow} onClose={() => setSelectedRow(null)} /> : null}
    </section>
  );
}

function ToolDetailDialog({ row, onClose }: { row: SessionToolRow; onClose: () => void }): JSX.Element {
  return (
    <div className="deepsea-tool-detail-overlay" onClick={onClose}>
      <div
        className="deepsea-tool-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="工具调用详情"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="deepsea-tool-detail-dialog__header">
          <div>
            <span>{toolActionLabel(row.action)}</span>
            <h3>{row.label}</h3>
          </div>
          <button type="button" aria-label="关闭工具调用详情" onClick={onClose} autoFocus>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="deepsea-tool-detail-dialog__target">
          <span>目标</span>
          <code>{row.target}</code>
        </div>
        <div className="deepsea-tool-detail-dialog__execution">
          <span>执行内容</span>
          {row.detail || row.output ? (
            <pre>{row.detail ?? row.output}</pre>
          ) : (
            <p>暂无执行内容</p>
          )}
        </div>
        <dl className="deepsea-tool-detail-grid">
          <div>
            <dt>状态</dt>
            <dd data-status={row.status}>{toolStatusLabel(row.status)}</dd>
          </div>
          <div>
            <dt>耗时</dt>
            <dd>{formatToolDisplayDuration(row)}</dd>
          </div>
          <div>
            <dt>级别</dt>
            <dd>{row.severity}</dd>
          </div>
          <div>
            <dt>动作</dt>
            <dd>{row.action}</dd>
          </div>
          <div>
            <dt>Event ID</dt>
            <dd>{row.eventId}</dd>
          </div>
          <div>
            <dt>记录时间</dt>
            <dd>{formatToolTimestamp(row.created_at)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function PlanModule({ items }: { items: SessionPlanItem[] }): JSX.Element {
  return (
    <section className="deepsea-inspector-section">
      <h3>会话计划 (Session Plan)</h3>
      {items.length === 0 ? (
        <div className="deepsea-empty">暂无会话计划</div>
      ) : (
      <div className="deepsea-plan-list">
        {items.map((item) => (
          <div data-status={item.status} key={item.id}>
            {item.status === 'completed' ? <CheckCircle2 aria-hidden="true" /> : <Square aria-hidden="true" />}
            <span>{item.title}</span>
          </div>
        ))}
      </div>
      )}
    </section>
  );
}

function DiffModule({
  rows,
  onCommand,
}: {
  rows: SessionDiffRow[];
  onCommand: (command: string) => void;
}): JSX.Element {
  const changedLabel = rows.length === 0 ? '本会话暂无文件变更' : `本会话 ${rows.length} 个文件变更`;
  return (
    <section className="deepsea-diff-alert">
      <div className="deepsea-diff-alert__header">
        <h3>本次会话变更 <span>(Session Changes)</span></h3>
        <span data-tone={rows.length === 0 ? 'muted' : 'danger'}>{changedLabel}</span>
      </div>
      <div className="deepsea-diff-card">
        {rows.length === 0 ? (
          <div className="deepsea-diff-row">
            <span className="deepsea-diff-row__index">0</span>
            <span className="deepsea-diff-row__file">
              <FileText aria-hidden="true" />
              <em>no session changes</em>
            </span>
            <span className="deepsea-diff-row__status" data-tone="muted">
              <strong data-tone="muted">0</strong>
              <CheckCircle2 aria-hidden="true" />
            </span>
          </div>
        ) : rows.map((row, index) => (
          <div className="deepsea-diff-row" key={row.path}>
            <span className="deepsea-diff-row__index">{index + 1}</span>
            <span className="deepsea-diff-row__file">
              <FileText aria-hidden="true" />
              <em>{row.path}</em>
            </span>
            <span className="deepsea-diff-row__status" data-tone={diffRowTone(row)}>
              <strong data-tone={diffRowTone(row)}>{formatDiffDelta(row)}</strong>
              <CheckCircle2 aria-hidden="true" />
            </span>
          </div>
        ))}
      </div>
      <div className="deepsea-diff-alert__footer">
        <div>
          <button type="button" onClick={() => onCommand('/compact')}>
            查看预览
            <ChevronDown aria-hidden="true" />
          </button>
          <button type="button" onClick={() => onCommand('/compact')}>
            立即应用
          </button>
        </div>
      </div>
    </section>
  );
}

function getActiveRun(detail: SessionDetail): SessionRun | null {
  return [...detail.runs].reverse().find((run) =>
    run.status === 'queued' || run.status === 'running' || run.status === 'retrying'
  ) ?? detail.runs[detail.runs.length - 1] ?? null;
}

function contextPressurePercent(pressure: StatusSnapshot['context']['pressure']): number {
  if (pressure === 'high') return 78;
  if (pressure === 'medium') return 52;
  return 28;
}

function formatProviderModel(provider: string, model: string | null | undefined): string {
  if (!model) return provider;
  if (provider === 'claude') return model.includes('Claude') ? model : `Claude ${model}`;
  if (provider === 'codex') return model.includes('gpt') ? model : `Codex ${model}`;
  return `${provider} ${model}`;
}

function formatCompactSessionTitle(title: string, maxLength = 17): string {
  if (title.length <= maxLength) return title;
  return `${title.slice(0, maxLength)}...`;
}

function ensureCurrentActiveSessionSummary(
  sessions: ActiveSessionSummary[],
  currentSession: Session,
  currentProjectId: string,
  currentProjectName: string,
): ActiveSessionSummary[] {
  if (sessions.some((session) => session.id === currentSession.id)) return sessions;
  if (!isSessionActiveForRail(currentSession)) return sessions;
  return [{
    id: currentSession.id,
    project_id: currentProjectId,
    project_name: currentProjectName,
    project_path: currentSession.workspace_path ?? currentSession.worktree_path ?? '',
    title: currentSession.title,
    status: currentSession.status,
    phase: currentSession.phase,
    provider: currentSession.provider,
    model: currentSession.model,
    pinned_at: currentSession.pinned_at,
    updated_at: currentSession.updated_at,
    unread_count: 0,
    active_run_count: 0,
    latest_event_summary: currentSession.current_goal,
  }, ...sessions];
}

function isSessionActiveForRail(session: Pick<Session, 'closed_at' | 'status' | 'archived_at'>): boolean {
  return session.closed_at === null && session.status !== 'archived' && session.archived_at === null;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatDuration(start: number, end: number): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
}

function toolActionLabel(action: string): string {
  const normalized = action.toUpperCase();
  if (normalized === 'READ') return '读取文件';
  if (normalized === 'EDIT') return '文件变更';
  if (normalized === 'WRITE') return '写入文件';
  if (normalized === 'BROWSER') return '浏览器验证';
  if (normalized === 'EXEC') return '执行命令';
  return '工具调用';
}

function toolStatusLabel(status: SessionToolRow['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'failed') return '失败';
  return '已完成';
}

function ToolStatusIcon({ status }: { status: SessionToolRow['status'] }): JSX.Element {
  if (status === 'failed') return <X aria-hidden="true" />;
  if (status === 'running') return <Ellipsis aria-hidden="true" />;
  return <CheckCircle2 aria-hidden="true" />;
}

function formatToolDuration(durationMs: number | null): string {
  return durationMs === null ? '--' : `${(durationMs / 1000).toFixed(1)}s`;
}

function formatToolDisplayDuration(row: SessionToolRow): string {
  return formatToolDuration(row.durationMs);
}

function formatToolTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatRelativeTime(now: number, timestamp: number): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function formatResponseTime(value: number | null): string {
  return value === null ? '--' : `${(value / 1000).toFixed(1)}s`;
}

function formatErrorRate(value: number | null): string {
  return value === null ? '--' : `${(value * 100).toFixed(1)}%`;
}

function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function toolRowTone(row: SessionToolRow): 'primary' | 'warn' | 'danger' | 'ok' {
  if (row.status === 'failed' || row.severity === 'error' || row.severity === 'critical') return 'danger';
  if (row.status === 'running' || row.severity === 'warning') return 'warn';
  return row.action === 'edit' || row.action === 'write' ? 'ok' : 'primary';
}

function diffRowTone(row: SessionDiffRow): 'ok' | 'danger' | 'warn' | 'muted' {
  if (row.status === 'deleted' || row.status === 'conflicted') return 'danger';
  if (row.status === 'renamed') return 'warn';
  if (row.status === 'modified' || row.status === 'added' || row.status === 'untracked') return 'ok';
  return 'muted';
}

function formatDiffDelta(row: SessionDiffRow): string {
  const additions = row.additions ?? 0;
  const deletions = row.deletions ?? 0;
  if (additions === 0 && deletions === 0) return row.summary ?? row.status;
  if (additions > 0 && deletions === 0) return `+${additions}`;
  if (additions === 0 && deletions > 0) return `-${deletions}`;
  return `+${additions} / -${deletions}`;
}
