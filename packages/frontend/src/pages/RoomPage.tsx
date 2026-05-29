import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, Brain, ChevronDown, ChevronLeft, Download, Eye, FileText, FolderOpen, MessageSquare, Reply, RotateCcw, Settings2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { roomSocket, type WsServerEvent } from '../lib/ws';
import type {
  Agent,
  AgentRun,
  Message,
  MessageAttachmentMetadata,
  PlannerDecision,
  Room,
  RoomAgent,
} from '../lib/types';
import { parseMessageMetadata } from '../lib/messageMetadata';
import { useI18n } from '../lib/i18n';
import { recordRecentRoomVisit } from '../lib/recentRooms';
import { cn } from '../lib/utils';
import {
  createStreamingDisplayState,
  enqueueStreamingChunk,
  flushStreamingDisplay,
  hasQueuedStreamingContent,
  resolveStreamingDisplayContent,
  shouldRetainStreamingDisplayState,
  tickStreamingDisplay,
  type StreamingDisplayState,
} from '../lib/streamingDisplay';
import { createStreamingEventTracker, shouldApplyStreamingEvent } from '../lib/streamingEvents';
import { AgentAvatar } from '../components/AgentAvatar';
import { AgentRunStatusCard } from '../components/AgentRunPanel';
import { AcpConfigPanel } from '../components/AcpConfigPanel';
import { AddAgentDialog } from '../components/AddAgentDialog';
import { MemoryPanel } from '../components/MemoryPanel';
import { RichMessageComposer } from '../components/RichMessageComposer';
import { RoomFilesPanel } from '../components/RoomFilesPanel';
import { MessageContent, isMarkdownMessageContent } from '../components/MessageContent';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';
import { RoomSettingsDialog } from '../components/SettingsDialogs';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '../components/ai-elements/Conversation';
import {
  MessageActions as AiMessageActions,
  MessageBadge as AiMessageBadge,
  MessageBody as AiMessageBody,
  MessageHeader as AiMessageHeader,
  MessageMeta as AiMessageMeta,
  MessageRow as AiMessageRow,
  MessageRunPanel as AiMessageRunPanel,
} from '../components/ai-elements/Message';
import {
  applyMessageStreamBatch,
  createDefaultReplyTarget,
  createPlannerDispatchInput,
  createReplyTarget,
  hasDispatchablePlannerSteps,
  shouldShowPlannerDecisionPanel,
  type MessageStreamUpdate,
  type ReplyTarget,
  type StreamTraceChannel,
} from './roomPageLogic';

type RoomFeatureTab = 'chat' | 'files';
type SendInput = { content: string; mentions?: string[]; files?: File[]; fileIds?: string[]; replyToMessageId?: string };

