import type { AcpBackend, AcpPermissionMode, Project } from './types.js';

export type SessionMode = 'ask' | 'plan' | 'code' | 'debug' | 'review';
export type SessionPhase =
  | 'idle'
  | 'brainstorming'
  | 'planning'
  | 'implementing'
  | 'debugging'
  | 'reviewing'
  | 'verifying'
  | 'blocked'
  | 'completed'
  | 'archived';
export type SessionStatus = 'active' | 'blocked' | 'completed' | 'archived' | 'failed';
export type SessionRunStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type SessionMessageRole = 'user' | 'assistant' | 'system';
export type SessionMessageType = 'text' | 'system' | 'agent_stream';
export type SessionMessageStatus = 'queued' | 'streaming' | 'completed' | 'failed';
export type SessionPlanItemStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed' | 'skipped';
export type SessionCompactionStrategy = 'manual' | 'focus' | 'aggressive' | 'conservative' | 'auto_suggested';
export type SessionCompactionStatus = 'previewed' | 'applied' | 'superseded' | 'discarded' | 'failed';
export type HistoryRecordStatus = 'completed' | 'blocked' | 'failed' | 'archived';
export type SessionEvidenceType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'file_read'
  | 'file_diff'
  | 'test'
  | 'build'
  | 'browser_check'
  | 'review'
  | 'commit'
  | 'compact'
  | 'checkpoint'
  | 'blocker'
  | 'new'
  | 'resume'
  | 'fork'
  | 'status';
export type SessionEvidenceSeverity = 'info' | 'warning' | 'error' | 'critical';
export type SessionContextSourceType =
  | 'agents'
  | 'rtk'
  | 'compact'
  | 'history'
  | 'memory'
  | 'file'
  | 'diff'
  | 'user_message'
  | 'system'
  | 'tool_result';

export interface Session {
  id: string;
  project_id: string;
  title: string;
  current_goal: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  status: SessionStatus;
  provider: AcpBackend | null;
  model: string | null;
  workspace_path: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  forked_from_session_id: string | null;
  forked_from_history_record_id: string | null;
  latest_compaction_id: string | null;
  latest_context_manifest_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface SessionMessage {
  id: string;
  session_id: string;
  role: SessionMessageRole;
  sender_id: string;
  sender_name: string | null;
  content: string;
  message_type: SessionMessageType;
  status: SessionMessageStatus;
  metadata: string | null;
  created_at: number;
}

export interface SessionRun {
  id: string;
  session_id: string;
  provider: AcpBackend;
  model: string | null;
  status: SessionRunStatus;
  mode: SessionMode;
  phase: SessionPhase | null;
  prompt: string;
  stdout: string;
  stderr: string;
  activity_log: string;
  error: string | null;
  acp_session_id: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SessionPlanItem {
  id: string;
  session_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: SessionPlanItemStatus;
  priority: number;
  source: string | null;
  evidence_event_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SessionContextManifest {
  id: string;
  session_id: string;
  run_id: string | null;
  total_token_estimate: number;
  prompt_hash: string | null;
  created_at: number;
  sources: SessionContextSource[];
}

export interface SessionContextSource {
  id: string;
  manifest_id: string;
  session_id: string;
  source_type: SessionContextSourceType;
  source_ref: string | null;
  title: string;
  included: 0 | 1;
  priority: number;
  token_estimate: number;
  reason: string | null;
  content_hash: string | null;
  excerpt: string | null;
  metadata: string | null;
  created_at: number;
}

export interface SessionCompaction {
  id: string;
  session_id: string;
  strategy: SessionCompactionStrategy;
  focus_prompt: string | null;
  preview_summary: string;
  applied_summary: string | null;
  retained_refs: string;
  dropped_refs: string;
  risk_notes: string | null;
  user_edited: 0 | 1;
  status: SessionCompactionStatus;
  created_at: number;
  applied_at: number | null;
}

export interface SessionEvidenceEvent {
  id: string;
  session_id: string;
  seq: number;
  event_type: SessionEvidenceType;
  severity: SessionEvidenceSeverity;
  source_run_id: string | null;
  source_message_id: string | null;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  created_at: number;
}

export interface SessionCheckpoint {
  id: string;
  session_id: string;
  title: string;
  description: string | null;
  git_head: string | null;
  branch_name: string | null;
  diff_summary: string | null;
  evidence_event_id: string | null;
  created_at: number;
}

export interface HistoryRecord {
  id: string;
  project_id: string;
  session_id: string;
  title: string;
  summary: string;
  status: HistoryRecordStatus;
  mode: SessionMode;
  started_at: number;
  ended_at: number;
  key_decisions: string[];
  changed_files: string[];
  verification_summary: string | null;
  commit_refs: string[];
  resume_brief: string;
  compact_count: number;
  fork_count: number;
  created_at: number;
  updated_at: number;
}

export interface SessionDetail {
  session: Session;
  messages: SessionMessage[];
  runs: SessionRun[];
  planItems: SessionPlanItem[];
  compactions: SessionCompaction[];
  checkpoints: SessionCheckpoint[];
  evidence: SessionEvidenceEvent[];
}

export interface StatusSnapshot {
  goal: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  status: SessionStatus;
  context: {
    totalTokenEstimate: number;
    latestCompactionId: string | null;
    retainedRecentMessages: number;
    pressure: 'low' | 'medium' | 'high';
  };
  git: {
    branchName: string | null;
    changedFileCount: number;
    hasUncommittedDiff: boolean;
    conflictRisk: 'none' | 'low' | 'high';
  };
  verification: {
    lastCommand: string | null;
    status: 'passed' | 'failed' | 'unknown';
    completedAt: number | null;
  };
  blocker: {
    reason: string;
    since: number;
    requiredAction: string;
  } | null;
  nextAction: {
    label: string;
    command: string | null;
    reason: string;
  };
  provider: {
    backend: AcpBackend | null;
    model: string | null;
    permissionMode: AcpPermissionMode | null;
  };
}

export interface SessionWorkspacePayload {
  project: Project;
  activeSession: SessionDetail;
  historyRecords: HistoryRecord[];
  status: StatusSnapshot;
  context: SessionContextManifest | null;
  evidence: SessionEvidenceEvent[];
}
