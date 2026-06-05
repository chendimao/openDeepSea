import { Copy, GitFork, RotateCcw } from 'lucide-react';
import React from 'react';
import type { HistoryRecord } from '../lib/types';

export function ResumeBriefPanel({
  record,
  onResume,
  onFork,
}: {
  record: HistoryRecord;
  onResume: () => void;
  onFork: () => void;
}): JSX.Element {
  return (
    <section className="session-workflow-surface" aria-label="Resume Brief">
      <span className="session-kicker">Resume Brief</span>
      <h3>{record.title}</h3>
      <pre>{record.resume_brief}</pre>
      <div className="session-workflow-actions">
        <button type="button" className="session-command-button" onClick={() => copyText(record.resume_brief)}>
          <Copy aria-hidden="true" />
          Copy
        </button>
        <button type="button" className="session-command-button" onClick={onFork}>
          <GitFork aria-hidden="true" />
          Fork
        </button>
        <button type="button" className="session-command-button" data-variant="primary" onClick={onResume}>
          <RotateCcw aria-hidden="true" />
          Resume
        </button>
      </div>
    </section>
  );
}

function copyText(value: string): void {
  if (typeof navigator === 'undefined') return;
  void navigator.clipboard?.writeText(value);
}
