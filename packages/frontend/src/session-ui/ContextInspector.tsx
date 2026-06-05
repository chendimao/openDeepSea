import React from 'react';
import type { SessionContextManifest } from '../lib/types';

export function ContextInspector({ context }: { context: SessionContextManifest | null }): JSX.Element {
  if (!context) {
    return <div className="session-empty">暂无 Context Manifest。运行 /context 后会显示 prompt 来源。</div>;
  }
  return (
    <section className="session-inspector-section" aria-label="Context Inspector">
      <div className="session-section-heading">
        <span className="session-label">Prompt Sources</span>
        <span>{context.total_token_estimate} tokens</span>
      </div>
      {context.sources.map((source) => (
        <article className="session-context-source" key={source.id}>
          <header>
            <strong>{source.title}</strong>
            <span>{source.source_type}</span>
          </header>
          <p>{source.reason}</p>
          {source.excerpt && <pre>{source.excerpt}</pre>}
        </article>
      ))}
    </section>
  );
}
