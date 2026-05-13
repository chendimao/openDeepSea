import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, Pencil, UserPlus } from 'lucide-react';
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
  const [manualOpen, setManualOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: gw, error: gatewayError, isLoading: gatewayLoading } = useQuery({
    queryKey: ['gateway-agents'],
    queryFn: api.listGatewayAgents,
    enabled: open,
  });

  const hasOpenClawAgents = Boolean(gw?.connected && gw.agents.length > 0);
  const showManualFields = !hasOpenClawAgents || manualOpen;
  const gatewayErrorMessage = gatewayError instanceof Error ? gatewayError.message : gw?.error;

  useEffect(() => {
    if (!open || manualOpen || !gw?.connected || gw.agents.length === 0 || picked || agentId.trim()) return;
    const first = gw.agents[0];
    setPicked(first.id);
    setAgentId(first.id);
    setAgentName(first.name ?? first.id);
  }, [agentId, gw, manualOpen, open, picked]);

  function resetForm() {
    setAgentId('');
    setAgentName('');
    setAgentRole('');
    setPicked(null);
    setManualOpen(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) resetForm();
  }

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
      resetForm();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm" variant="secondary">
            <UserPlus className="h-3.5 w-3.5" /> 邀请 Agent
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title="邀请 Agent 加入聊天室" description="从本机 OpenClaw 配置中选择 Agent">
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <Label className="mb-0">OpenClaw Agents</Label>
              {gatewayLoading && (
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  读取中
                </span>
              )}
            </div>

            {!gw && gatewayLoading ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                正在读取本机 OpenClaw agents 列表
              </div>
            ) : !gw?.connected ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                无法读取 OpenClaw agents，将使用手动输入。{gatewayErrorMessage ? `错误: ${gatewayErrorMessage}` : ''}
              </div>
            ) : gw.agents.length === 0 ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                本机 OpenClaw 配置中没有可用 agent，请手动输入 Agent ID。
              </div>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {gw.agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={picked === a.id}
                    onClick={() => {
                      setPicked(a.id);
                      setAgentId(a.id);
                      setAgentName(a.name ?? a.id);
                    }}
                    className={cn(
                      'w-full surface-1 rounded-md px-3 py-2 text-left ease-ocean transition-all flex items-start gap-2',
                      'hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:border-[var(--color-primary)]',
                      picked === a.id ? 'border-[var(--color-primary)] glow-primary' : '',
                    )}
                  >
                    <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-display text-[13px]">{a.name ?? a.id}</span>
                        <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-muted)]">{a.id}</span>
                      </div>
                      {(a.description || a.workspace) && (
                        <div className="mt-0.5 truncate text-[11px] text-[var(--color-fg-muted)]">
                          {a.description ?? a.workspace}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {hasOpenClawAgents && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setManualOpen((value) => !value)}>
              <Pencil className="h-3.5 w-3.5" />
              {manualOpen ? '收起手动输入' : '手动输入 Agent ID'}
            </Button>
          )}

          {showManualFields && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Agent ID</Label>
                <Input
                  value={agentId}
                  onChange={(e) => {
                    setPicked(null);
                    setAgentId(e.target.value);
                  }}
                  placeholder="main / coder / qa"
                  className="font-mono"
                />
              </div>
              <div>
                <Label>显示名称</Label>
                <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Coder" />
              </div>
            </div>
          )}

          <div>
            <Label>角色 (可选)</Label>
            <Input
              value={agentRole}
              onChange={(e) => setAgentRole(e.target.value)}
              placeholder="architect / coder / reviewer"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => handleOpenChange(false)}>取消</Button>
            <Button onClick={() => add.mutate()} disabled={!agentId.trim() || add.isPending}>
              {add.isPending ? '邀请中…' : '邀请'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
