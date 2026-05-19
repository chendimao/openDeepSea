import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, Brain, CheckSquare, ChevronDown, ChevronLeft, Download, FileText, FolderOpen, ListTodo, MessageSquare, Play, Plus, RotateCcw, Settings2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { roomSocket, type WsServerEvent } from '../lib/ws';
import type { AgentRun, Message, MessageAttachmentMetadata, Room, RoomAgent, Task, WorkflowRun } from '../lib/types';
import { parseMessageMetadata } from '../lib/messageMetadata';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import {
  createStreamingDisplayState,
  enqueueStreamingChunk,
  flushStreamingDisplay,
  hasQueuedStreamingContent,
  shouldRetainStreamingDisplayState,
  tickStreamingDisplay,
  type StreamingDisplayState,
} from '../lib/streamingDisplay';
import { createStreamingEventTracker, shouldApplyStreamingEvent } from '../lib/streamingEvents';
import { AgentAvatar } from '../components/AgentAvatar';
import { AgentRunStatusCard } from '../components/AgentRunPanel';
import { AcpConfigPanel } from '../components/AcpConfigPanel';
import { AddAgentDialog } from '../components/AddAgentDialog';
import { CreateTaskDialog } from '../components/CreateTaskDialog';
import { MemoryPanel } from '../components/MemoryPanel';
import { RichMessageComposer } from '../components/RichMessageComposer';
import { TaskBoard } from '../components/TaskBoard';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import { RoomFilesPanel } from '../components/RoomFilesPanel';
import { MessageContent } from '../components/MessageContent';
import { CollaborationDecisionCard } from '../components/CollaborationDecisionCard';
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

type SendInput = { content: string; mentions?: string[]; files?: File[]; fileIds?: string[] };
type RoomFeatureTab = 'chat' | 'tasks' | 'files';

