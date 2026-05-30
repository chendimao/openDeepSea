import { ChevronDown, Plus } from 'lucide-react';
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
  const filters: Array<{ id: RoomFeatureTab; label: string }> = [
    { id: 'chat', label: t('room.tab.chat') },
    { id: 'files', label: t('room.tab.files') },
  ];

  return (
    <div className="room-main-heading">
      <div className="chat-heading-copy">
        <div className="chat-heading-title">聊天</div>
        <div className="chat-heading-subtitle">Conversation Flow</div>
      </div>
      <label className="chat-filter-control">
        <span>{t('room.viewLabel')}</span>
        <select
          value={activeTab}
          aria-label={t('room.viewLabel')}
          onChange={(event) => onChange(event.currentTarget.value as RoomFeatureTab)}
        >
          {filters.map((filter) => (
            <option key={filter.id} value={filter.id}>{filter.label}</option>
          ))}
        </select>
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
      </label>
      <CreateTaskDialog roomId={roomId} agents={agents}>
        <button type="button" className="glass-button" aria-label={t('createTask.trigger')}>
          <Plus className="h-3.5 w-3.5" />
          <span>{t('createTask.trigger')}</span>
        </button>
      </CreateTaskDialog>
    </div>
  );
}
