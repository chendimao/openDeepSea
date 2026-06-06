import React from 'react';
import type { SessionWorkspacePayload } from '../lib/types';
import { SessionShellView } from './SessionShellView';
import type { SessionComposerSubmit } from './session-file-composer-model';

export function SessionShell({
  payload,
  onSendMessage,
  onCommand,
  onCancelRun,
  onRetryRun,
  onSaveContract,
  onOpenSession,
  onCreateSession,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (message: SessionComposerSubmit) => void;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onCreateSession?: (projectId: string) => void | Promise<void>;
}): JSX.Element {
  return (
    <SessionShellView
      payload={payload}
      onSendMessage={onSendMessage}
      onCommand={onCommand}
      onCancelRun={onCancelRun}
      onRetryRun={onRetryRun}
      onSaveContract={onSaveContract}
      onOpenSession={onOpenSession}
      onCreateSession={onCreateSession}
    />
  );
}
