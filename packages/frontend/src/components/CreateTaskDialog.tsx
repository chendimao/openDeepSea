import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckSquare, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { RoomAgent, Task } from '../lib/types';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input, Label, Textarea } from './ui/Input';

export function CreateTaskDialog({
  roomId,
  agents,
  initialTitle = '',
  children,
}: {
  roomId: string;
  agents: RoomAgent[];
  initialTitle?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('normal');
  const [interactionMode, setInteractionMode] = useState<Task['interaction_mode'] | 'inherit'>('inherit');
  const [assignedAgentId, setAssignedAgentId] = useState('');
  const queryClient = useQueryClient();
  const { interactionModeLabel, taskPriorityLabel } = useI18n();

  const create = useMutation({
    mutationFn: () =>
      api.createTask(roomId, {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        interaction_mode: interactionMode === 'inherit' ? undefined : interactionMode,
        assigned_agent_id: assignedAgentId || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-tasks', roomId] });
      toast.success('任务已创建');
      setOpen(false);
      setTitle(initialTitle);
      setDescription('');
      setPriority('normal');
      setInteractionMode('inherit');
      setAssignedAgentId('');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm" variant="secondary">
            <Plus className="h-3.5 w-3.5" /> 新建任务
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title="新建任务" description="把群聊里的协作事项沉淀为可追踪任务">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            create.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <Label>标题</Label>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="修复登录错误 / 拆分认证模块"
            />
          </div>
          <div>
            <Label>描述 (可选)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="补充任务背景、验收标准或相关上下文"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>优先级</Label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Task['priority'])}
                className="surface-1 h-10 w-full rounded-lg px-3 text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
              >
                {(['low', 'normal', 'high', 'urgent'] as const).map((p) => (
                  <option key={p} value={p}>
                    {taskPriorityLabel(p)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>指派 Agent (可选)</Label>
              <select
                value={assignedAgentId}
                onChange={(e) => setAssignedAgentId(e.target.value)}
                className="surface-1 h-10 w-full rounded-lg px-3 text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
              >
                <option value="">未指派</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.agent_name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Label>交互策略</Label>
            <select
              value={interactionMode}
              onChange={(e) => setInteractionMode(e.target.value as Task['interaction_mode'] | 'inherit')}
              className="surface-1 h-10 w-full rounded-lg px-3 text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
            >
              <option value="inherit">使用当前设置默认值</option>
              {(['ask_user', 'auto_recommended'] as const).map((mode) => (
                <option key={mode} value={mode}>
                  {interactionModeLabel(mode)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={create.isPending || !title.trim()}>
              <CheckSquare className="h-3.5 w-3.5" />
              {create.isPending ? '创建中…' : '创建任务'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
