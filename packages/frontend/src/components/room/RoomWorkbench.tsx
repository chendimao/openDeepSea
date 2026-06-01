import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ClipboardList, GitBranch, MessagesSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { roomSocket, type WsServerEvent } from '../../lib/ws';
import { parseMessageMetadata } from '../../lib/messageMetadata';
import type {
  Agent,
  AgentRun,
  Message,
  Room,
  RoomAgent,
  Task,
  MessageLayer,
  WorkflowRun,
} from '../../lib/types';
import { useI18n } from '../../lib/i18n';
import { recordRecentRoomVisit } from '../../lib/recentRooms';
import { cn } from '../../lib/utils';
import {
  createStreamingDisplayState,
  enqueueStreamingChunk,
  flushStreamingDisplay,
  hasQueuedStreamingContent,
  resolveStreamingDisplayContent,
  shouldRetainStreamingDisplayState,
  tickStreamingDisplay,
  type StreamingDisplayState,
} from '../../lib/streamingDisplay';
import { createStreamingEventTracker, shouldApplyStreamingEvent } from '../../lib/streamingEvents';
import { AcpConfigPanel } from '../AcpConfigPanel';
import { AddAgentDialog } from '../AddAgentDialog';
import { MemoryPanel } from '../MemoryPanel';
import { RichMessageComposer } from '../RichMessageComposer';
import { RoomFilesPanel } from '../RoomFilesPanel';
import type { TaskLayerVisibility } from '../TaskDetailPanel';
import { TaskWorkspacePanel } from '../TaskWorkspacePanel';
import type { TaskStatusFilter } from '../taskBoardLogic';
import { WorkspaceEmptyState } from '../WorkspaceEmptyState';
import { ChatMessageBubble } from '../chat/ChatMessageBubble';
import { ChatPanelHeader, type RoomFeatureTab } from '../chat/ChatPanelHeader';
import {
  findPreviousUserMessage,
  pairRunsWithAgentMessages,
  shouldUseStreamingDisplayForMessage,
} from '../chat/chatMessageModel';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '../ai-elements/Conversation';
import {
  applyMessageStreamBatch,
  createDefaultReplyTarget,
  createReplyTarget,
  getRoutableActiveTaskId,
  projectRoomActivityMessages,
  selectConversationMessages,
  type MessageStreamUpdate,
  type ReplyTarget,
  type StreamTraceChannel,
} from '../../pages/roomPageLogic';

const DEFAULT_TASK_LAYER_VISIBILITY: TaskLayerVisibility = {
  chat: true,
  activity: true,
  timeline: true,
  runtime: true,
  diff: true,
};
const DEFAULT_TASK_STATUS_FILTERS: TaskStatusFilter[] = ['todo', 'in_progress', 'review', 'done', 'failed'];
const CHAT_EMPTY_ACTIVITY_ITEMS: Array<{ icon: LucideIcon; label: string; tone: string }> = [
  { icon: Bot, label: 'AI 正在等待第一条协作消息', tone: 'ready' },
  { icon: ClipboardList, label: 'Task Card 会在对话中自动浮现', tone: 'task' },
  { icon: GitBranch, label: 'Execution Plan 将同步到右侧工作区', tone: 'sync' },
];
type SendInput = {
  content: string;
  mentions?: string[];
  files?: File[];
  fileIds?: string[];
  replyToMessageId?: string;
  activeTaskId?: string | null;
};

