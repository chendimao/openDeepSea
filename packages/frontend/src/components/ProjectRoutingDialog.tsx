import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useI18n, type MessageKey } from '../lib/i18n';
import type { MessageRoutingMode, Project, RoomAgent } from '../lib/types';
import { Button } from './ui/Button';
import { Dialog, DialogContent, DialogTrigger } from './ui/Dialog';

const ROUTING_OPTIONS: Array<{
  value: MessageRoutingMode;
  descriptionKey: MessageKey;
}> = [
  {
    value: 'mentions_only',
    descriptionKey: 'projectRouting.mentionsOnlyDescription',
  },
  {
    value: 'fallback_reply',
    descriptionKey: 'projectRouting.fallbackReplyDescription',
  },
  {
    value: 'fallback_route',
    descriptionKey: 'projectRouting.fallbackRouteDescription',
  },
];

export function ProjectRoutingDialog({
  project,
  agents,
}: {
  project: Project;
  agents: RoomAgent[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<MessageRoutingMode>(project.message_routing_mode);
  const [fallbackAgentId, setFallbackAgentId] = useState(project.fallback_agent_id ?? '');
  const queryClient = useQueryClient();
  const { routingModeLabel, t } = useI18n();
  const fallbackOptions = useMemo(
    () =>
      [...agents]
        .sort((a, b) => a.agent_name.localeCompare(b.agent_name))
        .filter((agent, index, list) => list.findIndex((item) => item.agent_id === agent.agent_id) === index),
    [agents],
  );
  const requiresFallback = mode !== 'mentions_only';
  const selectedFallbackInRoom = fallbackOptions.some((agent) => agent.agent_id === fallbackAgentId);

  useEffect(() => {
    if (!open) return;
    setMode(project.message_routing_mode);
    setFallbackAgentId(project.fallback_agent_id ?? '');
  }, [open, project.fallback_agent_id, project.message_routing_mode]);

  useEffect(() => {
    if (requiresFallback && !fallbackAgentId && fallbackOptions.length > 0) {
      setFallbackAgentId(fallbackOptions[0].agent_id);
    }
  }, [fallbackAgentId, fallbackOptions, requiresFallback]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProjectRouting(project.id, {
        message_routing_mode: mode,
        fallback_agent_id: requiresFallback ? fallbackAgentId : null,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', project.id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('projectRouting.updated'));
      setOpen(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" aria-label={t('projectRouting.aria')}>
          <Settings2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{t('common.settings')}</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('projectRouting.title')}
        description={t('projectRouting.description')}
        className="w-[min(94vw,620px)]"
      >
        <div className="space-y-4">
          <div className="grid gap-2">
            {ROUTING_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 transition-colors hover:border-[var(--color-border-strong)]"
              >
                <input
                  type="radio"
                  name="routing-mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                  className="mt-1 h-4 w-4 accent-[var(--color-primary)]"
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-[var(--color-fg)]">
                    {routingModeLabel(option.value)}
                  </span>
                  <span className="block text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
                    {t(option.descriptionKey)}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {requiresFallback && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
              <label className="mb-2 flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg-muted)]">
                <Bot className="h-3.5 w-3.5" />
                {t('projectRouting.fallbackAgent')}
              </label>
              <select
                value={fallbackAgentId}
                onChange={(event) => setFallbackAgentId(event.target.value)}
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] outline-none transition-all focus:border-[var(--color-primary)] focus:glow-primary"
              >
                {fallbackAgentId && !selectedFallbackInRoom && (
                  <option value={fallbackAgentId}>
                    {t('projectRouting.fallbackMissingInRoom', { agentId: fallbackAgentId })}
                  </option>
                )}
                {fallbackOptions.length === 0 && !fallbackAgentId ? (
                  <option value="">{t('projectRouting.noAvailableAgents')}</option>
                ) : (
                  fallbackOptions.map((agent) => (
                    <option key={agent.agent_id} value={agent.agent_id}>
                      {agent.agent_name} ({agent.agent_id})
                    </option>
                  ))
                )}
              </select>
              <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
                {t('projectRouting.note')}
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-4">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || (requiresFallback && !fallbackAgentId)}
            >
              {t('projectRouting.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
