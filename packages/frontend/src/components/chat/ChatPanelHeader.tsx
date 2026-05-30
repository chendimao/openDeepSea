import { FolderOpen, MessageSquare, Plus } from 'lucide-react';
import type { RoomAgent } from '../../lib/types';
import { useI18n } from '../../lib/i18n';
import { CreateTaskDialog } from '../CreateTaskDialog';

export type RoomFeatureTab = 'chat' | 'files';

interface ChatPanelHeaderProps {
  roomId: string;
  agents: RoomAgent[];
  activeTab: RoomFeatureTab;
  onChange: (tab: RoomFeatureTab) => void;
}

export function ChatPanelHeader({
  roomId,
  agents,
  activeTab,
  onChange,
}: ChatPanelHeaderProps): JSX.Element {
  const { t } = useI18n();
  const tabs: Array<{ id: RoomFeatureTab; label: string; icon: typeof MessageSquare }> = [
    { id: 'chat', label: t('room.tab.chat'), icon: MessageSquare },
    { id: 'files', label: t('room.tab.files'), icon: FolderOpen },
  ];

  return (
    <div className="room-main-heading">
      <div className="chat-heading-copy">
        <div className="chat-heading-title">聊天</div>
        <div className="chat-heading-subtitle">Conversation Flow</div>
      </div>
      <div className="room-feature-tabs" aria-label={t('room.viewLabel')}>
        <div className="segmented-control">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? 'is-active' : ''}
                aria-pressed={activeTab === tab.id}
                onClick={() => onChange(tab.id)}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.7} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
      <CreateTaskDialog roomId={roomId} agents={agents}>
        <button type="button" className="glass-button" aria-label={t('createTask.trigger')}>
          <Plus className="h-3.5 w-3.5" />
          <span>{t('createTask.trigger')}</span>
        </button>
      </CreateTaskDialog>
    </div>
  );
}