export function RoomWorkbench({ projectId, roomId }: { projectId: string; roomId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [configAgent, setConfigAgent] = useState<RoomAgent | null>(null);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [streamingMessageIds, setStreamingMessageIds] = useState<Set<string>>(() => new Set());
  const [activeTab, setActiveTab] = useState<RoomFeatureTab>('chat');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [autoActiveTaskDismissedRoomId, setAutoActiveTaskDismissedRoomId] = useState<string | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<TaskLayerVisibility>(DEFAULT_TASK_LAYER_VISIBILITY);
  const [taskStatusFilters, setTaskStatusFilters] = useState<TaskStatusFilter[]>(DEFAULT_TASK_STATUS_FILTERS);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [explicitReplyTarget, setExplicitReplyTarget] = useState<ReplyTarget | null>(null);
  const messageRefs = useRef<Map<string, HTMLElement>>(new Map());
  const streamingRunMessageIds = useRef<Map<string, string>>(new Map());
  const streamingEventTracker = useRef(createStreamingEventTracker());
  const finalizedStreamMessageIds = useRef<Set<string>>(new Set());
  const finalizedStreamRunIds = useRef<Set<string>>(new Set());
  const pendingStreamUpdates = useRef<MessageStreamUpdate[]>([]);
  const streamFlushFrame = useRef<number | null>(null);
  const {
    t,
    formatRelativeTime,
    interactionModeLabel,
    taskPriorityLabel,
    taskStatusLabel,
    workflowStatusLabel,
  } = useI18n();

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
  const { data: tasks = [] } = useQuery({
    queryKey: ['room-tasks', roomId],
    queryFn: () => api.listRoomTasks(roomId),
    enabled: !!roomId,
  });
  const { data: workflows = [] } = useQuery({
    queryKey: ['room-workflows', roomId],
    queryFn: () => api.listRoomWorkflows(roomId),
    enabled: !!roomId,
  });
  const { data: roomTaskEventResponse } = useQuery({
    queryKey: ['room-task-events', roomId, 'activity'],
    queryFn: () => api.listRoomTaskEvents(roomId, { layer: 'activity', limit: 80 }),
    enabled: !!roomId,
  });
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  const { data: activeTaskEventResponse, isLoading: activeTaskEventsLoading } = useQuery({
    queryKey: ['room-task-events', activeTask?.room_id, activeTask?.id],
    queryFn: () => api.listRoomTaskEvents(activeTask!.room_id, { taskId: activeTask!.id, limit: 80 }),
    enabled: !!activeTask,
  });
  const { data: taskExecutors = [], isLoading: taskExecutorsLoading } = useQuery({
    queryKey: ['task-executors', activeTask?.id],
    queryFn: () => api.listTaskExecutors(activeTask!.id),
    enabled: !!activeTask,
  });
  const roomActivityEvents = useMemo(() => {
    const byId = new Map((roomTaskEventResponse?.events ?? []).map((event) => [event.id, event]));
    for (const event of projectRoomActivityMessages(messages)) {
      byId.set(event.id, event);
    }
    return [...byId.values()];
  }, [messages, roomTaskEventResponse?.events]);
  const routableActiveTaskId = getRoutableActiveTaskId(activeTask);
  const updateTaskStatus = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: Task['status'] }) =>
      api.updateTask(task.id, { status }),
    onSuccess: (task) => {
      queryClient.setQueryData<Task[] | undefined>(['room-tasks', roomId], (prev) =>
        upsertTask(prev, task),
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const startTaskLoop = useMutation({
    mutationFn: (task: Task) => api.sendMessage(roomId, {
      content: t('taskWorkspace.startLoopPrompt', { id: task.id, title: task.title }),
      activeTaskId: task.id,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-task-events', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      toast.success(t('taskWorkspace.loopStarted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const activateTask = useMutation({
    mutationFn: (task: Task) => api.activateTask(roomId, task.id),
    onMutate: (task) => {
      setActiveTaskId(task.id);
      setShowMemoryPanel(false);
    },
    onError: (err) => toast.error((err as Error).message),
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
  const updateRoom = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; last_opened_at?: number | null; pinned_at?: number | null } }) =>
      api.updateRoom(id, patch),
    onSuccess: (updatedRoom) => {
      queryClient.setQueryData<Room | undefined>(['room', updatedRoom.id], updatedRoom);
      queryClient.setQueryData<Room[] | undefined>(['rooms', updatedRoom.project_id], (prev) =>
        prev?.map((item) => (item.id === updatedRoom.id ? updatedRoom : item)),
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  useEffect(() => {
    setActiveTab('chat');
    setShowMemoryPanel(false);
    setHighlightMessageId(null);
    setExplicitReplyTarget(null);
    setActiveTaskId(null);
    setAutoActiveTaskDismissedRoomId(null);
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
    updateRoom.mutate({
      id: room.id,
      patch: { last_opened_at: Date.now() },
    });
  }, [project?.id, room?.id]);

  useEffect(() => {
    if (tasks.length === 0) return;
    if (activeTaskId && tasks.some((task) => task.id === activeTaskId)) return;
    if (activeTaskId) {
      setActiveTaskId(null);
      return;
    }
    if (autoActiveTaskDismissedRoomId === roomId) return;
    setActiveTaskId(tasks[0].id);
  }, [activeTaskId, autoActiveTaskDismissedRoomId, roomId, tasks]);

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
  const clearActiveTask = useCallback(() => {
    setActiveTaskId(null);
    setAutoActiveTaskDismissedRoomId(roomId);
  }, [roomId]);
  const updateLayerVisibility = useCallback((layer: MessageLayer, visible: boolean) => {
    setLayerVisibility((current) => ({ ...current, [layer]: visible }));
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
        if (event.run.task_id) {
          queryClient.invalidateQueries({ queryKey: ['task-executors', event.run.task_id] });
        }
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
      } else if (event.type === 'task:created' && event.task.room_id === roomId) {
        queryClient.setQueryData<Task[] | undefined>(['room-tasks', roomId], (prev) =>
          upsertTask(prev, event.task),
        );
      } else if (event.type === 'task:updated' && event.task.room_id === roomId) {
        queryClient.setQueryData<Task[] | undefined>(['room-tasks', roomId], (prev) =>
          upsertTask(prev, event.task),
        );
      } else if (event.type === 'task:deleted') {
        queryClient.setQueryData<Task[] | undefined>(['room-tasks', roomId], (prev) =>
          (prev ?? []).filter((task) => task.id !== event.taskId),
        );
        setActiveTaskId((current) => (current === event.taskId ? null : current));
      } else if (event.type === 'task:activated' && event.roomId === roomId) {
        setActiveTaskId(event.taskId);
        setAutoActiveTaskDismissedRoomId(null);
        setShowMemoryPanel(false);
      } else if (event.type === 'task_event:new' && event.roomId === roomId) {
        queryClient.invalidateQueries({ queryKey: ['room-task-events', roomId] });
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
    <div className="workspace-root" data-testid="room-workbench">
      <div className={cn('workspace-grid task-os-grid', showMemoryPanel && 'has-inspector')}>
        <TaskWorkspacePanel
          tasks={tasks}
          activeTask={activeTask}
          activeTaskId={activeTaskId}
          statusFilters={taskStatusFilters}
          onStatusFiltersChange={setTaskStatusFilters}
          activityEvents={roomActivityEvents}
          taskEvents={activeTaskEventResponse?.events ?? []}
          taskEventsLoading={activeTaskEventsLoading}
          executors={taskExecutors}
          executorsLoading={taskExecutorsLoading}
          agents={agents}
          workflows={workflows}
          layerVisibility={layerVisibility}
          onSelectTask={(task) => {
            setAutoActiveTaskDismissedRoomId(null);
            activateTask.mutate(task);
          }}
          onChangeStatus={(task, status) => {
            updateTaskStatus.mutate({ task, status });
          }}
          onStartWorkflow={(task) => startTaskLoop.mutate(task)}
          startingTaskId={startTaskLoop.variables?.id ?? null}
          onLocateSourceMessage={focusMessage}
          onLayerVisibilityChange={updateLayerVisibility}
          onClearActiveTask={clearActiveTask}
          t={t}
          formatRelativeTime={formatRelativeTime}
          taskStatusLabel={taskStatusLabel}
          taskPriorityLabel={taskPriorityLabel}
          interactionModeLabel={interactionModeLabel}
          workflowStatusLabel={workflowStatusLabel}
        />
        <section className="workbench-panel room-main-panel" aria-label={t('room.viewLabel')}>
          <ChatPanelHeader
            project={project}
            room={room}
            agents={agents}
            showMemoryPanel={showMemoryPanel}
            onToggleMemoryPanel={() => {
              setShowMemoryPanel((v) => !v);
              if (!showMemoryPanel) setConfigAgent(null);
            }}
            onSelectAgent={setConfigAgent}
          />
          <div className="room-tab-content">
            {activeTab === 'chat' && (
              <ChatColumn
                messages={messages}
                tasks={tasks}
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
                activeTask={activeTask}
                activeTaskId={routableActiveTaskId}
                onReplyToMessage={replyToMessage}
                onClearReplyTarget={() => setExplicitReplyTarget(null)}
                onClearActiveTask={clearActiveTask}
                onLocateReplyTarget={focusMessage}
                onSelectTask={(task) => {
                  setAutoActiveTaskDismissedRoomId(null);
                  activateTask.mutate(task);
                }}
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

function upsertTask(prev: Task[] | undefined, task: Task): Task[] {
  const list = prev ?? [];
  return [task, ...list.filter((item) => item.id !== task.id)]
    .sort((a, b) => b.updated_at - a.updated_at);
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

function ChatColumn({
  messages,
  tasks,
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
  activeTask,
  activeTaskId,
  onReplyToMessage,
  onClearReplyTarget,
  onClearActiveTask,
  onLocateReplyTarget,
  onSelectTask,
}: {
  messages: Message[];
  tasks: Task[];
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
  activeTask: Task | null;
  activeTaskId: string | null;
  onReplyToMessage: (message: Message) => void;
  onClearReplyTarget: () => void;
  onClearActiveTask: () => void;
  onLocateReplyTarget: (messageId: string) => void;
  onSelectTask: (task: Task) => void;
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
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const visibleMessages = useMemo(() => selectConversationMessages(dedupeMessages(messages)), [messages]);
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
  const taskRouteTarget = activeTaskId && activeTask
    ? {
      kind: 'task' as const,
      label: t('composer.targetTask', { id: activeTask.id.slice(0, 6), title: activeTask.title }),
      onClear: onClearActiveTask,
    }
    : {
      kind: 'global' as const,
      label: t('composer.targetGlobal'),
    };

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
    send.mutate({
      content,
      mentions: input.mentions,
      files,
      fileIds,
      replyToMessageId: input.replyToMessageId,
      activeTaskId,
    });
  }, [activeTaskId, send]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Conversation className="flex-1">
        <ConversationContent>
          {visibleMessages.length === 0 ? (
            <ConversationEmptyState>
              <WorkspaceEmptyState
                icon={<MessagesSquare className="h-8 w-8" strokeWidth={1.75} />}
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
              >
                <div className="room-empty-activity" aria-hidden="true">
                  {CHAT_EMPTY_ACTIVITY_ITEMS.map(({ icon: Icon, label, tone }) => (
                    <span key={label} data-tone={tone}>
                      <Icon className="room-empty-activity-icon" strokeWidth={1.8} />
                      <b>{label}</b>
                    </span>
                  ))}
                </div>
              </WorkspaceEmptyState>
            </ConversationEmptyState>
          ) : (
            visibleMessages.map((m, index) => {
              const run = runByMessageId.get(m.id);
              const hasLocalStreamingState = streamingMessageIds.has(m.id) || streamingDisplay.isAnimating(m.id);
              const isStreamingMessage = shouldUseStreamingDisplayForMessage(m, run, hasLocalStreamingState);
              const displayMode = messageDisplayModes[m.id] ?? 'preview';
              const metadata = parseMessageMetadata(m.metadata);
              const task = metadata.task_id ? taskById.get(metadata.task_id) : undefined;
              return (
                <ChatMessageBubble
                  key={m.id}
                  message={m}
                  agentMeta={agentMap.get(m.sender_id)}
                  run={run}
                  runAgent={run ? agentByRoomId.get(run.room_agent_id) : undefined}
                  roomAgents={agents}
                  globalAgents={globalAgents}
                  roomId={roomId}
                  projectId={projectId}
                  task={task}
                  activeTaskId={activeTaskId}
                  streaming={isStreamingMessage}
                  displayContent={isStreamingMessage ? streamingDisplay.getDisplayedContent(m) : m.content}
                  displayMode={displayMode}
                  onDisplayModeChange={(mode) => setMessageDisplayModes((prev) => ({ ...prev, [m.id]: mode }))}
                  messageRef={(node) => registerMessageRef(m.id, node)}
                  highlighted={highlightMessageId === m.id}
                  onReply={() => onReplyToMessage(m)}
                  retrySourceMessage={findPreviousUserMessage(visibleMessages, index)}
                  onLocateReplyTarget={onLocateReplyTarget}
                  onSelectTask={onSelectTask}
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
        taskRouteTarget={taskRouteTarget}
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
