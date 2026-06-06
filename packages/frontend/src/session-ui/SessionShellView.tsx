import {
  Brain,
  CheckCircle2,
  ChevronDown,
  FileText,
  GitFork,
  MessageSquare,
  Minimize2,
  Plus,
  RefreshCcw,
  Repeat2,
  Search,
  Settings,
  ShieldCheck,
  Square,
  StopCircle,
  Timer,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useState } from 'react';
import type {
  ActiveSessionSummary,
  Session,
  SessionBottomStatus,
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
import { MessageContent } from '../components/MessageContent';
import {
  MarkdownDisplaySwitch,
  SessionMessageBubble,
  type SessionMessageDisplayMode,
} from './SessionMessageBubble';
import { ProjectAgentStrip } from './ProjectAgentStrip';
import { sessionStatusTone } from './session-ui-model';
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
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (message: SessionComposerSubmit) => void;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
}): JSX.Element {
  const activeRun = getActiveRun(payload.activeSession);
  const forkTarget = payload.historyRecords[0]?.id;

  return (
    <section className="session-shell deepsea-shell" aria-label="Session Operations Console">
      <TopCommandBar
        payload={payload}
        onCommand={onCommand}
        forkTarget={forkTarget}
      />
      <main className="deepsea-main">
        <ActiveSessionsRail
          sessions={payload.activeSessions}
          currentSession={payload.activeSession.session}
          currentProjectId={payload.project.id}
          currentProjectName={payload.project.name}
          onCommand={onCommand}
          onOpenSession={onOpenSession}
        />
        <TranscriptCanvas
          detail={payload.activeSession}
          evidence={payload.evidence}
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
      <BottomStatusBar status={payload.bottomStatus} />
    </section>
  );
}

