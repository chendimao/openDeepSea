import './session-os.css';
import React from 'react';
import type { SessionWorkspacePayload } from '../lib/types';
import { SessionShellView } from './SessionShellView';

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
