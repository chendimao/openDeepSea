import React, { useState } from 'react';
import type { SessionWorkspacePayload } from '../lib/types';
import { ContextInspector } from './ContextInspector';
import { EvidenceTimeline } from './EvidenceTimeline';
import { FilesInspector } from './FilesInspector';
import { ProviderInspector } from './ProviderInspector';
import { StatusInspector } from './StatusInspector';

type InspectorTab = 'status' | 'context' | 'evidence' | 'files' | 'provider';

const tabs: Array<{ id: InspectorTab; label: string }> = [
  { id: 'status', label: 'Status' },
  { id: 'context', label: 'Context' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'files', label: 'Files' },
  { id: 'provider', label: 'Provider' },
];

export function InspectorPanel({
  payload,
  onCommand,
}: {
  payload: SessionWorkspacePayload;
  onCommand: (command: string) => void;
}): JSX.Element {
  const [active, setActive] = useState<InspectorTab>('status');

  return (
    <aside className="session-panel session-inspector" aria-label="Session Inspector">
      <div className="session-panel-header">
        <div>
          <span className="session-kicker">Inspector</span>
          <h2 className="session-title">Status</h2>
        </div>
        <button type="button" className="session-command-button" onClick={() => onCommand('/status')}>
          Refresh
        </button>
      </div>
      <div className="session-inspector-tabs" role="tablist" aria-label="Inspector tabs">
        {tabs.map((tab) => (
          <button
            className="session-tab"
            data-active={active === tab.id ? 'true' : undefined}
            key={tab.id}
            role="tab"
            type="button"
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="session-scroll session-inspector__body">
        {active === 'status' && <StatusInspector status={payload.status} session={payload.activeSession.session} />}
        {active === 'context' && <ContextInspector context={payload.context} />}
        {active === 'evidence' && <EvidenceTimeline evidence={payload.evidence} />}
        {active === 'files' && <FilesInspector evidence={payload.evidence} />}
        {active === 'provider' && <ProviderInspector session={payload.activeSession.session} status={payload.status} />}
      </div>
    </aside>
  );
}
