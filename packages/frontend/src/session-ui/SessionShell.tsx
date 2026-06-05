import React from 'react';
import type { SessionWorkspacePayload } from '../lib/types';
import { SessionShellView } from './SessionShellView';

if (typeof document !== 'undefined') {
  void import('./session-os-entry.css');
}

export function SessionShell({
  payload,
  onSendMessage,
  onCommand,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (content: string) => void;
  onCommand: (command: string) => void;
}): JSX.Element {
  return <SessionShellView payload={payload} onSendMessage={onSendMessage} onCommand={onCommand} />;
}
