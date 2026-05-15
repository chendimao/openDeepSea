import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, Pencil, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input, Label } from './ui/Input';

export function AddAgentDialog({ roomId, children }: { roomId: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentRole, setAgentRole] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const { data: gw, error: gatewayError, isLoading: gatewayLoading } = useQuery({
    queryKey: ['gateway-agents'],
    queryFn: api.listGatewayAgents,
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

  const hasOpenClawAgents = Boolean(gw?.connected && gw.agents.length > 0);
  const showManualFields = !hasOpenClawAgents || manualOpen;
  const gatewayErrorMessage = gatewayError instanceof Error ? gatewayError.message : gw?.error;
  const templateErrorMessage = templateError instanceof Error ? templateError.message : undefined;

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
                {templateData.templates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    disabled={addTemplate.isPending}
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
                    {addTemplate.isPending && addTemplate.variables === template.id && (
                      <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-fg-muted)]" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <Label className="mb-0">OpenClaw Agents</Label>
              {gatewayLoading && (
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('addAgent.loadingShort')}
                </span>
              )}
            </div>

            {!gw && gatewayLoading ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                {t('gateway.readingAgents')}
              </div>
            ) : !gw?.connected ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                {gatewayErrorMessage
                  ? t('addAgent.readFailedManualWithMessage', { message: gatewayErrorMessage })
                  : t('addAgent.readFailedManual')}
              </div>
            ) : gw.agents.length === 0 ? (
              <div className="surface-1 rounded-md px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                {t('addAgent.noAgentsManual')}
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
              {manualOpen ? t('addAgent.manualCollapse') : t('addAgent.manualOpen')}
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
                <Label>{t('addAgent.displayName')}</Label>
                <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Coder" />
              </div>
            </div>
          )}

          <div>
            <Label>{t('addAgent.role')}</Label>
            <Input
              value={agentRole}
              onChange={(e) => setAgentRole(e.target.value)}
              placeholder="architect / coder / reviewer"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => handleOpenChange(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => add.mutate()} disabled={!agentId.trim() || add.isPending}>
              {add.isPending ? t('addAgent.inviting') : t('addAgent.submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
