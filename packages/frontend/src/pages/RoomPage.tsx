import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Hash, Send, Settings2 } from 'lucide-react';
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
    <div className="h-full flex flex-col relative">
      <header className="px-3 sm:px-5 h-14 border-b border-[var(--color-border)] flex items-center gap-3 flex-shrink-0">
        <Link
          to={`/projects/${projectId}`}
          className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] ease-ocean"
          aria-label="返回项目"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <Hash className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={2} />
        <div className="min-w-0">
          <div className="font-display text-[14px] font-semibold truncate">
            {room?.name ?? '...'}
          </div>
          <div className="hidden sm:block text-[11px] font-mono text-[var(--color-fg-muted)] truncate">
            {project?.name} · {project?.path}
          </div>
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
            <CreateTaskDialog roomId={roomId} agents={agents} />
          </span>
          <Link
            to={`/settings?project=${projectId}&room=${roomId}`}
            aria-label="群聊设置"
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md surface-2 px-2.5 text-[12px] font-medium text-[var(--color-fg)] hover:border-[var(--color-border-strong)] ease-ocean transition-all"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">设置</span>
          </Link>
          <AddAgentDialog roomId={roomId} />
        </div>
      </header>

      <div className="flex-1 min-h-0 flex max-lg:flex-col">
        <ChatColumn
          messages={messages}
          agents={agents}
          agentRuns={agentRuns}
          roomId={roomId}
          routingMode={settings?.effective.message_routing_mode ?? project?.message_routing_mode ?? 'mentions_only'}
          fallbackAgentId={settings?.effective.fallback_agent_id ?? project?.fallback_agent_id ?? null}
        />
        <TaskBoard
          tasks={tasks}
          agents={agents}
          workflows={taskWorkflows}
          onSelectTask={(task) => {
            setConfigAgent(null);
            setSelectedTask(task);
          }}
          onChangeStatus={(task, status) => updateTaskStatus.mutate({ task, status })}
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
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          agents={agents}
          onClose={() => setSelectedTask(null)}
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
    <div className="flex items-center -space-x-2 mr-2">
      {agents.slice(0, 6).map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onConfig(a)}
          aria-label={`配置 ${a.agent_name}`}
          className="ring-2 ring-[var(--color-avatar-ring)] rounded-full hover:scale-105 ease-ocean transition-transform"
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
}: {
  messages: Message[];
  agents: RoomAgent[];
  agentRuns: AgentRun[];
  roomId: string;
  routingMode: 'mentions_only' | 'fallback_reply' | 'fallback_route';
  fallbackAgentId: string | null;
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
    const mentionNames = Array.from(content.matchAll(/@([\w.-]+)/g)).map((m) => m[1]);
    const mentions = agents
      .filter((agent) => mentionNames.includes(agent.agent_name) || mentionNames.includes(agent.agent_id))
      .map((agent) => agent.id);
    send.mutate({ content, mentions: mentions.length > 0 ? mentions : undefined });
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-4">
        {messages.length === 0 ? (
          <WorkspaceEmptyState
            icon={<Hash className="h-9 w-9" strokeWidth={1.75} />}
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
}: {
  message: Message;
  agentMeta?: RoomAgent;
  run?: AgentRun;
  runAgent?: RoomAgent;
  roomId: string;
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
      <div className={cn('max-w-[680px] min-w-0 flex flex-col', isUser ? 'items-end' : 'w-full items-start')}>
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
            'rounded-lg text-[13.5px] leading-relaxed',
            isUser
              ? 'bg-[var(--color-primary)] px-3.5 py-2.5 text-[var(--color-primary-fg)]'
              : 'surface-2 w-full',
            message.message_type === 'agent_stream' && !isUser && 'font-mono text-[12.5px]',
          )}
        >
          {!isUser && run ? (
            <div className="space-y-2.5">
              <div className="px-3.5 pt-3">
                <MessageContent content={message.content || (message.message_type === 'agent_stream' ? '…' : '')} />
              </div>
              <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-2.5">
                <AgentRunStatusCard roomId={roomId} run={run} agent={runAgent} compact />
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
    const match = nextValue.slice(0, cursor).match(/@([\w.-]*)$/);
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
    <div className="border-t border-[var(--color-border)] px-3 sm:px-4 py-3 flex-shrink-0">
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
        <div className="flex items-end gap-2">
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
            className="min-h-[44px] max-h-[200px] min-w-0 flex-1 resize-none surface-1 rounded-lg px-3.5 py-2.5 text-[13.5px] outline-none focus:border-[var(--color-primary)] focus:glow-primary ease-ocean transition-all"
            disabled={agentCount === 0}
          />
          <Button
            type="submit"
            disabled={!value.trim() || sending || agentCount === 0}
            className="h-[44px] w-[84px] flex-shrink-0 px-0"
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