export function RoomPage() {
  const { projectId = '', roomId = '' } = useParams();
  const queryClient = useQueryClient();
  const [configAgent, setConfigAgent] = useState<RoomAgent | null>(null);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [streamingMessageIds, setStreamingMessageIds] = useState<Set<string>>(() => new Set());
  const [activeTab, setActiveTab] = useState<RoomFeatureTab>('chat');
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [explicitReplyTarget, setExplicitReplyTarget] = useState<ReplyTarget | null>(null);
  const messageRefs = useRef<Map<string, HTMLElement>>(new Map());
  const streamingRunMessageIds = useRef<Map<string, string>>(new Map());
  const streamingEventTracker = useRef(createStreamingEventTracker());
  const finalizedStreamMessageIds = useRef<Set<string>>(new Set());
  const finalizedStreamRunIds = useRef<Set<string>>(new Set());
  const pendingStreamUpdates = useRef<MessageStreamUpdate[]>([]);
  const streamFlushFrame = useRef<number | null>(null);
  const { t } = useI18n();

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
  });
  const { data: room } = useQuery({
    queryKey: ['room', roomId],
    queryFn: () => api.getRoom(roomId),
    enabled: !!roomId,
  });
  const { data: rooms = [] } = useQuery({
    queryKey: ['rooms', projectId],
    queryFn: () => api.listRooms(projectId),
    enabled: !!projectId,
  });
  const { data: messages = [] } = useQuery({
    queryKey: ['messages', roomId],
    queryFn: () => api.listMessages(roomId),
    enabled: !!roomId,
  });
  const { data: agents = [] } = useQuery({
    queryKey: ['room-agents', roomId],
    queryFn: () => api.listRoomAgents(roomId),
    enabled: !!roomId,
  });
  const { data: globalAgents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.listAgents(),
  });
  const { data: settings } = useQuery({
    queryKey: ['settings', 'room', roomId],
    queryFn: () => api.getRoomSettings(roomId),
    enabled: !!roomId,
  });
  const { data: agentRuns = [] } = useQuery({
    queryKey: ['agent-runs', roomId],
    queryFn: () => api.listAgentRuns(roomId),
    enabled: !!roomId,
    refetchInterval: (query) => {
      const runs = query.state.data as AgentRun[] | undefined;
      return runs?.some((run) => run.status === 'running' || run.status === 'queued' || run.status === 'retrying') ? 2000 : false;
    },
  });
  const streamingDisplay = useStreamingMessageDisplay(roomId);
  const appendStreamingChunk = streamingDisplay.appendChunk;
  const finishStreamingMessage = streamingDisplay.finishMessage;
  const clearStreamingMessage = streamingDisplay.clearMessage;

  useEffect(() => {
    setActiveTab('chat');
    setShowMemoryPanel(false);
    setHighlightMessageId(null);
    setExplicitReplyTarget(null);
    messageRefs.current.clear();
    streamingRunMessageIds.current.clear();
    streamingEventTracker.current.clear();
    finalizedStreamMessageIds.current.clear();
    finalizedStreamRunIds.current.clear();
    pendingStreamUpdates.current = [];
    if (streamFlushFrame.current !== null) {
      window.cancelAnimationFrame(streamFlushFrame.current);
      streamFlushFrame.current = null;
    }
  }, [roomId]);

  useEffect(() => {
    if (!project || !room || room.project_id !== project.id) return;
    recordRecentRoomVisit({ project, room });
  }, [project, room]);

  const registerMessageRef = useCallback((messageId: string, node: HTMLElement | null) => {
    if (node) {
      messageRefs.current.set(messageId, node);
    } else {
      messageRefs.current.delete(messageId);
    }
  }, []);

  const focusMessage = useCallback((messageId: string) => {
    setShowMemoryPanel(false);
    setConfigAgent(null);
    setActiveTab('chat');
    setHighlightMessageId(messageId);
  }, []);

  const flushPendingStreamUpdates = useCallback(() => {
    streamFlushFrame.current = null;
    const updates = pendingStreamUpdates.current.filter((update) => {
      if (update.done && update.message) return true;
      if (finalizedStreamMessageIds.current.has(update.messageId)) return false;
      if (update.runId && finalizedStreamRunIds.current.has(update.runId)) return false;
      return true;
    });
    pendingStreamUpdates.current = [];
    if (updates.length === 0) return;

    let matchedMessage = false;
    let finalFullContent = '';
    const finalDoneByMessageId = new Map<string, string>();
    const activeMessageIds = new Set<string>();

    queryClient.setQueryData<Message[] | undefined>(['messages', roomId], (prev) => {
      const result = applyMessageStreamBatch(prev, updates);
      matchedMessage = result.matched;
      finalFullContent = result.fullContent;
      for (const messageId of result.finalizedMessageIds) finalizedStreamMessageIds.current.add(messageId);
      for (const runId of result.finalizedRunIds) {
        finalizedStreamRunIds.current.add(runId);
        streamingRunMessageIds.current.delete(runId);
      }
      return result.messages;
    });

    for (const update of updates) {
      if (update.done) {
        const fallbackContent = queryClient
          .getQueryData<Message[]>(['messages', roomId])
          ?.find((message) => message.id === update.messageId)
          ?.content ?? finalFullContent;
        finalDoneByMessageId.set(update.messageId, update.message?.content ?? fallbackContent);
      } else {
        if (update.chunk && (!update.channel || update.channel === 'answer')) {
          appendStreamingChunk(update.messageId, update.chunk);
        }
        activeMessageIds.add(update.messageId);
      }
    }

    for (const [messageId, content] of finalDoneByMessageId) {
      finishStreamingMessage(messageId, content);
      activeMessageIds.delete(messageId);
    }
    if (activeMessageIds.size > 0 || finalDoneByMessageId.size > 0) {
      setStreamingMessageIds((prev) => {
        let next = prev;
        for (const messageId of activeMessageIds) next = addStreamingMessageId(next, messageId);
        for (const messageId of finalDoneByMessageId.keys()) next = removeStreamingMessageId(next, messageId);
        return next;
      });
    }

    if (!matchedMessage) {
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
    }
  }, [queryClient, roomId, appendStreamingChunk, finishStreamingMessage]);

  const enqueueStreamUpdate = useCallback((update: MessageStreamUpdate) => {
    pendingStreamUpdates.current.push(update);
    if (streamFlushFrame.current !== null) return;
    streamFlushFrame.current = window.requestAnimationFrame(flushPendingStreamUpdates);
  }, [flushPendingStreamUpdates]);

  const replyToMessage = useCallback((message: Message) => {
    setExplicitReplyTarget(createReplyTarget(message, true));
    setActiveTab('chat');
  }, []);

  useEffect(() => {
    if (!highlightMessageId || activeTab !== 'chat') return;
    const scrollTimer = window.setTimeout(() => {
      messageRefs.current.get(highlightMessageId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 60);
    const clearTimer = window.setTimeout(() => {
      setHighlightMessageId((current) => (current === highlightMessageId ? null : current));
    }, 2400);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [activeTab, highlightMessageId, messages.length]);

  // Subscribe to WS for this room
  useEffect(() => {
    if (!roomId) return;
    roomSocket.subscribe(roomId);
    const off = roomSocket.on((event: WsServerEvent) => {
      if (event.type === 'message:new' && event.roomId === roomId) {
        queryClient.setQueryData<Message[] | undefined>(['messages', roomId], (prev) =>
          upsertMessage(prev, event.message),
        );
        if (event.message.message_type === 'agent_stream') {
          setStreamingMessageIds((prev) => addStreamingMessageId(prev, event.message.id));
        }
      } else if (event.type === 'message:stream' && event.roomId === roomId) {
        if (!shouldApplyStreamingEvent(streamingEventTracker.current, event)) return;
        if (finalizedStreamMessageIds.current.has(event.messageId) && !(event.done && event.message)) return;
        if (event.runId && finalizedStreamRunIds.current.has(event.runId) && !(event.done && event.message)) return;
        if (event.runId) {
          streamingRunMessageIds.current.set(event.runId, event.messageId);
        }
        enqueueStreamUpdate({
          messageId: event.messageId,
          runId: event.runId,
          chunk: event.chunk,
          done: event.done,
          channel: event.channel,
          event: event.event,
          message: event.message,
        });
      } else if (
        (event.type === 'agent_run:created' || event.type === 'agent_run:updated') &&
        event.roomId === roomId
      ) {
        queryClient.setQueryData<AgentRun[] | undefined>(['agent-runs', roomId], (prev) =>
          upsertAgentRun(prev, event.run),
        );
        if (event.type === 'agent_run:updated' && isTerminalAgentRunStatus(event.run.status)) {
          finalizedStreamRunIds.current.add(event.run.id);
          const messageId =
            streamingRunMessageIds.current.get(event.run.id) ??
            findAgentRunMessageId(queryClient.getQueryData<Message[]>(['messages', roomId]), event.run);
          if (messageId) {
            finalizedStreamMessageIds.current.add(messageId);
            clearStreamingMessage(messageId);
            setStreamingMessageIds((prev) => removeStreamingMessageId(prev, messageId));
            streamingRunMessageIds.current.delete(event.run.id);
          }
          queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
        }
      } else if (event.type === 'room:agent_joined' && event.roomId === roomId) {
        queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      } else if (event.type === 'room:agent_left' && event.roomId === roomId) {
        queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      }
    });
    return () => {
      roomSocket.unsubscribe(roomId);
      off();
      if (streamFlushFrame.current !== null) {
        window.cancelAnimationFrame(streamFlushFrame.current);
        streamFlushFrame.current = null;
      }
      pendingStreamUpdates.current = [];
    };
  }, [roomId, queryClient, enqueueStreamUpdate, clearStreamingMessage]);

  useEffect(() => {
    if (streamingMessageIds.size === 0 || messages.length === 0) return;
    const runByMessageId = pairRunsWithAgentMessages(messages, agentRuns);
    const terminalMessageIds = new Set<string>();

    for (const messageId of streamingMessageIds) {
      const run = runByMessageId.get(messageId);
      if (!run || !isTerminalAgentRunStatus(run.status)) continue;
      terminalMessageIds.add(messageId);
      finalizedStreamMessageIds.current.add(messageId);
      finalizedStreamRunIds.current.add(run.id);
      streamingRunMessageIds.current.delete(run.id);
    }

    if (terminalMessageIds.size === 0) return;
    for (const messageId of terminalMessageIds) clearStreamingMessage(messageId);
    setStreamingMessageIds((prev) => {
      let next = prev;
      for (const messageId of terminalMessageIds) next = removeStreamingMessageId(next, messageId);
      return next;
    });
  }, [agentRuns, clearStreamingMessage, messages, streamingMessageIds]);

  return (
    <div className="workspace-root" data-testid="room-page">
      <header className="workspace-toolbar">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={`/projects/${projectId}`}
            className="toolbar-back"
            aria-label={t('room.backToProject')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <div className="font-display text-[15px] font-semibold leading-tight">
              {room?.name ?? t('room.defaultName')}
            </div>
            <div className="mt-1 hidden truncate font-mono text-[11px] text-[var(--color-fg-muted)] sm:block">
              {project?.name ?? t('room.defaultName')} · {project?.path ?? t('room.projectPathUnknown')}
            </div>
          </div>
        </div>

        <RoomSwitcher projectId={projectId} roomId={roomId} rooms={rooms} />

        <div className="room-toolbar-actions ml-auto flex min-w-0 items-center gap-2">
          <AgentStrip
            agents={agents}
            onConfig={(agent) => {
              setConfigAgent(agent);
            }}
          />
          {project && room && (
            <RoomSettingsDialog project={project} room={room} agents={agents}>
              <button
                type="button"
                aria-label={t('room.roomSettings')}
                className="glass-button"
              >
                <Settings2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t('room.tab.settings')}</span>
              </button>
            </RoomSettingsDialog>
          )}
          <button
            type="button"
            aria-label={t('memory.tab')}
            className={cn('glass-button', showMemoryPanel && 'glass-button-primary')}
            onClick={() => {
              setShowMemoryPanel((v) => !v);
              if (!showMemoryPanel) setConfigAgent(null);
            }}
          >
            <Brain className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span className="hidden sm:inline">{t('memory.tab')}</span>
          </button>
          <AddAgentDialog
            roomId={roomId}
            roomAgentGlobalIds={agents.map((agent) => agent.global_agent_id ?? '')}
            roomAgentIds={agents.map((agent) => agent.agent_id)}
          >
            <button type="button" className="glass-button" aria-label={t('room.inviteAgent')}>
              <Users className="h-3.5 w-3.5" strokeWidth={1.8} />
              <span className="hidden sm:inline">{t('room.inviteAgent')}</span>
            </button>
          </AddAgentDialog>
        </div>
      </header>

      <div className={cn('workspace-grid', showMemoryPanel && 'has-inspector')}>
        <section className="workbench-panel room-main-panel" aria-label={t('room.viewLabel')}>
          <RoomFeatureTabs activeTab={activeTab} onChange={setActiveTab} />
          <div className="room-tab-content">
            {activeTab === 'chat' && (
              <ChatColumn
                messages={messages}
                agents={agents}
                globalAgents={globalAgents}
                agentRuns={agentRuns}
                roomId={roomId}
                projectId={projectId}
                modelChatReady={Boolean(settings?.system.langchain_planner_model && settings.system.openai_api_key_set)}
                routingMode={settings?.effective.message_routing_mode ?? project?.message_routing_mode ?? 'mentions_only'}
                fallbackAgentId={settings?.effective.fallback_agent_id ?? project?.fallback_agent_id ?? null}
                streamingMessageIds={streamingMessageIds}
                streamingDisplay={streamingDisplay}
                registerMessageRef={registerMessageRef}
                highlightMessageId={highlightMessageId}
                explicitReplyTarget={explicitReplyTarget}
                onReplyToMessage={replyToMessage}
                onClearReplyTarget={() => setExplicitReplyTarget(null)}
                onLocateReplyTarget={focusMessage}
              />
            )}
            {activeTab === 'files' && (
              <RoomFilesPanel
                projectId={projectId}
                roomId={roomId}
                onLocateMessage={focusMessage}
              />
            )}
          </div>
        </section>
        {showMemoryPanel && (
          <aside className="workbench-panel inspector-panel memory-panel-shell p-4">
            <MemoryPanel
              projectId={projectId}
              roomId={roomId}
              roomAgents={agents}
            />
          </aside>
        )}
      </div>

      {configAgent && (
        <AcpConfigPanel
          agent={configAgent}
          roomAgents={agents}
          projectId={projectId}
          projectPath={project?.path ?? ''}
          roomId={roomId}
          onClose={() => setConfigAgent(null)}
        />
      )}
    </div>
  );
}

function upsertMessage(prev: Message[] | undefined, message: Message): Message[] {
  const list = prev ?? [];
  return dedupeMessages([...list.filter((item) => item.id !== message.id), message]);
}

function dedupeMessages(messages: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort(
    (a, b) => a.created_at - b.created_at,
  );
}

function addStreamingMessageId(prev: Set<string>, messageId: string): Set<string> {
  if (prev.has(messageId)) return prev;
  const next = new Set(prev);
  next.add(messageId);
  return next;
}

function removeStreamingMessageId(prev: Set<string>, messageId: string): Set<string> {
  if (!prev.has(messageId)) return prev;
  const next = new Set(prev);
  next.delete(messageId);
  return next;
}

type StreamingMessageDisplay = {
  appendChunk: (messageId: string, chunk: string) => void;
  finishMessage: (messageId: string, fullContent: string) => void;
  clearMessage: (messageId: string) => void;
  getDisplayedContent: (message: Message) => string;
  isAnimating: (messageId: string) => boolean;
};

function useStreamingMessageDisplay(roomId: string): StreamingMessageDisplay {
  const [displayStates, setDisplayStates] = useState<Map<string, StreamingDisplayState>>(() => new Map());
  const finalContentRef = useRef<Map<string, string>>(new Map());
  const timerRef = useRef<number | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const tick = useCallback(() => {
    setDisplayStates((prev) => {
      if (prev.size === 0) {
        stopTimer();
        return prev;
      }

      let changed = false;
      let needsMoreTicks = false;
      const next = new Map<string, StreamingDisplayState>();
      for (const [messageId, state] of prev) {
        let ticked = tickStreamingDisplay(state);
        const finalContent = finalContentRef.current.get(messageId);
        let done = finalContent !== undefined;
        if (finalContent !== undefined && !hasQueuedStreamingContent(ticked)) {
          ticked = flushStreamingDisplay(ticked, finalContent);
          finalContentRef.current.delete(messageId);
          done = true;
        }
        if (shouldRetainStreamingDisplayState(ticked, done)) {
          next.set(messageId, ticked);
        }
        if (ticked !== state) changed = true;
        if (hasQueuedStreamingContent(ticked) || finalContentRef.current.has(messageId)) {
          needsMoreTicks = true;
        }
      }

      if (!needsMoreTicks) stopTimer();
      return changed ? next : prev;
    });
  }, [stopTimer]);

  const ensureTimer = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setInterval(tick, 18);
  }, [tick]);

  const appendChunk = useCallback((messageId: string, chunk: string) => {
    if (!chunk) return;
    setDisplayStates((prev) => {
      const current = prev.get(messageId) ?? createStreamingDisplayState();
      const next = new Map(prev);
      next.set(messageId, enqueueStreamingChunk(current, chunk));
      return next;
    });
    ensureTimer();
  }, [ensureTimer]);

  const finishMessage = useCallback((messageId: string, fullContent: string) => {
    setDisplayStates((prev) => {
      const current = prev.get(messageId);
      if (current && hasQueuedStreamingContent(current)) {
        finalContentRef.current.set(messageId, fullContent);
        return prev;
      }
      finalContentRef.current.delete(messageId);
      const next = new Map(prev);
      next.delete(messageId);
      return next;
    });
    ensureTimer();
  }, [ensureTimer]);

  const clearMessage = useCallback((messageId: string) => {
    finalContentRef.current.delete(messageId);
    setDisplayStates((prev) => {
      if (!prev.has(messageId)) return prev;
      const next = new Map(prev);
      next.delete(messageId);
      return next;
    });
  }, []);

  const getDisplayedContent = useCallback((message: Message) => {
    return resolveStreamingDisplayContent(displayStates.get(message.id), message.content);
  }, [displayStates]);

  const isAnimating = useCallback((messageId: string) => {
    return hasQueuedStreamingContent(displayStates.get(messageId) ?? createStreamingDisplayState());
  }, [displayStates]);

  useEffect(() => {
    setDisplayStates(new Map());
    finalContentRef.current.clear();
    stopTimer();
    return stopTimer;
  }, [roomId, stopTimer]);

  return useMemo(() => ({
    appendChunk,
    finishMessage,
    clearMessage,
    getDisplayedContent,
    isAnimating,
  }), [appendChunk, finishMessage, clearMessage, getDisplayedContent, isAnimating]);
}

