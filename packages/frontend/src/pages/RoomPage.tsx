import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, Brain, CheckSquare, ChevronDown, ChevronLeft, Download, FileText, MessageSquare, Plus, Settings2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { roomSocket, type WsServerEvent } from '../lib/ws';
import type { AgentRun, Message, MessageAttachmentMetadata, RoomAgent, Task, WorkflowRun } from '../lib/types';
import { parseMessageMetadata } from '../lib/messageMetadata';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import { AgentAvatar } from '../components/AgentAvatar';
import { AgentRunStatusCard } from '../components/AgentRunPanel';
import { AcpConfigPanel } from '../components/AcpConfigPanel';
import { AddAgentDialog } from '../components/AddAgentDialog';
import { CreateTaskDialog } from '../components/CreateTaskDialog';
import { MemoryPanel } from '../components/MemoryPanel';
import { RichMessageComposer } from '../components/RichMessageComposer';
import { TaskBoard } from '../components/TaskBoard';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import { MessageContent } from '../components/MessageContent';
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

export function RoomPage() {
  const { projectId = '', roomId = '' } = useParams();
  const queryClient = useQueryClient();
  const [configAgent, setConfigAgent] = useState<RoomAgent | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
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
      } else if (event.type === 'message:stream' && event.roomId === roomId) {
        queryClient.setQueryData<Message[] | undefined>(['messages', roomId], (prev) => {
          if (!prev) return prev;
          return dedupeMessages(prev.map((m) =>
            m.id === event.messageId ? { ...m, content: m.content + event.chunk } : m,
          ));
        });
      } else if (
        (event.type === 'agent_run:created' || event.type === 'agent_run:updated') &&
        event.roomId === roomId
      ) {
        queryClient.setQueryData<AgentRun[] | undefined>(['agent-runs', roomId], (prev) =>
          upsertAgentRun(prev, event.run),
        );
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
  }, [roomId, queryClient]);

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

        <div className="toolbar-tabs" aria-label={t('room.viewLabel')}>
          <button className="toolbar-tab is-active" type="button">
            {t('room.tab.chat')} <ChevronDown className="h-3 w-3" strokeWidth={1.8} />
          </button>
          <button className="toolbar-tab is-active" type="button">
            {t('room.tab.tasks')} <ChevronDown className="h-3 w-3" strokeWidth={1.8} />
          </button>
          <button className="toolbar-tab" type="button">
            {t('room.tab.workflow')} <ChevronDown className="h-3 w-3" strokeWidth={1.8} />
          </button>
          <button className="toolbar-tab" type="button">
            {t('room.tab.files')} <ChevronDown className="h-3 w-3" strokeWidth={1.8} />
          </button>
          <button className="toolbar-tab" type="button">{t('room.tab.agent')}</button>
          <button className="toolbar-tab" type="button">{t('room.tab.settings')}</button>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <AgentStrip
            agents={agents}
            onConfig={(agent) => {
              setSelectedTask(null);
              setConfigAgent(agent);
            }}
          />
          <span className="hidden sm:inline-flex">
            <CreateTaskDialog roomId={roomId} agents={agents}>
              <button type="button" className="glass-button glass-button-primary">
                <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
                {t('room.newTask')}
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
            className={cn('glass-button', showMemoryPanel && 'glass-button-primary')}
            onClick={() => {
              setShowMemoryPanel((v) => !v);
              if (!showMemoryPanel) { setConfigAgent(null); setSelectedTask(null); }
            }}
          >
            <Brain className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span className="hidden sm:inline">{t('memory.tab')}</span>
          </button>
          <AddAgentDialog roomId={roomId}>
            <button type="button" className="glass-button">
              <Users className="h-3.5 w-3.5" strokeWidth={1.8} />
              {t('room.inviteAgent')}
            </button>
          </AddAgentDialog>
        </div>
      </header>

      <div className="workspace-grid">
        <section className="workbench-panel chat-workspace" aria-label={t('room.chatAria')}>
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
            retryingWorkflowId={retryWorkflow.variables}
          />
        </section>
        {showMemoryPanel ? (
          <aside className="workbench-panel inspector-panel memory-panel-shell p-4">
            <MemoryPanel
              projectId={projectId}
              roomId={roomId}
              roomAgents={agents}
            />
          </aside>
        ) : selectedTask ? (
          <TaskDetailPanel
            task={selectedTask}
            agents={agents}
            projectId={projectId}
            onClose={() => setSelectedTask(null)}
          />
        ) : (
          <TaskBoard
            tasks={tasks}
            agents={agents}
            workflows={taskWorkflows}
            selectedTaskId={null}
            onSelectTask={(task) => {
              setConfigAgent(null);
              setSelectedTask(task);
            }}
            onChangeStatus={(task, status) => updateTaskStatus.mutate({ task, status })}
            onStartWorkflow={(task) => startWorkflow.mutate(task)}
            startingTaskId={startWorkflow.isPending ? startWorkflow.variables?.id : null}
          />
        )}
      </div>

      {configAgent && (
        <AcpConfigPanel
          agent={configAgent}
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
}: {
  messages: Message[];
  agents: RoomAgent[];
  agentRuns: AgentRun[];
  roomId: string;
  projectId: string;
  modelChatReady: boolean;
  routingMode: 'mentions_only' | 'fallback_reply' | 'fallback_route';
  fallbackAgentId: string | null;
  onRetryWorkflow: (workflowId: string) => void;
  retryingWorkflowId?: string;
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
  const canSendChat = agents.length > 0 || modelChatReady;

  const send = useMutation({
    mutationFn: (input: { content: string; mentions?: string[]; files?: File[] }) => api.sendMessage(roomId, input),
    onSuccess: () => {
      setComposerResetKey((key) => key + 1);
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-tasks', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-workflows', roomId] });
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const handleSend = (input: { content: string; mentions?: string[]; files?: File[] }) => {
    const content = input.content.trim();
    const files = input.files;
    if (!content && (!files || files.length === 0)) return;
    send.mutate({ content, mentions: input.mentions, files });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="chat-stream-header">
        <div className="segmented-control">
          <button className="is-active" type="button">
            <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.7} />
            {t('room.stream.agent')}
          </button>
          <button type="button">
            <Users className="h-3.5 w-3.5" strokeWidth={1.7} />
            {t('room.stream.runs')}
          </button>
          <button type="button">
            <FileText className="h-3.5 w-3.5" strokeWidth={1.7} />
            {t('room.stream.stderr')}
          </button>
        </div>
        <button type="button" className="icon-glass-button" aria-label={t('room.newTask')}>
          <Plus className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

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
                action={agents.length === 0 && !modelChatReady ? <AddAgentDialog roomId={roomId} /> : undefined}
              />
            </ConversationEmptyState>
          ) : (
            visibleMessages.map((m) => {
              const run = runByMessageId.get(m.id);
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  agentMeta={agentMap.get(m.sender_id)}
                  run={run}
                  runAgent={run ? agentByRoomId.get(run.room_agent_id) : undefined}
                  roomId={roomId}
                  projectId={projectId}
                  onRetryWorkflow={onRetryWorkflow}
                  retryingWorkflowId={retryingWorkflowId}
                />
              );
            })
          )}
        </ConversationContent>
        <ConversationScrollButton label={t('room.scrollToBottom')} />
      </Conversation>

      <RichMessageComposer
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

