import React from 'react';
import type { Session, StatusSnapshot } from '../lib/types';

export function ProviderInspector({
  session,
  status,
}: {
  session: Session;
  status: StatusSnapshot;
}): JSX.Element {
  return (
    <section className="session-inspector-section" aria-label="Provider Inspector">
      <dl className="session-provider-grid">
        <div>
          <dt>Backend</dt>
          <dd>{status.provider.backend ?? session.provider ?? 'codex'}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{status.provider.model ?? session.model ?? 'default'}</dd>
        </div>
        <div>
          <dt>Permission</dt>
          <dd>{status.provider.permissionMode ?? 'read-only'}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>{session.worktree_path ?? session.workspace_path ?? 'unbound'}</dd>
        </div>
      </dl>
    </section>
  );
}