function isTerminalAgentRunStatus(status: AgentRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

export function shouldUseStreamingDisplayForMessage(
  message: Message,
  run: AgentRun | undefined,
  hasLocalStreamingState: boolean,
): boolean {
  if (message.sender_type === 'user' || message.message_type !== 'agent_stream') return false;
  if (run && isTerminalAgentRunStatus(run.status)) return false;
  if (run && (run.status === 'running' || run.status === 'queued' || run.status === 'retrying')) return true;
  return hasLocalStreamingState;
}

function findAgentRunMessageId(messages: Message[] | undefined, run: AgentRun): string | null {
  if (!messages) return null;
  const message = messages.find((item) =>
    item.sender_type === 'agent' &&
    item.message_type === 'agent_stream' &&
    item.sender_id === run.agent_id &&
    Math.abs(item.created_at - run.started_at) < 5000
  );
  return message?.id ?? null;
}

export function upsertAgentRun(prev: AgentRun[] | undefined, run: AgentRun): AgentRun[] {
  const list = prev ?? [];
  const existing = list.find((item) => item.id === run.id);
  const nextRun = existing && shouldKeepExistingAgentRun(existing, run) ? existing : run;
  return [nextRun, ...list.filter((item) => item.id !== run.id)]
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, 50);
}

function shouldKeepExistingAgentRun(existing: AgentRun, incoming: AgentRun): boolean {
  if (incoming.updated_at < existing.updated_at) return true;
  return isTerminalAgentRunStatus(existing.status) && !isTerminalAgentRunStatus(incoming.status);
}

