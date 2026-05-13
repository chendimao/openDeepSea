import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Hash, Send } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { roomSocket, type WsServerEvent } from '../lib/ws';
import type { Message, RoomAgent, Task } from '../lib/types';
import { cn, relativeTime } from '../lib/utils';
import { AgentAvatar } from '../components/AgentAvatar';
import { AcpConfigPanel } from '../components/AcpConfigPanel';
import { AddAgentDialog } from '../components/AddAgentDialog';
import { CreateTaskDialog } from '../components/CreateTaskDialog';
import { TaskBoard } from '../components/TaskBoard';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import { Button } from '../components/ui/Button';

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
  const { data: tasks = [] } = useQuery({
    queryKey: ['room-tasks', roomId],
    queryFn: () => api.listRoomTasks(roomId),
    enabled: !!roomId,
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
          prev ? [...prev, event.message] : [event.message],
        );
      } else if (event.type === 'message:stream' && event.roomId === roomId) {
        queryClient.setQueryData<Message[] | undefined>(['messages', roomId], (prev) => {
          if (!prev) return prev;
          return prev.map((m) =>
            m.id === event.messageId ? { ...m, content: m.content + event.chunk } : m,
          );
        });
      } else if (event.type === 'room:agent_joined' && event.roomId === roomId) {
        queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      } else if (event.type === 'room:agent_left' && event.roomId === roomId) {
        queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
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
      <header className="px-5 h-14 border-b border-[var(--color-border)] flex items-center gap-3 flex-shrink-0">
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
          <div className="text-[11px] font-mono text-[var(--color-fg-muted)] truncate">
            {project?.name} · {project?.path}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <AgentStrip agents={agents} onConfig={setConfigAgent} />
          <CreateTaskDialog roomId={roomId} agents={agents} />
          <AddAgentDialog roomId={roomId} />
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <ChatColumn messages={messages} agents={agents} roomId={roomId} />
        <TaskBoard
          tasks={tasks}
          agents={agents}
          onSelectTask={setSelectedTask}
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
          className="ring-2 ring-[var(--color-bg)] rounded-full hover:scale-105 ease-ocean transition-transform"
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
  roomId,
}: {
  messages: Message[];
  agents: RoomAgent[];
  roomId: string;
}) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const agentMap = useMemo(
    () => new Map(agents.map((a) => [a.agent_id, a])),
    [agents],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const send = useMutation({
    mutationFn: () => api.sendMessage(roomId, input.trim()),
    onSuccess: () => {
      setInput('');
      queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {messages.length === 0 ? (
          <div className="text-center text-[13px] text-[var(--color-fg-muted)] mt-20">
            还没有消息. 邀请 agent 加入, 然后发布第一个任务吧 🦞
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} agentMeta={agentMap.get(m.sender_id)} />
          ))
        )}
      </div>

      <Composer
        value={input}
        onChange={setInput}
        onSend={() => {
          if (!input.trim()) return;
          send.mutate();
        }}
        sending={send.isPending}
        agentCount={agents.length}
      />
    </div>
  );
}

function MessageBubble({ message, agentMeta }: { message: Message; agentMeta?: RoomAgent }) {
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
      <div className={cn('max-w-[680px] min-w-0 flex flex-col', isUser ? 'items-end' : 'items-start')}>
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
            'rounded-xl px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words',
            isUser
              ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
              : 'surface-2',
            message.message_type === 'agent_stream' && !isUser && 'font-mono text-[12.5px]',
          )}
        >
          {message.content || (message.message_type === 'agent_stream' ? '…' : '')}
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
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  agentCount: number;
}) {
  return (
    <div className="border-t border-[var(--color-border)] px-4 py-3 flex-shrink-0">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
        className="flex items-end gap-2"
      >
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={
            agentCount === 0
              ? '先邀请一个 agent 才能开始对话…'
              : '发布任务或消息 (Enter 发送, Shift+Enter 换行)'
          }
          rows={1}
          className="flex-1 resize-none surface-1 rounded-lg px-3.5 py-2.5 text-[13.5px] outline-none focus:border-[var(--color-primary)] focus:glow-primary ease-ocean transition-all min-h-[42px] max-h-[200px]"
          disabled={agentCount === 0}
        />
        <Button
          type="submit"
          disabled={!value.trim() || sending || agentCount === 0}
          className="h-[42px]"
        >
          <Send className="h-3.5 w-3.5" /> 发送
        </Button>
      </form>
    </div>
  );
}
