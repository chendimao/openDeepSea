import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Loader2, Plus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { Agent } from '../lib/types';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input, Label } from './ui/Input';

export function AddAgentDialog({
  roomId,
  roomAgentGlobalIds = [],
  roomAgentIds = [],
  children,
}: {
  roomId: string;
  roomAgentGlobalIds?: string[];
  roomAgentIds?: string[];
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const { data: agents = [], isLoading: agentsLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: api.listAgents,
    enabled: open,
  });
  const joinedGlobalIds = new Set(roomAgentGlobalIds.filter(Boolean));
  const joinedAgentIds = new Set(roomAgentIds.filter(Boolean));
  const filteredAgents = agents.filter((agent) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return `${agent.name} ${agent.agent_id} ${agent.description ?? ''}`.toLowerCase().includes(needle);
  });

  function resetForm() {
    setSearch('');
    setSelectedIds([]);
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) resetForm();
  }

  const add = useMutation({
    mutationFn: (ids: string[]) => api.addRoomAgentsBatch(roomId, ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      toast.success(selectedIds.length > 1 ? `已加入 ${selectedIds.length} 个智能体` : t('addAgent.success'));
      setOpen(false);
      resetForm();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const addingAny = add.isPending;

  function toggleAgent(agent: Agent) {
    const joined = joinedGlobalIds.has(agent.id) || joinedAgentIds.has(agent.agent_id);
    if (joined || addingAny) return;
    setSelectedIds((current) =>
      current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id],
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm" variant="secondary">
            <UserPlus className="h-3.5 w-3.5" /> {t('addAgent.trigger')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title={t('addAgent.title')} description="从全局智能体库选择一个或多个智能体加入当前群聊。">
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <Label className="mb-0">全局智能体库</Label>
              {agentsLoading && (
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('addAgent.loadingShort')}
                </span>
              )}
            </div>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索智能体名称或 ID"
              className="mb-2"
            />
            <div className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
              {!agentsLoading && filteredAgents.length === 0 ? (
                <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                  暂无可拉入的智能体。可以先到左侧“智能体”页面创建。
                </div>
              ) : (
                filteredAgents.map((agent) => {
                  const joined = joinedGlobalIds.has(agent.id) || joinedAgentIds.has(agent.agent_id);
                  const selected = selectedIds.includes(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      disabled={addingAny || joined}
                      onClick={() => toggleAgent(agent)}
                      className={cn(
                        'w-full surface-1 rounded-md px-3 py-2 text-left ease-ocean transition-all flex items-start gap-2',
                        'hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:border-[var(--color-primary)]',
                        selected && 'border-[var(--color-primary)] glow-primary',
                        'disabled:cursor-not-allowed disabled:opacity-60',
                      )}
                    >
                      <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-primary)]" strokeWidth={1.75} />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-display text-[13px]">{agent.name}</span>
                          {agent.is_builtin ? (
                            <span className="shrink-0 rounded border border-[var(--color-border)] px-1 py-0.5 text-[9.5px] text-[var(--color-fg-muted)]">
                              内置
                            </span>
                          ) : null}
                          <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-muted)]">
                            {agent.agent_id}
                          </span>
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-[11px] text-[var(--color-fg-muted)]">
                          {agent.responsibilities || agent.description || '未设置主要工作'}
                        </div>
                      </div>
                      {joined ? (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[var(--color-success)]">
                          <Check className="h-3 w-3" />
                          已加入
                        </span>
                      ) : selected ? (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[var(--color-primary)]">
                          <Check className="h-3 w-3" />
                          已选择
                        </span>
                      ) : addingAny ? (
                        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-fg-muted)]" />
                      ) : (
                        <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-muted)]" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="text-[11.5px] text-[var(--color-fg-muted)]">
              已选择 {selectedIds.length} 个智能体
            </div>
            <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={addingAny}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => add.mutate(selectedIds)} disabled={selectedIds.length === 0 || addingAny}>
              {addingAny ? '加入中...' : `加入 ${selectedIds.length} 个`}
            </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
