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
export type SessionRunStatus =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type SessionAgentRuntimeStatus = 'idle' | 'running' | 'paused' | 'failed' | 'completed';
export type SessionMessageRole = 'user' | 'assistant' | 'system';
export type SessionMessageType = 'text' | 'system' | 'agent_stream';
export type SessionMessageStatus = 'queued' | 'streaming' | 'completed' | 'failed';
export type SessionAgentEventChannel = 'answer' | 'activity' | 'thinking' | 'tool' | 'command' | 'event';
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
  closed_at: number | null;
  pinned_at: number | null;
  last_viewed_at: number | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface ActiveSessionSummary {
  id: string;
  project_id: string;
  project_name: string;
  project_path: string;
  title: string;
  status: SessionStatus;
  phase: SessionPhase;
  provider: AcpBackend | null;
  model: string | null;
  pinned_at: number | null;
  created_at: number;
  last_viewed_at: number | null;
  updated_at: number;
  unread_count: number;
  active_run_count: number;
  latest_event_summary: string | null;
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
  agent_id: string;
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
  runtime_profile_snapshot: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SessionTokenUsageRecord {
  id: string;
  session_id: string;
  run_id: string | null;
  agent_id: string | null;
  provider: AcpBackend | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  source: string;
  is_final: 0 | 1;
  raw_payload: Record<string, unknown>;
  created_at: number;
}

export interface SessionTokenUsageSummary {
  input: number;
  output: number;
  total: number;
}

export interface SessionAgentRuntime {
  id: string;
  session_id: string;
  agent_id: string;
  provider: AcpBackend;
  model: string | null;
  provider_session_id: string | null;
  status: SessionAgentRuntimeStatus;
  current_run_id: string | null;
  latest_checkpoint_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionAgentEvent {
  id: string;
  session_id: string;
  agent_id: string;
  run_id: string;
  seq: number;
  channel: SessionAgentEventChannel;
  event_type: string;
  content: string;
  payload_json: string | null;
  created_at: number;
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

export interface SessionTodoStats {
  sessionId: string;
  total: number;
  open: number;
  pending: number;
  inProgress: number;
  blocked: number;
  failed: number;
  completed: number;
  skipped: number;
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
  agentEvents: SessionAgentEvent[];
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

export interface SessionProjectSwitcher {
  activeProjectId: string;
  projects: Array<{
    id: string;
    name: string;
    path: string;
    active: boolean;
    created_at?: number;
    updated_at: number;
    pinned_at?: number | null;
    sort_order?: number | null;
    recentSessions: Array<{
      id: string;
      title: string;
      status: SessionStatus | HistoryRecordStatus;
      updated_at: number;
      href: string;
      source: 'session' | 'history';
    }>;
  }>;
}

export interface SessionBottomStatus {
  health: 'ok' | 'warning' | 'error';
  healthLabel: string;
  indexStatus: 'ready' | 'building' | 'missing' | 'unknown';
  indexLabel: string;
  lastResponseMs: number | null;
  errorRate: number | null;
  networkLatencyMs: number | null;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  } | null;
}

export interface SessionContract {
  sessionId: string;
  objective: string;
  scope: string | null;
  risks: string[];
  acceptanceCriteria: string[];
  updated_at: number;
}

export interface SessionToolRow {
  id: string;
  action: 'read' | 'write' | 'edit' | 'exec' | 'browser' | 'tool';
  label: string;
  target: string;
  status: 'completed' | 'running' | 'failed' | 'unknown';
  durationMs: number | null;
  runDurationMs?: number | null;
  command?: string | null;
  output?: string | null;
  detail?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  severity: SessionEvidenceSeverity;
  eventId: string;
  created_at: number;
}

export interface SessionDiffRow {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  additions: number | null;
  deletions: number | null;
  summary: string | null;
}

export interface SessionHistoryFilters {
  q: string;
  status: HistoryRecordStatus | 'all';
  mode: SessionMode | 'all';
}

export interface SessionWorkspacePayload {
  project: Project;
  activeSession: SessionDetail;
  activeSessions: ActiveSessionSummary[];
  historyRecords: HistoryRecord[];
  status: StatusSnapshot;
  context: SessionContextManifest | null;
  evidence: SessionEvidenceEvent[];
  projectSwitcher: SessionProjectSwitcher;
  bottomStatus: SessionBottomStatus;
  contract: SessionContract;
  toolRows: SessionToolRow[];
  diffRows: SessionDiffRow[];
  historyFilters: SessionHistoryFilters;
}
