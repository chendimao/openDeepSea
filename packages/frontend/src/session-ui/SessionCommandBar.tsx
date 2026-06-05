import { Boxes, GitFork, Gauge, History, Minimize2, Plus, RotateCcw } from 'lucide-react';
import React from 'react';
import type { SessionWorkspacePayload } from '../lib/types';
import { contextPressureLabel, pressureTone } from './session-ui-model';

export function SessionCommandBar({
  payload,
  onCommand,
}: {
  payload: SessionWorkspacePayload;
  onCommand: (command: string) => void;
}): JSX.Element {
  const session = payload.activeSession.session;
  const provider = session.provider ?? 'codex';
  const model = session.model ?? 'default';

  return (
    <header className="session-commandbar">
      <div className="session-commandbar__identity">
        <span className="session-kicker">Project</span>
        <div>
          <h1 className="session-title">{payload.project.name}</h1>
          <p className="session-subtitle">{session.title}</p>
        </div>
      </div>
      <div className="session-commandbar__meta" aria-label="Session runtime">
        <span className="session-chip">{provider}</span>
        <span className="session-chip">{model}</span>
        <span className="session-chip" data-tone={pressureTone(payload.status.context.pressure)}>
          {contextPressureLabel(payload.status.context.pressure)}
        </span>
      </div>
      <nav className="session-commandbar__actions" aria-label="Session commands">
        <CommandButton icon={<Plus />} label="New" command="/new" onCommand={onCommand} primary />
        <CommandButton icon={<Minimize2 />} label="Compact" command="/compact" onCommand={onCommand} />
        <CommandButton icon={<GitFork />} label="Fork" command="/fork" onCommand={onCommand} />
        <CommandButton icon={<RotateCcw />} label="Resume" command="/resume" onCommand={onCommand} />
        <CommandButton icon={<Gauge />} label="Status" command="/status" onCommand={onCommand} />
        <CommandButton icon={<Boxes />} label="Context" command="/context" onCommand={onCommand} />
        <CommandButton icon={<History />} label="History" command="/history" onCommand={onCommand} />
      </nav>
    </header>
  );
}

function CommandButton({
  icon,
  label,
  command,
  onCommand,
  primary,
}: {
  icon: JSX.Element;
  label: string;
  command: string;
  onCommand: (command: string) => void;
  primary?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className="session-command-button"
      data-variant={primary ? 'primary' : undefined}
      onClick={() => onCommand(command)}
      aria-label={label}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
