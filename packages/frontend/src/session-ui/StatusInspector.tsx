import React from 'react';
import type { Session, StatusSnapshot } from '../lib/types';
import { contextPressureLabel, pressureTone } from './session-ui-model';

export function StatusInspector({
  status,
  session,
}: {
  status: StatusSnapshot;
  session: Session;
}): JSX.Element {
  return (
    <section className="session-inspector-section" aria-label="Status Inspector">
      <Metric label="Goal" value={status.goal ?? session.title} />
      <Metric label="Mode" value={`${status.mode} / ${status.phase}`} />
      <Metric label="Context" value={`${status.context.totalTokenEstimate} tokens`} tone={pressureTone(status.context.pressure)} />
      <Metric label="Pressure" value={contextPressureLabel(status.context.pressure)} tone={pressureTone(status.context.pressure)} />
      <Metric label="Diff" value={status.git.hasUncommittedDiff ? `${status.git.changedFileCount} files` : 'clean'} />
      <Metric label="Verification" value={`${status.verification.status}: ${status.verification.lastCommand ?? 'unknown'}`} />
      {status.blocker && <Metric label="Blocker" value={status.blocker.reason} tone="danger" />}
      <Metric label="Next" value={status.nextAction.label} />
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }): JSX.Element {
  return (
    <div className="session-metric">
      <dt>{label}</dt>
      <dd>
        <span className="session-chip" data-tone={tone}>{value}</span>
      </dd>
    </div>
  );
}
