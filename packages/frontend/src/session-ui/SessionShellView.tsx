import {
  Brain,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Edit3,
  Ellipsis,
  FileText,
  Filter,
  FolderOpen,
  FolderPlus,
  GitFork,
  Info,
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
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createPortal } from 'react-dom';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type {
  ActiveSessionSummary,
  ApprovalCardMetadata,
  MessageMetadata,
  ProjectUsedAgentsPayload,
  Session,
  SessionApprovalStatus,
  SessionContract,
  SessionDetail,
  SessionDiffRow,
  SessionAgentEvent,
  SessionEvidenceEvent,
  SessionMessage,
  SessionPlanItem,
  SessionRun,
  SessionToolRow,
  SessionTodoStats,
  SessionWorkspacePayload,
  StatusSnapshot,
  WorkflowArtifactVersionView,
  WorkflowAgentAssignmentView,
  WorkflowControllerView,
  WorkflowGateView,
  WorkspaceFilePreview,
} from '../lib/types';
import { api } from '../lib/api';
import { parseMessageMetadata } from '../lib/messageMetadata';
import { isPinnedItem, layerIds, reorderWithinLayer, sortPinnedItems } from '../lib/sortableItems';
import {
  MarkdownPreview,
  MessageContent,
  isVisualCompanionOfferContent,
  type WorkspaceFileOpenHandler,
} from '../components/MessageContent';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import { ImageJobStatusCard } from '../image-generation/ImageJobStatusCard';
import {
  MarkdownDisplaySwitch,
  SessionMessageBubble,
  type SessionMessageDisplayMode,
} from './SessionMessageBubble';
import { ProjectAgentStrip } from './ProjectAgentStrip';
import { SessionFileComposer } from './SessionFileComposer';
import { SessionCenterWorkspace } from './SessionCenterWorkspace';
import type { SessionCenterWorkspacePane } from './SessionCenterWorkspace';
import type { SessionComposerSubmit } from './session-file-composer-model';
import { GeneratedImageEvidencePanel } from './GeneratedImageEvidencePanel';

export type SessionKnowledgeActionKind = 'message' | 'run';
export type SessionKnowledgeActionKey = `${SessionKnowledgeActionKind}:${string}`;

export type SessionKnowledgeSaveInput =
  | { kind: 'message'; key: SessionKnowledgeActionKey; message: SessionMessage }
  | { kind: 'run'; key: SessionKnowledgeActionKey; run: SessionRun; title: string; content: string };

export function buildSessionKnowledgeActionKey(
  kind: SessionKnowledgeActionKind,
  id: string,
): SessionKnowledgeActionKey {
  return `${kind}:${id}`;
}

const VISUAL_COMPANION_ACCEPTANCE_MESSAGE = '同意，打开设计预览。';
const RISK_APPROVAL_APPROVE_MESSAGE = '确认';
const RISK_APPROVAL_REJECT_MESSAGE = '取消';

export function buildVisualCompanionAcceptanceSubmit(): SessionComposerSubmit {
  return { content: VISUAL_COMPANION_ACCEPTANCE_MESSAGE };
}

function buildRiskApprovalDecisionSubmit(decision: 'approved' | 'rejected'): SessionComposerSubmit {
  return { content: decision === 'approved' ? RISK_APPROVAL_APPROVE_MESSAGE : RISK_APPROVAL_REJECT_MESSAGE };
}

export function recordVisualCompanionOfferAccepted(acceptedKeys: Set<string>, offerKey: string): boolean {
  if (acceptedKeys.has(offerKey)) return false;
  acceptedKeys.add(offerKey);
  return true;
}

export function shouldShowVisualCompanionAction(input: {
  role: SessionMessage['role'];
  displayMode: SessionMessageDisplayMode;
  content: string;
  accepted: boolean;
}): boolean {
  return input.role === 'assistant' &&
    input.displayMode === 'preview' &&
    !input.accepted &&
    isVisualCompanionOfferContent(input.content);
}

async function writeTranscriptTextToClipboard(content: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return;
    }
  } catch {
    // Fall back to a selection-based copy path for restricted browser contexts.
  }

  const textarea = document.createElement('textarea');
  textarea.value = content;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, content.length);
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('Clipboard copy failed');
}

export function SessionShellView({
  payload,
  onSendMessage,
  onCommand,
  onCancelRun,
  onRetryRun,
  onSaveContract,
  onOpenSession,
  onCreateSession,
  onCreateProject,
  onRenameProject,
  onRemoveProject,
  onReorderProjects,
  onToggleSessionPin,
  onSaveKnowledge,
  onApproveWorkflowArtifact,
  savingKnowledgeKey,
  todoStats,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (message: SessionComposerSubmit) => void;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onCreateSession?: (projectId: string) => void | Promise<void>;
  onCreateProject?: () => void;
  onRenameProject?: (project: ProjectSwitcherProject) => void;
  onRemoveProject?: (project: ProjectSwitcherProject) => void;
  onReorderProjects?: (input: { ids: string[]; pinned: boolean }) => void;
  onToggleSessionPin?: (session: ActiveSessionSummary) => void;
  onSaveKnowledge?: (input: SessionKnowledgeSaveInput) => void;
  onApproveWorkflowArtifact?: (artifactVersionId: string) => void;
  savingKnowledgeKey?: SessionKnowledgeActionKey | null;
  todoStats?: SessionTodoStats | null;
}): JSX.Element {
  const activeRun = getActiveRun(payload.activeSession);
  const latestTranscriptRunId = getLatestTranscriptRunId(payload.activeSession);
  const forkTarget = payload.historyRecords[0]?.id;
  const [activeWorkspacePane, setActiveWorkspacePane] = useState<SessionCenterWorkspacePane>('transcript');
  const showInspector = isSessionInspectorVisibleForWorkspacePane(activeWorkspacePane);

  return (
    <section className="session-shell deepsea-shell" aria-label="Session Operations Console">
      <main className={showInspector ? 'deepsea-main' : 'deepsea-main deepsea-main--without-inspector'}>
        <ProjectSessionTreeRail
          projects={payload.projectSwitcher.projects}
          sessions={payload.activeSessions}
          currentSession={payload.activeSession.session}
          currentProjectId={payload.project.id}
          currentProjectName={payload.project.name}
          onCommand={onCommand}
          onOpenSession={onOpenSession}
          onCreateSession={onCreateSession}
          onCreateProject={onCreateProject}
          onRenameProject={onRenameProject}
          onRemoveProject={onRemoveProject}
          onReorderProjects={onReorderProjects}
          onToggleSessionPin={onToggleSessionPin}
        />
        <SessionCenterWorkspace
          projectId={payload.project.id}
          workspaceRootPath={payload.project.path}
          onActivePaneChange={setActiveWorkspacePane}
          transcript={(
            <TranscriptCanvas
              detail={payload.activeSession}
              evidence={payload.evidence}
              projectId={payload.project.id}
              onSendMessage={onSendMessage}
              onRetryRun={onRetryRun}
              onSaveKnowledge={onSaveKnowledge}
              onApproveWorkflowArtifact={onApproveWorkflowArtifact}
              savingKnowledgeKey={savingKnowledgeKey}
              todoStats={todoStats}
            />
          )}
        />
        {showInspector ? (
          <IntegratedInspector
            payload={payload}
            activeRun={activeRun}
            latestTranscriptRunId={latestTranscriptRunId}
            onCommand={onCommand}
            onCancelRun={onCancelRun}
            onRetryRun={onRetryRun}
            onSaveContract={onSaveContract}
            onApproveWorkflowArtifact={onApproveWorkflowArtifact}
          />
        ) : null}
      </main>
      <BottomStatusBar
        payload={payload}
        forkTarget={forkTarget}
        onCommand={onCommand}
      />
    </section>
  );
}

export function isSessionInspectorVisibleForWorkspacePane(pane: SessionCenterWorkspacePane): boolean {
  return pane === 'transcript';
}

export function buildSessionTodoStatsFromPlanItems(sessionId: string, planItems: SessionPlanItem[]): SessionTodoStats {
  const stats: SessionTodoStats = {
    sessionId,
    total: planItems.length,
    open: 0,
    pending: 0,
    inProgress: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
    skipped: 0,
  };
  for (const item of planItems) {
    if (item.status === 'pending') stats.pending += 1;
    else if (item.status === 'in_progress') stats.inProgress += 1;
    else if (item.status === 'blocked') stats.blocked += 1;
    else if (item.status === 'failed') stats.failed += 1;
    else if (item.status === 'completed') stats.completed += 1;
    else if (item.status === 'skipped') stats.skipped += 1;
  }
  stats.open = stats.pending + stats.inProgress + stats.blocked + stats.failed;
  return stats;
}

type BottomGitState = 'clean' | 'changed' | 'conflicts';

function formatBottomGitBranch(branchName: string | null): string {
  const normalized = branchName?.trim();
  return normalized ? normalized : 'detached';
}

function formatBottomGitState(git: StatusSnapshot['git']): { label: string; state: BottomGitState } {
  if (git.conflictRisk === 'high') return { label: 'conflicts', state: 'conflicts' };
  if (git.changedFileCount > 0) return { label: `${git.changedFileCount} changed`, state: 'changed' };
  return { label: 'clean', state: 'clean' };
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
  const gitBranch = formatBottomGitBranch(payload.status.git.branchName);
  const gitState = formatBottomGitState(payload.status.git);
  const gitTitle = `Git: ${gitBranch}, ${gitState.label}`;
  const pressure = contextPressurePercent(payload.status.context.pressure);

  return (
    <footer className="deepsea-bottom-status" aria-label="Session status bar">
      <div className="deepsea-bottom-status__path" aria-label="当前会话信息">
        <GitFork aria-hidden="true" />
        <span className="deepsea-bottom-status__session-title" title={payload.activeSession.session.title}>
          {formatCompactSessionTitle(payload.activeSession.session.title, 28)}
        </span>
        <span className="deepsea-bottom-status__path-separator" aria-hidden="true">·</span>
        <span
          className="deepsea-bottom-status__git"
          data-git-state={gitState.state}
          title={gitTitle}
        >
          <span className="deepsea-bottom-status__git-branch">{gitBranch}</span>
          <span className="deepsea-bottom-status__git-state">{gitState.label}</span>
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
        <span className="deepsea-bottom-status__label">Token 消耗</span>
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
  updated_at?: number;
  pinned_at?: number | null;
  sort_order?: number | null;
  recentSessions: ProjectSwitcherProject['recentSessions'];
  sortable: boolean;
  sessions: ActiveSessionSummary[];
};

type ProjectSwitcherProject = SessionWorkspacePayload['projectSwitcher']['projects'][number];

export type SessionSidebarGroupMode = 'project' | 'time';
export type SessionSidebarSortMode = 'created' | 'updated';
export type SessionSidebarVisibility = 'all' | 'pinned';

export type SessionSidebarPrefs = {
  groupMode: SessionSidebarGroupMode;
  sortMode: SessionSidebarSortMode;
  visibility: SessionSidebarVisibility;
};

export const SESSION_SIDEBAR_PREFS_STORAGE_KEY = 'opendeepsea.sessionSidebar.viewPrefs';

export const DEFAULT_SESSION_SIDEBAR_PREFS: SessionSidebarPrefs = {
  groupMode: 'project',
  sortMode: 'updated',
  visibility: 'all',
};

export type SessionSidebarModel = {
  heading: '项目' | '聊天';
  projects: ProjectSessionTreeProject[];
  timeRows: ActiveSessionSummary[];
  emptyMessage: string;
};

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
  if (activeId === overId || !canDropProjectOn(projects, activeId, overId)) return null;
  const sortableProjects = projects.map((project, index) => ({
    ...project,
    created_at: project.created_at ?? -index,
    pinned_at: project.pinned_at ?? null,
    sort_order: project.sort_order ?? null,
  }));
  const moved = sortableProjects.find((project) => project.id === activeId);
  if (!moved) return null;
  const pinned = isPinnedItem(moved);
  const beforeIds = layerIds(sortPinnedItems(sortableProjects), pinned);
  const next = reorderWithinLayer(sortableProjects, activeId, overId);
  const ids = layerIds(next, pinned);
  if (ids.join('\0') === beforeIds.join('\0')) return null;
  return ids.length > 0 ? { ids, pinned } : null;
}

type ProjectDragTarget = Pick<ProjectSwitcherProject, 'id' | 'pinned_at'> & { sortable?: boolean };

function canDropProjectOn(
  projects: ProjectDragTarget[],
  draggingProjectId: string | null,
  targetProjectId: string,
): boolean {
  if (!draggingProjectId || draggingProjectId === targetProjectId) return false;
  const active = projects.find((project) => project.id === draggingProjectId);
  const target = projects.find((project) => project.id === targetProjectId);
  if (!isSortableProjectDragTarget(active) || !isSortableProjectDragTarget(target)) return false;
  const activePinned = (active.pinned_at ?? null) !== null;
  const targetPinned = (target.pinned_at ?? null) !== null;
  return activePinned === targetPinned;
}

function isSortableProjectDragTarget(project: ProjectDragTarget | undefined): project is ProjectDragTarget {
  return Boolean(project && project.sortable !== false && !project.id.startsWith('orphan:'));
}

export function shouldIgnoreProjectDragStart(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Boolean(target.closest('button, [role="menu"], .deepsea-project-session-row-wrap'));
}

export function syncExpandedProjectIds(
  current: Record<string, boolean>,
  projects: Pick<ProjectSwitcherProject, 'id'>[],
  currentProjectId: string,
): Record<string, boolean> {
  return Object.fromEntries(projects.map((project) => [
    project.id,
    project.id === currentProjectId ? true : current[project.id] ?? false,
  ]));
}

