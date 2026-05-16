import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, Pencil, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { AcpBackend } from '../lib/types';
import { cn } from '../lib/utils';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';
import { Input, Label } from './ui/Input';

const ACP_BACKENDS: { id: AcpBackend; label: string }[] = [
  { id: 'codex', label: 'Codex' },
  { id: 'claudecode', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
];

export function AddAgentDialog({ roomId, children }: { roomId: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentRole, setAgentRole] = useState('');
  const [acpBackend, setAcpBackend] = useState<AcpBackend>('codex');
  const queryClient = useQueryClient();
  const { t } = useI18n();

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

  function resetForm() {
    setAgentId('');
    setAgentName('');
    setAgentRole('');
    setAcpBackend('codex');
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
        acp_enabled: true,
        acp_backend: acpBackend,
        acp_session_id: null,
        acp_session_label: null,
        acp_permission_mode: 'bypass',
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

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <Pencil className="h-3.5 w-3.5 text-[var(--color-primary)]" strokeWidth={1.75} />
              <Label className="mb-0">{t('addAgent.manualAcp')}</Label>
            </div>
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
                <Label>{t('addAgent.displayName')}</Label>
                <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Coder" />
              </div>
              <div className="col-span-2">
                <Label>{t('addAgent.acpBackend')}</Label>
                <select
                  value={acpBackend}
                  onChange={(e) => setAcpBackend(e.target.value as AcpBackend)}
                  className="surface-1 h-10 w-full rounded-lg px-3 font-mono text-[13px] outline-none focus:border-[var(--color-primary)] focus:glow-primary"
                >
                  {ACP_BACKENDS.map((backend) => (
                    <option key={backend.id} value={backend.id}>
                      {backend.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div>
            <Label>{t('addAgent.role')}</Label>
            <Input
              value={agentRole}
              onChange={(e) => setAgentRole(e.target.value)}
              placeholder="architect / coder / reviewer"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={addingAny}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => add.mutate()} disabled={!agentId.trim() || addingAny}>
              {add.isPending ? t('addAgent.inviting') : t('addAgent.submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
