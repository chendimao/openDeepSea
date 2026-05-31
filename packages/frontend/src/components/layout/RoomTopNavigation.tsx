import { Link } from 'react-router-dom';
import { Brain, Search, Settings2, Users } from 'lucide-react';
import type { Project, Room, RoomAgent } from '../../lib/types';
import { cn } from '../../lib/utils';
import { useI18n } from '../../lib/i18n';
import { AgentAvatar } from '../AgentAvatar';
import { AddAgentDialog } from '../AddAgentDialog';
import { RoomSettingsDialog } from '../SettingsDialogs';

interface RoomTopNavigationProps {
  projectId: string;
  roomId: string;
  project?: Project | null;
  room?: Room | null;
  agents: RoomAgent[];
  showMemoryPanel: boolean;
  onToggleMemoryPanel: () => void;
  onSelectAgent: (agent: RoomAgent | null) => void;
}

export function RoomTopNavigation({
  projectId,
  roomId,
  project,
  room,
  agents,
  showMemoryPanel,
  onToggleMemoryPanel,
  onSelectAgent,
}: RoomTopNavigationProps): JSX.Element {
  const { t } = useI18n();

  return (
    <header className="workspace-toolbar">
      <div className="room-toolbar-identity">
        <Link
          to={`/projects/${projectId}`}
          className="toolbar-logo"
          aria-label={t('room.backToProject')}
        >
          <img src="/lobster.svg" alt="" className="h-5 w-5" />
        </Link>
        <div className="min-w-0">
          <div className="room-toolbar-title">
            {room?.name ?? t('room.defaultName')}
          </div>
          <div className="room-toolbar-subtitle">
            {project?.name ?? t('room.defaultName')}
          </div>
        </div>
      </div>

      <label className="room-global-search" aria-label="全局搜索">
        <Search className="h-4 w-4" strokeWidth={1.8} />
        <input type="search" placeholder="搜索消息、任务、文件" />
        <span>⌘K</span>
      </label>

      <div className="room-toolbar-actions ml-auto flex min-w-0 items-center gap-2">
        <AgentStrip agents={agents} onConfig={onSelectAgent} />
        {project && room ? (
          <RoomSettingsDialog project={project} room={room} agents={agents}>
            <button
              type="button"
              aria-label={t('room.roomSettings')}
              className="glass-button"
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('room.tab.settings')}</span>
            </button>
          </RoomSettingsDialog>
        ) : (
          <button
            type="button"
            aria-label={t('room.roomSettings')}
            className="glass-button"
            disabled
          >
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
        <AddAgentDialog
          roomId={roomId}
          roomAgentGlobalIds={agents.map((agent) => agent.global_agent_id ?? '')}
          roomAgentIds={agents.map((agent) => agent.agent_id)}
        >
          <button type="button" className="glass-button" aria-label={t('room.inviteAgent')}>
            <Users className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span className="hidden sm:inline">{t('room.inviteAgent')}</span>
          </button>
        </AddAgentDialog>
        <div className="room-user-avatar" aria-label="Current user">U</div>
      </div>
    </header>
  );
}

function AgentStrip({
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
    <div className="room-agent-strip mr-2 flex items-center -space-x-2">
      {agents.slice(0, 6).map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onConfig(agent)}
          aria-label={t('room.configureAgent', { name: agent.agent_name })}
          className="rounded-full ring-2 ring-white/80 transition-transform ease-ocean hover:scale-105"
          title={`${agent.agent_name}${agent.acp_enabled ? ` · ACP: ${agent.acp_backend}` : ''}`}
        >
          <AgentAvatar name={agent.agent_name} size={26} active={!!agent.acp_enabled} />
        </button>
      ))}
      {agents.length > 6 && (
        <span className="ml-3 text-[11px] font-mono text-[var(--color-fg-muted)]">+{agents.length - 6}</span>
      )}
    </div>
  );
}
