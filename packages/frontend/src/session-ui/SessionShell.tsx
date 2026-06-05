import React from 'react';
import type { HistoryRecordStatus, SessionMode, SessionWorkspacePayload } from '../lib/types';
import { SessionShellView } from './SessionShellView';

if (typeof document !== 'undefined') {
  void import('./session-os-entry.css');
}

export function SessionShell({
  payload,
  onSendMessage,
  onCommand,
  onCancelRun,
  onRetryRun,
  onSaveContract,
  onFilterHistory,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (content: string) => void;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
  onFilterHistory?: (filters: { q?: string; status?: HistoryRecordStatus | 'all'; mode?: SessionMode | 'all' }) => void;
}): JSX.Element {
  return (
    <SessionShellView
      payload={payload}
      onSendMessage={onSendMessage}
      onCommand={onCommand}
      onCancelRun={onCancelRun}
      onRetryRun={onRetryRun}
      onSaveContract={onSaveContract}
      onFilterHistory={onFilterHistory}
    />
  );
}