function RoomSwitcher({
  projectId,
  roomId,
  rooms,
}: {
  projectId: string;
  roomId: string;
  rooms: Room[];
}) {
  const { t } = useI18n();
  const currentRoom = rooms.find((item) => item.id === roomId) ?? null;
  const visibleRooms = [
    ...(currentRoom ? [currentRoom] : []),
    ...rooms.filter((item) => item.id !== roomId).slice(0, 4),
  ];
  const visibleIds = new Set(visibleRooms.map((item) => item.id));
  const hiddenRooms = rooms.filter((item) => !visibleIds.has(item.id));

  return (
    <nav className="toolbar-tabs room-switcher" aria-label={t('room.switcherLabel')}>
      {visibleRooms.map((item) => (
        <Link
          key={item.id}
          to={`/projects/${projectId}/rooms/${item.id}`}
          className={cn('toolbar-tab', item.id === roomId && 'is-active')}
          aria-current={item.id === roomId ? 'page' : undefined}
          title={item.name}
        >
          {item.name}
        </Link>
      ))}
      {hiddenRooms.length > 0 && (
        <details className="room-more-menu">
          <summary className="toolbar-tab">
            <span>{t('room.moreRooms')}</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </summary>
          <div className="room-more-list">
            {hiddenRooms.map((item) => (
              <Link key={item.id} to={`/projects/${projectId}/rooms/${item.id}`}>
                {item.name}
              </Link>
            ))}
          </div>
        </details>
      )}
    </nav>
  );
}

