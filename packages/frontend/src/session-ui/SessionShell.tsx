import React from 'react';
import type {
  ActiveSessionSummary,
  SessionTodoStats,
  SessionWorkspacePayload,
  SuperpowersFinishBranchDecisionValue,
} from '../lib/types';
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
  onApproveWorkflowArtifact,
  onSubmitFinishBranchDecision,
  savingKnowledgeKey,
  todoStats,
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
  onApproveWorkflowArtifact?: (artifactVersionId: string) => void;
  onSubmitFinishBranchDecision?: (workflowRunId: string, decision: SuperpowersFinishBranchDecisionValue) => void;
  savingKnowledgeKey?: SessionKnowledgeActionKey | null;
  todoStats?: SessionTodoStats | null;
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
      onApproveWorkflowArtifact={onApproveWorkflowArtifact}
      onSubmitFinishBranchDecision={onSubmitFinishBranchDecision}
      savingKnowledgeKey={savingKnowledgeKey}
      todoStats={todoStats}
    />
  );
}