export function RoomPage() {
  const { projectId = '', roomId = '' } = useParams();
  const queryClient = useQueryClient();
  const [configAgent, setConfigAgent] = useState<RoomAgent | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [streamingMessageIds, setStreamingMessageIds] = useState<Set<string>>(() => new Set());
  const [activeTab, setActiveTab] = useState<RoomFeatureTab>('chat');
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const messageRefs = useRef<Map<string, HTMLElement>>(new Map());
  const streamingRunMessageIds = useRef<Map<string, string>>(new Map());
  const streamingEventTracker = useRef(createStreamingEventTracker());
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
  const rootTasks = tasks.filter((task) => !task.parent_task_id);
  const taskWorkflowKey = rootTasks.map((task) => task.id).join(',');
  const { data: taskWorkflows = [] } = useQuery({
    queryKey: ['room-workflows', roomId, taskWorkflowKey],
    queryFn: async () => {
      const all = await Promise.all(rootTasks.map((task) => api.listTaskWorkflows(task.id)));
      return all.flat();
    },
    enabled: rootTasks.length > 0,
  });
  const { data: agentRuns = [] } = useQuery({
    queryKey: ['agent-runs', roomId],
    queryFn: () => api.listAgentRuns(roomId),
    enabled: !!roomId,
    refetchInterval: (query) => {
      const runs = query.state.data as AgentRun[] | undefined;
      return runs?.some((run) => run.status === 'running' || run.status === 'queued') ? 2000 : false;
    },
  });
  const streamingDisplay = useStreamingMessageDisplay(roomId);
  const workflowById = useMemo(
    () => new Map(taskWorkflows.map((workflow) => [workflow.id, workflow])),
    [taskWorkflows],
  );

  useEffect(() => {
    setActiveTab('chat');
    setSelectedTask(null);
    setShowMemoryPanel(false);
    setHighlightMessageId(null);
    messageRefs.current.clear();
    streamingRunMessageIds.current.clear();
    streamingEventTracker.current.clear();
  }, [roomId]);

  useEffect(() => {
    if (activeTab !== 'tasks') return;
    const rootTasks = tasks
      .filter((task) => !task.parent_task_id)
      .sort((a, b) => b.updated_at - a.updated_at);
    if (rootTasks.length === 0) {
      setSelectedTask(null);
      return;
    }
    if (!selectedTask || !rootTasks.some((task) => task.id === selectedTask.id)) {
      setSelectedTask(rootTasks[0] ?? null);
    }
  }, [activeTab, selectedTask, tasks]);

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

  const updateTaskStatus = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: Task['status'] }) =>
      api.updateTask(task.id, { status }),
    onError: (err) => toast.error((err as Error).message),
  });

  const retryWorkflow = useMutation({
    mutationFn: (workflowId: string) => api.retryWorkflowStep(workflowId),
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ['task-workflows', workflow.task_id] });
      queryClient.invalidateQueries({ queryKey: ['workflow', workflow.id] });
      queryClient.invalidateQueries({ queryKey: ['agent-runs', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-tasks', roomId] });
      toast.success(t('room.retryStageDone'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const startWorkflow = useMutation({
    mutationFn: (task: Task) =>
      api.startWorkflowWithConversation(task.room_id, task.id, {
        content: t('workflow.startIntent', { title: task.title }),
      }),
    onSuccess: (workflow) => {
      invalidateWorkflowConversationQueries(queryClient, workflow.room_id, workflow.task_id, workflow.id);
      toast.success(t('taskDetail.workflowStarted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

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
        let matchedMessage = false;
        let fullContent = '';
        if (event.runId) {
          streamingRunMessageIds.current.set(event.runId, event.messageId);
        }
        queryClient.setQueryData<Message[] | undefined>(['messages', roomId], (prev) => {
          if (!prev) return prev;
          const next = prev.map((m) => {
            if (m.id !== event.messageId) return m;
            matchedMessage = true;
            fullContent = m.content + event.chunk;
            return event.done && event.message ? event.message : { ...m, content: fullContent };
          });
          return dedupeMessages(next);
        });
        if (event.chunk) {
          streamingDisplay.appendChunk(event.messageId, event.chunk);
        }
        if (!matchedMessage) {
          queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
        }
        if (event.done) {
          const fallbackContent = queryClient
            .getQueryData<Message[]>(['messages', roomId])
            ?.find((message) => message.id === event.messageId)
            ?.content ?? fullContent;
          streamingDisplay.finishMessage(event.messageId, fallbackContent);
        }
        setStreamingMessageIds((prev) =>
          event.done ? removeStreamingMessageId(prev, event.messageId) : addStreamingMessageId(prev, event.messageId),
        );
        if (event.done && event.runId) {
          streamingRunMessageIds.current.delete(event.runId);
        }
      } else if (
        (event.type === 'agent_run:created' || event.type === 'agent_run:updated') &&
        event.roomId === roomId
      ) {
        queryClient.setQueryData<AgentRun[] | undefined>(['agent-runs', roomId], (prev) =>
          upsertAgentRun(prev, event.run),
        );
        if (event.type === 'agent_run:updated' && isTerminalAgentRunStatus(event.run.status)) {
          const messageId =
            streamingRunMessageIds.current.get(event.run.id) ??
            findAgentRunMessageId(queryClient.getQueryData<Message[]>(['messages', roomId]), event.run);
          if (messageId) {
            setStreamingMessageIds((prev) => removeStreamingMessageId(prev, messageId));
            streamingRunMessageIds.current.delete(event.run.id);
          }
        }
      } else if (event.type === 'room:agent_joined' && event.roomId === roomId) {
        queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      } else if (event.type === 'room:agent_left' && event.roomId === roomId) {
        queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      } else if (
        (event.type === 'workflow:created' || event.type === 'workflow:updated') &&
        event.roomId === roomId
      ) {
        queryClient.setQueryData<WorkflowRun[] | undefined>(
          ['task-workflows', event.workflow.task_id],
          (prev) => upsertWorkflow(prev, event.workflow),
        );
        queryClient.setQueriesData<WorkflowRun[] | undefined>(
          { queryKey: ['room-workflows', roomId] },
          (prev) => upsertWorkflow(prev, event.workflow),
        );
        queryClient.invalidateQueries({ queryKey: ['workflow', event.workflow.id] });
      } else if (
        (event.type === 'workflow_step:created' || event.type === 'workflow_step:updated') &&
        event.roomId === roomId
      ) {
        queryClient.invalidateQueries({ queryKey: ['task-workflows', event.step.task_id] });
        queryClient.invalidateQueries({ queryKey: ['workflow', event.step.workflow_run_id] });
      } else if (event.type === 'workflow_artifact:created' && event.roomId === roomId) {
        queryClient.invalidateQueries({ queryKey: ['task-workflows', event.artifact.task_id] });
        queryClient.invalidateQueries({ queryKey: ['workflow', event.artifact.workflow_run_id] });
      } else if (event.type === 'task:created' && event.task.room_id === roomId) {
        queryClient.setQueryData<Task[] | undefined>(['room-tasks', roomId], (prev) =>
          prev ? [event.task, ...prev.filter((task) => task.id !== event.task.id)] : [event.task],
        );
      } else if (event.type === 'task:updated' && event.task.room_id === roomId) {
        queryClient.setQueryData<Task[] | undefined>(['room-tasks', roomId], (prev) =>
          prev ? prev.map((task) => (task.id === event.task.id ? event.task : task)) : [event.task],
        );
        setSelectedTask((current) => (current?.id === event.task.id ? event.task : current));
      } else if (event.type === 'task:deleted') {
        queryClient.setQueryData<Task[] | undefined>(['room-tasks', roomId], (prev) =>
          prev?.filter((task) => task.id !== event.taskId),
        );
        setSelectedTask((current) => (current?.id === event.taskId ? null : current));
      }
    });
    return () => {
      roomSocket.unsubscribe(roomId);
      off();
    };
  }, [roomId, queryClient, streamingDisplay.appendChunk, streamingDisplay.finishMessage]);

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
              setSelectedTask(null);
              setConfigAgent(agent);
            }}
          />
          <span className="inline-flex">
            <CreateTaskDialog roomId={roomId} agents={agents}>
              <button type="button" className="glass-button glass-button-primary" aria-label={t('room.newTask')}>
                <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
                <span className="hidden sm:inline">{t('room.newTask')}</span>
              </button>
            </CreateTaskDialog>
          </span>
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
              if (!showMemoryPanel) { setConfigAgent(null); setSelectedTask(null); }
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
                agentRuns={agentRuns}
                roomId={roomId}
                projectId={projectId}
                modelChatReady={Boolean(settings?.system.langchain_planner_model && settings.system.openai_api_key_set)}
                routingMode={settings?.effective.message_routing_mode ?? project?.message_routing_mode ?? 'mentions_only'}
                fallbackAgentId={settings?.effective.fallback_agent_id ?? project?.fallback_agent_id ?? null}
                onRetryWorkflow={(workflowId) => retryWorkflow.mutate(workflowId)}
                retryingWorkflowId={retryWorkflow.isPending ? retryWorkflow.variables : undefined}
                workflowById={workflowById}
                streamingMessageIds={streamingMessageIds}
                streamingDisplay={streamingDisplay}
                registerMessageRef={registerMessageRef}
                highlightMessageId={highlightMessageId}
              />
            )}
            {activeTab === 'tasks' && (
              <div className="room-task-tab">
                <TaskBoard
                  tasks={tasks}
                  agents={agents}
                  workflows={taskWorkflows}
                  selectedTaskId={selectedTask?.id ?? null}
                  onSelectTask={(task) => {
                    setConfigAgent(null);
                    setShowMemoryPanel(false);
                    setSelectedTask(task);
                  }}
                  onChangeStatus={(task, status) => updateTaskStatus.mutate({ task, status })}
                  onStartWorkflow={(task) => startWorkflow.mutate(task)}
                  onLocateSourceMessage={focusMessage}
                  startingTaskId={startWorkflow.isPending ? startWorkflow.variables?.id : null}
                />
                {selectedTask && (
                  <TaskDetailPanel
                    task={selectedTask}
                    agents={agents}
                    projectId={projectId}
                    onLocateSourceMessage={focusMessage}
                    onClose={() => setSelectedTask(null)}
                  />
                )}
              </div>
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

  const getDisplayedContent = useCallback((message: Message) => {
    return displayStates.get(message.id)?.displayed ?? message.content;
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
    getDisplayedContent,
    isAnimating,
  }), [appendChunk, finishMessage, getDisplayedContent, isAnimating]);
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

function upsertAgentRun(prev: AgentRun[] | undefined, run: AgentRun): AgentRun[] {
  const list = prev ?? [];
  return [run, ...list.filter((item) => item.id !== run.id)]
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, 50);
}

function upsertWorkflow(prev: WorkflowRun[] | undefined, workflow: WorkflowRun): WorkflowRun[] {
  const list = prev ?? [];
  return [workflow, ...list.filter((item) => item.id !== workflow.id)]
    .sort((a, b) => b.created_at - a.created_at);
}

function invalidateWorkflowConversationQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  roomId: string,
  taskId: string,
  workflowId: string,
) {
  queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
  queryClient.invalidateQueries({ queryKey: ['room-tasks', roomId] });
  queryClient.invalidateQueries({ queryKey: ['room-workflows', roomId] });
  queryClient.invalidateQueries({ queryKey: ['task-workflows', taskId] });
  queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
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
    { id: 'tasks', label: t('room.tab.tasks'), icon: ListTodo },
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
  agentRuns,
  roomId,
  projectId,
  modelChatReady,
  routingMode,
  fallbackAgentId,
  onRetryWorkflow,
  retryingWorkflowId,
  workflowById,
  streamingMessageIds,
  streamingDisplay,
  registerMessageRef,
  highlightMessageId,
}: {
  messages: Message[];
  agents: RoomAgent[];
  agentRuns: AgentRun[];
  roomId: string;
  projectId: string;
  modelChatReady: boolean;
  routingMode: 'mentions_only' | 'fallback_reply';
  fallbackAgentId: string | null;
  onRetryWorkflow: (workflowId: string) => void;
  retryingWorkflowId?: string;
  workflowById: Map<string, WorkflowRun>;
  streamingMessageIds: Set<string>;
  streamingDisplay: StreamingMessageDisplay;
  registerMessageRef: (messageId: string, node: HTMLElement | null) => void;
  highlightMessageId: string | null;
}) {
  const [composerResetKey, setComposerResetKey] = useState(0);
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
  const latestWorkflowEventMessageIds = useMemo(
    () => latestWorkflowEventMessageIdsByRun(visibleMessages),
    [visibleMessages],
  );
  const canSendChat = agents.length > 0 || modelChatReady;

  const send = useMutation({
    mutationFn: (input: SendInput) => api.sendMessage(roomId, input),
    onSuccess: () => {
      setComposerResetKey((key) => key + 1);
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-tasks', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-workflows', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      queryClient.invalidateQueries({ queryKey: ['project-files', projectId] });
      queryClient.invalidateQueries({ queryKey: ['files'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const handleSend = (input: SendInput) => {
    const content = input.content.trim();
    const files = input.files;
    const fileIds = input.fileIds;
    if (!content && (!files || files.length === 0) && (!fileIds || fileIds.length === 0)) return;
    send.mutate({ content, mentions: input.mentions, files, fileIds });
  };

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
            visibleMessages.map((m) => {
              const run = runByMessageId.get(m.id);
              const isStreamingMessage = streamingMessageIds.has(m.id) || streamingDisplay.isAnimating(m.id);
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  agentMeta={agentMap.get(m.sender_id)}
                  agents={agents}
                  run={run}
                  runAgent={run ? agentByRoomId.get(run.room_agent_id) : undefined}
                  roomId={roomId}
                  projectId={projectId}
                  onRetryWorkflow={onRetryWorkflow}
                  retryingWorkflowId={retryingWorkflowId}
                  workflowById={workflowById}
                  latestWorkflowEventMessageIds={latestWorkflowEventMessageIds}
                  streaming={isStreamingMessage}
                  displayContent={isStreamingMessage ? streamingDisplay.getDisplayedContent(m) : m.content}
                  messageRef={(node) => registerMessageRef(m.id, node)}
                  highlighted={highlightMessageId === m.id}
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
        onSend={handleSend}
        sending={send.isPending}
        disabled={!canSendChat}
        agents={agents}
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

function latestWorkflowEventMessageIdsByRun(messages: Message[]): Map<string, string> {
  const latest = new Map<string, { messageId: string; createdAt: number }>();
  for (const message of messages) {
    if (message.sender_type !== 'system') continue;
    const metadata = parseMessageMetadata(message.metadata);
    if (!metadata.workflow_run_id || !metadata.event_type?.startsWith('workflow_')) continue;
    const current = latest.get(metadata.workflow_run_id);
    if (!current || message.created_at >= current.createdAt) {
      latest.set(metadata.workflow_run_id, { messageId: message.id, createdAt: message.created_at });
    }
  }
  return new Map(Array.from(latest, ([workflowId, item]) => [workflowId, item.messageId]));
}

function MessageBubble({
  message,
  agentMeta,
  agents,
  run,
  runAgent,
  roomId,
  projectId,
  onRetryWorkflow,
  retryingWorkflowId,
  workflowById,
  latestWorkflowEventMessageIds,
  streaming,
  displayContent,
  messageRef,
  highlighted,
}: {
  message: Message;
  agentMeta?: RoomAgent;
  agents: RoomAgent[];
  run?: AgentRun;
  runAgent?: RoomAgent;
  roomId: string;
  projectId: string;
  onRetryWorkflow: (workflowId: string) => void;
  retryingWorkflowId?: string;
  workflowById: Map<string, WorkflowRun>;
  latestWorkflowEventMessageIds: Map<string, string>;
  streaming: boolean;
  displayContent: string;
  messageRef: (node: HTMLElement | null) => void;
  highlighted: boolean;
}) {
  const { t, formatRelativeTime } = useI18n();
  const queryClient = useQueryClient();
  const metadata = parseMessageMetadata(message.metadata);
  const startCollaboration = useMutation({
    mutationFn: () => {
      if (!metadata.collaboration_decision || !metadata.source_message_id) {
        throw new Error('collaboration decision is missing source message');
      }
      return api.startCollaboration(roomId, {
        source_message_id: metadata.source_message_id,
        decision: metadata.collaboration_decision,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['agent-runs', roomId] });
      toast.success('已启动群聊协作');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const promoteToWorkflow = useMutation({
    mutationFn: () => {
      if (!metadata.collaboration_decision || !metadata.source_message_id) {
        throw new Error('collaboration decision is missing source message');
      }
      return api.promoteMessageToWorkflow(roomId, metadata.source_message_id, {
        decision: metadata.collaboration_decision,
      });
    },
    onSuccess: ({ task, workflow }) => {
      invalidateWorkflowConversationQueries(queryClient, roomId, task.id, workflow.id);
      toast.success(t('taskDetail.workflowStarted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
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
  const [readinessDismissed, setReadinessDismissed] = useState(false);
  const promoteReadyTask = useMutation({
    mutationFn: () => api.promoteMessageToWorkflow(roomId, message.id),
    onSuccess: ({ task, workflow }) => {
      invalidateWorkflowConversationQueries(queryClient, roomId, task.id, workflow.id);
      toast.success(t('taskDetail.workflowStarted'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const isUser = message.sender_type === 'user';
  const isSystem = message.sender_type === 'system';
  const attachments = metadata.attachments;
  const renderedContent = displayContent || (message.message_type === 'agent_stream' ? '…' : '');
  const hasContent = Boolean(renderedContent.trim());
  const isStreaming = !isUser && message.message_type === 'agent_stream' && (
    streaming || run?.status === 'running' || run?.status === 'queued'
  );
  const isTaskEvent = isSystem && Boolean(metadata.event_type && metadata.task_id);
  const eventWorkflow = metadata.workflow_run_id ? workflowById.get(metadata.workflow_run_id) : undefined;
  const isLatestWorkflowEvent = Boolean(
    metadata.workflow_run_id &&
      latestWorkflowEventMessageIds.get(metadata.workflow_run_id) === message.id,
  );
  const canRetryWorkflowEvent = isTaskEvent &&
    metadata.event_type === 'workflow_blocked' &&
    Boolean(metadata.workflow_run_id) &&
    isLatestWorkflowEvent &&
    (!eventWorkflow || eventWorkflow.status === 'blocked');
  const isCollaborationDecision = isSystem && Boolean(metadata.collaboration_decision && metadata.source_message_id);
  const shouldShowTaskReadiness =
    !isUser &&
    !isSystem &&
    !isStreaming &&
    !readinessDismissed &&
    metadata.task_readiness?.ready === true;

  if (isTaskEvent) {
    return (
      <AiMessageRow
        ref={messageRef}
        variant="event"
        data-message-id={message.id}
        className={cn(highlighted && 'is-highlighted')}
      >
        <div className="task-event-row" title={message.content || metadata.task_title || metadata.task_id}>
          <CheckSquare className="h-3.5 w-3.5" strokeWidth={1.8} />
          <span>{message.content}</span>
          {canRetryWorkflowEvent && metadata.workflow_run_id && (
            <button
              type="button"
              className="task-event-action"
              disabled={retryingWorkflowId === metadata.workflow_run_id}
              title={t('agentRun.retryStage')}
              aria-label={t('agentRun.retryStage')}
              onClick={(event) => {
                event.stopPropagation();
                onRetryWorkflow(metadata.workflow_run_id!);
              }}
            >
              <RotateCcw className={cn('h-3 w-3', retryingWorkflowId === metadata.workflow_run_id && 'animate-spin')} strokeWidth={1.8} />
              <span>{t('common.retry')}</span>
            </button>
          )}
        </div>
      </AiMessageRow>
    );
  }

  if (isCollaborationDecision && metadata.collaboration_decision && metadata.source_message_id) {
    return (
      <AiMessageRow
        ref={messageRef}
        variant="event"
        data-message-id={message.id}
        className={cn(highlighted && 'is-highlighted')}
      >
        <CollaborationDecisionCard
          decision={metadata.collaboration_decision}
          sourceMessageId={metadata.source_message_id}
          agents={agents}
          starting={startCollaboration.isPending}
          promoting={promoteToWorkflow.isPending}
          onStartCollaboration={() => startCollaboration.mutate()}
          onPromoteToWorkflow={() => promoteToWorkflow.mutate()}
        />
      </AiMessageRow>
    );
  }

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
          {hasContent && (
            <AiMessageActions>
              <button
                type="button"
                className="ai-message-action"
                title={t('memory.saveAsMemory')}
                disabled={saveAsMemory.isPending}
                onClick={() => saveAsMemory.mutate()}
              >
                <BookmarkPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
            </AiMessageActions>
          )}
        </AiMessageHeader>
        <AiMessageBody stream={isStreaming}>
          {hasContent ? (
            <MessageContent content={renderedContent} streaming={isStreaming} />
          ) : message.message_type === 'agent_stream' ? (
            <MessageContent content="…" streaming={isStreaming} />
          ) : null}
          <MessageAttachments attachments={attachments} />
        </AiMessageBody>
        {shouldShowTaskReadiness && metadata.task_readiness && (
          <TaskReadinessActions
            title={metadata.task_readiness.title}
            starting={promoteReadyTask.isPending}
            onStart={() => promoteReadyTask.mutate()}
            onContinue={() => setReadinessDismissed(true)}
          />
        )}
        {!isUser && run && (
          <AiMessageRunPanel>
            <AgentRunStatusCard
              roomId={roomId}
              run={run}
              agent={runAgent}
              compact
              onRetryWorkflow={onRetryWorkflow}
              retrying={retryingWorkflowId === run.workflow_run_id}
            />
          </AiMessageRunPanel>
        )}
      </div>
    </AiMessageRow>
  );
}

function TaskReadinessActions({
  title,
  starting,
  onStart,
  onContinue,
}: {
  title: string;
  starting: boolean;
  onStart: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="task-readiness-actions">
      <div className="task-readiness-copy">
        <span>已具备创建任务的基础信息</span>
        <strong>{title}</strong>
      </div>
      <div className="task-readiness-buttons">
        <button
          type="button"
          className="task-readiness-button is-primary"
          disabled={starting}
          onClick={onStart}
        >
          <Play className="h-3.5 w-3.5" strokeWidth={1.8} />
          <span>{starting ? '启动中' : '开始任务'}</span>
        </button>
        <button
          type="button"
          className="task-readiness-button"
          disabled={starting}
          onClick={onContinue}
        >
          继续沟通
        </button>
      </div>
    </div>
  );
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