function RoomFeatureTabs({
  activeTab,
  onChange,
}: {
  activeTab: RoomFeatureTab;
  onChange: (tab: RoomFeatureTab) => void;
}) {
  const { t } = useI18n();
  const tabs: Array<{ id: RoomFeatureTab; label: string; icon: typeof MessageSquare }> = [
    { id: 'chat', label: t('room.tab.chat'), icon: MessageSquare },
    { id: 'files', label: t('room.tab.files'), icon: FolderOpen },
  ];

  return (
    <div className="room-feature-tabs" aria-label={t('room.viewLabel')}>
      <div className="segmented-control">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? 'is-active' : ''}
              aria-pressed={activeTab === tab.id}
              onClick={() => onChange(tab.id)}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.7} />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AgentStrip({
  agents,
  onConfig,
}: {
  agents: RoomAgent[];
  onConfig: (a: RoomAgent) => void;
}) {
  const { t } = useI18n();

  if (agents.length === 0)
    return <span className="text-[12px] text-[var(--color-fg-muted)]">{t('room.noAgents')}</span>;
  return (
    <div className="mr-2 flex items-center -space-x-2">
      {agents.slice(0, 6).map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onConfig(a)}
          aria-label={t('room.configureAgent', { name: a.agent_name })}
          className="rounded-full ring-2 ring-white/80 transition-transform ease-ocean hover:scale-105"
          title={`${a.agent_name}${a.acp_enabled ? ` · ACP: ${a.acp_backend}` : ''}`}
        >
          <AgentAvatar name={a.agent_name} size={26} active={!!a.acp_enabled} />
        </button>
      ))}
      {agents.length > 6 && (
        <span className="ml-3 text-[11px] font-mono text-[var(--color-fg-muted)]">+{agents.length - 6}</span>
      )}
    </div>
  );
}

