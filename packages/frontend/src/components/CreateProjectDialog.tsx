import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input, Label, Textarea } from './ui/Input';

export function CreateProjectDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createProject({ name, path, description: description || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('项目已添加');
      setOpen(false);
      setName('');
      setPath('');
      setDescription('');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        title="添加本地项目"
        description="把已有的代码目录纳入 OpenClaw Room 管理"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !path.trim()) return;
            create.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <Label>项目名称</Label>
            <Input
              autoFocus
              placeholder="my-awesome-app"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <Label>本地路径 (绝对路径)</Label>
            <Input
              placeholder="/Users/you/code/my-awesome-app"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <Label>描述 (可选)</Label>
            <Textarea
              placeholder="一句话说明这个项目..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim() || !path.trim()}>
              {create.isPending ? '添加中…' : '添加项目'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
