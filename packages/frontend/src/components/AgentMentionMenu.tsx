import { Bot } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import type { RoomAgent } from '../lib/types';
import { cn } from '../lib/utils';
import { AgentAvatar } from './AgentAvatar';

interface AgentMentionMenuProps {
  agents: RoomAgent[];
  query: string;
  onSelect: (agent: RoomAgent) => void;
}

export function AgentMentionMenu({
  agents,
  query,
  onSelect,
}: AgentMentionMenuProps): JSX.Element | null {
  const { t } = useI18n();
  const normalized = query.toLowerCase();
  const filtered = agents
    .filter((agent) => {
      const haystack = `${agent.agent_name} ${agent.agent_id}`.toLowerCase();
      return haystack.includes(normalized);
    })
    .slice(0, 6);

  if (agents.length === 0) return null;

  return (
    <div className="mention-menu surface-1" role="listbox" aria-label={t('mention.menuAria')}>
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-2 text-[11px] font-mono uppercase tracking-wider text-[var(--color-fg-muted)]">
        <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />
        Agent
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-[var(--color-fg-muted)]">
            {t('mention.empty')}
          </div>
        ) : (
          filtered.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="option"
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(agent);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ease-ocean transition-colors',
                'hover:bg-[var(--color-surface-raised)] focus:bg-[var(--color-surface-raised)] focus:outline-none',
              )}
            >
              <AgentAvatar name={agent.agent_name} size={24} active={!!agent.acp_enabled} />
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium text-[var(--color-fg)]">
                  {agent.agent_name}
                </div>
                <div className="truncate font-mono text-[10.5px] text-[var(--color-muted)]">
                  {agent.agent_id}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
