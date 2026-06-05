import React, { useState } from 'react';
import type { SessionCompaction } from '../lib/types';

export function CompactPreviewSurface({
  compaction,
  onApply,
  onDiscard,
}: {
  compaction: SessionCompaction;
  onApply: (summary: string) => void;
  onDiscard: () => void;
}): JSX.Element {
  const [summary, setSummary] = useState(compaction.applied_summary ?? compaction.preview_summary);
  return (
    <section className="session-workflow-surface" aria-label="Compact Preview">
      <span className="session-kicker">Compact Preview</span>
      <textarea className="session-textarea" value={summary} onChange={(event) => setSummary(event.currentTarget.value)} />
      <div className="session-workflow-grid">
        <Block label="Keep" value={compaction.retained_refs} />
        <Block label="Drop" value={compaction.dropped_refs} />
        <Block label="Risks" value={compaction.risk_notes ?? '无'} />
      </div>
      <div className="session-workflow-actions">
        <button type="button" className="session-command-button" onClick={onDiscard}>Discard</button>
        <button type="button" className="session-command-button" data-variant="primary" onClick={() => onApply(summary)}>Apply</button>
      </div>
    </section>
  );
}

function Block({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <span className="session-label">{label}</span>
      <pre>{value}</pre>
    </div>
  );
}
