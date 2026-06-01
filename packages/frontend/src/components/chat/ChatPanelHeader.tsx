import { Brain, Settings2 } from 'lucide-react';
import type { Project, Room, RoomAgent } from '../../lib/types';
import { useI18n } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { AgentAvatar } from '../AgentAvatar';
import { RoomSettingsDialog } from '../SettingsDialogs';

export type RoomFeatureTab = 'chat' | 'files';

interface ChatPanelHeaderProps {
  project?: Project | null;
  room?: Room | null;
  agents: RoomAgent[];
  showMemoryPanel: boolean;
  onToggleMemoryPanel: () => void;
  onSelectAgent: (agent: RoomAgent | null) => void;
}

export function ChatPanelHeader({
  project,
  room,
  agents,
  showMemoryPanel,
  onToggleMemoryPanel,
  onSelectAgent,
}: ChatPanelHeaderProps): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="room-main-heading">
      <div className="chat-heading-copy">
        <div className="chat-heading-title">聊天</div>
      </div>
      <div className="room-heading-actions">
        <ChatAgentStrip agents={agents} onConfig={onSelectAgent} />
        {project && room ? (
          <RoomSettingsDialog project={project} room={room} agents={agents}>
            <button type="button" aria-label={t('room.roomSettings')} className="glass-button">
              <Settings2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('room.tab.settings')}</span>
            </button>
          </RoomSettingsDialog>
        ) : (
          <button type="button" aria-label={t('room.roomSettings')} className="glass-button" disabled>
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('room.tab.settings')}</span>
          </button>
        )}
        <button
          type="button"
          aria-label={t('memory.tab')}
          className={cn('glass-button', showMemoryPanel && 'glass-button-primary')}
          onClick={onToggleMemoryPanel}
        >
          <Brain className="h-3.5 w-3.5" strokeWidth={1.8} />
          <span className="hidden sm:inline">{t('memory.tab')}</span>
        </button>
      </div>
    </div>
  );
}

function ChatAgentStrip({
  agents,
  onConfig,
}: {
  agents: RoomAgent[];
  onConfig: (agent: RoomAgent) => void;
}): JSX.Element {
  const { t } = useI18n();

  if (agents.length === 0) {
    return <span className="room-agent-empty-label">{t('room.noAgents')}</span>;
  }

  return (
    <div className="room-agent-strip flex items-center -space-x-2">
      {agents.slice(0, 4).map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onConfig(agent)}
          aria-label={t('room.configureAgent', { name: agent.agent_name })}
          className="rounded-full ring-2 ring-white/80 transition-transform ease-ocean hover:scale-105"
          title={`${agent.agent_name}${agent.acp_enabled ? ` · ACP: ${agent.acp_backend}` : ''}`}
        >
          <AgentAvatar name={agent.agent_name} size={24} active={!!agent.acp_enabled} />
        </button>
      ))}
      {agents.length > 4 && (
        <span className="ml-3 text-[11px] font-mono text-[var(--color-fg-muted)]">+{agents.length - 4}</span>
      )}
    </div>
  );
}
