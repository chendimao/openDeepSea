import React from 'react';
import type { SessionDetail } from '../lib/types';
import { ObjectiveContract } from './ObjectiveContract';
import { SessionComposer } from './SessionComposer';
import { SessionTranscript } from './SessionTranscript';

export function ActiveSessionSurface({
  detail,
  onSendMessage,
}: {
  detail: SessionDetail;
  onSendMessage: (content: string) => void;
}): JSX.Element {
  const activeRun = [...detail.runs].reverse().find((run) =>
    run.status === 'queued' || run.status === 'running' || run.status === 'retrying'
  );
  return (
    <main className="session-panel session-active" aria-label="Active Session">
      <div className="session-panel-header">
        <div>
          <span className="session-kicker">Active Session</span>
          <h2 className="session-title">{detail.session.title}</h2>
        </div>
        <span className="session-chip" data-tone={detail.session.status === 'failed' ? 'danger' : undefined}>
          {detail.session.status}
        </span>
      </div>
      <div className="session-scroll session-active__body">
        <ObjectiveContract session={detail.session} planItems={detail.planItems} />
        {activeRun && (
          <div className="session-run-banner">
            <span className="session-label">Running</span>
            <strong>{activeRun.provider}</strong>
            <span>{activeRun.status}</span>
          </div>
        )}
        <SessionTranscript detail={detail} />
      </div>
      <SessionComposer onSendMessage={onSendMessage} />
    </main>
  );
}
