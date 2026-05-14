import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, FileText, MessageSquare, Plus, Send, Settings2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { roomSocket, type WsServerEvent } from '../lib/ws';
import type { AgentRun, Message, RoomAgent, Task, WorkflowRun } from '../lib/types';
import { cn, relativeTime } from '../lib/utils';
import { AgentAvatar } from '../components/AgentAvatar';
import { AgentRunStatusCard } from '../components/AgentRunPanel';
import { AcpConfigPanel } from '../components/AcpConfigPanel';
import { AddAgentDialog } from '../components/AddAgentDialog';
import { CreateTaskDialog } from '../components/CreateTaskDialog';
import { TaskBoard } from '../components/TaskBoard';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import { Button } from '../components/ui/Button';
import { AgentMentionMenu } from '../components/AgentMentionMenu';
import { MessageContent } from '../components/MessageContent';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';
import { RoomSettingsDialog } from '../components/SettingsDialogs';

export function RoomPage() {
  const { projectId = '', roomId = '' } = useParams();
  const queryClient = useQueryClient();
  const [configAgent, setConfigAgent] = useState<RoomAgent | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

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
  const inspectorTask = selectedTask ?? rootTasks[0] ?? null;
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
      toast.success('已重试当前阶段');
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
    <div className="workspace-root">
      <header className="workspace-toolbar">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={`/projects/${projectId}`}
            className="toolbar-back"
            aria-label="返回项目"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <div className="font-display text-[15px] font-semibold leading-tight">
              {room?.name ?? '开发闭环看板'}
            </div>
            <div className="mt-1 hidden truncate font-mono text-[11px] text-[var(--color-fg-muted)] sm:block">
              {project?.name ?? '开发闭环看板'} · {project?.path ?? '/Users/chendimao/www/openclaw-room'}
            </div>
          </div>
        </div>

        <div className="toolbar-tabs" aria-label="工作区视图">
          <button className="toolbar-tab is-active" type="button">
            聊天 <ChevronDown className="h-3 w-3" strokeWidth={1.8} />
          </button>
          <button className="toolbar-tab is-active" type="button">
            任务 <ChevronDown className="h-3 w-3" strokeWidth={1.8} />
          </button>
          <button className="toolbar-tab" type="button">
            工作流 <ChevronDown className="h-3 w-3" strokeWidth={1.8} />
          </button>
          <button className="toolbar-tab" type="button">
            文件 <ChevronDown className="h-3 w-3" strokeWidth={1.8} />
          </button>
          <button className="toolbar-tab" type="button">Agent</button>
          <button className="toolbar-tab" type="button">设置</button>
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
                新建任务
              </button>
            </CreateTaskDialog>
          </span>
          {project && room && (
            <RoomSettingsDialog project={project} room={room} agents={agents}>
              <button
                type="button"
                aria-label="群聊设置"
                className="glass-button"
              >
                <Settings2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">设置</span>
              </button>
            </RoomSettingsDialog>
          )}
          <AddAgentDialog roomId={roomId}>
            <button type="button" className="glass-button">
              <Users className="h-3.5 w-3.5" strokeWidth={1.8} />
              邀请 Agent
            </button>
          </AddAgentDialog>
        </div>
      </header>

      <div className="workspace-grid">
        <section className="workbench-panel chat-workspace" aria-label="AI Agent 协作流">
          <ChatColumn
            messages={messages}
            agents={agents}
            agentRuns={agentRuns}
            roomId={roomId}
            routingMode={settings?.effective.message_routing_mode ?? project?.message_routing_mode ?? 'mentions_only'}
            fallbackAgentId={settings?.effective.fallback_agent_id ?? project?.fallback_agent_id ?? null}
            onRetryWorkflow={(workflowId) => retryWorkflow.mutate(workflowId)}
            retryingWorkflowId={retryWorkflow.variables}
          />
        </section>
        <TaskBoard
          tasks={tasks}
          agents={agents}
          workflows={taskWorkflows}
          selectedTaskId={inspectorTask?.id ?? null}
          onSelectTask={(task) => {
            setConfigAgent(null);
            setSelectedTask(task);
          }}
          onChangeStatus={(task, status) => updateTaskStatus.mutate({ task, status })}
        />
        <TaskDetailPanel
          task={inspectorTask}
          agents={agents}
          onClose={() => setSelectedTask(null)}
        />
      </div>

      {configAgent && (
        <AcpConfigPanel
          agent={configAgent}
          projectId={projectId}
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

function AgentStrip({
  agents,
  onConfig,
}: {
  agents: RoomAgent[];
  onConfig: (a: RoomAgent) => void;
}) {
  if (agents.length === 0)
    return <span className="text-[12px] text-[var(--color-fg-muted)]">暂无 agent</span>;
  return (
    <div className="mr-2 flex items-center -space-x-2">
      {agents.slice(0, 6).map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onConfig(a)}
          aria-label={`配置 ${a.agent_name}`}
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
  routingMode,
  fallbackAgentId,
  onRetryWorkflow,
  retryingWorkflowId,
}: {
  messages: Message[];
  agents: RoomAgent[];
  agentRuns: AgentRun[];
  roomId: string;
  routingMode: 'mentions_only' | 'fallback_reply' | 'fallback_route';
  fallbackAgentId: string | null;
  onRetryWorkflow: (workflowId: string) => void;
  retryingWorkflowId?: string;
}) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, agentRuns.length]);

  const send = useMutation({
    mutationFn: ({
      content,
      mentions,
    }: {
      content: string;
      mentions?: string[];
    }) => api.sendMessage(roomId, content, mentions),
    onSuccess: () => {
      setInput('');
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const createTaskFromCommand = useMutation({
    mutationFn: (title: string) => api.createTask(roomId, { title }),
    onSuccess: () => {
      setInput('');
      queryClient.invalidateQueries({ queryKey: ['room-tasks', roomId] });
      toast.success('任务已创建');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const handleSend = () => {
    const content = input.trim();
    if (!content) return;
    const taskMatch = content.match(/^\/task\s+(.+)/);
    if (taskMatch?.[1]?.trim()) {
      createTaskFromCommand.mutate(taskMatch[1].trim());
      return;
    }
    const mentionNames = Array.from(content.matchAll(/@([\p{L}\p{N}_.-]+)/gu)).map((m) => m[1]);
    const mentions = agents
      .filter((agent) => mentionNames.includes(agent.agent_name) || mentionNames.includes(agent.agent_id))
      .map((agent) => agent.id);
    send.mutate({ content, mentions: mentions.length > 0 ? mentions : undefined });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="chat-stream-header">
        <div className="segmented-control">
          <button className="is-active" type="button">
            <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.7} />
            Agent Stream
          </button>
          <button type="button">
            <Users className="h-3.5 w-3.5" strokeWidth={1.7} />
            Runs
          </button>
          <button type="button">
            <FileText className="h-3.5 w-3.5" strokeWidth={1.7} />
            stderr
          </button>
        </div>
        <button type="button" className="icon-glass-button" aria-label="新建任务">
          <Plus className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      <div ref={scrollRef} className="chat-scroll flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {messages.length === 0 ? (
          <WorkspaceEmptyState
            icon={<MessageSquare className="h-9 w-9" strokeWidth={1.75} />}
            title="还没有消息"
            description={
              agents.length === 0
                ? '先添加一个 agent，再开始对话或创建任务。'
                : '发送第一条消息，或使用 /task 快速创建协作任务。'
            }
            action={agents.length === 0 ? <AddAgentDialog roomId={roomId} /> : undefined}
          />
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
                onRetryWorkflow={onRetryWorkflow}
                retryingWorkflowId={retryingWorkflowId}
              />
            );
          })
        )}
      </div>

      <Composer
        value={input}
        onChange={setInput}
        onSend={handleSend}
        sending={send.isPending || createTaskFromCommand.isPending}
        agentCount={agents.length}
        agents={agents}
        routingMode={routingMode}
        fallbackAgentId={fallbackAgentId}
        fallbackAgent={agents.find((agent) => agent.agent_id === fallbackAgentId)}
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
  onRetryWorkflow,
  retryingWorkflowId,
}: {
  message: Message;
  agentMeta?: RoomAgent;
  run?: AgentRun;
  runAgent?: RoomAgent;
  roomId: string;
  onRetryWorkflow: (workflowId: string) => void;
  retryingWorkflowId?: string;
}) {
  const isUser = message.sender_type === 'user';
  const isSystem = message.sender_type === 'system';

  if (isSystem) {
    return (
      <div className="text-center text-[11.5px] text-[var(--color-fg-muted)] font-mono py-1">
        {message.content}
      </div>
    );
  }

  return (
    <div className={cn('flex gap-3 fade-up', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {!isUser && (
        <AgentAvatar name={message.sender_name ?? message.sender_id} size={32} active={!!agentMeta?.acp_enabled} />
      )}
      <div className={cn('min-w-0 max-w-[760px] flex flex-col', isUser ? 'items-end' : 'w-full items-start')}>
        <div className="flex items-center gap-2 mb-1">
          <span className="font-display text-[12.5px] font-semibold">
            {isUser ? '你' : message.sender_name ?? message.sender_id}
          </span>
          {agentMeta?.acp_enabled && agentMeta.acp_backend && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--color-surface-raised)] text-[var(--color-accent)] border border-[var(--color-border)]">
              ACP:{agentMeta.acp_backend}
            </span>
          )}
          <span className="text-[10.5px] font-mono text-[var(--color-muted)]">
            {relativeTime(message.created_at)}
          </span>
        </div>
        <div
          className={cn(
            'message-bubble text-[13.5px] leading-relaxed',
            isUser
              ? 'user-message px-3.5 py-2.5 text-[var(--color-primary-fg)]'
              : 'w-full',
            message.message_type === 'agent_stream' && !isUser && 'font-mono text-[12.5px]',
          )}
        >
          {!isUser && run ? (
            <div className="space-y-2.5">
              <div className="px-3.5 pt-3">
                <MessageContent content={message.content || (message.message_type === 'agent_stream' ? '…' : '')} />
              </div>
              <div className="run-box-wrap px-2.5 py-2.5">
                <AgentRunStatusCard
                  roomId={roomId}
                  run={run}
                  agent={runAgent}
                  compact
                  onRetryWorkflow={onRetryWorkflow}
                  retrying={retryingWorkflowId === run.workflow_run_id}
                />
              </div>
            </div>
          ) : (
            <div className={!isUser ? 'px-3.5 py-2.5' : undefined}>
              <MessageContent content={message.content || (message.message_type === 'agent_stream' ? '…' : '')} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  sending,
  agentCount,
  agents,
  routingMode,
  fallbackAgentId,
  fallbackAgent,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  agentCount: number;
  agents: RoomAgent[];
  routingMode: 'mentions_only' | 'fallback_reply' | 'fallback_route';
  fallbackAgentId: string | null;
  fallbackAgent?: RoomAgent;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);

  useEffect(() => {
    if (!value) setMention(null);
  }, [value]);

  const updateMention = (nextValue: string, selectionStart: number | null) => {
    const cursor = selectionStart ?? nextValue.length;
    const match = nextValue.slice(0, cursor).match(/@([\p{L}\p{N}_.-]*)$/u);
    setMention(match ? { start: cursor - match[0].length, query: match[1] } : null);
  };

  const setValue = (nextValue: string, selectionStart: number | null) => {
    onChange(nextValue);
    updateMention(nextValue, selectionStart);
  };

  const selectAgent = (agent: RoomAgent) => {
    if (!mention) return;
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? value.length;
    const nextValue = `${value.slice(0, mention.start)}@${agent.agent_name} ${value.slice(cursor)}`;
    onChange(nextValue);
    setMention(null);
    window.requestAnimationFrame(() => {
      const nextCursor = mention.start + agent.agent_name.length + 2;
      textarea?.focus();
      textarea?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  return (
    <div className="composer-shell flex-shrink-0 px-4 py-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setMention(null);
          onSend();
        }}
        className="relative space-y-2"
      >
        {mention && (
          <AgentMentionMenu agents={agents} query={mention.query} onSelect={selectAgent} />
        )}
        <div className="composer-box flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value, e.target.selectionStart)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && mention) {
                e.preventDefault();
                setMention(null);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                setMention(null);
                onSend();
              }
            }}
            onSelect={(e) => updateMention(value, e.currentTarget.selectionStart)}
            placeholder={
              agentCount === 0
                ? '先邀请一个 agent 才能开始对话...'
                : '发送消息、@agent 定向，或 /task 创建任务'
            }
            rows={1}
            className="min-h-[44px] max-h-[200px] min-w-0 flex-1 resize-none bg-transparent px-3.5 py-2.5 text-[13.5px] outline-none placeholder:text-[var(--color-muted)]"
            disabled={agentCount === 0}
          />
          <Button
            type="submit"
            disabled={!value.trim() || sending || agentCount === 0}
            className="h-[40px] w-[78px] flex-shrink-0 px-0"
          >
            <Send className="h-3.5 w-3.5" /> 发送
          </Button>
        </div>
        <p className="px-1 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
          {routingHint(routingMode, fallbackAgentId, fallbackAgent)}
        </p>
      </form>
    </div>
  );
}

function routingHint(
  mode: 'mentions_only' | 'fallback_reply' | 'fallback_route',
  fallbackAgentId: string | null,
  fallbackAgent?: RoomAgent,
): string {
  if (mode === 'mentions_only') return '当前策略：只有被 @ 的智能体会回复；无 @ 时不会触发回复。';
  if (fallbackAgentId && !fallbackAgent) {
    return `当前策略：无 @ 时交给 ${fallbackAgentId}；当前聊天室尚未邀请它，因此不会触发兜底。`;
  }
  if (mode === 'fallback_reply') {
    return `当前策略：无 @ 时由 ${fallbackAgent?.agent_name ?? '兜底智能体'} 回复。`;
  }
  return `当前策略：无 @ 时由 ${fallbackAgent?.agent_name ?? '兜底智能体'} 分析并 @ 相关智能体协作。`;
}
