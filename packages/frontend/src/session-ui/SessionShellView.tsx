import React from 'react';
import type { SessionWorkspacePayload } from '../lib/types';
import { ActiveSessionSurface } from './ActiveSessionSurface';
import { HistoryRecordsRail } from './HistoryRecordsRail';
import { InspectorPanel } from './InspectorPanel';
import { SessionCommandBar } from './SessionCommandBar';

export function SessionShellView({
  payload,
  onSendMessage,
  onCommand,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (content: string) => void;
  onCommand: (command: string) => void;
}): JSX.Element {
  return (
    <section className="session-shell" aria-label="Session Operations Console">
      <SessionCommandBar payload={payload} onCommand={onCommand} />
      <div className="session-workspace-grid">
        <HistoryRecordsRail
          records={payload.historyRecords}
          activeSession={payload.activeSession.session}
          onCommand={onCommand}
        />
        <ActiveSessionSurface detail={payload.activeSession} onSendMessage={onSendMessage} />
        <InspectorPanel payload={payload} onCommand={onCommand} />
      </div>
    </section>
  );
}