function MessageBubble({
  message,
  agentMeta,
  run,
  runAgent,
  roomId,
  projectId,
  onRetryWorkflow,
  retryingWorkflowId,
}: {
  message: Message;
  agentMeta?: RoomAgent;
  run?: AgentRun;
  runAgent?: RoomAgent;
  roomId: string;
  projectId: string;
  onRetryWorkflow: (workflowId: string) => void;
  retryingWorkflowId?: string;
}) {
  const { t, formatRelativeTime } = useI18n();
  const queryClient = useQueryClient();
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
  const isUser = message.sender_type === 'user';
  const isSystem = message.sender_type === 'system';
  const metadata = parseMessageMetadata(message.metadata);
  const attachments = metadata.attachments;
  const hasContent = Boolean(message.content?.trim());
  const isTaskEvent = isSystem && Boolean(metadata.event_type && metadata.task_id);

  if (isTaskEvent) {
    return (
      <AiMessageRow variant="event">
        <div className="task-event-row" title={message.content || metadata.task_title || metadata.task_id}>
          <CheckSquare className="h-3.5 w-3.5" strokeWidth={1.8} />
          <span>{message.content}</span>
        </div>
      </AiMessageRow>
    );
  }

  if (isSystem) {
    return (
      <AiMessageRow variant="system">
        {message.content}
      </AiMessageRow>
    );
  }

  return (
    <AiMessageRow variant={isUser ? 'user' : 'agent'} className="fade-up">
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
        <AiMessageBody stream={message.message_type === 'agent_stream' && !isUser}>
          {hasContent ? (
            <MessageContent content={message.content || (message.message_type === 'agent_stream' ? '…' : '')} />
          ) : message.message_type === 'agent_stream' ? (
            <MessageContent content="…" />
          ) : null}
          <MessageAttachments attachments={attachments} />
        </AiMessageBody>
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

function MessageAttachments({ attachments }: { attachments: MessageAttachmentMetadata[] }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<MessageAttachmentMetadata | null>(null);
  if (attachments.length === 0) return null;

  return (
    <>
      <div className="message-attachments">
        {attachments.map((attachment) => {
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
  mode: 'mentions_only' | 'fallback_reply' | 'fallback_route',
  fallbackAgentId: string | null,
  fallbackAgent: RoomAgent | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (mode === 'mentions_only') return t('room.routing.mentionsOnly');
  if (fallbackAgentId && !fallbackAgent) {
    return t('room.routing.fallbackMissing', { agentId: fallbackAgentId });
  }
  const agentName = fallbackAgent?.agent_name ?? t('room.routing.fallbackAgent');
  if (mode === 'fallback_reply') {
    return t('room.routing.fallbackReply', { agentName });
  }
  return t('room.routing.fallbackRoute', { agentName });
}
