import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hash, MessageSquarePlus, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Dialog, DialogContent, DialogTrigger } from '../components/ui/Dialog';
import { Input, Label, Textarea } from '../components/ui/Input';
import { relativeTime } from '../lib/utils';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
  });
  const { data: rooms = [] } = useQuery({
    queryKey: ['rooms', projectId],
    queryFn: () => api.listRooms(projectId),
    enabled: !!projectId,
  });

  if (!project) return <div className="p-8 text-[var(--color-fg-muted)]">加载项目…</div>;

  return (
    <div className="h-full overflow-y-auto">
      <header className="px-4 sm:px-8 pt-8 pb-5 border-b border-[var(--color-border)]">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-[22px] font-semibold tracking-tight">{project.name}</h1>
            <span className="min-w-0 truncate text-[12px] font-mono text-[var(--color-muted)]">
              {project.path}
            </span>
          </div>
          {project.description && (
            <p className="mt-2 text-[13px] text-[var(--color-fg-muted)]">{project.description}</p>
          )}
          <div className="mt-4 flex items-center gap-5 text-[12px] font-mono text-[var(--color-fg-muted)]">
            <span>聊天室 {project.stats?.rooms ?? 0}</span>
            <span>任务 {project.stats?.tasks ?? 0}</span>
            <span>已完成 {project.stats?.tasksDone ?? 0}</span>
            <span>进行中 {project.stats?.tasksInProgress ?? 0}</span>
          </div>
        </div>
      </header>

      <section className="px-4 sm:px-8 py-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-baseline gap-3 mb-4">
            <h2 className="font-display text-[14px] font-medium">聊天室</h2>
            <span className="text-[12px] font-mono text-[var(--color-fg-muted)]">{rooms.length}</span>
            <div className="ml-auto">
              <CreateRoomDialog projectId={projectId} />
            </div>
          </div>

          {rooms.length === 0 ? (
            <WorkspaceEmptyState
              icon={<MessageSquarePlus className="h-9 w-9" strokeWidth={1.75} />}
              title="还没有聊天室"
              description="为项目创建一个协作主题，后续可以邀请 agent、发送消息并拆分任务。"
              action={<CreateRoomDialog projectId={projectId} buttonText="创建第一个聊天室" />}
            />
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {rooms.map((r) => (
                <RoomItem key={r.id} projectId={projectId} room={r} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RoomItem({ projectId, room }: { projectId: string; room: { id: string; name: string; description: string | null; created_at: number } }) {
  const queryClient = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteRoom(room.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast.success('已删除');
    },
  });

  return (
    <div className="group surface-1 rounded-lg p-4 hover:border-[var(--color-accent)] ease-ocean transition-all relative">
      <Link to={`/projects/${projectId}/rooms/${room.id}`} className="block">
        <div className="flex items-center gap-2 mb-1 pr-8">
          <Hash className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={2} />
          <h3 className="font-display text-[14px] font-semibold truncate">{room.name}</h3>
        </div>
        {room.description && (
          <p className="text-[12px] text-[var(--color-fg-muted)] line-clamp-1 mt-1">{room.description}</p>
        )}
        <p className="text-[11px] font-mono text-[var(--color-muted)] mt-3">{relativeTime(room.created_at)}</p>
      </Link>
      <button
        onClick={() => del.mutate()}
        className="absolute right-2 top-2 p-1.5 rounded-md text-[var(--color-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-danger)] hover:bg-[var(--color-surface-raised)] ease-ocean"
        aria-label="删除聊天室"
        type="button"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function CreateRoomDialog({ projectId, buttonText = '新建聊天室' }: { projectId: string; buttonText?: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createRoom(projectId, { name, description: description || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast.success('聊天室已创建');
      setOpen(false);
      setName('');
      setDescription('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          {buttonText === '新建聊天室' ? <Plus className="h-3.5 w-3.5" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
          {buttonText}
        </Button>
      </DialogTrigger>
      <DialogContent title="新建聊天室" description="为这个项目开启一个新的协作主题">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <Label>聊天室名称</Label>
            <Input
              autoFocus
              placeholder="auth-refactor / bug-fixing / discussion"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <Label>主题描述 (可选)</Label>
            <Textarea
              placeholder="这个聊天室的目标是..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