function expandedProjectIdsEqual(left: Record<string, boolean>, right: Record<string, boolean>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
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
  onCreateProject,
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
  onCreateProject?: () => void;
  onRenameProject?: (project: ProjectSwitcherProject) => void;
  onRemoveProject?: (project: ProjectSwitcherProject) => void;
  onReorderProjects?: (input: { ids: string[]; pinned: boolean }) => void;
  onToggleSessionPin?: (session: ActiveSessionSummary) => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const normalizedQuery = q.trim().toLowerCase();
  const [sidebarPrefs, setSidebarPrefs] = useState(readSessionSidebarPrefs);
  const sidebarModel = buildSessionSidebarModel({
    projects,
    sessions,
    currentSession,
    currentProjectId,
    currentProjectName,
    normalizedQuery,
    prefs: sidebarPrefs,
  });
  const visibleProjects = sidebarModel.projects;
  const visibleTimeRows = sidebarModel.timeRows;
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(visibleProjects.map((project) => [project.id, project.id === currentProjectId]))
  );
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [dropProjectId, setDropProjectId] = useState<string | null>(null);
  const treeProjectIdKey = visibleProjects.map((project) => project.id).join('\0');
  useEffect(() => {
    setExpandedProjectIds((current) => {
      const next = syncExpandedProjectIds(current, visibleProjects, currentProjectId);
      return expandedProjectIdsEqual(current, next) ? current : next;
    });
  }, [currentProjectId, treeProjectIdKey]);
  const updateSidebarPrefs = (patch: Partial<SessionSidebarPrefs>) => {
    setSidebarPrefs((current) => {
      const next = normalizeSessionSidebarPrefs({ ...current, ...patch });
      writeSessionSidebarPrefs(next);
      return next;
    });
  };
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
  const handleProjectDrop = (event: DragEvent<HTMLElement>, targetProject: ProjectSessionTreeProject) => {
    event.preventDefault();
    if (!targetProject.sortable || !draggingProjectId || draggingProjectId === targetProject.id) {
      resetDragState();
      return;
    }
    const input = buildProjectReorderInput(projects, draggingProjectId, targetProject.id);
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
        <div className="deepsea-project-tree-heading" data-session-sidebar-mode={sidebarPrefs.groupMode}>
          <span>{sidebarModel.heading}</span>
          <div>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" aria-label="筛选、排序和整理会话">
                  <Filter aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={8} className="deepsea-project-filter-menu">
                  <SidebarMenuSection title="整理">
                    <SidebarMenuItem
                      icon={FolderOpen}
                      label="按项目"
                      active={sidebarPrefs.groupMode === 'project'}
                      onSelect={() => updateSidebarPrefs({ groupMode: 'project' })}
                    />
                    <SidebarMenuItem
                      icon={Timer}
                      label="时间顺序列表"
                      active={sidebarPrefs.groupMode === 'time'}
                      onSelect={() => updateSidebarPrefs({ groupMode: 'time' })}
                    />
                  </SidebarMenuSection>
                  <SidebarMenuSection title="排序条件">
                    <SidebarMenuItem
                      icon={Timer}
                      label="已创建"
                      active={sidebarPrefs.sortMode === 'created'}
                      onSelect={() => updateSidebarPrefs({ sortMode: 'created' })}
                    />
                    <SidebarMenuItem
                      icon={SquarePen}
                      label="已更新"
                      active={sidebarPrefs.sortMode === 'updated'}
                      onSelect={() => updateSidebarPrefs({ sortMode: 'updated' })}
                    />
                  </SidebarMenuSection>
                  <SidebarMenuSection title="显示">
                    <SidebarMenuItem
                      icon={MessageSquare}
                      label="所有聊天"
                      active={sidebarPrefs.visibility === 'all'}
                      onSelect={() => updateSidebarPrefs({ visibility: 'all' })}
                    />
                    <SidebarMenuItem
                      icon={Pin}
                      label="置顶"
                      active={sidebarPrefs.visibility === 'pinned'}
                      onSelect={() => updateSidebarPrefs({ visibility: 'pinned' })}
                    />
                  </SidebarMenuSection>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <button type="button" aria-label="添加项目" onClick={onCreateProject}>
              <FolderPlus aria-hidden="true" />
            </button>
          </div>
        </div>
        {sidebarPrefs.groupMode === 'time' ? (
          visibleTimeRows.length === 0 ? (
            <div className="deepsea-empty">{sidebarModel.emptyMessage}</div>
          ) : visibleTimeRows.map((session) => (
            <ProjectSessionTimeRow
              currentSessionId={currentSession.id}
              key={session.id}
              onOpenSession={onOpenSession}
              onToggleSessionPin={onToggleSessionPin}
              session={session}
              sortMode={sidebarPrefs.sortMode}
            />
          ))
        ) : visibleProjects.length === 0 ? (
          <div className="deepsea-empty">{sidebarModel.emptyMessage}</div>
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
              data-sortable={project.sortable ? 'true' : 'false'}
              draggable={project.sortable}
              key={project.id}
              onDragStart={(event) => {
                if (!project.sortable || shouldIgnoreProjectDragStart(event.target)) {
                  event.preventDefault();
                  resetDragState();
                  return;
                }
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', project.id);
                setDraggingProjectId(project.id);
              }}
              onDragOver={(event) => {
                if (!project.sortable || !canDropProjectOn(projects, draggingProjectId, project.id)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropProjectId(project.id);
              }}
              onDragLeave={() => {
                if (dropProjectId === project.id) setDropProjectId(null);
              }}
              onDrop={(event) => handleProjectDrop(event, project)}
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
                {project.sortable ? (
                  <div className="deepsea-project-node__actions">
                    <DropdownMenu.Root
                      open={projectMenuOpen}
                      onOpenChange={(open) => setOpenProjectMenuId(open ? project.id : null)}
                    >
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          className="deepsea-project-node__icon-button"
                          aria-label={`打开 ${project.name} 项目操作菜单`}
                        >
                          <Ellipsis aria-hidden="true" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="end"
                          sideOffset={6}
                          className="deepsea-project-node__menu"
                        >
                          {projectActionMenuItems.map((item) => {
                            const Icon = item.icon;
                            return (
                              <DropdownMenu.Item
                                asChild
                                key={item.label}
                                onSelect={() => {
                                  setOpenProjectMenuId(null);
                                  if (item.label === '编辑名称') onRenameProject?.(project);
                                  else onRemoveProject?.(project);
                                }}
                              >
                                <button
                                  type="button"
                                  className="deepsea-project-node__menu-item"
                                  data-danger={item.danger ? 'true' : undefined}
                                  data-project-menu-item={item.label}
                                >
                                  <Icon aria-hidden="true" />
                                  <span>{item.label}</span>
                                </button>
                              </DropdownMenu.Item>
                            );
                          })}
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
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
                ) : null}
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
                      sortMode={sidebarPrefs.sortMode}
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

function SidebarMenuSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="deepsea-project-filter-menu__section">
      <div className="deepsea-project-filter-menu__title">{title}</div>
      {children}
    </div>
  );
}

function SidebarMenuItem({
  icon: Icon,
  label,
  active,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <DropdownMenu.Item asChild onSelect={onSelect}>
      <button
        type="button"
        className="deepsea-project-filter-menu__item"
        data-active={active ? 'true' : undefined}
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
        {active ? <CheckCircle2 aria-hidden="true" /> : null}
      </button>
    </DropdownMenu.Item>
  );
}

function ProjectSessionTimeRow({
  session,
  currentSessionId,
  sortMode,
  onOpenSession,
  onToggleSessionPin,
}: {
  session: ActiveSessionSummary;
  currentSessionId: string;
  sortMode: SessionSidebarSortMode;
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onToggleSessionPin?: (session: ActiveSessionSummary) => void;
}): JSX.Element {
  const isCurrent = session.id === currentSessionId;
  return (
    <div
      className="deepsea-project-session-row-wrap deepsea-project-session-row-wrap--time"
      data-current={isCurrent ? 'true' : undefined}
      data-pinned={session.pinned_at !== null ? 'true' : 'false'}
      data-session-sidebar-time-row="true"
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
        className="deepsea-project-session-row deepsea-project-session-row--time"
        data-current={isCurrent ? 'true' : undefined}
        data-project-session-row="true"
        data-running={session.active_run_count > 0 ? 'true' : undefined}
        data-status={session.status}
        onClick={() => onOpenSession?.(session.project_id, session.id)}
      >
        <span className="deepsea-project-session-row__stack">
          <span className="deepsea-project-session-row__main">
            <span className="deepsea-project-session-row__title" title={session.title}>
              {formatCompactSessionTitle(session.title, 31)}
            </span>
            <time className="deepsea-project-session-row__time">
              {formatRelativeTime(Date.now(), getSessionSidebarSortTime(session, sortMode))}
            </time>
          </span>
          <span className="deepsea-project-session-row__project" title={session.project_name}>
            {session.project_name}
          </span>
          {session.latest_event_summary ? (
            <span className="deepsea-project-session-row__summary" data-session-change-summary="true">
              {session.latest_event_summary}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  );
}

function ProjectSessionRow({
  session,
  currentSessionId,
  sortMode,
  onOpenSession,
  onToggleSessionPin,
}: {
  session: ActiveSessionSummary;
  currentSessionId: string;
  sortMode: SessionSidebarSortMode;
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
        <span className="deepsea-project-session-row__stack">
          <span className="deepsea-project-session-row__main">
            <span className="deepsea-project-session-row__title" title={session.title}>
              {formatCompactSessionTitle(session.title, 31)}
            </span>
            <time className="deepsea-project-session-row__time">
              {formatRelativeTime(Date.now(), getSessionSidebarSortTime(session, sortMode))}
            </time>
          </span>
          {session.latest_event_summary ? (
            <span className="deepsea-project-session-row__summary" data-session-change-summary="true">
              {session.latest_event_summary}
            </span>
          ) : null}
        </span>
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
  return buildProjectSessionTreeFromActiveSessions(input.projects, activeSessions);
}

function buildProjectSessionTreeFromActiveSessions(
  projects: ProjectSwitcherProject[],
  activeSessions: ActiveSessionSummary[],
): ProjectSessionTreeProject[] {
  const sessionsByProjectId = new Map<string, ActiveSessionSummary[]>();
  for (const session of activeSessions) {
    const bucket = sessionsByProjectId.get(session.project_id) ?? [];
    bucket.push(session);
    sessionsByProjectId.set(session.project_id, bucket);
  }

  const knownProjectIds = new Set(projects.map((project) => project.id));
  const projectNodes: ProjectSessionTreeProject[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    path: project.path,
    active: project.active,
    created_at: project.created_at,
    updated_at: project.updated_at,
    pinned_at: project.pinned_at,
    sort_order: project.sort_order,
    recentSessions: project.recentSessions,
    sortable: true,
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
      created_at: session.created_at,
      updated_at: session.updated_at,
      recentSessions: [],
      sortable: false,
      sessions: [],
    };
    orphanProject.sessions.push(session);
    orphanProjects.set(orphanId, orphanProject);
  }

  return [...projectNodes, ...orphanProjects.values()];
}

export function normalizeSessionSidebarPrefs(value: unknown): SessionSidebarPrefs {
  if (!value || typeof value !== 'object') return DEFAULT_SESSION_SIDEBAR_PREFS;
  const record = value as Partial<Record<keyof SessionSidebarPrefs, unknown>>;
  const groupMode = record.groupMode === 'time' || record.groupMode === 'project'
    ? record.groupMode
    : DEFAULT_SESSION_SIDEBAR_PREFS.groupMode;
  const sortMode = record.sortMode === 'created' || record.sortMode === 'updated'
    ? record.sortMode
    : DEFAULT_SESSION_SIDEBAR_PREFS.sortMode;
  const visibility = record.visibility === 'all' || record.visibility === 'pinned'
    ? record.visibility
    : DEFAULT_SESSION_SIDEBAR_PREFS.visibility;
  return { groupMode, sortMode, visibility };
}

export function readSessionSidebarPrefs(): SessionSidebarPrefs {
  const storage = getSessionSidebarStorage();
  if (!storage) return DEFAULT_SESSION_SIDEBAR_PREFS;
  try {
    const raw = storage.getItem(SESSION_SIDEBAR_PREFS_STORAGE_KEY);
    return normalizeSessionSidebarPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_SESSION_SIDEBAR_PREFS;
  }
}

export function writeSessionSidebarPrefs(prefs: SessionSidebarPrefs): void {
  const storage = getSessionSidebarStorage();
  if (!storage) return;
  try {
    storage.setItem(SESSION_SIDEBAR_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore persistence failures so the current interaction can still update in memory.
  }
}

function getSessionSidebarStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function getSessionSidebarSortTime(session: ActiveSessionSummary, sortMode: SessionSidebarSortMode): number {
  if (sortMode === 'created') return session.created_at;
  return session.last_viewed_at ?? session.updated_at;
}

function getProjectSidebarSortTime(project: ProjectSessionTreeProject, sortMode: SessionSidebarSortMode): number {
  if (sortMode === 'created') return project.created_at ?? 0;
  return project.updated_at ?? project.created_at ?? 0;
}

export function sortSessionsForSidebar(
  sessions: ActiveSessionSummary[],
  sortMode: SessionSidebarSortMode,
): ActiveSessionSummary[] {
  return [...sessions].sort((left, right) => {
    const delta = getSessionSidebarSortTime(right, sortMode) - getSessionSidebarSortTime(left, sortMode);
    return delta || right.updated_at - left.updated_at || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}

function sortProjectsForSidebar(
  projects: ProjectSessionTreeProject[],
  sortMode: SessionSidebarSortMode,
): ProjectSessionTreeProject[] {
  return [...projects].sort((left, right) => {
    const delta = getProjectSidebarSortTime(right, sortMode) - getProjectSidebarSortTime(left, sortMode);
    return delta || left.name.localeCompare(right.name);
  });
}

function filterSessionsByVisibility(
  sessions: ActiveSessionSummary[],
  visibility: SessionSidebarVisibility,
): ActiveSessionSummary[] {
  return visibility === 'pinned'
    ? sessions.filter((session) => session.pinned_at !== null)
    : sessions;
}

function filterSessionsByQuery(
  sessions: ActiveSessionSummary[],
  normalizedQuery: string,
): ActiveSessionSummary[] {
  if (!normalizedQuery) return sessions;
  return sessions.filter((session) =>
    [
      session.title,
      session.project_name,
      session.project_path,
      session.latest_event_summary ?? '',
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  );
}

export function buildSessionSidebarModel(input: {
  projects: ProjectSwitcherProject[];
  sessions: ActiveSessionSummary[];
  currentSession: Session;
  currentProjectId: string;
  currentProjectName: string;
  normalizedQuery: string;
  prefs: SessionSidebarPrefs;
}): SessionSidebarModel {
  const activeSessions = ensureCurrentActiveSessionSummary(
    input.sessions,
    input.currentSession,
    input.currentProjectId,
    input.currentProjectName,
  ).filter((session) => session.status !== 'archived');
  const visibleSessions = sortSessionsForSidebar(
    filterSessionsByVisibility(activeSessions, input.prefs.visibility),
    input.prefs.sortMode,
  );
  const tree = buildProjectSessionTreeFromActiveSessions(input.projects, visibleSessions)
    .map((project) => ({
      ...project,
      sessions: sortSessionsForSidebar(project.sessions, input.prefs.sortMode),
    }));
  const queryFilteredProjects = filterProjectSessionTree(tree, input.normalizedQuery);
  const displayProjects = queryFilteredProjects.filter((project) => project.sessions.length > 0);
  const projects = sortProjectsForSidebar(
    displayProjects,
    input.prefs.sortMode,
  );
  const timeRows = filterSessionsByQuery(visibleSessions, input.normalizedQuery);
  return {
    heading: input.prefs.groupMode === 'time' ? '聊天' : '项目',
    projects: input.prefs.groupMode === 'project' ? projects : [],
    timeRows: input.prefs.groupMode === 'time' ? timeRows : [],
    emptyMessage: input.prefs.visibility === 'pinned' ? '暂无置顶会话。' : '没有匹配的会话。',
  };
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

function SessionTitleBar({
  detail,
  todoStats,
}: {
  detail: SessionDetail;
  todoStats?: SessionTodoStats | null;
}): JSX.Element {
  const stats = todoStats?.sessionId === detail.session.id
    ? todoStats
    : buildSessionTodoStatsFromPlanItems(detail.session.id, detail.planItems);
  return (
    <header className="deepsea-session-titlebar" aria-label="当前会话标题">
      <div className="deepsea-session-titlebar__identity">
        <MessageSquare aria-hidden="true" />
        <div>
          <h2 title={detail.session.title}>{formatCompactSessionTitle(detail.session.title)}</h2>
          {detail.session.current_goal ? <p title={detail.session.current_goal}>{detail.session.current_goal}</p> : null}
        </div>
      </div>
      <span
        className="deepsea-session-titlebar__todo"
        data-session-todo-count="true"
        aria-label={`当前会话待办数量：${stats.open}`}
        title={`当前会话待办数量：${stats.open} / ${stats.total}`}
      >
        待办 <strong>{stats.open}</strong>
      </span>
    </header>
  );
}

function TranscriptCanvas({
  detail,
  evidence,
  projectId,
  onSendMessage,
  onRetryRun,
  onSaveKnowledge,
  onApproveWorkflowArtifact,
  savingKnowledgeKey,
  todoStats,
}: {
  detail: SessionDetail;
  evidence: SessionEvidenceEvent[];
  projectId: string;
  onSendMessage: (message: SessionComposerSubmit) => void;
  onRetryRun?: (runId: string) => void;
  onSaveKnowledge?: (input: SessionKnowledgeSaveInput) => void;
  onApproveWorkflowArtifact?: (artifactVersionId: string) => void;
  savingKnowledgeKey?: SessionKnowledgeActionKey | null;
  todoStats?: SessionTodoStats | null;
}): JSX.Element {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const followTranscriptRef = useRef(true);
  const acceptedVisualCompanionOfferKeysRef = useRef(new Set<string>());
  const [optimisticApprovalStatuses, setOptimisticApprovalStatuses] = useState<Record<string, SessionApprovalStatus>>({});
  const { data: projectAgents } = useQuery({
    queryKey: ['project-used-agents', projectId],
    queryFn: () => api.getProjectUsedAgents(projectId),
    staleTime: 20_000,
  });
  const transcriptTimeline = buildTranscriptTimeline(detail);
  const timeline = transcriptTimeline.slice(-36);
  const latestTranscriptRunId = getLatestTimelineRunId(transcriptTimeline);
  const persistedApprovalStatusBySourceMessageId = useMemo(
    () => buildSessionApprovalStatusLookup(detail.messages),
    [detail.messages],
  );
  const approvalStatusBySourceMessageId = useMemo(() => {
    const statuses = new Map(persistedApprovalStatusBySourceMessageId);
    for (const [sourceMessageId, status] of Object.entries(optimisticApprovalStatuses)) {
      statuses.set(sourceMessageId, { status, updatedAt: Number.MAX_SAFE_INTEGER });
    }
    return statuses;
  }, [optimisticApprovalStatuses, persistedApprovalStatusBySourceMessageId]);
  const hasLiveRun = timeline.some((item) => item.kind === 'run' && isRunLive(item.run.status));
  const [nowTick, setNowTick] = useState(() => Date.now());
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
  const [copiedActionKey, setCopiedActionKey] = useState<string | null>(null);
  const [acceptedVisualCompanionOfferKeys, setAcceptedVisualCompanionOfferKeys] = useState<Set<string>>(() => new Set());
  const [workspacePreviewPath, setWorkspacePreviewPath] = useState<string | null>(null);
  const openWorkspaceFilePreview: WorkspaceFileOpenHandler = (path) => setWorkspacePreviewPath(path);
  const displayModeFor = (key: string): SessionMessageDisplayMode => displayModes[key] ?? 'preview';
  const setDisplayModeFor = (key: string, mode: SessionMessageDisplayMode) => {
    setDisplayModes((current) => ({ ...current, [key]: mode }));
  };
  const acceptVisualCompanionOffer = (offerKey: string): void => {
    if (!recordVisualCompanionOfferAccepted(acceptedVisualCompanionOfferKeysRef.current, offerKey)) return;
    setAcceptedVisualCompanionOfferKeys(new Set(acceptedVisualCompanionOfferKeysRef.current));
    onSendMessage(buildVisualCompanionAcceptanceSubmit());
  };
  const submitRiskApprovalDecision = (sourceMessageId: string, status: Exclude<SessionApprovalStatus, 'pending'>): void => {
    setOptimisticApprovalStatuses((current) => ({ ...current, [sourceMessageId]: status }));
    onSendMessage(buildRiskApprovalDecisionSubmit(status));
  };
  const copyTranscriptText = async (content: string, key: string) => {
    try {
      await writeTranscriptTextToClipboard(content);
      setCopiedActionKey(key);
      window.setTimeout(() => {
        setCopiedActionKey((current) => (current === key ? null : current));
      }, 1200);
    } catch {
      setCopiedActionKey(null);
      toast.error('复制失败，请检查浏览器剪贴板权限');
    }
  };
  const agentNamesById = buildAgentNamesById(detail.messages, projectAgents);

  useEffect(() => {
    if (!hasLiveRun) return undefined;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasLiveRun]);

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

  const expandTranscriptDetails = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.querySelectorAll<HTMLDetailsElement>('details').forEach((details) => {
      details.open = true;
    });
  }, []);

  return (
    <section className="deepsea-transcript" aria-label="Active Session">
      <SessionTitleBar detail={detail} todoStats={todoStats} />
      <div className="deepsea-transcript__header">
        <h3>
          <MessageSquare aria-hidden="true" />
          3. 对话记录 <span>(Transcript)</span>
        </h3>
        <button
          type="button"
          className="deepsea-transcript__expand"
          aria-label="展开当前对话中的全部可折叠内容"
          onClick={expandTranscriptDetails}
        >
          全部展开
          <ChevronDown aria-hidden="true" />
        </button>
      </div>
      <div className="deepsea-transcript__scroll" data-transcript-scroll="true" ref={transcriptRef}>
        {timeline.length === 0 ? (
          <div className="deepsea-empty deepsea-empty--center">发送第一条消息开始当前会话。</div>
        ) : timeline.map((item) => {
          if (item.kind === 'message') {
            const displayMode = displayModeFor(item.key);
            return (
              <TranscriptMessage
                key={item.key}
                projectId={projectId}
                message={item.message}
                displayMode={displayMode}
                onDisplayModeChange={(mode) => setDisplayModeFor(item.key, mode)}
                onSaveKnowledge={onSaveKnowledge}
                savingKnowledgeKey={savingKnowledgeKey}
                copiedActionKey={copiedActionKey}
                onCopyText={(content, key) => void copyTranscriptText(content, key)}
                visualCompanionAccepted={acceptedVisualCompanionOfferKeys.has(`message:${item.message.id}`)}
                onAcceptVisualCompanion={() => acceptVisualCompanionOffer(`message:${item.message.id}`)}
                onOpenWorkspaceFile={openWorkspaceFilePreview}
                onSubmitRiskApprovalDecision={submitRiskApprovalDecision}
                approvalStatusBySourceMessageId={approvalStatusBySourceMessageId}
              />
            );
          }
          if (item.kind === 'workflow-group') {
            return (
              <WorkflowChatMessage
                key={item.key}
                group={item.group}
                onApprove={onApproveWorkflowArtifact}
                onRequestChange={(artifact) => onSendMessage({
                  content: buildWorkflowArtifactChangeRequestContent(artifact),
                  workflowArtifactChangeRequest: {
                    workflowRunId: artifact.workflow_run_id,
                    artifactVersionId: artifact.id,
                    artifactType: artifact.artifact_type,
                  },
                })}
              />
            );
          }
          const runEvidence = evidence.filter((event) => event.source_run_id === item.run.id);
          const runAgentEvents = (detail.agentEvents ?? []).filter((event) => event.run_id === item.run.id);
          const output = runOutputText(item.run);
          const failureDetails = runFailureDetails(item.run, runAgentEvents);
          const displayMode = displayModeFor(item.key);
          const runLabel = agentNamesById.get(item.run.agent_id) ?? item.run.agent_id;
          const runKnowledgeActionKey = buildSessionKnowledgeActionKey('run', item.run.id);
          const runCopyActionKey = `copy:${runKnowledgeActionKey}`;
          const runCopied = copiedActionKey === runCopyActionKey;
          const canSaveRunKnowledge = Boolean(onSaveKnowledge && output.trim());
          const savingRunKnowledge = savingKnowledgeKey === runKnowledgeActionKey;
          const runKnowledgeTitle = `智能体回复 - ${runLabel} - ${formatClock(item.run.started_at)}`;
          const runVisualCompanionOfferKey = `run:${item.run.id}`;
          const canOpenRunVisualCompanion = shouldShowVisualCompanionAction({
            role: 'assistant',
            displayMode,
            content: output,
            accepted: acceptedVisualCompanionOfferKeys.has(runVisualCompanionOfferKey),
          });
          return (
            <article key={item.key} className="deepsea-message deepsea-message--agent-run" data-role="assistant">
              <RunFlowCapsule
                run={item.run}
                runLabel={runLabel}
                runAgentEvents={runAgentEvents}
                runEvidence={runEvidence}
                failureDetails={failureDetails}
                output={output}
                displayMode={displayMode}
                streaming={isRunLive(item.run.status)}
                now={nowTick}
                latestTranscriptRunId={latestTranscriptRunId}
                onRetryRun={onRetryRun}
                onOpenWorkspaceFile={openWorkspaceFilePreview}
                actions={(
                  <>
                    <button
                      type="button"
                      className="deepsea-message__action"
                      data-action="copy"
                      data-state={runCopied ? 'copied' : undefined}
                      aria-label="复制智能体输出"
                      onClick={() => void copyTranscriptText(output, runCopyActionKey)}
                    >
                      {runCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      <span>{runCopied ? '已复制' : '复制'}</span>
                    </button>
                    {canSaveRunKnowledge ? (
                      <button
                        type="button"
                        className="deepsea-message__action"
                        data-action="knowledge"
                        data-state={savingRunKnowledge ? 'saving' : undefined}
                        aria-label="保存智能体输出为知识"
                        disabled={savingRunKnowledge}
                        onClick={() => onSaveKnowledge?.({
                          kind: 'run',
                          key: runKnowledgeActionKey,
                          run: item.run,
                          title: runKnowledgeTitle,
                          content: output,
                        })}
                      >
                        <BookOpen aria-hidden="true" />
                        <span>{savingRunKnowledge ? '保存中' : '保存为知识'}</span>
                      </button>
                    ) : null}
                    {canOpenRunVisualCompanion ? (
                      <button
                        type="button"
                        className="deepsea-message__action"
                        data-action="visual-companion"
                        data-acceptance-message={VISUAL_COMPANION_ACCEPTANCE_MESSAGE}
                        aria-label="打开设计预览"
                        onClick={() => acceptVisualCompanionOffer(runVisualCompanionOfferKey)}
                      >
                        <SquarePen aria-hidden="true" />
                        <span>打开设计预览</span>
                      </button>
                    ) : null}
                    <MarkdownDisplaySwitch
                      content={output}
                      mode={displayMode}
                      onModeChange={(mode) => setDisplayModeFor(item.key, mode)}
                    />
                  </>
                )}
              />
            </article>
          );
        })}
        <div aria-hidden="true" className="deepsea-transcript__end" data-transcript-end="true" ref={transcriptEndRef} />
      </div>
      <div className="deepsea-composer-anchor">
        <DeepseaComposer
          projectId={detail.session.project_id}
          sessionId={detail.session.id}
          onSendMessage={onSendMessage}
        />
      </div>
      <WorkspaceDocumentPreviewDialog
        projectId={projectId}
        path={workspacePreviewPath}
        onOpenChange={(open) => {
          if (!open) setWorkspacePreviewPath(null);
        }}
      />
    </section>
  );
}

type WorkflowMissionStageState = 'done' | 'active' | 'gate' | 'blocked' | 'failed' | 'pending';
type WorkflowViewMode = 'flow' | 'log';

const WORKFLOW_STAGE_ORDER = ['analysis', 'planning', 'assignment', 'implementation', 'code_review', 'acceptance'] as const;
const WORKFLOW_EVENT_PREVIEW_LIMIT = 4;

interface WorkflowChatGroup {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
  controller: WorkflowControllerView | null;
  artifacts: WorkflowArtifactVersionView[];
  gates: WorkflowGateView[];
  assignments: WorkflowAgentAssignmentView[];
}

function WorkflowChatMessage({
  group,
  onApprove,
  onRequestChange,
}: {
  group: WorkflowChatGroup;
  onApprove?: (artifactVersionId: string) => void;
  onRequestChange: (artifact: WorkflowArtifactVersionView) => void;
}): JSX.Element {
  const summary = formatWorkflowChatSummary(group);
  const status = getWorkflowChatStatus(group);
  const hasLiveWorkflowState = hasWorkflowChatState(group);

  return (
    <article
      className={`deepsea-message deepsea-message--workflow is-${status}`}
      data-role="assistant"
      data-workflow-chat-message="true"
      aria-label="工作流消息"
    >
      <header className="deepsea-workflow-chat__header">
        <span className="deepsea-status-chip" data-tone={status === 'blocked' ? 'warn' : 'ok'}>
          <Brain aria-hidden="true" />
          规划师 (Planner)
        </span>
        <time className="deepsea-mono">{formatClock(group.updatedAt)}</time>
        <strong>{formatWorkflowFlowStatus(status)}</strong>
      </header>
      <div className="deepsea-message-body deepsea-workflow-chat">
        <div className="deepsea-workflow-chat__summary-row">
          <p className="deepsea-workflow-chat__summary-text" title={summary}>{summary}</p>
          {hasLiveWorkflowState ? (
            <div className="deepsea-workflow-chat__badges" aria-label="Workflow 摘要">
              <span>{formatWorkflowIntentLabel(group.controller?.selected_intent)}</span>
              <span>{formatWorkflowStageLabel(group.controller?.active_stage)}</span>
              <span>{formatPendingGateCount(group.gates)}</span>
              <span>{group.assignments.length} agents</span>
            </div>
          ) : null}
        </div>
        {hasLiveWorkflowState ? (
          <WorkflowChatStateStream
            status={status}
            group={group}
          />
        ) : null}
        <WorkflowEventRows
          messages={group.messages}
          expanded={false}
        />
        {hasLiveWorkflowState ? (
          <WorkflowGateSummary artifacts={group.artifacts} gates={group.gates} onApprove={onApprove} onRequestChange={onRequestChange} />
        ) : null}
      </div>
    </article>
  );
}

function WorkflowViewToggle({
  mode,
  onModeChange,
  label,
  className,
}: {
  mode: WorkflowViewMode;
  onModeChange: (mode: WorkflowViewMode) => void;
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={['deepsea-workflow-view-toggle', className].filter(Boolean).join(' ')}
      data-workflow-view-toggle="true"
      aria-label={label}
    >
      <button
        type="button"
        className={mode === 'flow' ? 'is-active' : undefined}
        aria-pressed={mode === 'flow'}
        onClick={() => onModeChange('flow')}
      >
        流程图
      </button>
      <button
        type="button"
        className={mode === 'log' ? 'is-active' : undefined}
        aria-pressed={mode === 'log'}
        onClick={() => onModeChange('log')}
      >
        日志
      </button>
    </div>
  );
}

function hasWorkflowChatState(group: WorkflowChatGroup): boolean {
  return Boolean(group.controller || group.artifacts.length > 0 || group.gates.length > 0 || group.assignments.length > 0);
}

function WorkflowChatStateStream({
  group,
  status,
}: {
  group: WorkflowChatGroup;
  status: 'pending' | 'active' | 'blocked' | 'done';
}): JSX.Element {
  const cards = buildWorkflowFlowCards(group.controller, group.artifacts, group.gates, group.assignments);
  const visibleCards = cards.slice(0, 4);
  const hiddenCount = Math.max(0, cards.length - visibleCards.length);
  return (
    <div className="deepsea-workflow-state-stream" data-workflow-state-stream="true" aria-label="Workflow 主流程流转">
      <div className="deepsea-workflow-state-stream__head">
        <span>{formatWorkflowFlowTimelineLabel(group.controller, group.messages)}</span>
        <strong>{formatWorkflowFlowStatus(status)}</strong>
      </div>
      <div className="deepsea-workflow-state-stream__steps">
        {visibleCards.map((card, index) => (
          <WorkflowChatStateStep key={`${card.title}:${card.detail}`} card={card} index={index} />
        ))}
        {hiddenCount > 0 ? (
          <div className="deepsea-workflow-state-stream__more">+{hiddenCount} 个后续节点已合并</div>
        ) : null}
      </div>
    </div>
  );
}

function WorkflowChatStateStep({
  card,
  index,
}: {
  card: WorkflowFlowCard;
  index: number;
}): JSX.Element {
  const Icon = card.icon ?? FileText;
  return (
    <article className="deepsea-workflow-state-step" data-card-tone={card.tone} data-card-status={formatDataToken(card.status)}>
      <span className="deepsea-workflow-state-step__index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
      <span className="deepsea-workflow-state-step__icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="deepsea-workflow-state-step__body">
        <div className="deepsea-workflow-state-step__meta">
          <strong title={card.title}>{card.title}</strong>
          <span>{card.status}</span>
        </div>
        <p title={card.detail}>{card.detail}</p>
        <span className="deepsea-workflow-state-step__progress" aria-hidden="true">
          <span style={{ width: `${card.progress}%` }} />
        </span>
      </div>
    </article>
  );
}

function WorkflowEventRows({
  messages,
  expanded = false,
}: {
  messages: SessionMessage[];
  expanded?: boolean;
}): JSX.Element | null {
  if (messages.length === 0) return null;
  if (!expanded) {
    const latestMessage = messages[messages.length - 1]!;
    const hiddenCount = Math.max(0, messages.length - 1);
    return (
      <div className="deepsea-workflow-events" data-expanded="false" data-compact="true" aria-label="连续工作流事件">
        <div className="deepsea-workflow-events__header">
          <span>Execution Log 合并事件</span>
          <strong>{messages.length} events</strong>
        </div>
        <div className="deepsea-workflow-events__compact">
          <strong>{formatWorkflowEventLabel(latestMessage)}</strong>
          <time className="deepsea-mono">{formatClock(latestMessage.created_at)}</time>
          <span title={latestMessage.content}>{formatWorkflowEventPreview(latestMessage.content)}</span>
          <em title={`已合并前 ${hiddenCount} 条 workflow 事件`}>{hiddenCount > 0 ? `+${hiddenCount} 旧事件` : '最新事件'}</em>
        </div>
      </div>
    );
  }
  const previewLimit = expanded ? messages.length : WORKFLOW_EVENT_PREVIEW_LIMIT;
  const hiddenCount = Math.max(0, messages.length - previewLimit);
  const visibleMessages = messages.slice(-previewLimit);
  return (
    <div className="deepsea-workflow-events" data-expanded={expanded ? 'true' : 'false'} aria-label="连续工作流事件">
      <div className="deepsea-workflow-events__header">
        <span>Execution Log 合并事件</span>
        <strong>{messages.length} events</strong>
      </div>
      {visibleMessages.map((message, index) => (
        <article className="deepsea-workflow-event" key={message.id}>
          <span className="deepsea-workflow-event__index">{String(hiddenCount + index + 1).padStart(2, '0')}</span>
          <div className="deepsea-workflow-event__body">
            <div className="deepsea-workflow-event__meta">
              <strong>{formatWorkflowEventLabel(message)}</strong>
              <time className="deepsea-mono">{formatClock(message.created_at)}</time>
            </div>
            <p title={message.content}>{formatWorkflowEventPreview(message.content)}</p>
          </div>
        </article>
      ))}
      {hiddenCount > 0 ? (
        <div className="deepsea-workflow-events__more">
          已合并前 {hiddenCount} 条 workflow 事件，当前优先显示最近流转。
        </div>
      ) : null}
    </div>
  );
}

function WorkflowStageRail({
  controller,
  gates,
}: {
  controller: WorkflowControllerView | null;
  gates: WorkflowGateView[];
}): JSX.Element {
  return (
    <ol className="deepsea-workflow-stage-rail" aria-label="Workflow 阶段">
      {WORKFLOW_STAGE_ORDER.map((stage) => {
        const state = getWorkflowStageState(stage, controller, gates);
        return (
          <li key={stage} className="deepsea-workflow-stage-rail__item" data-state={state}>
            <span>{formatWorkflowStageLabel(stage)}</span>
            <strong>{formatWorkflowStageStateLabel(state)}</strong>
          </li>
        );
      })}
    </ol>
  );
}

function WorkflowGateSummary({
  artifacts,
  gates,
  onApprove,
  onRequestChange,
}: {
  artifacts: WorkflowArtifactVersionView[];
  gates: WorkflowGateView[];
  onApprove?: (artifactVersionId: string) => void;
  onRequestChange: (artifact: WorkflowArtifactVersionView) => void;
}): JSX.Element | null {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const gateItems = gates
    .filter((gate) => gate.artifact_version_id)
    .map((gate) => {
      const artifact = gate.artifact_version_id ? artifactById.get(gate.artifact_version_id) : undefined;
      return artifact ? { gate, artifact } : null;
    })
    .filter((item): item is { gate: WorkflowGateView; artifact: WorkflowArtifactVersionView } => Boolean(item));
  if (gateItems.length === 0) return null;
  const pendingItems = gateItems.filter((item) => item.gate.status === 'pending');
  if (pendingItems.length === 0) return null;

  return (
    <div className="deepsea-workflow-gate-summary" aria-label="Workflow 门禁摘要">
      {pendingItems.map(({ gate, artifact }) => (
        <article className="deepsea-workflow-gate-summary__item" key={`${gate.kind}:${artifact.id}`} data-status={gate.status}>
          <div className="deepsea-workflow-gate-summary__body">
            <strong>{formatWorkflowArtifactHeading(artifact)}</strong>
            <span title={artifact.title}>{artifact.title}</span>
            <small>{gate.reason}</small>
          </div>
          <div className="deepsea-workflow-gate-summary__actions">
            <button
              type="button"
              data-workflow-artifact-action="request-change"
              aria-label={`请求 planner 修改 ${formatWorkflowArtifactHeading(artifact)}`}
              onClick={() => onRequestChange(artifact)}
            >
              <Edit3 aria-hidden="true" />
              请求修改
            </button>
            {gate.status === 'pending' ? (
              <button
                type="button"
                data-workflow-artifact-action="approve"
                aria-label={`确认 ${formatWorkflowArtifactType(artifact.artifact_type)} v${artifact.version}`}
                disabled={!onApprove}
                onClick={() => onApprove?.(artifact.id)}
              >
                <Check aria-hidden="true" />
                确认
              </button>
            ) : (
              <span className="deepsea-status-chip" data-tone="success">已确认</span>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function WorkflowAgentRoster({
  assignments,
}: {
  assignments: WorkflowAgentAssignmentView[];
}): JSX.Element | null {
  if (assignments.length === 0) return null;
  return (
    <div className="deepsea-workflow-agent-roster" aria-label="Workflow 子代理摘要">
      {assignments.map((assignment) => (
        <article className="deepsea-workflow-agent-roster__item" key={`${assignment.task_id}:${assignment.role}`}>
          <strong title={assignment.task_title}>{assignment.assigned_agent_name ?? assignment.assigned_agent_id ?? assignment.role}</strong>
          <span>{assignment.role} · {assignment.execution_mode}</span>
          {assignment.fallback_reason ? <small title={assignment.fallback_reason}>{assignment.fallback_reason}</small> : null}
          <code title={assignment.scope_write.join(', ')}>{assignment.scope_write.join(', ') || 'scopeWrite 未声明'}</code>
        </article>
      ))}
    </div>
  );
}

type WorkflowFlowLine = {
  className: 'flow-path-parallel' | 'flow-path-sequential';
  d: string;
};

type WorkflowFlowCard = {
  icon: LucideIcon;
  tone: 'controller' | 'gate' | 'agent' | 'event';
  title: string;
  status: string;
  detail: string;
  progress: number;
};

function WorkflowFlowMap({
  kind,
  phaseLabel,
  title,
  status,
  summary,
  lines,
  cards,
}: {
  kind: 'mission' | 'run';
  phaseLabel: string;
  title: string;
  status: 'pending' | 'active' | 'blocked' | 'done';
  summary: string;
  lines: WorkflowFlowLine[];
  cards: WorkflowFlowCard[];
}): JSX.Element {
  const columns = kind === 'mission' ? 3 : 2;
  const flowHeight = kind === 'mission'
    ? Math.max(142, 42 + Math.ceil(Math.max(cards.length, 1) / 2) * 44)
    : Math.max(164, 54 + Math.ceil(Math.max(cards.length, 1) / columns) * 62);
  if (kind === 'mission') {
    const distributionCards = cards.slice(0, 2);
    const executionCards = cards.slice(2);
    return (
      <div
        className="deepsea-workflow-flow"
        data-session-workflow-map={kind}
        data-workflow-flow-root="true"
        aria-label="Workflow 流转"
        style={{ minHeight: flowHeight }}
      >
        <svg
          className="deepsea-workflow-flow__lines"
          viewBox={`0 0 640 ${flowHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {lines.map((line, index) => (
            <path key={`${line.className}:${index}`} className={line.className} d={line.d} fill="none" />
          ))}
        </svg>
        <div className="deepsea-workflow-flow__phase">
          <span>{phaseLabel}</span>
        </div>
        <div className="deepsea-workflow-flow__track" aria-hidden="true" />
        <div className="deepsea-workflow-flow__step" data-step="distribution">
          <span className="deepsea-workflow-flow__dot" aria-hidden="true" data-tone={status === 'pending' ? 'pending' : 'done'} />
          <div className="deepsea-workflow-flow__step-head">
            <span>1. 任务分配与并行启动</span>
            <strong>{status === 'pending' ? 'pending' : 'done'}</strong>
          </div>
          <div className="deepsea-workflow-flow__cards">
            {distributionCards.map((card) => (
              <WorkflowFlowCardView key={`${card.title}:${card.detail}`} card={card} />
            ))}
          </div>
        </div>
        <div className="deepsea-workflow-flow__step" data-step="execution">
          <span className="deepsea-workflow-flow__dot" aria-hidden="true" data-tone={status} />
          <div className="deepsea-workflow-flow__step-head">
            <span>2. 并行执行进度</span>
            <strong>{formatWorkflowFlowStatus(status)}</strong>
          </div>
          <div className="deepsea-workflow-flow__cards">
            {executionCards.map((card) => (
              <WorkflowFlowCardView key={`${card.title}:${card.detail}`} card={card} />
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="deepsea-workflow-flow"
      data-session-workflow-map={kind}
      data-workflow-flow-root="true"
      aria-label="Workflow 流转"
      style={{ minHeight: flowHeight }}
    >
      <svg
        className="deepsea-workflow-flow__lines"
        viewBox={`0 0 640 ${flowHeight}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {lines.map((line, index) => (
          <path key={`${line.className}:${index}`} className={line.className} d={line.d} fill="none" />
        ))}
      </svg>
      <div className="deepsea-workflow-flow__phase">
        <span>{phaseLabel}</span>
      </div>
      <div className="deepsea-workflow-flow__track" aria-hidden="true" />
      <div className="deepsea-workflow-flow__node">
        <span className="deepsea-workflow-flow__dot" aria-hidden="true" data-tone={status} />
        <div className="deepsea-workflow-flow__heading">
          <span>{title}</span>
          <strong>{formatWorkflowFlowStatus(status)}</strong>
        </div>
        {kind === 'run' ? <p className="deepsea-workflow-flow__summary">{summary}</p> : null}
        <div className="deepsea-workflow-flow__cards">
          {cards.map((card) => (
            <WorkflowFlowCardView key={`${card.title}:${card.detail}`} card={card} />
          ))}
        </div>
      </div>
    </div>
  );
}

function WorkflowFlowCardView({ card }: { card: WorkflowFlowCard }): JSX.Element {
  const Icon = card.icon ?? FileText;
  return (
    <article className="deepsea-workflow-flow-card" data-card-tone={card.tone} data-card-status={formatDataToken(card.status)}>
      <span className="deepsea-workflow-flow-card__icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="deepsea-workflow-flow-card__content">
        <div className="deepsea-workflow-flow-card__head">
          <span>{card.title}</span>
          <strong>{card.status}</strong>
        </div>
        <p title={card.detail}>{card.detail}</p>
        <div className="deepsea-workflow-flow-card__progress" aria-hidden="true">
          <span style={{ width: `${card.progress}%` }} />
        </div>
      </div>
    </article>
  );
}

function formatDataToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function buildWorkflowFlowLines(
  assignments: WorkflowAgentAssignmentView[],
  gates: WorkflowGateView[],
  controller: WorkflowControllerView | null,
): WorkflowFlowLine[] {
  const hasGate = gates.some((gate) => gate.status === 'pending');
  const hasAssignments = assignments.length > 0;
  return [
    { className: 'flow-path-parallel', d: 'M 30 38 L 30 84 L 276 84' },
    { className: 'flow-path-parallel', d: 'M 30 84 L 590 84' },
    {
      className: 'flow-path-sequential',
      d: `M 30 38 L 30 ${hasAssignments || hasGate || controller ? 162 : 132}`,
    },
  ];
}

function buildWorkflowFlowCards(
  controller: WorkflowControllerView | null,
  artifacts: WorkflowArtifactVersionView[],
  gates: WorkflowGateView[],
  assignments: WorkflowAgentAssignmentView[],
): WorkflowFlowCard[] {
  const pendingGate = gates.find((gate) => gate.status === 'pending' && gate.artifact_version_id);
  const pendingGateArtifact = pendingGate?.artifact_version_id
    ? artifacts.find((artifact) => artifact.id === pendingGate.artifact_version_id)
    : undefined;
  const controllerCard: WorkflowFlowCard = {
    icon: Brain,
    tone: 'controller',
    title: 'Controller',
    status: controller?.controller ?? 'planner',
    detail: controller?.active_stage
      ? `${formatWorkflowStageLabel(controller.active_stage)} 阶段`
      : '等待 workflow 推进',
    progress: controller?.blocker ? 40 : controller ? 72 : 24,
  };
  const gateCard: WorkflowFlowCard = {
    icon: ShieldCheck,
    tone: 'gate',
    title: 'Gate',
    status: formatPendingGateCount(gates),
    detail: pendingGateArtifact?.title ?? '当前无人工确认项',
    progress: pendingGate ? 48 : 88,
  };
  const agentCard: WorkflowFlowCard = {
    icon: GitFork,
    tone: 'agent',
    title: 'Active Agents',
    status: `${assignments.length} agents`,
    detail: assignments[0]
      ? `${assignments[0].assigned_agent_name ?? assignments[0].assigned_agent_id ?? assignments[0].role} · ${assignments[0].fallback_reason ?? assignments[0].task_title}`
      : '等待 agent 分派',
    progress: assignments.length > 0 ? 64 : 20,
  };
  const assignmentCards = assignments.slice(0, 2).map((assignment, index): WorkflowFlowCard => ({
    icon: GitFork,
    tone: 'agent',
    title: formatWorkflowAssignmentCardTitle(assignment, index, assignments),
    status: assignment.backend ?? assignment.execution_mode,
    detail: assignment.fallback_reason
      ? `${assignment.task_title} · ${assignment.fallback_reason}`
      : assignment.task_title,
    progress: 100,
  }));
  const distributionCards = assignmentCards.length > 0
    ? assignmentCards
    : [controllerCard, gateCard];
  const executionCards = assignmentCards.length > 0
    ? [controllerCard, gateCard]
    : [agentCard];
  return [...distributionCards, ...executionCards];
}

function formatWorkflowAssignmentCardTitle(
  assignment: WorkflowAgentAssignmentView,
  index: number,
  assignments: WorkflowAgentAssignmentView[],
): string {
  const base = assignment.assigned_agent_name ?? assignment.assigned_agent_id ?? assignment.role;
  const duplicateCount = assignments.filter((item) =>
    (item.assigned_agent_name ?? item.assigned_agent_id ?? item.role) === base
  ).length;
  return duplicateCount > 1 ? `${base} ${String(index + 1).padStart(2, '0')}` : base;
}

function formatWorkflowIntentLabel(intent: string | null | undefined): string {
  if (!intent) return 'workflow';
  if (intent === 'standard_development') return '标准开发';
  if (intent === 'light_task') return '轻量任务';
  if (intent === 'debugger') return '调试';
  if (intent === 'brainstorming') return '头脑风暴';
  return intent.replace(/_/g, ' ');
}

function formatWorkflowFlowTimelineLabel(controller: WorkflowControllerView | null, messages: SessionMessage[]): string {
  const stage = formatWorkflowStageLabel(controller?.active_stage);
  return `${stage} · ${formatWorkflowEventCount(messages)}`;
}

function formatWorkflowFlowStatus(status: 'pending' | 'active' | 'blocked' | 'done'): string {
  if (status === 'done') return 'done';
  if (status === 'active') return 'active';
  if (status === 'blocked') return 'blocked';
  return 'pending';
}

function getWorkflowStageState(
  stage: (typeof WORKFLOW_STAGE_ORDER)[number],
  controller: WorkflowControllerView | null,
  gates: WorkflowGateView[],
): WorkflowMissionStageState {
  const activeStage = normalizeWorkflowStage(controller?.active_stage);
  if (controller?.blocker && activeStage === stage) return 'blocked';
  if (gates.some((gate) => gate.status === 'pending') && activeStage === stage) return 'gate';
  if (activeStage === stage) return 'active';
  const activeIndex = activeStage ? WORKFLOW_STAGE_ORDER.indexOf(activeStage) : -1;
  const stageIndex = WORKFLOW_STAGE_ORDER.indexOf(stage);
  if (activeIndex >= 0 && stageIndex >= 0 && stageIndex < activeIndex) return 'done';
  return 'pending';
}

function normalizeWorkflowStage(stage: string | null | undefined): (typeof WORKFLOW_STAGE_ORDER)[number] | null {
  if (stage === 'brainstorming') return 'analysis';
  if (stage === 'agent_assignment') return 'assignment';
  return WORKFLOW_STAGE_ORDER.find((knownStage) => knownStage === stage) ?? null;
}

function formatWorkflowMissionMeta(controller: WorkflowControllerView | null): string {
  if (!controller) return 'controller: pending · next: 等待 workflow 数据';
  return [
    `intent: ${controller.selected_intent ?? 'workflow'}`,
    `controller: ${controller.controller ?? 'planner'}`,
    `next: ${controller.next_action ?? '等待推进'}`,
  ].join(' · ');
}

function formatPendingGateCount(gates: WorkflowGateView[]): string {
  const pending = gates.filter((gate) => gate.status === 'pending').length;
  return pending > 0 ? `${pending} 个门禁` : '无待确认门禁';
}

function formatWorkflowStageLabel(stage: string | null | undefined): string {
  if (stage === 'analysis') return '分析';
  if (stage === 'planning') return '计划';
  if (stage === 'assignment' || stage === 'agent_assignment') return '分派';
  if (stage === 'implementation') return '实现';
  if (stage === 'code_review') return '审查';
  if (stage === 'acceptance') return '验收';
  if (stage === 'brainstorming') return '分析';
  return stage ?? 'general';
}

function formatWorkflowStageStateLabel(state: WorkflowMissionStageState): string {
  if (state === 'done') return 'done';
  if (state === 'active') return 'active';
  if (state === 'gate') return 'gate';
  if (state === 'blocked') return 'blocked';
  if (state === 'failed') return 'failed';
  return 'pending';
}

function WorkflowArtifactGatePanel({
  artifacts,
  gates,
  onApprove,
  onRequestChange,
}: {
  artifacts: WorkflowArtifactVersionView[];
  gates: WorkflowGateView[];
  onApprove?: (artifactVersionId: string) => void;
  onRequestChange: (artifact: WorkflowArtifactVersionView) => void;
}): JSX.Element | null {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const gateItems = gates
    .filter((gate) => gate.artifact_version_id)
    .map((gate) => {
      const artifact = gate.artifact_version_id ? artifactById.get(gate.artifact_version_id) : undefined;
      return artifact ? { gate, artifact } : null;
    })
    .filter((item): item is { gate: WorkflowGateView; artifact: WorkflowArtifactVersionView } => Boolean(item));
  if (gateItems.length === 0) return null;
  const pendingCount = gateItems.filter((item) => item.gate.status === 'pending').length;

  return (
    <section className="deepsea-workflow-artifacts" data-workflow-artifact-panel="true" aria-label="工作流产物确认">
      <div className="deepsea-workflow-artifacts__header">
        <div>
          <span className="deepsea-status-chip" data-tone="warn">Workflow Gate</span>
          <h3>{pendingCount > 0 ? '等待用户确认' : '已确认产物'}</h3>
        </div>
        <span>{pendingCount > 0 ? `${pendingCount} 个门禁` : `${gateItems.length} 个产物`}</span>
      </div>
      <div className="deepsea-workflow-artifacts__list">
        {gateItems.map(({ gate, artifact }) => (
          <article className="deepsea-workflow-artifact" key={`${gate.kind}:${artifact.id}`}>
            <header className="deepsea-workflow-artifact__title">
              <FileText aria-hidden="true" />
              <div>
                <strong>{formatWorkflowArtifactHeading(artifact)}</strong>
                <span>{artifact.title}</span>
              </div>
            </header>
            <div className="deepsea-workflow-artifact__body">
              <MarkdownPreview content={artifact.content} />
            </div>
            <footer className="deepsea-workflow-artifact__footer">
              <span>{gate.reason}</span>
              <div className="deepsea-workflow-artifact__actions">
                <button
                  type="button"
                  data-workflow-artifact-action="request-change"
                  aria-label={`请求 planner 修改 ${formatWorkflowArtifactHeading(artifact)}`}
                  onClick={() => onRequestChange(artifact)}
                >
                  <Edit3 aria-hidden="true" />
                  请求 planner 修改
                </button>
                {gate.status === 'pending' ? (
                  <button
                    type="button"
                    data-workflow-artifact-action="approve"
                    aria-label={`确认 ${artifact.artifact_type} v${artifact.version}`}
                    disabled={!onApprove}
                    onClick={() => onApprove?.(artifact.id)}
                  >
                    <Check aria-hidden="true" />
                    确认 {formatWorkflowArtifactType(artifact.artifact_type)}
                  </button>
                ) : (
                  <span className="deepsea-status-chip" data-tone="success">已确认</span>
                )}
              </div>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

function WorkflowControllerPanel({
  controller,
}: {
  controller?: WorkflowControllerView | null;
}): JSX.Element | null {
  if (!controller) return null;
  return (
    <section className="deepsea-workflow-controller" data-workflow-controller-panel="true" aria-label="Workflow controller">
      <div className="deepsea-workflow-controller__header">
        <span className="deepsea-status-chip" data-tone="ok">Workflow</span>
        <strong>{controller.selected_intent ?? 'unrouted'}</strong>
      </div>
      <dl className="deepsea-workflow-controller__grid">
        <div>
          <dt>Stage</dt>
          <dd>{controller.active_stage ?? 'pending'}</dd>
        </div>
        <div>
          <dt>Controller</dt>
          <dd>{controller.controller ?? 'planner'}</dd>
        </div>
        <div>
          <dt>Next</dt>
          <dd>{controller.next_action ?? '等待推进'}</dd>
        </div>
      </dl>
      {controller.blocker ? (
        <p className="deepsea-workflow-controller__blocker">{controller.blocker}</p>
      ) : null}
    </section>
  );
}

function WorkflowAgentAssignmentTable({
  assignments,
}: {
  assignments?: WorkflowAgentAssignmentView[];
}): JSX.Element | null {
  if (!assignments || assignments.length === 0) return null;
  return (
    <section className="deepsea-agent-assignment" data-agent-assignment-table="true" aria-label="子代理分配">
      <header className="deepsea-agent-assignment__header">
        <span className="deepsea-status-chip" data-tone="ok">Assignments</span>
        <strong>子代理分配</strong>
      </header>
      <div className="deepsea-agent-assignment__rows">
        {assignments.map((assignment) => (
          <article className="deepsea-agent-assignment__row" key={`${assignment.task_id}:${assignment.role}`}>
            <div className="deepsea-agent-assignment__task">
              <strong>{assignment.task_title}</strong>
              <span>{assignment.role} · {assignment.execution_mode}</span>
            </div>
            <div className="deepsea-agent-assignment__agent">
              <span>{assignment.assigned_agent_name ?? assignment.assigned_agent_id ?? '未分配'}</span>
              {assignment.backend ? <small>{assignment.backend}</small> : null}
            </div>
            {assignment.fallback_reason ? <p>{assignment.fallback_reason}</p> : null}
            <code>{assignment.scope_write.join(', ') || 'scopeWrite 未声明'}</code>
          </article>
        ))}
      </div>
    </section>
  );
}

function buildWorkflowArtifactChangeRequestContent(artifact: WorkflowArtifactVersionView): string {
  return `请修改 ${formatWorkflowArtifactType(artifact.artifact_type)} v${artifact.version}：`;
}

function formatWorkflowArtifactHeading(artifact: WorkflowArtifactVersionView): string {
  return `${formatWorkflowArtifactType(artifact.artifact_type, true)} v${artifact.version}`;
}

function formatWorkflowArtifactType(type: WorkflowArtifactVersionView['artifact_type'], titleCase = false): string {
  if (type === 'spec') return titleCase ? 'Spec' : 'spec';
  if (type === 'plan') return titleCase ? 'Plan' : 'plan';
  if (type === 'lightweight_plan') return titleCase ? 'Lightweight Plan' : 'lightweight plan';
  if (type === 'review') return titleCase ? 'Review' : 'review';
  return titleCase ? 'Verification' : 'verification';
}

type TranscriptTimelineItem =
  | { kind: 'message'; key: string; timestamp: number; message: SessionMessage }
  | { kind: 'run'; key: string; timestamp: number; run: SessionRun }
  | { kind: 'workflow-group'; key: string; timestamp: number; group: WorkflowChatGroup };

type SourceTranscriptTimelineItem =
  | { kind: 'message'; key: string; timestamp: number; message: SessionMessage }
  | { kind: 'run'; key: string; timestamp: number; run: SessionRun };

function buildTranscriptTimeline(detail: SessionDetail): TranscriptTimelineItem[] {
  const sourceTimeline: SourceTranscriptTimelineItem[] = [
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

  const hasWorkflowTranscriptMessages = sourceTimeline.some(
    (item) => item.kind === 'message' && isWorkflowTranscriptMessage(item.message),
  );
  const workflowStateItem = hasWorkflowTranscriptMessages ? null : buildWorkflowStateChatGroup(detail);
  const timeline: TranscriptTimelineItem[] = [];
  let pendingWorkflowMessages: SessionMessage[] = [];

  const flushWorkflowMessages = () => {
    if (pendingWorkflowMessages.length === 0) return;
    timeline.push({
      kind: 'workflow-group',
      key: `workflow-group:${pendingWorkflowMessages.map((message) => message.id).join(':')}`,
      timestamp: pendingWorkflowMessages[0]?.created_at ?? Date.now(),
      group: buildWorkflowChatGroup(detail, pendingWorkflowMessages, { includeWorkflowState: false }),
    });
    pendingWorkflowMessages = [];
  };

  for (const item of sourceTimeline) {
    if (item.kind === 'message' && isWorkflowTranscriptMessage(item.message)) {
      pendingWorkflowMessages.push(item.message);
      continue;
    }
    flushWorkflowMessages();
    timeline.push(item);
  }
  flushWorkflowMessages();
  if (workflowStateItem) timeline.push(workflowStateItem);
  attachWorkflowStateToLatestGroup(timeline, detail);
  return timeline.sort((left, right) => left.timestamp - right.timestamp || left.key.localeCompare(right.key));
}

function attachWorkflowStateToLatestGroup(timeline: TranscriptTimelineItem[], detail: SessionDetail): void {
  if (!hasWorkflowState(detail)) return;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.kind !== 'workflow-group') continue;
    timeline[index] = {
      ...item,
      group: buildWorkflowChatGroup(detail, item.group.messages, { includeWorkflowState: true }),
    };
    return;
  }
}

function hasWorkflowState(detail: SessionDetail): boolean {
  return Boolean(
    detail.workflowController ||
    (detail.workflowArtifacts ?? []).length > 0 ||
    (detail.workflowGates ?? []).length > 0 ||
    (detail.workflowAgentAssignments ?? []).length > 0
  );
}

function buildWorkflowStateChatGroup(detail: SessionDetail): TranscriptTimelineItem | null {
  const controller = detail.workflowController ?? null;
  const artifacts = detail.workflowArtifacts ?? [];
  const gates = detail.workflowGates ?? [];
  const assignments = detail.workflowAgentAssignments ?? [];
  if (!controller && artifacts.length === 0 && gates.length === 0 && assignments.length === 0) return null;
  const artifactTimes = artifacts.map((artifact) => artifact.created_at);
  const messageTimes = detail.messages.map((message) => message.created_at);
  const runTimes = detail.runs.map((run) => run.started_at);
  const timestamp = Math.max(0, ...artifactTimes, ...messageTimes, ...runTimes, detail.session.updated_at);
  return {
    kind: 'workflow-group',
    key: `workflow-group:state:${controller?.workflow_run_id ?? artifacts[0]?.workflow_run_id ?? gates[0]?.workflow_run_id ?? detail.session.id}`,
    timestamp,
    group: buildWorkflowChatGroup(detail, []),
  };
}

function buildWorkflowChatGroup(
  detail: SessionDetail,
  messages: SessionMessage[],
  options: { includeWorkflowState?: boolean } = {},
): WorkflowChatGroup {
  const includeWorkflowState = options.includeWorkflowState ?? true;
  const artifacts = includeWorkflowState ? detail.workflowArtifacts ?? [] : [];
  const messageTimes = messages.map((message) => message.created_at);
  const stateTimes = artifacts.map((artifact) => artifact.created_at);
  const createdAt = messageTimes.length > 0
    ? Math.min(...messageTimes)
    : Math.min(...stateTimes, detail.session.updated_at);
  const updatedAt = messageTimes.length > 0
    ? Math.max(...messageTimes)
    : Math.max(...stateTimes, detail.session.updated_at);
  return {
    id: messages.length > 0
      ? messages.map((message) => message.id).join(':')
      : detail.workflowController?.workflow_run_id ?? artifacts[0]?.workflow_run_id ?? detail.session.id,
    createdAt,
    updatedAt,
    messages,
    controller: includeWorkflowState ? detail.workflowController ?? null : null,
    artifacts,
    gates: includeWorkflowState ? detail.workflowGates ?? [] : [],
    assignments: includeWorkflowState ? detail.workflowAgentAssignments ?? [] : [],
  };
}

function isWorkflowTranscriptMessage(message: SessionMessage): boolean {
  const sender = `${message.sender_id} ${message.sender_name ?? ''}`.toLowerCase();
  if (sender.includes('workflow') || sender.includes('工作流')) return true;
  const metadata = parseMessageMetadata(message.metadata);
  if (metadata.workflow_run_id || metadata.workflow_step_id) return true;
  if (metadata.event_type?.startsWith('workflow_') || metadata.event_type?.startsWith('workflow-')) return true;
  const text = message.content.trim();
  return /^(子任务|产品经理检测|诊断：|决策：|恢复次数：|已决定恢复执行|等待用户确认|当前 workflow|已进入 Superpowers 工作流)/.test(text);
}

function getWorkflowChatStatus(group: WorkflowChatGroup): 'pending' | 'active' | 'blocked' | 'done' {
  if (group.controller?.blocker) return 'blocked';
  if (group.gates.some((gate) => gate.status === 'pending')) return 'active';
  if (group.messages.length > 0) return 'done';
  return group.controller || group.artifacts.length > 0 || group.assignments.length > 0 ? 'active' : 'pending';
}

function formatWorkflowChatSummary(group: WorkflowChatGroup): string {
  if (group.controller?.next_action) {
    return group.controller.next_action;
  }
  if (group.messages.length > 0) {
    return `${group.messages.length} 条工作流事件`;
  }
  return group.controller?.next_action
    ?? formatWorkflowMissionMeta(group.controller)
    ?? '等待 workflow 数据';
}

function formatWorkflowEventCount(messages: SessionMessage[]): string {
  return `${messages.length} 条工作流事件`;
}

function formatWorkflowEventLabel(message: SessionMessage): string {
  const metadata = parseMessageMetadata(message.metadata);
  if (metadata.event_type) return metadata.event_type;
  return message.sender_name ?? message.sender_id;
}

function formatWorkflowEventPreview(content: string): string {
  const normalized = content
    .replace(/^```[a-zA-Z0-9_-]*\s*/g, '')
    .replace(/```\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'workflow event recorded';
  return normalized.length > 96 ? `${normalized.slice(0, 96).trimEnd()}...` : normalized;
}

function getLatestTimelineRunId(timeline: TranscriptTimelineItem[]): string | null {
  const latest = timeline.at(-1);
  return latest?.kind === 'run' ? latest.run.id : null;
}

function getLatestTranscriptRunId(detail: SessionDetail): string | null {
  return getLatestTimelineRunId(buildTranscriptTimeline(detail));
}

interface SessionApprovalStatusSnapshot {
  status: SessionApprovalStatus;
  updatedAt: number;
}

function buildSessionApprovalStatusLookup(messages: SessionMessage[]): Map<string, SessionApprovalStatusSnapshot> {
  const statuses = new Map<string, SessionApprovalStatusSnapshot>();
  for (const message of messages) {
    const metadata = parseMessageMetadata(message.metadata);
    const approval = metadata.session_approval;
    if (!approval || !isSessionApprovalStatus(approval.status)) continue;
    const sourceMessageId = typeof approval.sourceMessageId === 'string' ? approval.sourceMessageId.trim() : '';
    if (!sourceMessageId) continue;
    const updatedAt = firstNumber(approval.decidedAt, approval.createdAt, message.created_at) ?? message.created_at;
    const current = statuses.get(sourceMessageId);
    if (!current || updatedAt >= current.updatedAt) {
      statuses.set(sourceMessageId, { status: approval.status, updatedAt });
    }
  }
  return statuses;
}

function isSessionApprovalStatus(value: unknown): value is SessionApprovalStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected';
}

function shouldRenderRiskApprovalPanel(message: SessionMessage, metadata: MessageMetadata): boolean {
  return message.role === 'system' && message.sender_id === 'risk-gate' && Boolean(metadata.approval_card);
}

function getSessionApprovalSourceMessageId(metadata: MessageMetadata, fallbackMessageId: string): string {
  const approvalSource = metadata.session_approval?.sourceMessageId;
  if (typeof approvalSource === 'string' && approvalSource.trim()) return approvalSource.trim();
  if (typeof metadata.source_message_id === 'string' && metadata.source_message_id.trim()) {
    return metadata.source_message_id.trim();
  }
  return fallbackMessageId;
}

function getEffectiveSessionApprovalStatus({
  metadata,
  fallbackMessageId,
  approvalStatusBySourceMessageId,
}: {
  metadata: MessageMetadata;
  fallbackMessageId: string;
  approvalStatusBySourceMessageId: Map<string, SessionApprovalStatusSnapshot>;
}): SessionApprovalStatus {
  const sourceMessageId = getSessionApprovalSourceMessageId(metadata, fallbackMessageId);
  const latest = approvalStatusBySourceMessageId.get(sourceMessageId)?.status;
  if (latest) return latest;
  return isSessionApprovalStatus(metadata.session_approval?.status) ? metadata.session_approval.status : 'pending';
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

function RiskApprovalMessagePanel({
  approvalCard,
  status,
  onApprove,
  onReject,
}: {
  approvalCard: ApprovalCardMetadata;
  status: SessionApprovalStatus;
  onApprove: () => void;
  onReject: () => void;
}): JSX.Element {
  const rows = buildRiskApprovalRows(approvalCard);
  return (
    <div className="deepsea-risk-approval" data-approval-status={status}>
      <div className="deepsea-risk-approval__summary">
        <span className="deepsea-risk-approval__icon" aria-hidden="true">
          <ShieldCheck />
        </span>
        <div>
          <strong>风险确认</strong>
          <span>{riskApprovalStatusLabel(status)}</span>
        </div>
      </div>
      <table className="deepsea-risk-approval__table" aria-label="风险确认详情">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="deepsea-risk-approval__actions">
        {status === 'pending' ? (
          <>
            <button
              type="button"
              className="deepsea-risk-approval__button"
              data-approval-action="approve"
              aria-label="确定执行风险任务"
              title="发送确认并启动 planner"
              onClick={onApprove}
            >
              <Check aria-hidden="true" />
              <span>确定</span>
            </button>
            <button
              type="button"
              className="deepsea-risk-approval__button"
              data-approval-action="reject"
              aria-label="取消本次风险任务"
              title="发送取消并放弃本次执行"
              onClick={onReject}
            >
              <X aria-hidden="true" />
              <span>取消</span>
            </button>
          </>
        ) : (
          <span className="deepsea-risk-approval__decision">{riskApprovalDecisionLabel(status)}</span>
        )}
      </div>
    </div>
  );
}

function buildRiskApprovalRows(approvalCard: ApprovalCardMetadata): Array<{ label: string; value: string }> {
  const verificationCommands = Array.isArray(approvalCard.verification)
    ? approvalCard.verification
      .map((item) => item?.command)
      .filter((command): command is string => typeof command === 'string' && command.trim().length > 0)
    : [];
  return [
    { label: '风险级别', value: formatRiskApprovalValue(approvalCard.riskLevel) },
    { label: '任务类型', value: formatRiskApprovalValue(approvalCard.taskKind) },
    { label: '原因', value: formatRiskApprovalValue(approvalCard.approvalReason) ?? formatRiskApprovalValue(approvalCard.summary) },
    { label: '执行方式', value: formatRiskApprovalValue(approvalCard.executionMode) },
    { label: '智能体', value: formatRiskApprovalList(approvalCard.agents) },
    { label: '读取范围', value: formatRiskApprovalList(approvalCard.scopeRead) },
    { label: '写入范围', value: formatRiskApprovalList(approvalCard.scopeWrite) },
    { label: '验证命令', value: formatRiskApprovalList(verificationCommands, '；') },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));
}

function formatRiskApprovalValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function formatRiskApprovalList(value: unknown, separator = '、'): string | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map(formatRiskApprovalValue)
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items.join(separator) : null;
}

function riskApprovalStatusLabel(status: SessionApprovalStatus): string {
  if (status === 'approved') return '已确认';
  if (status === 'rejected') return '已取消';
  return '等待确认';
}

function riskApprovalDecisionLabel(status: SessionApprovalStatus): string {
  if (status === 'approved') return '已确认执行';
  if (status === 'rejected') return '已取消执行';
  return '等待确认';
}

function TranscriptMessage({
  projectId,
  message,
  displayMode,
  onDisplayModeChange,
  onSaveKnowledge,
  savingKnowledgeKey,
  copiedActionKey,
  onCopyText,
  visualCompanionAccepted,
  onAcceptVisualCompanion,
  onOpenWorkspaceFile,
  onSubmitRiskApprovalDecision,
  approvalStatusBySourceMessageId,
}: {
  projectId: string;
  message: SessionMessage;
  displayMode: SessionMessageDisplayMode;
  onDisplayModeChange: (mode: SessionMessageDisplayMode) => void;
  onSaveKnowledge?: (input: SessionKnowledgeSaveInput) => void;
  savingKnowledgeKey?: SessionKnowledgeActionKey | null;
  copiedActionKey: string | null;
  onCopyText: (content: string, key: string) => void;
  visualCompanionAccepted: boolean;
  onAcceptVisualCompanion: () => void;
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler;
  onSubmitRiskApprovalDecision: (sourceMessageId: string, status: Exclude<SessionApprovalStatus, 'pending'>) => void;
  approvalStatusBySourceMessageId: Map<string, SessionApprovalStatusSnapshot>;
}): JSX.Element {
  const metadata = parseMessageMetadata(message.metadata);
  const imageJobId = metadata.image_generation_job_id;
  const riskApprovalSourceMessageId = shouldRenderRiskApprovalPanel(message, metadata)
    ? getSessionApprovalSourceMessageId(metadata, message.id)
    : null;
  const riskApprovalPanel = shouldRenderRiskApprovalPanel(message, metadata) && metadata.approval_card ? (
    <RiskApprovalMessagePanel
      approvalCard={metadata.approval_card}
      status={getEffectiveSessionApprovalStatus({
        metadata,
        fallbackMessageId: message.id,
        approvalStatusBySourceMessageId,
      })}
      onApprove={() => riskApprovalSourceMessageId && onSubmitRiskApprovalDecision(riskApprovalSourceMessageId, 'approved')}
      onReject={() => riskApprovalSourceMessageId && onSubmitRiskApprovalDecision(riskApprovalSourceMessageId, 'rejected')}
    />
  ) : undefined;
  const knowledgeActionKey = buildSessionKnowledgeActionKey('message', message.id);
  const copyActionKey = `copy:${knowledgeActionKey}`;
  const copied = copiedActionKey === copyActionKey;
  const savingKnowledge = savingKnowledgeKey === knowledgeActionKey;
  const canSaveKnowledge = Boolean(onSaveKnowledge && message.role === 'assistant' && message.content.trim());
  const canOpenVisualCompanion = shouldShowVisualCompanionAction({
    role: message.role,
    displayMode,
    content: message.content,
    accepted: visualCompanionAccepted,
  });
  return (
    <>
      <SessionMessageBubble
        role={message.role}
        content={message.content}
        timeLabel={formatClock(message.created_at)}
        statusLabel={message.status === 'queued' || message.status === 'streaming' ? '思考中' : null}
        roleLabel={message.sender_name ?? message.sender_id}
        attachments={metadata.attachments}
        displayMode={displayMode}
        onDisplayModeChange={onDisplayModeChange}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        structuredContent={riskApprovalPanel}
        actions={(
          <>
            <button
              type="button"
              className="deepsea-message__action"
              data-action="copy"
              data-state={copied ? 'copied' : undefined}
              aria-label="复制消息内容"
              onClick={() => onCopyText(message.content, copyActionKey)}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
            {canSaveKnowledge ? (
              <button
                type="button"
                className="deepsea-message__action"
                data-action="knowledge"
                data-state={savingKnowledge ? 'saving' : undefined}
                aria-label="保存消息为知识"
                disabled={savingKnowledge}
                onClick={() => onSaveKnowledge?.({ kind: 'message', key: knowledgeActionKey, message })}
              >
                <BookOpen aria-hidden="true" />
                <span>{savingKnowledge ? '保存中' : '保存为知识'}</span>
              </button>
            ) : null}
            {canOpenVisualCompanion ? (
              <button
                type="button"
                className="deepsea-message__action"
                data-action="visual-companion"
                data-acceptance-message={VISUAL_COMPANION_ACCEPTANCE_MESSAGE}
                aria-label="打开设计预览"
                onClick={onAcceptVisualCompanion}
              >
                <SquarePen aria-hidden="true" />
                <span>打开设计预览</span>
              </button>
            ) : null}
          </>
        )}
      />
      {imageJobId && <ImageJobStatusCard projectId={projectId} jobId={imageJobId} />}
    </>
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
  | { type: 'text'; id: string; text: string; events: SessionRunTranscriptEvent[] }
  | ({ type: 'event' } & SessionRunTranscriptEvent);

export interface SessionRunTranscriptEvent {
  id: string;
  label: string;
  detail: string | null;
  created_at: number;
  event_type: string;
  channel: SessionAgentEvent['channel'];
  content: string;
  payloadJson: string | null;
}

type RunEventKind = 'context' | 'tool' | 'edit' | 'verify' | 'error' | 'done' | 'activity';

interface RunEventRailItem {
  id: string;
  kind: RunEventKind;
  label: string;
  detail: string;
  count: number;
  events: SessionRunTranscriptEvent[];
}

function RunFlowCapsule({
  run,
  runLabel,
  runAgentEvents,
  runEvidence,
  failureDetails,
  output,
  displayMode,
  streaming,
  now,
  latestTranscriptRunId,
  onRetryRun,
  onOpenWorkspaceFile,
  actions,
}: {
  run: SessionRun;
  runLabel: string;
  runAgentEvents: SessionAgentEvent[];
  runEvidence: SessionEvidenceEvent[];
  failureDetails: RunFailureDetail[];
  output: string;
  displayMode: SessionMessageDisplayMode;
  streaming: boolean;
  now: number;
  latestTranscriptRunId: string | null;
  onRetryRun?: (runId: string) => void;
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler;
  actions: ReactNode;
}): JSX.Element {
  const railItems = buildRunEventRailItems(runAgentEvents);
  return (
    <section className="deepsea-run-log deepsea-run-capsule" data-run-flow-capsule="true" aria-label={`${runLabel} 执行流`}>
      <header className="deepsea-run-capsule__header">
        <div className="deepsea-run-capsule__identity">
          <span className="deepsea-run-capsule__avatar" aria-hidden="true">{formatRunAvatarLabel(runLabel)}</span>
          <div>
            <strong title={runLabel}>{runLabel}</strong>
            <span>{run.phase ?? run.mode} · {run.provider}</span>
          </div>
        </div>
        <div className="deepsea-run-capsule__status">
          <time className="deepsea-mono">{formatClock(run.started_at)}</time>
          <ThinkingDurationBadge run={run} agentEvents={runAgentEvents} now={now} />
          <RunStatusBadge
            run={run}
            agentEvents={runAgentEvents}
            onRetryRun={latestTranscriptRunId === run.id ? onRetryRun : undefined}
          />
        </div>
        <div className="deepsea-message-tools deepsea-message-tools--run">{actions}</div>
      </header>
      <div className="deepsea-run-dynamic-monitor" data-run-dynamic-monitor="true">
        <div className="deepsea-run-dynamic-monitor__header">
          <span>执行链路</span>
          <strong>实时活动</strong>
        </div>
        <RunStateStream
          status={getRunFlowStatus(run.status)}
          summary={formatRunFlowSummary(run)}
          cards={buildRunFlowCards(run, runAgentEvents, failureDetails)}
        />
        <div className="deepsea-run-log-mode" aria-label="Run 日志视图">
          <strong>{railItems.length} groups</strong>
          <span>日志已在下方执行事件与消息流中展开。</span>
        </div>
      </div>
      <AgentThoughtPanel
        run={run}
        evidence={runEvidence}
        agentEvents={runAgentEvents}
        failureDetails={failureDetails}
      />
      <div className="deepsea-run-capsule__body">
        <RunEventRail items={railItems} />
        <div className="deepsea-run-log-body">
          {displayMode === 'source' ? (
            <MessageContent content={output} mode={displayMode} suppressTraceEvents />
          ) : (
            <SessionRunTimeline
              events={runAgentEvents}
              fallbackText={output}
              streaming={streaming}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          )}
        </div>
      </div>
      <GeneratedImageEvidencePanel evidence={runEvidence} />
    </section>
  );
}

function RunStateStream({
  status,
  summary,
  cards,
}: {
  status: 'pending' | 'active' | 'blocked' | 'done';
  summary: string;
  cards: WorkflowFlowCard[];
}): JSX.Element {
  return (
    <div className="deepsea-run-state-stream" aria-label="Agent run 内部流转">
      <div className="deepsea-workflow-state-stream__head">
        <span>{summary}</span>
        <strong>{formatWorkflowFlowStatus(status)}</strong>
      </div>
      <div className="deepsea-workflow-state-stream__steps">
        {cards.map((card, index) => (
          <WorkflowChatStateStep key={`${card.title}:${card.detail}`} card={card} index={index} />
        ))}
      </div>
    </div>
  );
}

function buildRunFlowCards(
  run: SessionRun,
  events: SessionAgentEvent[],
  failureDetails: RunFailureDetail[],
): WorkflowFlowCard[] {
  return [
    {
      icon: FileText,
      tone: 'event',
      title: 'stdout',
      status: formatRunFlowCardStatus(run.status),
      detail: formatRunFlowOutputDetail(run),
      progress: getRunFlowProgress(run.status, run.stdout.trim().length > 0),
    },
    {
      icon: MessageSquare,
      tone: 'event',
      title: 'events',
      status: `${events.length} events`,
      detail: formatRunFlowEventDetail(events),
      progress: events.length > 0 ? 68 : 18,
    },
    {
      icon: CheckCircle2,
      tone: 'gate',
      title: 'checks',
      status: failureDetails.length > 0 ? 'Review' : 'Pass',
      detail: formatRunFailureFlowDetail(failureDetails),
      progress: failureDetails.length > 0 ? 45 : 92,
    },
  ];
}

function getRunFlowStatus(status: SessionRun['status']): 'pending' | 'active' | 'blocked' | 'done' {
  if (status === 'failed' || status === 'interrupted') return 'blocked';
  if (status === 'completed') return 'done';
  if (status === 'running' || status === 'retrying') return 'active';
  return 'pending';
}

function formatRunFlowSummary(run: SessionRun): string {
  if (run.status === 'failed') return run.error?.trim() || run.stderr.trim() || '执行失败，等待处理。';
  if (run.status === 'interrupted') return '执行已中断，等待恢复。';
  if (run.status === 'cancelled') return '运行已取消。';
  if (run.status === 'paused') return '运行已暂停。';
  if (run.status === 'completed') return run.stdout.trim() ? '已生成 agent 输出，详见下方消息流。' : '执行已完成，暂无输出。';
  if (run.status === 'queued') return '等待调度执行。';
  return run.activity_log.trim() || 'Agent 正在执行任务流。';
}

function formatRunFlowCardStatus(status: SessionRun['status']): string {
  if (status === 'completed') return 'Done';
  if (status === 'failed' || status === 'interrupted') return 'Blocked';
  if (status === 'paused') return 'Paused';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'queued') return 'Queued';
  if (status === 'retrying') return 'Retrying';
  return 'Coding';
}

function formatRunFlowOutputDetail(run: SessionRun): string {
  if (run.stdout.trim()) return '输出已流入消息时间线';
  if (run.stderr.trim()) return 'stderr 已记录';
  if (run.status === 'completed') return '暂无可展示输出';
  if (run.status === 'failed') return '失败原因待处理';
  if (run.status === 'cancelled') return '运行已取消';
  if (run.status === 'paused') return '运行已暂停';
  if (run.status === 'interrupted') return '运行已中断';
  return '等待首个输出片段';
}

function formatRunFlowEventDetail(events: SessionAgentEvent[]): string {
  const event = events[0];
  if (!event) return '等待事件流';
  if (event.event_type === 'tool_call') return '工具调用已进入执行轨道';
  if (event.channel === 'answer') return '回答片段正在汇入时间线';
  if (event.channel === 'thinking') return '思考过程已记录';
  return event.content.trim() || '事件流已接入';
}

function formatRunFailureFlowDetail(failureDetails: RunFailureDetail[]): string {
  const failure = failureDetails[0];
  if (!failure) return '执行检查通过';
  const text = failure.text.trim();
  if (!text) return `${failure.label} 待处理`;
  return text.length > 32 ? `${text.slice(0, 32)}...` : text;
}

function getRunFlowProgress(status: SessionRun['status'], hasOutput: boolean): number {
  if (status === 'completed') return 100;
  if (status === 'failed' || status === 'interrupted') return hasOutput ? 62 : 48;
  if (status === 'cancelled') return 36;
  if (status === 'paused') return 52;
  if (status === 'queued') return 16;
  if (status === 'retrying') return 64;
  return hasOutput ? 78 : 58;
}

function RunEventRail({ items }: { items: RunEventRailItem[] }): JSX.Element | null {
  const [selectedEvents, setSelectedEvents] = useState<SessionRunTranscriptEvent[] | null>(null);
  if (items.length === 0) return null;
  return (
    <aside className="deepsea-run-event-rail" data-run-event-rail="true" aria-label="关键执行事件">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="deepsea-run-event-rail__item"
          data-kind={item.kind}
          onClick={() => setSelectedEvents(item.events)}
        >
          <strong>{item.label}{item.count > 1 ? ` x${item.count}` : ''}</strong>
          <span title={item.detail}>{item.detail}</span>
        </button>
      ))}
      {selectedEvents ? <SessionRunEventDetailDialog events={selectedEvents} onClose={() => setSelectedEvents(null)} /> : null}
    </aside>
  );
}

function buildRunEventRailItems(events: SessionAgentEvent[]): RunEventRailItem[] {
  const grouped = new Map<RunEventKind, RunEventRailItem>();
  for (const sourceEvent of [...events].sort((left, right) => left.seq - right.seq || left.created_at - right.created_at)) {
    const marker = runEventMarker(sourceEvent);
    if (!marker) continue;
    const event = buildSessionRunTranscriptEvent(sourceEvent, marker);
    const kind = inferRunEventKind(event);
    const current = grouped.get(kind);
    if (current) {
      current.count += 1;
      current.events.push(event);
      if (!current.detail && event.detail) current.detail = event.detail;
      continue;
    }
    grouped.set(kind, {
      id: `${kind}:${event.id}`,
      kind,
      label: formatRunEventKindLabel(kind),
      detail: formatRunEventRailDetail(event),
      count: 1,
      events: [event],
    });
  }
  return Array.from(grouped.values());
}

function inferRunEventKind(event: SessionRunTranscriptEvent): RunEventKind {
  const haystack = `${event.event_type} ${event.label} ${event.content} ${event.detail ?? ''}`.toLowerCase();
  if (haystack.includes('error') || haystack.includes('failed') || haystack.includes('fatal')) return 'error';
  if (haystack.includes('verify') || haystack.includes('test') || haystack.includes('build') || haystack.includes('检查')) return 'verify';
  if (haystack.includes('edit') || haystack.includes('patch') || haystack.includes('write') || haystack.includes('修改')) return 'edit';
  if (haystack.includes('tool') || haystack.includes('command') || haystack.includes('call')) return 'tool';
  if (haystack.includes('context') || haystack.includes('read') || haystack.includes('search') || haystack.includes('读取')) return 'context';
  if (haystack.includes('done') || haystack.includes('complete') || haystack.includes('完成')) return 'done';
  return 'activity';
}

function formatRunEventKindLabel(kind: RunEventKind): string {
  if (kind === 'context') return 'Context';
  if (kind === 'tool') return 'Tool';
  if (kind === 'edit') return 'Edit';
  if (kind === 'verify') return 'Verify';
  if (kind === 'error') return 'Error';
  if (kind === 'done') return 'Done';
  return 'Activity';
}

function formatRunEventRailDetail(event: SessionRunTranscriptEvent): string {
  const detail = event.detail?.trim() || event.content.trim() || event.label;
  return detail.slice(0, 96);
}

function formatRunAvatarLabel(runLabel: string): string {
  const trimmed = runLabel.trim();
  return (trimmed[0] ?? 'A').toUpperCase();
}

function SessionRunTimeline({
  events,
  fallbackText,
  streaming,
  onOpenWorkspaceFile,
}: {
  events: SessionAgentEvent[];
  fallbackText: string;
  streaming: boolean;
  onOpenWorkspaceFile?: WorkspaceFileOpenHandler;
}): JSX.Element {
  const items = buildSessionRunTranscriptItems(events, fallbackText);
  const lastTextItemId = [...items].reverse().find((item) => item.type === 'text')?.id ?? null;
  const [selectedEvents, setSelectedEvents] = useState<SessionRunTranscriptEvent[] | null>(null);
  return (
    <div className="deepsea-run-timeline">
      {items.map((item) => item.type === 'text' ? (
        <div key={item.id} className="deepsea-run-timeline__text">
          <MessageContent
            content={item.text}
            mode="preview"
            streaming={streaming && item.id === lastTextItemId}
            suppressTraceEvents
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            inlineSuffix={item.events.length > 0 ? (
              <button
                type="button"
                className="deepsea-run-timeline__details-button"
                aria-label="查看本段调用详情"
                title={`查看本段调用详情：${item.events.map((event) => event.label).join(' / ')}`}
                data-event-labels={item.events.map((event) => event.label).join(' / ')}
                onClick={() => setSelectedEvents(item.events)}
              >
                <Info aria-hidden="true" />
              </button>
            ) : undefined}
          />
        </div>
      ) : (
        <div key={item.id} className="deepsea-run-timeline__event">
          <span>[{item.label}]</span>
          {item.detail && <small>{item.detail}</small>}
        </div>
      ))}
      {selectedEvents ? (
        <SessionRunEventDetailDialog events={selectedEvents} onClose={() => setSelectedEvents(null)} />
      ) : null}
    </div>
  );
}

function WorkspaceDocumentPreviewDialog({
  projectId,
  path,
  onOpenChange,
}: {
  projectId: string;
  path: string | null;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const {
    data,
    error,
    isError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['workspace-message-file-preview', projectId, path],
    queryFn: () => api.getWorkspaceFilePreview(projectId, path!),
    enabled: Boolean(path),
    retry: false,
  });

  return (
    <Dialog open={Boolean(path)} onOpenChange={onOpenChange}>
      <DialogContent className="deepsea-workspace-doc-preview" title={path ?? '文件预览'}>
        {!path ? null : isLoading ? (
          <WorkspaceDocumentPreviewState>正在加载文档...</WorkspaceDocumentPreviewState>
        ) : isError ? (
          <WorkspaceDocumentPreviewState>
            <strong>文档无法预览</strong>
            <span>{error instanceof Error ? error.message : '读取文件失败'}</span>
            <button type="button" onClick={() => void refetch()}>
              <RefreshCcw aria-hidden="true" />
              重试
            </button>
          </WorkspaceDocumentPreviewState>
        ) : data ? (
          <WorkspaceDocumentPreviewContent preview={data} />
        ) : (
          <WorkspaceDocumentPreviewState>没有文件内容。</WorkspaceDocumentPreviewState>
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceDocumentPreviewContent({ preview }: { preview: WorkspaceFilePreview }): JSX.Element {
  return (
    <div className="deepsea-workspace-doc-preview__body">
      <div className="deepsea-workspace-doc-preview__meta">
        <span>{preview.path}</span>
        {preview.truncated ? <strong>已截断</strong> : null}
      </div>
      {isMarkdownWorkspacePreview(preview) ? (
        <div className="deepsea-workspace-doc-preview__markdown">
          <MarkdownPreview content={preview.content} />
        </div>
      ) : (
        <pre className="deepsea-workspace-doc-preview__code"><code>{preview.content}</code></pre>
      )}
    </div>
  );
}

function WorkspaceDocumentPreviewState({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="deepsea-file-viewer-state">{children}</div>;
}

function isMarkdownWorkspacePreview(preview: WorkspaceFilePreview): boolean {
  return preview.path.endsWith('.md') || preview.path.endsWith('.mdx') || preview.language === 'markdown';
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
    items.push({ type: 'text', id: `text-${textIndex}`, text, events: [] });
    textIndex += 1;
  };

  const appendMarker = (event: SessionAgentEvent, marker: { label: string; detail: string | null }) => {
    flushText();
    const transcriptEvent = buildSessionRunTranscriptEvent(event, marker);
    const previousText = [...items].reverse().find((item) => item.type === 'text');
    if (previousText?.type === 'text') {
      previousText.events.push(transcriptEvent);
      return;
    }
    items.push({ type: 'event', ...transcriptEvent });
  };

  for (const event of sortedEvents) {
    if (isAnswerTextEvent(event)) {
      textBuffer += event.content;
      continue;
    }
    const marker = runEventMarker(event);
    if (marker) {
      appendMarker(event, marker);
    }
  }

  flushText();
  if (items.length === 0) {
    const text = fallbackText.trim();
    return text ? [{ type: 'text', id: 'text-fallback', text, events: [] }] : [];
  }
  if (!items.some((item) => item.type === 'text')) {
    const text = fallbackText.trim();
    if (text) items.push({ type: 'text', id: 'text-fallback', text, events: [] });
  }
  return items;
}

function buildSessionRunTranscriptEvent(
  event: SessionAgentEvent,
  marker: { label: string; detail: string | null },
): SessionRunTranscriptEvent {
  return {
    id: event.id,
    label: marker.label,
    detail: marker.detail,
    created_at: event.created_at,
    event_type: event.event_type,
    channel: event.channel,
    content: event.content,
    payloadJson: event.payload_json,
  };
}

function isAnswerTextEvent(event: SessionAgentEvent): boolean {
  return event.channel === 'answer' &&
    event.content.length > 0;
}

function firstAnswerEvent(events: SessionAgentEvent[]): SessionAgentEvent | null {
  return [...events]
    .filter(isAnswerTextEvent)
    .sort((left, right) => left.created_at - right.created_at || left.seq - right.seq)[0] ?? null;
}

function runEventMarker(event: SessionAgentEvent): { label: string; detail: string | null } | null {
  if (event.channel === 'command' || event.event_type === 'command' || event.event_type === 'command_output') {
    return { label: 'Run Command', detail: eventCommandDetail(event) };
  }

  if (/file_diff|patch/i.test(event.event_type)) {
    return { label: 'Patch', detail: eventCommandDetail(event) };
  }

  if (/plan_update|update_plan/i.test(event.event_type)) {
    return { label: 'Update Plan', detail: eventCommandDetail(event) };
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

function SessionRunEventDetailDialog({
  events,
  onClose,
}: {
  events: SessionRunTranscriptEvent[];
  onClose: () => void;
}): React.ReactPortal | JSX.Element | null {
  const [selectedEventId, setSelectedEventId] = useState(events[0]?.id ?? null);
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0] ?? null;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!selectedEvent) return null;

  const payload = formatAgentEventPayloadJson(selectedEvent.payloadJson);
  const eventDetail = selectedEvent.detail ?? trimTimelineDetail(selectedEvent.content);

  const dialog = (
    <div className="deepsea-tool-detail-overlay deepsea-run-event-dialog-overlay" onClick={onClose}>
      <div
        className="deepsea-tool-detail-dialog deepsea-run-event-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="调用事件详情"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="deepsea-tool-detail-dialog__header">
          <div>
            <span>期间 {events.length} 个调用</span>
            <h3>{selectedEvent.label}</h3>
          </div>
          <button type="button" aria-label="关闭调用事件详情" onClick={onClose} autoFocus>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="deepsea-run-event-dialog__body">
          <div className="deepsea-run-event-dialog__list" aria-label="调用事件列表">
            {events.map((event, index) => (
              <button
                type="button"
                key={event.id}
                data-active={event.id === selectedEvent.id}
                onClick={() => setSelectedEventId(event.id)}
              >
                <span>{index + 1}</span>
                <strong>{event.label}</strong>
                {event.detail ? <small>{event.detail}</small> : null}
              </button>
            ))}
          </div>
          <div className="deepsea-run-event-dialog__detail">
            <div className="deepsea-tool-detail-dialog__execution">
              <span>事件摘要</span>
              {eventDetail ? <pre>{eventDetail}</pre> : <p>暂无事件摘要</p>}
            </div>
            {payload ? (
              <div className="deepsea-tool-detail-dialog__execution">
                <span>原始 Payload</span>
                <pre>{payload}</pre>
              </div>
            ) : null}
            <dl className="deepsea-tool-detail-grid">
              <div>
                <dt>类型</dt>
                <dd>{selectedEvent.event_type}</dd>
              </div>
              <div>
                <dt>通道</dt>
                <dd>{selectedEvent.channel}</dd>
              </div>
              <div>
                <dt>Event ID</dt>
                <dd>{selectedEvent.id}</dd>
              </div>
              <div>
                <dt>记录时间</dt>
                <dd>{formatToolTimestamp(selectedEvent.created_at)}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}

function formatAgentEventPayloadJson(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  const payload = parseAgentEventPayload(payloadJson);
  if (payload === null) return payloadJson;
  return JSON.stringify(payload, null, 2);
}

function ThinkingDurationBadge({
  run,
  agentEvents,
  now,
}: {
  run: SessionRun;
  agentEvents: SessionAgentEvent[];
  now: number;
}): JSX.Element | null {
  const duration = getSessionRunThinkingDuration(run, agentEvents, now);
  if (!duration) return null;
  return (
    <span className="deepsea-thinking-duration" data-active={duration.active ? 'true' : 'false'}>
      <Timer aria-hidden="true" />
      {duration.label}
    </span>
  );
}

function RunStatusBadge({
  run,
  agentEvents = [],
  onRetryRun,
}: {
  run: SessionRun;
  agentEvents?: SessionAgentEvent[];
  onRetryRun?: (runId: string) => void;
}): JSX.Element {
  const view = sessionRunStatusView(run, agentEvents);
  const retryLabel = runStatusRetryLabel(run, view);
  return (
    <span className="deepsea-run-status-group">
      <span className="deepsea-run-status" data-tone={view.tone} title={view.title}>
        {view.label}
      </span>
      {retryLabel && onRetryRun && (
        <button
          type="button"
          className="deepsea-run-status-retry"
          aria-label={retryLabel}
          onClick={() => onRetryRun?.(run.id)}
        >
          <Repeat2 aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

type RunStatusTone = 'ok' | 'warn' | 'danger' | 'muted';
type RunStatusViewModel = { label: string; tone: RunStatusTone; title?: string; retryLabel?: string };

function sessionRunStatusView(run: SessionRun, agentEvents: SessionAgentEvent[] = []): RunStatusViewModel {
  const interruptDiagnostic = runCompletionInterruptDiagnostic(run, agentEvents);
  if (interruptDiagnostic) return { label: '收尾中断', tone: 'warn', title: interruptDiagnostic, retryLabel: '重新收尾' };
  return runStatusView(run.status);
}

function runStatusView(status: SessionRun['status']): RunStatusViewModel {
  if (status === 'failed' || status === 'interrupted') return { label: '失败', tone: 'danger' };
  if (status === 'completed') return { label: '完成', tone: 'ok' };
  if (status === 'paused') return { label: '已暂停', tone: 'muted' };
  if (status === 'cancelled') return { label: '已取消', tone: 'muted' };
  return { label: '运行中', tone: 'warn' };
}

function failedRunRetryLabel(run: SessionRun): string {
  return run.stdout.trim() ? '继续失败回复' : '重试失败运行';
}

function runStatusRetryLabel(run: SessionRun, view: RunStatusViewModel): string | null {
  if (view.retryLabel) return view.retryLabel;
  if (run.status === 'failed' || run.status === 'interrupted') return failedRunRetryLabel(run);
  return null;
}

function RunStatusIcon({ tone }: { tone: RunStatusTone }): JSX.Element {
  if (tone === 'ok') return <CheckCircle2 aria-hidden="true" />;
  if (tone === 'warn') return <Ellipsis aria-hidden="true" />;
  if (tone === 'danger') return <X aria-hidden="true" />;
  return <Square aria-hidden="true" />;
}

interface RunFailureDetail {
  label: 'error' | 'stderr' | 'diagnostic';
  text: string;
}

function RunFailureDetails({ details }: { details: RunFailureDetail[] }): JSX.Element | null {
  if (details.length === 0) return null;
  return (
    <details className="deepsea-run-error-details">
      <summary>
        <X aria-hidden="true" />
        <span>错误详情</span>
      </summary>
      <div>
        {details.map((detail) => (
          <section key={detail.label}>
            <span>{detail.label}</span>
            <pre>{detail.text}</pre>
          </section>
        ))}
      </div>
    </details>
  );
}

function AgentThoughtPanel({
  run,
  evidence,
  agentEvents,
  failureDetails,
}: {
  run: SessionRun;
  evidence: SessionEvidenceEvent[];
  agentEvents: SessionAgentEvent[];
  failureDetails: RunFailureDetail[];
}): JSX.Element | null {
  const thought = agentThoughtText(run, evidence, agentEvents);
  const defaultOpen = isRunThoughtOpenByDefault(run.status);
  const [openState, setOpenState] = useState(() => ({
    runId: run.id,
    status: run.status,
    open: defaultOpen,
  }));
  const open = openState.runId === run.id && openState.status === run.status ? openState.open : defaultOpen;

  if (!thought && failureDetails.length === 0) return null;
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
      {thought ? <p>{thought}</p> : null}
      <RunFailureDetails details={failureDetails} />
    </details>
  );
}

function isRunThoughtOpenByDefault(status: SessionRun['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'retrying' || status === 'paused';
}

function DeepseaComposer({
  projectId,
  sessionId,
  onSendMessage,
}: {
  projectId: string;
  sessionId: string;
  onSendMessage: (message: SessionComposerSubmit) => void;
}): JSX.Element {
  return <SessionFileComposer projectId={projectId} sessionId={sessionId} onSendMessage={onSendMessage} />;
}

function IntegratedInspector({
  payload,
  activeRun,
  latestTranscriptRunId,
  onCommand,
  onCancelRun,
  onRetryRun,
  onSaveContract,
  onApproveWorkflowArtifact,
}: {
  payload: SessionWorkspacePayload;
  activeRun: SessionRun | null;
  latestTranscriptRunId: string | null;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
  onApproveWorkflowArtifact?: (artifactVersionId: string) => void;
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
        <WorkflowInspectorModule
          controller={payload.activeSession.workflowController ?? null}
          artifacts={payload.activeSession.workflowArtifacts ?? []}
          gates={payload.activeSession.workflowGates ?? []}
          onApprove={onApproveWorkflowArtifact}
        />
        <ContractModule contract={payload.contract} onSaveContract={onSaveContract} />
        <PlanModule items={payload.activeSession.planItems} />
        <RunModule
          run={activeRun}
          latestTranscriptRunId={latestTranscriptRunId}
          agentEvents={activeRun ? payload.activeSession.agentEvents.filter((event) => event.run_id === activeRun.id) : []}
          onCancelRun={onCancelRun}
          onRetryRun={onRetryRun}
        />
        <ToolsModule rows={payload.toolRows} />
        <DiffModule rows={payload.diffRows} onCommand={onCommand} />
      </div>
    </aside>
  );
}

function WorkflowInspectorModule({
  controller,
  artifacts,
  gates,
  onApprove,
}: {
  controller?: WorkflowControllerView | null;
  artifacts: WorkflowArtifactVersionView[];
  gates: WorkflowGateView[];
  onApprove?: (artifactVersionId: string) => void;
}): JSX.Element | null {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const pendingGate = gates.find((gate) => gate.status === 'pending' && gate.artifact_version_id);
  const pendingArtifact = pendingGate?.artifact_version_id
    ? artifactById.get(pendingGate.artifact_version_id)
    : undefined;
  if (!controller && !pendingGate) return null;
  const status = getWorkflowInspectorStatus(controller ?? null, Boolean(pendingGate));

  return (
    <section
      className="deepsea-glass-card deepsea-workflow-inspector"
      data-workflow-inspector="true"
      data-state={status.tone}
    >
      <div className="deepsea-module-title">
        <h3>
          <ShieldCheck aria-hidden="true" />
          Workflow 状态
        </h3>
        <span>{status.label}</span>
      </div>
      <div className="deepsea-workflow-inspector__body">
        <div>
          <span>状态</span>
          <p>{status.description}</p>
        </div>
        {controller ? (
          <div>
            <span>阶段</span>
            <p>{controller.active_stage ?? 'pending'} · {controller.controller ?? 'planner'}</p>
          </div>
        ) : null}
        {pendingGate && pendingArtifact ? (
          <div className="deepsea-workflow-inspector__approval">
            <span>{pendingGate.reason}</span>
            <button
              type="button"
              data-workflow-artifact-action="approve"
              aria-label={`确认 ${pendingArtifact.artifact_type} v${pendingArtifact.version}`}
              disabled={!onApprove}
              onClick={() => onApprove?.(pendingArtifact.id)}
            >
              <Check aria-hidden="true" />
              确认 {formatWorkflowArtifactType(pendingArtifact.artifact_type)}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function getWorkflowInspectorStatus(
  controller: WorkflowControllerView | null,
  hasPendingGate: boolean,
): { label: string; description: string; tone: 'running' | 'waiting' | 'blocked' | 'idle' } {
  if (hasPendingGate) {
    return {
      label: '等待确认',
      description: '等待用户确认 workflow artifact，确认后任务会继续执行。',
      tone: 'waiting',
    };
  }
  if (!controller) {
    return {
      label: '空闲',
      description: '暂无运行中的工作流。',
      tone: 'idle',
    };
  }
  if (controller.blocker) {
    return {
      label: '已阻塞',
      description: controller.next_action ?? controller.blocker,
      tone: 'blocked',
    };
  }
  if (controller.controller === 'user') {
    return {
      label: '等待用户',
      description: controller.next_action ?? '等待用户确认后继续。',
      tone: 'waiting',
    };
  }
  return {
    label: '运行中',
    description: controller.next_action ?? 'Workflow 正在执行，等待下一条运行事件或阶段更新。',
    tone: 'running',
  };
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
          <span>原因 (Reason)</span>
          <p>{contract.reason ?? '未记录原因'}</p>
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
  latestTranscriptRunId,
  agentEvents,
  onCancelRun,
  onRetryRun,
}: {
  run: SessionRun | null;
  latestTranscriptRunId: string | null;
  agentEvents?: SessionAgentEvent[];
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
  const status = sessionRunStatusView(run, agentEvents ?? []);
  const cancellable = run.status === 'queued' || run.status === 'running' || run.status === 'retrying';
  const failureText = runFailureText(run, agentEvents);
  const retryLabel = latestTranscriptRunId === run.id ? runStatusRetryLabel(run, status) : null;
  return (
    <section className="deepsea-inspector-section deepsea-run-section">
      <div className="deepsea-module-title">
        <h3>代理运行 (Active Run)</h3>
        <span>1 条记录</span>
      </div>
      <div className="deepsea-run-table">
        <div data-tone={status.tone} title={status.title}>
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
            {retryLabel && onRetryRun && (
              <button
                type="button"
                className="deepsea-run-row-retry-action"
                aria-label={retryLabel}
                onClick={() => onRetryRun(run.id)}
              >
                <Repeat2 aria-hidden="true" />
                <span>{retryLabel}</span>
              </button>
            )}
          </div>
          {failureText && <p className="deepsea-run-row-error" title={failureText}>{failureText}</p>}
        </div>
      </div>
    </section>
  );
}

function isRunLive(status: SessionRun['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'retrying';
}

function runOutputText(run: SessionRun): string {
  if (run.status === 'failed') {
    const output = run.stdout.trim();
    if (output) return output;
    return '运行失败，暂无回复内容。';
  }
  const output = run.stdout.trim() || run.stderr.trim();
  if (output) return output;
  if (run.status === 'completed') return '未返回可展示回复。';
  if (run.status === 'cancelled') return '运行已取消。';
  if (run.status === 'paused') return '运行已暂停。';
  if (run.status === 'interrupted') return '运行已中断。';
  return '等待智能体输出...';
}

function runFailureText(run: SessionRun, events: SessionAgentEvent[] = []): string | null {
  if (run.status !== 'failed') return null;
  const reason = run.error?.trim() || run.stderr.trim();
  if (reason) return reason;
  return failureDiagnosticFromAgentEvents(events);
}

function runFailureDetails(run: SessionRun, events: SessionAgentEvent[] = []): RunFailureDetail[] {
  if (run.status !== 'failed') return [];
  const details: RunFailureDetail[] = [];
  const error = run.error?.trim();
  const stderr = run.stderr.trim();
  if (error) details.push({ label: 'error', text: error });
  if (stderr && stderr !== error) details.push({ label: 'stderr', text: stderr });
  if (details.length === 0) {
    const diagnostic = failureDiagnosticFromAgentEvents(events);
    if (diagnostic) details.push({ label: 'diagnostic', text: diagnostic });
  }
  return details;
}

function runCompletionInterruptDiagnostic(run: SessionRun, events: SessionAgentEvent[]): string | null {
  if (run.status !== 'completed') return null;
  if (!run.stdout.trim()) return null;
  const completedSeq = [...events].reverse().find((event) => event.event_type === 'run_completed')?.seq ?? null;
  for (const event of [...events].reverse()) {
    if (completedSeq !== null && event.seq <= completedSeq) continue;
    if (completedSeq === null && run.completed_at !== null && event.created_at < run.completed_at) continue;
    const diagnostic = failureDiagnosticFromPayload(parseAgentEventPayload(event.payload_json)) ??
      normalizeFailureDiagnostic(event.content, false);
    if (looksLikeProviderInterruptDiagnostic(diagnostic)) return cleanRunStatusDiagnostic(diagnostic);
    const content = event.content.trim();
    if (looksLikeProviderInterruptDiagnostic(content)) return cleanRunStatusDiagnostic(content);
  }
  return null;
}

function looksLikeProviderInterruptDiagnostic(text: string | null | undefined): text is string {
  return Boolean(text && /(Unhandled error during turn|exceeded retry limit|Too Many Requests|429\b|rate limit|quota exceeded)/i.test(text));
}

function cleanRunStatusDiagnostic(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
}

function failureDiagnosticFromAgentEvents(events: SessionAgentEvent[]): string | null {
  for (const event of [...events].reverse()) {
    const diagnostic = failureDiagnosticFromPayload(parseAgentEventPayload(event.payload_json)) ??
      normalizeFailureDiagnostic(event.content, false);
    if (diagnostic) return diagnostic;
  }
  return null;
}

function failureDiagnosticFromPayload(payload: unknown): string | null {
  const rawOutput = asRecord(readNestedValue(payload, ['rawEvent', 'params', 'update', 'rawOutput'])) ??
    asRecord(readNestedValue(payload, ['rawEvent', 'params', 'update', 'output'])) ??
    asRecord(readNestedValue(payload, ['rawOutput'])) ??
    asRecord(readNestedValue(payload, ['output']));
  const exitCode = firstNumber(rawOutput?.exit_code, rawOutput?.exitCode);
  const status = firstString(
    readNestedValue(payload, ['rawEvent', 'params', 'update', 'status']),
    rawOutput?.status,
  );
  const text = firstString(
    rawOutput?.stderr,
    rawOutput?.error,
    rawOutput?.output,
    rawOutput?.aggregated_output,
    rawOutput?.formatted_output,
    extractContentText(readNestedValue(payload, ['rawEvent', 'params', 'update', 'content'])),
    extractContentText(readNestedValue(payload, ['content'])),
  );
  const failed = (exitCode !== null && exitCode !== 0) ||
    status === 'failed' ||
    status === 'error' ||
    looksLikeFailureDiagnostic(text);
  return normalizeFailureDiagnostic(text, failed);
}

function extractContentText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractContentText(item))
      .filter((part): part is string => Boolean(part?.trim()));
    return parts.join('\n').trim() || null;
  }
  const item = asRecord(value);
  if (!item) return null;
  return firstString(
    item.text,
    asRecord(item.content)?.text,
    extractContentText(item.content),
    extractContentText(item.output),
  );
}

function normalizeFailureDiagnostic(text: string | null | undefined, failed: boolean): string | null {
  if (!text?.trim()) return null;
  if (!failed && !looksLikeFailureDiagnostic(text)) return null;
  const stripped = text
    .trim()
    .replace(/^```[A-Za-z0-9_-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  return stripped.length > 4000 ? `${stripped.slice(0, 4000).trimEnd()}\n\n[已截断]` : stripped;
}

function looksLikeFailureDiagnostic(text: string | null | undefined): boolean {
  return Boolean(text && /(Error:|Unhandled|Exception|failed|failure|EPERM|EACCES|ENOENT|operation not permitted|exit code [1-9])/i.test(text));
}

function readNestedValue(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const key of path) {
    const current = asRecord(cursor);
    if (!current) return null;
    cursor = current[key];
  }
  return cursor;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function runThoughtStatusLabel(status: SessionRun['status']): string {
  if (status === 'failed' || status === 'interrupted') return 'RISK';
  if (status === 'completed') return 'VERIFIED';
  if (status === 'cancelled') return 'CANCELLED';
  if (status === 'paused') return 'PAUSED';
  return 'RUNNING';
}

export function getSessionRunThinkingDuration(
  run: Pick<SessionRun, 'status' | 'started_at' | 'updated_at' | 'completed_at'> &
    Partial<Pick<SessionRun, 'stdout' | 'stderr'>>,
  agentEvents: SessionAgentEvent[] = [],
  now = Date.now(),
): { label: string; active: boolean } | null {
  if (!Number.isFinite(run.started_at) || run.started_at <= 0) return null;
  const answerAt = firstAnswerEvent(agentEvents)?.created_at ?? null;
  const live = isRunLive(run.status);
  const hasOutputFallback = Boolean(run.stdout?.trim() || run.stderr?.trim());
  const active = live && answerAt === null && !hasOutputFallback;
  const endAt = answerAt ?? (active ? now : run.completed_at ?? run.updated_at ?? now);
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
  ) ?? getLatestRun(detail.runs);
}

function getLatestRun(runs: SessionRun[]): SessionRun | null {
  return runs.at(-1) ?? null;
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
    created_at: currentSession.created_at,
    last_viewed_at: currentSession.last_viewed_at,
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
