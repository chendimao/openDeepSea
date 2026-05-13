import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input, Label } from './ui/Input';
import { cn } from '../lib/utils';

export function AddAgentDialog({ roomId, children }: { roomId: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentRole, setAgentRole] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: gw } = useQuery({
    queryKey: ['gateway-agents'],
    queryFn: api.listGatewayAgents,
    enabled: open,
  });

  const add = useMutation({
    mutationFn: () =>
      api.addRoomAgent(roomId, {
        agent_id: agentId,
        agent_name: agentName || agentId,
        agent_role: agentRole || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      toast.success('Agent 已加入聊天室');
      setOpen(false);
      setAgentId('');
      setAgentName('');
      setAgentRole('');
      setPicked(null);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm" variant="secondary">
            <UserPlus className="h-3.5 w-3.5" /> 邀请 Agent
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title="邀请 Agent 加入聊天室" description="从 OpenClaw 选一个 profile, 或手动指定一个 agent ID">
        <div className="space-y-4">
          {gw && (
            <div>
              <Label>从 OpenClaw 中选择</Label>
              {!gw.connected ? (
                <p className="text-[12px] text-[var(--color-fg-muted)]">
                  Gateway 未连接, 请检查 OpenClaw 守护进程是否在运行
                </p>
              ) : gw.agents.length === 0 ? (
                <p className="text-[12px] text-[var(--color-fg-muted)]">
                  Gateway 中没有可用的 agent, 可在下方手动输入 ID
                </p>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                  {gw.agents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        setPicked(a.id);
                        setAgentId(a.id);
                        setAgentName(a.name ?? a.id);
                      }}
                      className={cn(
                        'w-full surface-1 rounded-md px-3 py-2 text-left ease-ocean transition-all flex items-center gap-2',
                        picked === a.id ? 'border-[var(--color-primary)] glow-primary' : 'hover:border-[var(--color-border-strong)]',
                      )}
                    >
                      <Bot className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={1.75} />
                      <div className="min-w-0">
                        <div className="font-display text-[13px]">{a.name ?? a.id}</div>
                        <div className="font-mono text-[11px] text-[var(--color-fg-muted)] truncate">{a.id}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Agent ID</Label>
              <Input
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="main / coder / qa"
                className="font-mono"
              />
            </div>
            <div>
              <Label>显示名称</Label>
              <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Coder" />
            </div>
          </div>
          <div>
            <Label>角色 (可选)</Label>
            <Input
              value={agentRole}
              onChange={(e) => setAgentRole(e.target.value)}
              placeholder="architect / coder / reviewer"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={() => add.mutate()} disabled={!agentId.trim() || add.isPending}>
              {add.isPending ? '邀请中…' : '邀请'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
