import React from 'react';
import type { SessionEvidenceEvent } from '../lib/types';
import { evidenceTypeLabel } from './session-ui-model';

export function EvidenceTimeline({ evidence }: { evidence: SessionEvidenceEvent[] }): JSX.Element {
  return (
    <section className="session-inspector-section" aria-label="Evidence Timeline">
      {evidence.length === 0 ? (
        <div className="session-empty">暂无 evidence。消息、工具调用、diff、测试和提交会在这里汇总。</div>
      ) : evidence.map((event) => (
        <article className="session-timeline-event" data-severity={event.severity} key={event.id}>
          <span className="session-timeline-event__seq">{event.seq}</span>
          <div>
            <header>
              <strong>{event.title}</strong>
              <span>{evidenceTypeLabel(event.event_type)}</span>
            </header>
            <p>{event.summary ?? JSON.stringify(event.payload)}</p>
          </div>
        </article>
      ))}
    </section>
  );
}