function ChatColumn({
  messages,
  agents,
  globalAgents,
  agentRuns,
  roomId,
  projectId,
  modelChatReady,
  routingMode,
  fallbackAgentId,
  streamingMessageIds,
  streamingDisplay,
  registerMessageRef,
  highlightMessageId,
  explicitReplyTarget,
  onReplyToMessage,
  onClearReplyTarget,
  onLocateReplyTarget,
}: {
  messages: Message[];
  agents: RoomAgent[];
  globalAgents: Agent[];
  agentRuns: AgentRun[];
  roomId: string;
  projectId: string;
  modelChatReady: boolean;
  routingMode: 'mentions_only' | 'fallback_reply';
  fallbackAgentId: string | null;
  streamingMessageIds: Set<string>;
  streamingDisplay: StreamingMessageDisplay;
  registerMessageRef: (messageId: string, node: HTMLElement | null) => void;
  highlightMessageId: string | null;
  explicitReplyTarget: ReplyTarget | null;
  onReplyToMessage: (message: Message) => void;
  onClearReplyTarget: () => void;
  onLocateReplyTarget: (messageId: string) => void;
}) {
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [defaultReplySuppressedForMessageId, setDefaultReplySuppressedForMessageId] = useState<string | null>(null);
  const [messageDisplayModes, setMessageDisplayModes] = useState<Record<string, 'preview' | 'source'>>({});
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const agentMap = useMemo(
    () => new Map(agents.map((a) => [a.agent_id, a])),
    [agents],
  );
  const agentByRoomId = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );
  const runByMessageId = useMemo(
    () => pairRunsWithAgentMessages(messages, agentRuns),
    [messages, agentRuns],
  );
  const visibleMessages = useMemo(() => dedupeMessages(messages), [messages]);
  const streamingReplyMessageIds = useMemo(
    () => new Set(Array.from(streamingMessageIds)),
    [streamingMessageIds],
  );
  const defaultReplyTarget = useMemo(
    () => explicitReplyTarget ?? createDefaultReplyTarget(
      visibleMessages,
      new Set([
        ...streamingReplyMessageIds,
        ...(defaultReplySuppressedForMessageId ? [defaultReplySuppressedForMessageId] : []),
      ]),
    ),
    [defaultReplySuppressedForMessageId, explicitReplyTarget, streamingReplyMessageIds, visibleMessages],
  );
  const canSendChat = agents.length > 0 || modelChatReady;

  const send = useMutation({
    mutationFn: (input: SendInput) => api.sendMessage(roomId, input),
    onSuccess: () => {
      setComposerResetKey((key) => key + 1);
      setDefaultReplySuppressedForMessageId(null);
      onClearReplyTarget();
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      queryClient.invalidateQueries({ queryKey: ['project-files', projectId] });
      queryClient.invalidateQueries({ queryKey: ['files'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // 这里是消息气泡、方案选择按钮等入口复用的最小发送点。
  // 统一走 api.sendMessage -> /rooms/:roomId/messages -> dispatchUserMessage。
  const submitUserMessage = useCallback((input: SendInput) => {
    const content = input.content.trim();
    const files = input.files;
    const fileIds = input.fileIds;
    if (!content && (!files || files.length === 0) && (!fileIds || fileIds.length === 0)) return;
    send.mutate({ content, mentions: input.mentions, files, fileIds, replyToMessageId: input.replyToMessageId });
  }, [send]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Conversation className="flex-1">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState>
              <WorkspaceEmptyState
                icon={<MessageSquare className="h-9 w-9" strokeWidth={1.75} />}
                title={t('room.emptyMessagesTitle')}
                description={
                  agents.length === 0
                    ? modelChatReady
                      ? t('room.emptyMessagesWithModel')
                      : t('room.emptyMessagesNoAgents')
                    : t('room.emptyMessagesWithAgents')
                }
                action={
                  agents.length === 0 && !modelChatReady
                    ? (
                      <AddAgentDialog
                        roomId={roomId}
                        roomAgentGlobalIds={agents.map((agent) => agent.global_agent_id ?? '')}
                        roomAgentIds={agents.map((agent) => agent.agent_id)}
                      />
                    )
                    : undefined
                }
              />
            </ConversationEmptyState>
          ) : (
            visibleMessages.map((m, index) => {
              const run = runByMessageId.get(m.id);
              const hasLocalStreamingState = streamingMessageIds.has(m.id) || streamingDisplay.isAnimating(m.id);
              const isStreamingMessage = shouldUseStreamingDisplayForMessage(m, run, hasLocalStreamingState);
              const displayMode = messageDisplayModes[m.id] ?? 'preview';
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  agentMeta={agentMap.get(m.sender_id)}
                  run={run}
                  runAgent={run ? agentByRoomId.get(run.room_agent_id) : undefined}
                  roomAgents={agents}
                  globalAgents={globalAgents}
                  roomId={roomId}
                  projectId={projectId}
                  streaming={isStreamingMessage}
                  displayContent={isStreamingMessage ? streamingDisplay.getDisplayedContent(m) : m.content}
                  displayMode={displayMode}
                  onDisplayModeChange={(mode) => setMessageDisplayModes((prev) => ({ ...prev, [m.id]: mode }))}
                  messageRef={(node) => registerMessageRef(m.id, node)}
                  highlighted={highlightMessageId === m.id}
                  onReply={() => onReplyToMessage(m)}
                  retrySourceMessage={findPreviousUserMessage(visibleMessages, index)}
                  onLocateReplyTarget={onLocateReplyTarget}
                />
              );
            })
          )}
        </ConversationContent>
        <ConversationScrollButton label={t('room.scrollToBottom')} />
      </Conversation>

      <RichMessageComposer
        projectId={projectId}
        resetKey={composerResetKey}
        onSend={submitUserMessage}
        sending={send.isPending}
        disabled={!canSendChat}
        agents={agents}
        replyTarget={defaultReplyTarget}
        onClearReplyTarget={
          explicitReplyTarget
            ? onClearReplyTarget
            : defaultReplyTarget
              ? () => setDefaultReplySuppressedForMessageId(defaultReplyTarget.messageId)
              : undefined
        }
        placeholder={
          agents.length === 0
            ? modelChatReady
              ? t('room.composerModelReady')
              : t('room.composerNoAgents')
            : t('room.composerReady')
        }
        routingHint={
          agents.length === 0 && modelChatReady
            ? t('room.routing.modelChat')
            : routingHint(
              routingMode,
              fallbackAgentId,
              agents.find((agent) => agent.agent_id === fallbackAgentId),
              t,
            )
        }
      />
    </div>
  );
}

function pairRunsWithAgentMessages(messages: Message[], runs: AgentRun[]): Map<string, AgentRun> {
  const result = new Map<string, AgentRun>();
  const usedRunIds = new Set<string>();
  const sortedRuns = [...runs].sort((a, b) => a.started_at - b.started_at);

  for (const message of messages) {
    if (message.sender_type !== 'agent' || message.message_type !== 'agent_stream') continue;
    const run = sortedRuns.find((candidate) => {
      if (usedRunIds.has(candidate.id)) return false;
      if (candidate.agent_id !== message.sender_id) return false;
      const distance = Math.abs(candidate.started_at - message.created_at);
      return distance <= 5000;
    });
    if (!run) continue;
    result.set(message.id, run);
    usedRunIds.add(run.id);
  }

  return result;
}

export function findPreviousUserMessage(messages: Message[], beforeIndex: number): Message | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.sender_type === 'user' && message.content.trim()) return message;
  }
  return null;
}

