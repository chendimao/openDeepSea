import React from 'react';
import type { SessionDetail } from '../lib/types';
import { evidenceTypeLabel, formatSessionAge } from './session-ui-model';

export function SessionTranscript({ detail }: { detail: SessionDetail }): JSX.Element {
  const now = Date.now();
  return (
    <section className="session-transcript" aria-label="Session transcript">
      <div className="session-section-heading">
        <span className="session-label">Transcript</span>
        <span>{detail.messages.length} messages</span>
      </div>
      {detail.messages.length === 0 && detail.runs.length === 0 ? (
        <div className="session-empty">发送第一条消息开始当前会话。</div>
      ) : (
        <>
          {detail.messages.map((message) => (
            <article className="session-message" data-role={message.role} key={message.id}>
              <header>
                <strong>{message.sender_name ?? message.sender_id}</strong>
                <span>{message.role}</span>
                <time>{formatSessionAge(now, message.created_at)}</time>
              </header>
              <p>{message.content}</p>
            </article>
          ))}
          {detail.runs.map((run) => (
            <details className="session-run-row" key={run.id}>
              <summary>
                <span>{run.provider}</span>
                <strong>{run.status}</strong>
                <small>{run.mode}</small>
              </summary>
              <pre>{run.stdout || run.stderr || run.activity_log || 'No output yet'}</pre>
            </details>
          ))}
          {detail.evidence.slice(-8).map((event) => (
            <article className="session-evidence-inline" key={event.id}>
              <span>{event.seq}</span>
              <strong>{evidenceTypeLabel(event.event_type)}</strong>
              <p>{event.summary ?? event.title}</p>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
