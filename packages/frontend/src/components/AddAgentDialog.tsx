import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Loader2, UserPlus } from 'lucide-react';
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
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const { data: agents = [], isLoading: agentsLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: api.listAgents,
    enabled: open,
  });
  const {
    data: templateData,
    error: templateError,
    isLoading: templatesLoading,
  } = useQuery({
    queryKey: ['agent-templates'],
    queryFn: api.listAgentTemplates,
    enabled: open,
  });

  const templateErrorMessage = templateError instanceof Error ? templateError.message : undefined;
  const joinedGlobalIds = new Set(roomAgentGlobalIds.filter(Boolean));
  const joinedAgentIds = new Set(roomAgentIds.filter(Boolean));
  const filteredAgents = agents.filter((agent) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return `${agent.name} ${agent.agent_id} ${agent.description ?? ''}`.toLowerCase().includes(needle);
  });

  function resetForm() {
    setSearch('');
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) resetForm();
  }

  const add = useMutation({
    mutationFn: (agent: Agent) =>
      api.addRoomAgent(roomId, {
        global_agent_id: agent.id,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      toast.success(t('addAgent.success'));
      setOpen(false);
      resetForm();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const addTemplate = useMutation({
    mutationFn: (templateId: string) => api.addRoomAgentFromTemplate(roomId, templateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['room-agents', roomId] });
      toast.success(t('addAgent.success'));
      setOpen(false);
      resetForm();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const addingAny = add.isPending || addTemplate.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm" variant="secondary">
            <UserPlus className="h-3.5 w-3.5" /> {t('addAgent.trigger')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title={t('addAgent.title')} description={t('addAgent.description')}>
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
                  const pending = add.isPending && add.variables?.id === agent.id;
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      disabled={addingAny || joined}
                      onClick={() => add.mutate(agent)}
                      className={cn(
                        'w-full surface-1 rounded-md px-3 py-2 text-left ease-ocean transition-all flex items-start gap-2',
                        'hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:border-[var(--color-primary)]',
                        'disabled:cursor-not-allowed disabled:opacity-60',
                      )}
                    >
                      <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-primary)]" strokeWidth={1.75} />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-display text-[13px]">{agent.name}</span>
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
                      ) : pending ? (
                        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-fg-muted)]" />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <Label className="mb-0">{t('addAgent.builtInTemplates')}</Label>
              {templatesLoading && (
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('addAgent.loadingShort')}
                </span>
              )}
            </div>

            {!templateData && templatesLoading ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                {t('addAgent.templatesLoading')}
              </div>
            ) : templateErrorMessage ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                {t('addAgent.templatesFailedWithMessage', { message: templateErrorMessage })}
              </div>
            ) : !templateData || templateData.templates.length === 0 ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                {t('addAgent.templatesEmpty')}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {templateData.templates.map((template) => {
                  const isCurrentTemplatePending = addTemplate.isPending && addTemplate.variables === template.id;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      disabled={addingAny}
                      aria-busy={isCurrentTemplatePending}
                      aria-label={`${template.name}${isCurrentTemplatePending ? ` ${t('addAgent.inviting')}` : ''}`}
                      onClick={() => addTemplate.mutate(template.id)}
                      className={cn(
                        'w-full surface-1 rounded-md px-3 py-2 text-left ease-ocean transition-all flex items-start gap-2',
                        'hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:border-[var(--color-primary)]',
                        'disabled:cursor-not-allowed disabled:opacity-60',
                      )}
                    >
                      <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-primary)]" strokeWidth={1.75} />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-display text-[13px]">{template.name}</span>
                          <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-muted)]">
                            {template.acp_backend}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-[var(--color-fg-muted)]">
                          {template.description}
                        </div>
                      </div>
                      {isCurrentTemplatePending && (
                        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-fg-muted)]" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={addingAny}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