function MessageBubble({
  message,
  agentMeta,
  run,
  runAgent,
  roomAgents,
  globalAgents,
  roomId,
  projectId,
  streaming,
  displayContent,
  displayMode,
  onDisplayModeChange,
  messageRef,
  highlighted,
  onReply,
  retrySourceMessage,
  onLocateReplyTarget,
}: {
  message: Message;
  agentMeta?: RoomAgent;
  run?: AgentRun;
  runAgent?: RoomAgent;
  roomAgents: RoomAgent[];
  globalAgents: Agent[];
  roomId: string;
  projectId: string;
  streaming: boolean;
  displayContent: string;
  displayMode: 'preview' | 'source';
  onDisplayModeChange: (mode: 'preview' | 'source') => void;
  messageRef: (node: HTMLElement | null) => void;
  highlighted: boolean;
  onReply: () => void;
  retrySourceMessage?: Message | null;
  onLocateReplyTarget: (messageId: string) => void;
}) {
  const { t, formatRelativeTime } = useI18n();
  const queryClient = useQueryClient();
  const metadata = parseMessageMetadata(message.metadata);
  const saveAsMemory = useMutation({
    mutationFn: () =>
      api.createMemory(projectId, {
        scope: 'room',
        memory_type: 'fact',
        title: `${message.sender_name ?? message.sender_id}: ${(message.content ?? '').slice(0, 80)}`,
        content: message.content ?? '',
        room_id: roomId,
        source_type: 'message',
        source_id: message.id,
      }),
    onSuccess: () => {
      toast.success(t('memory.savedFromMessage'));
      queryClient.invalidateQueries({ queryKey: ['memories', projectId] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const retryAgentRun = useMutation({
    mutationFn: () => {
      const retryContent = retrySourceMessage?.content?.trim();
      if (!run || !retryContent) throw new Error('没有可重试的用户消息');
      return api.sendMessage(roomId, {
        content: retryContent,
        mentions: [run.agent_id],
      });
    },
    onSuccess: () => {
      toast.success('已重新发送给智能体');
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['agent-runs', roomId] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const continuePlanner = useMutation({
    mutationFn: (input: { source_message_id: string; planner_decision: PlannerDecision }) =>
      api.dispatchPlannerDecision(roomId, input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      queryClient.invalidateQueries({ queryKey: ['agent-runs', roomId] });
      const addedCount = result.added_agents?.length ?? 0;
      const deferredCount = result.deferred_steps?.length ?? 0;
      toast.success(
        result.dispatched > 0
          ? addedCount > 0
            ? deferredCount > 0
              ? `已加入 ${addedCount} 个智能体，先派发 ${result.dispatched} 个，暂缓 ${deferredCount} 个后续步骤`
              : `已加入 ${addedCount} 个智能体并派发 ${result.dispatched} 个智能体`
            : deferredCount > 0
              ? `已先派发 ${result.dispatched} 个智能体，暂缓 ${deferredCount} 个后续步骤`
              : `已派发 ${result.dispatched} 个智能体`
          : '没有可派发的下一步',
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const isUser = message.sender_type === 'user';
  const isSystem = message.sender_type === 'system';
  const attachments = metadata.attachments;
  const renderedContent = displayContent || (message.message_type === 'agent_stream' ? '…' : '');
  const hasContent = Boolean(renderedContent.trim());
  const hasMarkdownDisplayMode = hasContent && isMarkdownMessageContent(renderedContent);
  const isStreaming = shouldUseStreamingDisplayForMessage(message, run, streaming);
  const canReply = !isSystem && hasContent && !isStreaming;
  const canRetryAgentRun = !isUser && run?.status === 'failed' && Boolean(retrySourceMessage?.content?.trim());
  const showPlannerDecisionPanel = shouldShowPlannerDecisionPanel({
    isUser,
    decision: metadata.planner_decision,
  });

  if (isSystem) {
    return (
      <AiMessageRow
        ref={messageRef}
        variant="system"
        data-message-id={message.id}
        className={cn(highlighted && 'is-highlighted')}
      >
        {message.content}
      </AiMessageRow>
    );
  }

  return (
    <AiMessageRow
      ref={messageRef}
      variant={isUser ? 'user' : 'agent'}
      data-message-id={message.id}
      className={cn('fade-up', highlighted && 'is-highlighted')}
    >
      {!isUser && (
        <AgentAvatar name={message.sender_name ?? message.sender_id} size={32} active={!!agentMeta?.acp_enabled} />
      )}
      <div className="ai-message-card group">
        <AiMessageHeader>
          <AiMessageMeta>
            <span className="ai-message-sender">
              {isUser ? t('room.currentUser') : message.sender_name ?? message.sender_id}
            </span>
            <span className="ai-message-time">
              {formatRelativeTime(message.created_at)}
            </span>
          </AiMessageMeta>
          {agentMeta?.acp_enabled && agentMeta.acp_backend && (
            <AiMessageBadge>ACP:{agentMeta.acp_backend}</AiMessageBadge>
          )}
          {(hasContent || canRetryAgentRun) && (
            <AiMessageActions>
              {hasMarkdownDisplayMode && (
                <>
                  <button
                    type="button"
                    className={cn('ai-message-action', displayMode === 'preview' && 'is-active')}
                    title={t('message.preview')}
                    aria-label={t('message.preview')}
                    aria-pressed={displayMode === 'preview'}
                    onClick={() => onDisplayModeChange('preview')}
                  >
                    <Eye className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={cn('ai-message-action', displayMode === 'source' && 'is-active')}
                    title={t('message.source')}
                    aria-label={t('message.source')}
                    aria-pressed={displayMode === 'source'}
                    onClick={() => onDisplayModeChange('source')}
                  >
                    <FileText className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </>
              )}
              {canReply && (
                <button
                  type="button"
                  className="ai-message-action"
                  title="回复此消息"
                  onClick={onReply}
                >
                  <Reply className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )}
              {canRetryAgentRun && (
                <button
                  type="button"
                  className="ai-message-action"
                  title="重试此回复"
                  disabled={retryAgentRun.isPending}
                  onClick={() => retryAgentRun.mutate()}
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )}
              {hasContent && (
                <button
                  type="button"
                  className="ai-message-action"
                  title={t('memory.saveAsMemory')}
                  disabled={saveAsMemory.isPending}
                  onClick={() => saveAsMemory.mutate()}
                >
                  <BookmarkPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )}
            </AiMessageActions>
          )}
        </AiMessageHeader>
        <AiMessageBody stream={isStreaming}>
          {metadata.reply_to && (
            <button
              type="button"
              className="message-reply-reference"
              onClick={() => onLocateReplyTarget(metadata.reply_to!.message_id)}
              title="跳转到引用消息"
            >
              <span>{metadata.reply_to.sender_name ?? metadata.reply_to.sender_id}</span>
              <small>{metadata.reply_to.excerpt}</small>
            </button>
          )}
          {hasContent ? (
            <MessageContent
              content={renderedContent}
              streaming={isStreaming}
              mode={displayMode}
              trace={metadata.trace}
              roomAgents={roomAgents}
              globalAgents={globalAgents}
              suppressPlannerDecisionSummary={showPlannerDecisionPanel}
              roomId={roomId}
            />
          ) : message.message_type === 'agent_stream' ? (
            <MessageContent
              content="…"
              streaming={isStreaming}
              trace={metadata.trace}
              roomAgents={roomAgents}
              globalAgents={globalAgents}
              roomId={roomId}
            />
          ) : null}
          <MessageAttachments attachments={attachments} />
        </AiMessageBody>
        {showPlannerDecisionPanel && metadata.planner_decision && (
          <PlannerDecisionPanel
            decision={metadata.planner_decision}
            roomAgents={roomAgents}
            continuing={continuePlanner.isPending}
            onContinue={() => {
              const input = createPlannerDispatchInput(message, metadata);
              if (!input) return;
              continuePlanner.mutate(input);
            }}
          />
        )}
        {!isUser && run && (
          <AiMessageRunPanel>
            <AgentRunStatusCard
              roomId={roomId}
              run={run}
              agent={runAgent}
              compact
            />
          </AiMessageRunPanel>
        )}
      </div>
    </AiMessageRow>
  );
}

function PlannerDecisionPanel({
  decision,
  roomAgents,
  continuing,
  onContinue,
}: {
  decision: PlannerDecision;
  roomAgents: RoomAgent[];
  continuing: boolean;
  onContinue: () => void;
}) {
  const activeAgentIds = new Set(roomAgents.filter((agent) => agent.left_at === null).map((agent) => agent.agent_id));
  const missingAgentIds = decision.next_steps
    .map((step) => step.agent_id)
    .filter((agentId) => !activeAgentIds.has(agentId));
  const canContinue = hasDispatchablePlannerSteps(decision);
  return (
    <section className="mt-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/55 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
            Planner
          </span>
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
            {formatPlannerMode(decision.mode)}
          </span>
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
            {formatPlannerStatus(decision.status)}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
            {decision.next_steps.length} 步
          </span>
          <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
            {decision.awaiting_user_confirmation ? '等待确认' : '无需确认'}
          </span>
        </div>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-fg)]">{decision.summary}</p>
      {decision.next_steps.length > 0 && (
        <ol className="mt-2 grid gap-1.5">
          {decision.next_steps.map((step, index) => (
            <li
              key={`${step.agent_id}-${index}`}
              className="grid gap-1 rounded-md bg-[var(--color-surface-raised)]/60 px-2.5 py-2 text-[11.5px] text-[var(--color-fg-muted)] sm:grid-cols-[minmax(128px,0.32fr)_1fr] sm:items-start"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-[10px] text-[var(--color-muted)]">#{index + 1}</span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--color-fg)]" title={step.agent_id}>
                  {step.agent_id}
                </span>
              </div>
              <span className="min-w-0 leading-relaxed text-[var(--color-fg-muted)]">{step.goal}</span>
            </li>
          ))}
        </ol>
      )}
      {missingAgentIds.length > 0 && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
          缺席智能体：
          <span className="font-mono text-[var(--color-warning)]">{missingAgentIds.join(', ')}</span>。
          继续时会自动从全局智能体库查找并加入。
        </p>
      )}
      {decision.awaiting_user_confirmation && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {canContinue ? (
            <button
              type="button"
              className="glass-button glass-button-primary"
              disabled={continuing}
              onClick={onContinue}
            >
              {continuing ? '继续中…' : '按建议继续'}
            </button>
          ) : (
            <span className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[11.5px] text-[var(--color-fg-muted)]">
              当前建议没有可派发的下一步
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function formatPlannerMode(mode: PlannerDecision['mode']): string {
  return mode === 'auto_continue' ? '自动继续' : '建议后暂停';
}

function formatPlannerStatus(status: PlannerDecision['status']): string {
  const labels: Record<PlannerDecision['status'], string> = {
    suggested: '已建议',
    dispatching: '派发中',
    completed: '已完成',
    blocked: '已阻塞',
  };
  return labels[status];
}

function MessageAttachments({ attachments }: { attachments: MessageAttachmentMetadata[] }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<MessageAttachmentMetadata | null>(null);
  if (attachments.length === 0) return null;

  return (
    <>
      <div className="message-attachments">
        {attachments.map((attachment) => {
          if (attachment.deleted) {
            return (
              <div key={attachment.id} className="message-attachment-card is-deleted">
                <span className="message-attachment-icon" aria-hidden="true">
                  <FileText className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[12px] font-medium text-[var(--color-fg)]">{attachment.name}</span>
                  <span className="block truncate text-[10.5px] font-mono text-[var(--color-fg-muted)]">
                    {t('message.attachmentDeleted')}
                  </span>
                </span>
              </div>
            );
          }

          const content = (
            <>
              {attachment.isImage ? (
                <img src={attachment.url} alt={attachment.name} loading="lazy" />
              ) : (
                <span className="message-attachment-icon" aria-hidden="true">
                  <FileText className="h-4 w-4" />
                </span>
              )}
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[12px] font-medium text-[var(--color-fg)]">{attachment.name}</span>
                <span className="block truncate text-[10.5px] font-mono text-[var(--color-fg-muted)]">
                  {formatAttachmentSize(attachment.size)} · {attachment.mimeType}
                </span>
              </span>
              <Download className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" aria-hidden="true" />
            </>
          );

          return attachment.isImage ? (
            <button
              key={attachment.id}
              type="button"
              className="message-attachment-card is-image"
              onClick={() => setPreview(attachment)}
              aria-label={t('message.previewImage', { name: attachment.name })}
            >
              {content}
            </button>
          ) : (
            <a
              key={attachment.id}
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              className="message-attachment-card"
            >
              {content}
            </a>
          );
        })}
      </div>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="image-preview-dialog" title={preview?.name}>
          {preview && (
            <div className="image-preview-shell">
              <div className="image-preview-stage">
                <img src={preview.url} alt={preview.name} />
              </div>
              <div className="image-preview-footer">
                <span className="min-w-0 flex-1 truncate text-[11px] font-mono text-[var(--color-fg-muted)]">
                  {formatAttachmentSize(preview.size)} · {preview.mimeType}
                </span>
                <a href={preview.url} target="_blank" rel="noreferrer" className="image-preview-link">
                  {t('message.openOriginal')}
                </a>
                <a href={preview.url} download={preview.name} className="image-preview-link">
                  {t('message.download')}
                </a>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function routingHint(
  mode: 'mentions_only' | 'fallback_reply',
  fallbackAgentId: string | null,
  fallbackAgent: RoomAgent | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (mode === 'mentions_only') return t('room.routing.mentionsOnly');
  if (fallbackAgentId && !fallbackAgent) {
    return t('room.routing.fallbackMissing', { agentId: fallbackAgentId });
  }
  const agentName = fallbackAgent?.agent_name ?? t('room.routing.fallbackAgent');
  return t('room.routing.fallbackReply', { agentName });
}