function TopCommandBar({
  payload,
  onCommand,
  forkTarget,
}: {
  payload: SessionWorkspacePayload;
  onCommand: (command: string) => void;
  forkTarget?: string;
}): JSX.Element {
  const pressure = contextPressurePercent(payload.status.context.pressure);
  const activeProjectName = payload.project.name;
  const projects = payload.projectSwitcher.projects;
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);

  return (
    <>
      <div className="deepsea-project-strip" aria-label="Project command bar">
        <div className="deepsea-project-breadcrumb">
          <GitFork aria-hidden="true" />
          <span className="deepsea-mono">workspace</span>
          <ChevronDown aria-hidden="true" />
        </div>
        <div className="deepsea-project-switcher">
          <button
            type="button"
            aria-expanded={projectMenuOpen}
            aria-label="切换项目"
            onClick={() => setProjectMenuOpen((open) => !open)}
          >
            <strong>{activeProjectName}</strong>
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
        <div
          className="deepsea-project-menu"
          data-open={projectMenuOpen ? 'true' : undefined}
          role="dialog"
          aria-label="项目切换器"
          aria-hidden={projectMenuOpen ? undefined : true}
          onClick={() => setProjectMenuOpen(false)}
        >
          <div className="deepsea-project-menu__panel" onClick={(event) => event.stopPropagation()}>
            <div className="deepsea-project-menu__header">
              <div>
                <h2>项目切换器</h2>
                <p>选择一个工作区以继续您的任务</p>
              </div>
              <div>
                <label className="deepsea-project-menu__search">
                  <Search aria-hidden="true" />
                  <input type="search" placeholder="搜索项目..." />
                </label>
                <button type="button" aria-label="关闭项目切换器" onClick={() => setProjectMenuOpen(false)}>
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </div>
            <div className="deepsea-project-menu__body">
              <div className="deepsea-project-grid">
                {projects.map((project) => (
                  <article className="deepsea-project-card" data-active={project.active ? 'true' : undefined} key={project.id}>
                    {project.active && (
                      <div className="deepsea-project-card__active">
                        <i />
                        <span>当前激活</span>
                      </div>
                    )}
                    <div className="deepsea-project-card__head">
                      <h3>{project.name}</h3>
                      <p className="deepsea-mono">{project.path}</p>
                    </div>
                    <div className="deepsea-project-card__sessions">
                      <span>最近会话</span>
                      {project.recentSessions.length === 0 ? (
                        <em>暂无会话</em>
                      ) : project.recentSessions.map((session) => (
                        <button
                          type="button"
                          key={`${project.id}-${session.source}-${session.id}`}
                          title={session.title}
                          onClick={() => {
                            if (typeof window !== 'undefined') window.location.assign(session.href);
                          }}
                        >
                          <strong>{formatCompactSessionTitle(session.title)}</strong>
                          <em>{formatRelativeTime(Date.now(), session.updated_at)}</em>
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
                <article className="deepsea-project-card deepsea-project-card--add">
                  <Plus aria-hidden="true" />
                  <span>新建项目</span>
                </article>
              </div>
            </div>
            <div className="deepsea-project-menu__footer">
              <button type="button">
                <Settings aria-hidden="true" />
                管理所有工作区
              </button>
            </div>
          </div>
        </div>
        <div className="deepsea-strip-actions">
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
      </div>
    </>
  );
}

function BottomStatusBar({ status }: { status: SessionBottomStatus }): JSX.Element {
  return (
    <footer className="deepsea-bottom-status" aria-label="Session status bar">
      <div className="deepsea-bottom-status__group">
        <span className="deepsea-bottom-status__label">系统健康状态</span>
        <span className="deepsea-status-dot" data-tone={healthTone(status.health)} />
        <strong>{status.healthLabel}</strong>
      </div>
      <span className="deepsea-bottom-status__divider" />
      <div className="deepsea-bottom-status__group">
        <span className="deepsea-bottom-status__label">索引状态</span>
        <span className="deepsea-status-dot" data-tone={status.indexStatus === 'ready' ? 'primary' : 'warn'} />
        <strong>{status.indexLabel}</strong>
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

function ActiveSessionsRail({
  sessions,
  currentSession,
  currentProjectId,
  currentProjectName,
  onCommand,
  onOpenSession,
}: {
  sessions: ActiveSessionSummary[];
  currentSession: Session;
  currentProjectId: string;
  currentProjectName: string;
  onCommand: (command: string) => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const normalizedQuery = q.trim().toLowerCase();
  const visibleSessions = ensureCurrentActiveSessionSummary(
    sessions,
    currentSession,
    currentProjectId,
    currentProjectName,
  ).filter((session) => {
    if (!normalizedQuery) return true;
    return [
      session.title,
      session.project_name,
      session.project_path,
      session.latest_event_summary ?? '',
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
  });

  return (
    <aside className="deepsea-history" aria-label="Active Sessions">
      <div className="deepsea-history__header">
        <div className="deepsea-history__title">
          <div>
            <MessageSquare aria-hidden="true" />
            <h2>活跃会话</h2>
          </div>
          <div className="deepsea-history__tools">
            <span className="deepsea-active-count">{visibleSessions.length}</span>
          </div>
        </div>
        <form
          className="deepsea-search"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <Search aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.currentTarget.value)}
            placeholder="搜索活跃会话..."
          />
        </form>
      </div>

      <div className="deepsea-history__list">
        {visibleSessions.length === 0 ? (
          <div className="deepsea-empty">没有匹配的活跃会话。</div>
        ) : visibleSessions.map((session) => {
          const isCurrent = session.id === currentSession.id;
          return (
            <button
              type="button"
              aria-current={isCurrent ? 'true' : undefined}
              className={`deepsea-history-card deepsea-active-session-card${isCurrent ? ' is-active' : ''}`}
              data-status={session.status}
              data-current={isCurrent ? 'true' : undefined}
              data-running={session.active_run_count > 0 ? 'true' : undefined}
              data-pinned={session.pinned_at !== null ? 'true' : undefined}
              key={session.id}
              onClick={() => onOpenSession?.(session.project_id, session.id)}
            >
              <span className="deepsea-history-card__rail" />
              <div>
                <div className="deepsea-active-session-card__project">
                  <span>{session.project_name}</span>
                  <em>{formatRelativeTime(Date.now(), session.updated_at)}</em>
                </div>
                <h3 title={session.title}>{formatCompactSessionTitle(session.title)}</h3>
                <p>{session.latest_event_summary ?? session.project_path}</p>
                <div className="deepsea-history-card__footer">
                  <span className="deepsea-status-chip" data-tone={session.active_run_count > 0 ? 'primary' : sessionStatusTone(session.status)}>
                    {activeSessionStatusLabel(session)}
                  </span>
                  <span className="deepsea-agent-mini">
                    <Brain aria-hidden="true" />
                    {formatProviderModel(session.provider ?? 'codex', session.model)}
                  </span>
                </div>
                {(session.unread_count > 0 || session.pinned_at !== null) && (
                  <div className="deepsea-active-session-card__meta">
                    {session.pinned_at !== null && <span>置顶</span>}
                    {session.unread_count > 0 && <span>{session.unread_count} 未读</span>}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="deepsea-history__footer">
        <button type="button" className="deepsea-primary-button" data-command="/new" onClick={() => onCommand('/new')}>
          <Plus aria-hidden="true" />
          新建会话
        </button>
      </div>
    </aside>
  );
}

function TranscriptCanvas({
  detail,
  evidence,
  onSendMessage,
}: {
  detail: SessionDetail;
  evidence: SessionEvidenceEvent[];
  onSendMessage: (message: SessionComposerSubmit) => void;
}): JSX.Element {
  const timeline = buildTranscriptTimeline(detail).slice(-36);
  const [displayModes, setDisplayModes] = useState<Record<string, SessionMessageDisplayMode>>({});
  const displayModeFor = (key: string): SessionMessageDisplayMode => displayModes[key] ?? 'preview';
  const setDisplayModeFor = (key: string, mode: SessionMessageDisplayMode) => {
    setDisplayModes((current) => ({ ...current, [key]: mode }));
  };

  return (
    <section className="deepsea-transcript" aria-label="Active Session">
      <div className="deepsea-transcript__scroll">
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
          return (
            <React.Fragment key={item.key}>
              <AgentThoughtPanel run={item.run} evidence={runEvidence} />
              <article className="deepsea-run-log">
                <div>
                  <span className="deepsea-status-chip" data-tone={item.run.status === 'failed' ? 'danger' : 'ok'}>ASSISTANT</span>
                  <time className="deepsea-mono">{formatClock(item.run.started_at)}</time>
                  <ThinkingDurationBadge run={item.run} />
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
      </div>
      <DeepseaComposer projectId={detail.session.project_id} onSendMessage={onSendMessage} />
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

function TranscriptMessage({
  message,
  displayMode,
  onDisplayModeChange,
}: {
  message: SessionMessage;
  displayMode: SessionMessageDisplayMode;
  onDisplayModeChange: (mode: SessionMessageDisplayMode) => void;
}): JSX.Element {
  return (
    <SessionMessageBubble
      role={message.role}
      content={message.content}
      timeLabel={formatClock(message.created_at)}
      statusLabel={message.status === 'queued' || message.status === 'streaming' ? '思考中' : null}
      displayMode={displayMode}
      onDisplayModeChange={onDisplayModeChange}
    />
  );
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
      continue;
    }

    const marker = runEventMarker(event);
    if (!marker) continue;
    flushText();
    items.push({
      type: 'event',
      id: `event-${event.id}`,
      label: marker.label,
      detail: marker.detail,
      created_at: event.created_at,
    });
  }

  flushText();
  if (items.length === 0) {
    const text = fallbackText.trim();
    return text ? [{ type: 'text', id: 'text-fallback', text }] : [];
  }
  return items;
}

function isAnswerTextEvent(event: SessionAgentEvent): boolean {
  return event.channel === 'answer' &&
    event.content.length > 0 &&
    event.event_type !== 'protocol.stderr';
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

function AgentThoughtPanel({
  run,
  evidence,
}: {
  run: SessionRun;
  evidence: SessionEvidenceEvent[];
}): JSX.Element | null {
  const thought = agentThoughtText(run, evidence);
  if (!thought) return null;
  const status = run.status === 'failed' ? 'RISK' : run.status === 'completed' ? 'VERIFIED' : 'RUNNING';
  return (
    <section className="deepsea-agent-thought" aria-label="智能体思考过程">
      <div className="deepsea-agent-thought__header">
        <span>
          <Brain aria-hidden="true" />
          <strong>智能体思考过程</strong>
          <em>Agent Thought Process</em>
        </span>
        <mark>{status}</mark>
      </div>
      <p>{thought}</p>
    </section>
  );
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
        <h3>代理运行 (Active Run)</h3>
        <div className="deepsea-empty">暂无代理运行</div>
      </section>
    );
  }

  const provider = run.provider;
  const model = run.model;
  const runLabel = run.status;
  const cancellable = run.status === 'queued' || run.status === 'running' || run.status === 'retrying';
  return (
    <section className="deepsea-inspector-section deepsea-run-section">
      <h3>代理运行 (Active Run)</h3>
      <div className="deepsea-run-card">
        <div className="deepsea-run-card__top">
          <div className="deepsea-run-card__agent">
            <span>
              <Brain aria-hidden="true" />
            </span>
            <div>
              <strong className="deepsea-mono">{formatProviderModel(provider, model)}</strong>
              <em>
                <i />
                {runLabel}
              </em>
            </div>
          </div>
          <div className="deepsea-run-card__time">
            <strong className="deepsea-mono">{formatDuration(run.started_at, run.completed_at ?? Date.now())}</strong>
            <span>运行耗时</span>
          </div>
        </div>
        <div className="deepsea-run-card__actions">
          <button
            type="button"
            aria-label="停止运行"
            disabled={!cancellable}
            onClick={() => run && onCancelRun?.(run.id)}
          >
            <StopCircle aria-hidden="true" />
            停止
          </button>
          <button type="button" aria-label="重新执行" onClick={() => onRetryRun?.(run.id)}>
            <Repeat2 aria-hidden="true" />
            重试
          </button>
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
  return '等待智能体输出...';
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

function agentThoughtText(run: SessionRun, evidence: SessionEvidenceEvent[]): string | null {
  const activity = trimDisplayText(run.activity_log);
  if (activity) return activity;
  const evidenceText = evidence
    .map((event) => trimDisplayText(event.summary ?? event.title))
    .filter(Boolean)
    .slice(0, 3)
    .join('\n');
  return evidenceText || null;
}

function trimDisplayText(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (text.length <= 1200) return text;
  return `${text.slice(0, 1200).trimEnd()}\n...`;
}

function ToolsModule({ rows }: { rows: SessionToolRow[] }): JSX.Element {
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
        {rows.map((row, index) => (
          <div key={row.id} data-tone={toolRowTone(row)}>
            <span>{index + 1}</span>
            <strong>{toolActionLabel(row.action)}</strong>
            <p>{row.target}</p>
            <span>{row.durationMs === null ? '--' : `${(row.durationMs / 1000).toFixed(1)}s`}</span>
            {row.status === 'running' ? <span>...</span> : <CheckCircle2 aria-hidden="true" />}
          </div>
        ))}
      </div>
      )}
    </section>
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

function activeSessionStatusLabel(session: ActiveSessionSummary): string {
  if (session.active_run_count > 0) return `运行中 ${session.active_run_count}`;
  const labels: Record<string, string> = {
    active: '空闲',
    completed: '已完成',
    blocked: '阻塞',
    failed: '失败',
    archived: '已归档',
  };
  return labels[session.status] ?? session.status;
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

function formatRelativeTime(now: number, timestamp: number): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function healthTone(health: SessionBottomStatus['health']): 'ok' | 'warn' | 'danger' {
  if (health === 'error') return 'danger';
  if (health === 'warning') return 'warn';
  return 'ok';
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
