import React from 'react';
import type { ActiveSessionSummary, SessionWorkspacePayload } from '../lib/types';
import { SessionShellView, type SessionKnowledgeActionKey, type SessionKnowledgeSaveInput } from './SessionShellView';
import type { SessionComposerSubmit } from './session-file-composer-model';

type SessionShellProject = SessionWorkspacePayload['projectSwitcher']['projects'][number];

export function SessionShell({
  payload,
  onSendMessage,
  onCommand,
  onCancelRun,
  onRetryRun,
  onSaveContract,
  onOpenSession,
  onCreateSession,
  onCreateProject,
  onRenameProject,
  onRemoveProject,
  onReorderProjects,
  onToggleSessionPin,
  onSaveKnowledge,
  savingKnowledgeKey,
}: {
  payload: SessionWorkspacePayload;
  onSendMessage: (message: SessionComposerSubmit) => void;
  onCommand: (command: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryRun?: (runId: string) => void;
  onSaveContract?: (input: { scope?: string | null; risks?: string[]; acceptanceCriteria?: string[] }) => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onCreateSession?: (projectId: string) => void | Promise<void>;
  onCreateProject?: () => void;
  onRenameProject?: (project: SessionShellProject) => void;
  onRemoveProject?: (project: SessionShellProject) => void;
  onReorderProjects?: (input: { ids: string[]; pinned: boolean }) => void;
  onToggleSessionPin?: (session: ActiveSessionSummary) => void;
  onSaveKnowledge?: (input: SessionKnowledgeSaveInput) => void;
  savingKnowledgeKey?: SessionKnowledgeActionKey | null;
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
      onCreateProject={onCreateProject}
      onRenameProject={onRenameProject}
      onRemoveProject={onRemoveProject}
      onReorderProjects={onReorderProjects}
      onToggleSessionPin={onToggleSessionPin}
      onSaveKnowledge={onSaveKnowledge}
      savingKnowledgeKey={savingKnowledgeKey}
    />
  );
}
