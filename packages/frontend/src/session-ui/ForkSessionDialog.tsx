import { GitFork } from 'lucide-react';
import React, { useState } from 'react';
import type { AcpBackend, SessionMode } from '../lib/types';

export function ForkSessionDialog({
  sourceLabel,
  onFork,
}: {
  sourceLabel: string;
  onFork: (input: { title: string; provider: AcpBackend; model: string; mode: SessionMode }) => void;
}): JSX.Element {
  const [title, setTitle] = useState(`Fork: ${sourceLabel}`);
  const [provider, setProvider] = useState<AcpBackend>('codex');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<SessionMode>('code');

  return (
    <form
      className="session-workflow-surface"
      aria-label="Fork Session"
      onSubmit={(event) => {
        event.preventDefault();
        onFork({ title, provider, model, mode });
      }}
    >
      <span className="session-kicker">Fork Session</span>
      <p>Source: {sourceLabel}</p>
      <label>
        <span className="session-label">Title</span>
        <input className="session-input" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
      </label>
      <label>
        <span className="session-label">Provider</span>
        <select className="session-input" value={provider} onChange={(event) => setProvider(event.currentTarget.value as AcpBackend)}>
          <option value="codex">codex</option>
          <option value="claudecode">claudecode</option>
          <option value="opencode">opencode</option>
        </select>
      </label>
      <label>
        <span className="session-label">Model</span>
        <input className="session-input" value={model} onChange={(event) => setModel(event.currentTarget.value)} />
      </label>
      <label>
        <span className="session-label">Mode</span>
        <select className="session-input" value={mode} onChange={(event) => setMode(event.currentTarget.value as SessionMode)}>
          <option value="ask">ask</option>
          <option value="plan">plan</option>
          <option value="code">code</option>
          <option value="debug">debug</option>
          <option value="review">review</option>
        </select>
      </label>
      <button type="submit" className="session-command-button" data-variant="primary">
        <GitFork aria-hidden="true" />
        Fork
      </button>
    </form>
  );
}
