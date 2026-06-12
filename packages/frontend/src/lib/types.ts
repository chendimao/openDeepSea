import type { KnowledgeSource } from './knowledgeDisplay';

export type AcpBackend = 'claudecode' | 'opencode' | 'codex';
export type AcpPermissionMode = 'bypass' | 'workspace-write' | 'read-only';
export type AgentRuntimeBackend = 'acp' | 'model' | 'none';
export type AgentMemoryScope = 'project' | 'room' | 'agent' | 'task' | 'none';
export type AgentToolCapability =
  | 'read_files'
  | 'write_files'
  | 'run_shell'
  | 'browser'
  | 'search'
  | 'image_input'
  | 'commit';

export interface AgentToolPolicy {
  allowed: AgentToolCapability[];
}

export interface AgentWorkspacePolicy {
  read: string[];
  write: string[];
}

export type WorkflowRole = 'analyst' | 'planner' | 'coordinator' | 'executor' | 'reviewer' | 'acceptor';
export type WorkflowStatus =
  | 'draft'
  | 'running'
  | 'awaiting_decision'
  | 'awaiting_approval'
  | 'blocked'
  | 'cancelled'
  | 'completed'
  | 'failed';
export type WorkflowStage = 'analysis' | 'planning' | 'assignment' | 'implementation' | 'code_review' | 'acceptance';
export type WorkflowPlanTaskMode = 'parallel' | 'serial';
export type WorkflowPlanTaskStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'skipped';
export interface WorkflowPlanTaskJson {
  id: string;
  title: string;
  description: string;
  role: Extract<WorkflowRole, 'planner' | 'executor' | 'reviewer' | 'acceptor'>;
  agent_id: string | null;
  mode: WorkflowPlanTaskMode;
  depends_on: string[];
  status: WorkflowPlanTaskStatus;
  progress: number;
  result_refs: string[];
}
export interface WorkflowPlanJson {
  workflow_name: string;
  source_message_id: string;
  goal: string;
  summary: string;
  tasks: WorkflowPlanTaskJson[];
}
export type SuperpowersPhase =
  | 'brainstorming'
  | 'spec_review'
  | 'worktree'
  | 'writing_plans'
  | 'plan_review'
  | 'tdd_execute'
  | 'spec_compliance_review'
  | 'code_quality_review'
  | 'finish_branch';
export type SuperpowersReviewVerdict = 'pending' | 'approved' | 'changes_requested' | 'failed';
export interface SuperpowersTddEvidence {
  stage: 'RED' | 'GREEN' | 'REFACTOR';
  command: string | null;
  summary: string | null;
  passed: boolean | null;
}
export interface SuperpowersReview {
  verdict: SuperpowersReviewVerdict;
  findings: string[];
  reviewedAt: string | null;
}
export interface SuperpowersVerificationEvidence {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  required: boolean;
  fresh: boolean;
  recordedAt: string | null;
}
export type SuperpowersFinishBranchDecisionValue = 'merge_local' | 'create_pr' | 'keep_branch' | 'discard_work';
export interface SuperpowersFinishBranchDecision {
  decision: SuperpowersFinishBranchDecisionValue;
  options: SuperpowersFinishBranchDecisionValue[];
  reason: string;
  decidedAt: string | null;
}
export interface SuperpowersGraphStateSummary {
  runtimeProfile?: 'superpowers';
  superpowersPhase?: SuperpowersPhase | string | null;
  designDocPath?: string | null;
  tddEvidence?: SuperpowersTddEvidence[];
  specComplianceReview?: SuperpowersReview | null;
  codeQualityReview?: SuperpowersReview | null;
  verificationEvidence?: SuperpowersVerificationEvidence[];
  finishBranchDecision?: SuperpowersFinishBranchDecision | null;
}
export type GraphNodeName =
  | 'context'
  | 'planning'
  | 'brainstorming'
  | 'spec_review'
  | 'worktree'
  | 'writing_plans'
  | 'plan_review'
  | 'approval'
  | 'dispatch'
  | 'execute'
  | 'tdd_execute'
  | 'review'
  | 'spec_compliance_review'
  | 'code_quality_review'
  | 'repair_decision'
  | 'verify'
  | 'finish_branch'
  | 'acceptance'
  | 'memory';
export type WorkflowDefinitionScope = 'system' | 'project' | 'room';
export type WorkflowDefinitionStatus = 'draft' | 'published' | 'archived';
export type WorkflowDefinitionNodeType =
  | 'context'
  | 'planning'
  | 'brainstorming'
  | 'spec_review'
  | 'worktree'
  | 'writing_plans'
  | 'plan_review'
  | 'approval_gate'
  | 'dispatch'
  | 'execute'
  | 'tdd_execute'
  | 'review'
  | 'spec_compliance_review'
  | 'code_quality_review'
  | 'repair_decision'
  | 'verify'
  | 'finish_branch'
  | 'acceptance'
  | 'memory';
export interface WorkflowDefinitionNodeMetadata {
  runtime_profile?: 'superpowers';
  required_skill_names?: string[];
  gate_policy?: string;
}
export interface WorkflowDefinitionGraphMetadata {
  runtime_profile?: 'superpowers';
  required_skill_names?: string[];
  gate_policy?: string;
}
export interface WorkflowDefinitionNode {
  id: string;
  type: WorkflowDefinitionNodeType;
  label: string;
  stage?: WorkflowStage | null;
  role?: WorkflowRole | null;
  position?: { x: number; y: number } | null;
  metadata?: WorkflowDefinitionNodeMetadata | null;
}
export interface WorkflowDefinitionEdge {
  from: string;
  to: string;
  condition?: string | null;
}
export interface WorkflowDefinitionGraph {
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
  metadata?: WorkflowDefinitionGraphMetadata | null;
}
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string | null;
  scope: WorkflowDefinitionScope;
  scope_id: string;
  version: number;
  status: WorkflowDefinitionStatus;
  builtin_key: string | null;
  definition_json: string;
  definition: WorkflowDefinitionGraph;
  created_at: number;
  updated_at: number;
}
export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'skipped';
export type TaskArtifactType =
  | 'analysis'
  | 'decision_request'
  | 'decision_response'
  | 'plan'
  | 'assignment'
  | 'implementation_summary'
  | 'review'
  | 'acceptance';
export type MemoryScope = 'global' | 'project' | 'room' | 'agent' | 'task';
export type MemoryType = 'decision' | 'fact' | 'preference' | 'lesson' | 'task_summary' | 'artifact_summary';
export type MemorySourceType = 'manual' | 'message' | 'workflow' | 'task';
export type TaskInteractionMode = 'ask_user' | 'auto_recommended';
export type TaskCreatedFrom = 'manual' | 'chat_plan' | 'slash_command' | 'workflow_assignment';
export type AcpSessionHandoffReason =
  | 'manual_new_session'
  | 'first_session'
  | 'resume_unavailable'
  | 'automatic_rotation'
  | 'automatic_rotation_after_events';
export type TaskEventType =
  | 'message_routed'
  | 'message_route_uncertain'
  | 'message_intent_uncertain'
  | 'plan_proposed'
  | 'runtime_event'
  | 'diff_detected'
  | 'task_created'
  | 'task_updated'
  | 'task_status_changed'
  | 'task_deleted'
  | 'workflow_started'
  | 'workflow_stage_changed'
  | 'workflow_plan_ready'
  | 'workflow_assignment_created'
  | 'workflow_blocked'
  | 'workflow_recovery_decided'
  | 'workflow_completed'
  | 'workflow_cancelled'
  | 'workflow_failed'
  | 'workflow_memory_written';
export type TaskKind =
  | 'chat_answer'
  | 'brainstorming'
  | 'code_review'
  | 'bug_fix'
  | 'frontend_change'
  | 'backend_change'
  | 'fullstack_change'
  | 'test_only'
  | 'docs_only'
  | 'ops_or_config'
  | 'unknown';
export type TaskRiskLevel = 'low' | 'medium' | 'high';
export type WorkflowExecutionMode = 'serial' | 'parallel' | 'hybrid';
export interface VerificationCommandMetadata {
  command: string;
  reason: string;
  required: boolean;
}
export interface TaskRiskAssessment {
  taskKind: TaskKind;
  riskLevel: TaskRiskLevel;
  requiresApproval: boolean;
  approvalReason: string;
  confidence: number;
  reasons: string[];
  scopeRead: string[];
  scopeWrite: string[];
  verificationCommands: VerificationCommandMetadata[];
}
export interface ApprovalCardMetadata {
  riskLevel: Exclude<TaskRiskLevel, 'low'>;
  taskKind: TaskKind;
  summary: string;
  approvalReason: string;
  agents: string[];
  executionMode: WorkflowExecutionMode;
  scopeRead: string[];
  scopeWrite: string[];
  verification: VerificationCommandMetadata[];
  risks: string[];
  assumptions: string[];
}
export type SessionApprovalStatus = 'pending' | 'approved' | 'rejected';
export interface SessionApprovalMetadata {
  status: SessionApprovalStatus;
  sourceMessageId: string;
  originalContent: string;
  riskAssessment: TaskRiskAssessment;
  approvalCard: ApprovalCardMetadata;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
  platformSkillRefs: PlatformSkillRef[];
  createdAt: number;
  decidedAt?: number;
  decidedByMessageId?: string;
}
export interface StructuredAgentEventMetadata {
  workflowRunId: string;
  stepId: string;
  agentRunId: string;
  type: 'started' | 'progress' | 'artifact' | 'decision_request' | 'scope_change_request' | 'blocked' | 'completed' | 'failed';
  summary: string;
  detail?: string;
  progress?: number;
  artifacts?: string[];
  requestedDecision?: {
    question: string;
    options?: string[];
    recommendation?: string;
    impact: string;
  };
  createdAt: number;
}
export type SettingsScope = 'system' | 'project' | 'room';
export type PlatformSkillProvider = 'codex' | 'claudecode' | 'opencode';
export type PlatformSkillInstallMode = 'copy' | 'symlink' | 'unknown';

export interface PlatformSkillRef {
  provider: PlatformSkillProvider;
  name: string;
}

export type TerminalProfile = 'project_shell' | 'skills_install';
export type TerminalStatus = 'running' | 'exited' | 'failed' | 'killed' | 'idle-timeout';

export interface TerminalSessionInfo {
  id: string;
  profile: TerminalProfile;
  cwd: string;
  status: TerminalStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
}

export interface CreateTerminalSessionInput {
  profile: TerminalProfile;
  projectId?: string | null;
  cols: number;
  rows: number;
}

export interface PlatformSkillSummary {
  provider: PlatformSkillProvider;
  label: string;
  root: string;
  rootExists: boolean;
  rootWritable: boolean;
  installedCount: number;
  issues: string[];
}

export interface PlatformSkill {
  provider: PlatformSkillProvider;
  name: string;
  description: string | null;
  path: string;
  manifestPath: string | null;
  installMode: PlatformSkillInstallMode;
  sourceLabel: string | null;
  version: string | null;
  lastModifiedAt: number | null;
  valid: boolean;
  issues: string[];
}

export interface SessionPlannerPlatformSkillsResponse {
  provider: PlatformSkillProvider;
  skills: PlatformSkill[];
}

export interface PlatformSkillAggregateIssue {
  provider: PlatformSkillProvider;
  message: string;
}

export interface PlatformSkillAggregate {
  name: string;
  displayName: string;
  description: string | null;
  providers: PlatformSkillProvider[];
  missingProviders: PlatformSkillProvider[];
  installations: Partial<Record<PlatformSkillProvider, PlatformSkill>>;
  installModes: Partial<Record<PlatformSkillProvider, PlatformSkillInstallMode>>;
  valid: boolean;
  issues: PlatformSkillAggregateIssue[];
  lastModifiedAt: number | null;
}

export type OnlineSkillView = 'all-time' | 'trending' | 'hot';
export type OnlineSkillAuditStatus = 'unknown' | 'none' | 'available';
export type OnlineSkillsTokenSource = 'settings' | 'environment' | 'none';

export interface OnlineSkill {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string | null;
  source: 'skillsmp';
  upstreamSource: string | null;
  sourceType: string | null;
  sourceUrl: string;
  installUrl: string | null;
  installCommand: string;
  tags: string[];
  author: string | null;
  stars: number | null;
  installs: number | null;
  updatedAt: number | null;
  auditStatus: OnlineSkillAuditStatus;
  installedProviders: PlatformSkillProvider[];
  isDuplicate: boolean;
}

export interface OnlineSkillListResponse {
  skills: OnlineSkill[];
  total: number;
  page: number;
  pages: number;
  limit: number;
  stale: boolean;
  updatedAt: number;
}

export interface OnlineSkillDetailResponse {
  skill: OnlineSkill;
  stale: boolean;
  updatedAt: number;
}

export interface OnlineSkillAuditResponse {
  id: string;
  status: Extract<OnlineSkillAuditStatus, 'none' | 'available'>;
  audit: unknown | null;
  stale: boolean;
  updatedAt: number;
}

export interface OnlineSkillsTokenConfig {
  tokenConfigured: boolean;
  tokenPreview: string | null;
  source: OnlineSkillsTokenSource;
  storedTokenConfigured: boolean;
  storedTokenPreview: string | null;
  environmentTokenConfigured: boolean;
  environmentTokenPreview: string | null;
}

export interface AgentReference {
  room_id: string;
  room_name: string;
  active?: boolean;
}

export interface Agent {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  preferred_user_name: string | null;
  personality: string | null;
  rules: string | null;
  responsibilities: string | null;
  default_acp_backend: AcpBackend | null;
  default_acp_permission_mode: AcpPermissionMode;
  default_runtime_backend: AgentRuntimeBackend;
  default_tool_policy: AgentToolPolicy;
  default_workspace_policy: AgentWorkspacePolicy;
  default_memory_scope: AgentMemoryScope;
  is_builtin: 0 | 1;
  builtin_key: string | null;
  created_at: number;
  updated_at: number;
  reference_count: number;
  references?: AgentReference[];
}

export interface ProjectUsedAgentsPayload {
  planner: {
    kind: 'session_planner';
    agent_id: 'planner';
    name: string;
    effective_acp_backend: AcpBackend;
    project_override_acp_backend: AcpBackend | null;
    backend_source: 'project' | 'builtin';
    runtime_profile: {
      permission_mode: AcpPermissionMode;
      runtime_backend: AgentRuntimeBackend;
      tool_policy: AgentToolPolicy;
      workspace_policy: AgentWorkspacePolicy;
      memory_scope: AgentMemoryScope;
    };
  };
  agents: ProjectUsedRoomAgent[];
}

export interface ProjectUsedRoomAgent {
  kind: 'room_agent';
  global_agent_id: string | null;
  agent_id: string;
  name: string;
  acp_enabled: boolean;
  acp_backend: AcpBackend | null;
  room_bindings: ProjectUsedRoomAgentBinding[];
}

export interface ProjectUsedRoomAgentBinding {
  room_id: string;
  room_name: string;
  room_agent_id: string;
  acp_backend: AcpBackend | null;
  workflow_role: WorkflowRole | null;
}

export type AgentInput = {
  agent_id: string;
  name: string;
  description?: string | null;
  preferred_user_name?: string | null;
  personality?: string | null;
  rules?: string | null;
  responsibilities?: string | null;
  default_acp_backend?: AcpBackend | null;
  default_acp_permission_mode?: AcpPermissionMode | null;
};

export interface ProjectStats {
  rooms: number;
  tasks: number;
  tasksDone: number;
  tasksInProgress: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  pinned_at?: number | null;
  sort_order?: number | null;
  message_routing_mode: MessageRoutingMode;
  fallback_agent_id: string | null;
  created_at: number;
  updated_at: number;
  stats?: ProjectStats;
}

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

export interface CreateSessionKnowledgeNoteInput {
  messageId?: string;
  title?: string;
  content?: string;
}

export interface SessionKnowledgeNoteMetadata {
  decisions: string[];
  constraints: string[];
  risks: string[];
  learnings: string[];
}

export interface SessionKnowledgeNoteResponse {
  source: KnowledgeSource;
  deduplicated: boolean;
  metadata: SessionKnowledgeNoteMetadata;
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

export type WorkflowArtifactVersionType = 'spec' | 'plan' | 'lightweight_plan' | 'review' | 'verification';
export type WorkflowArtifactVersionStatus = 'draft' | 'reviewing' | 'approved' | 'superseded' | 'rejected';

export interface WorkflowArtifactVersionView {
  id: string;
  workflow_run_id: string;
  artifact_type: WorkflowArtifactVersionType;
  version: number;
  status: WorkflowArtifactVersionStatus;
  title: string;
  content: string;
  structured_data: unknown;
  created_by_agent_id: string;
  change_request_message_id: string | null;
  approved_by: string | null;
  approved_at: number | null;
  created_at: number;
}

export interface WorkflowGateView {
  kind: 'spec_confirm' | 'plan_confirm' | 'finish_branch';
  workflow_run_id: string;
  artifact_version_id: string | null;
  status: 'pending' | 'approved' | 'blocked';
  reason: string;
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
  workflowArtifacts?: WorkflowArtifactVersionView[];
  workflowGates?: WorkflowGateView[];
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
    updated_at?: number;
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

export type MessageRoutingMode = 'mentions_only' | 'fallback_reply';
export type SuperpowersBootstrapOwner = 'project' | 'provider' | 'disabled';
export type ProviderSuperpowersProvider = 'claude' | 'codex' | 'opencode';
export type ProviderSuperpowersInstallStatus =
  | 'not_started'
  | 'installed'
  | 'installed_by_startup'
  | 'installing'
  | 'failed'
  | 'unsupported'
  | 'cli_missing';

export interface ProviderSuperpowersCheck {
  provider: ProviderSuperpowersProvider;
  label: string;
  cli_installed: boolean;
  version: string | null;
  superpowers_installed: boolean;
  install_attempted: boolean;
  install_status: ProviderSuperpowersInstallStatus;
  message: string | null;
  checked_at: number;
}

export interface ProviderSuperpowersStatus {
  started_at: number | null;
  completed_at: number | null;
  running: boolean;
  providers: ProviderSuperpowersCheck[];
}

export interface ScopedSettings {
  scope: SettingsScope;
  scope_id: string;
  message_routing_mode: MessageRoutingMode | null;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode | null;
  auto_distill_enabled: 0 | 1 | null;
  default_workflow_definition_id: string | null;
  superpowers_bootstrap_owner: SuperpowersBootstrapOwner | null;
  workspace_excluded_dirs: string | null;
  session_planner_acp_backend: AcpBackend | null;
  updated_at: number;
}

export interface EffectiveSettings {
  message_routing_mode: MessageRoutingMode;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode;
  auto_distill_enabled: boolean;
  default_workflow_definition_id: string | null;
  superpowers_bootstrap_owner: SuperpowersBootstrapOwner;
  workspace_excluded_dirs: string[];
  session_planner_acp_backend: AcpBackend | null;
}

export type KnowledgeEmbeddingProviderId = 'local-hash' | 'openai-compatible';

export interface KnowledgeEmbeddingRuntimeSummary {
  provider: KnowledgeEmbeddingProviderId;
  model: string;
  dimensions: number | null;
  base_url: string | null;
  api_key_set: boolean;
  api_key_env_var: string | null;
  available: boolean;
  unavailable_reason: string | null;
}

export interface KnowledgeEmbeddingStatus {
  runtime: KnowledgeEmbeddingRuntimeSummary;
  project_id?: string;
  total_enabled_chunks: number;
  embedded_chunks: number;
  stale_chunks: number;
  missing_chunks: number;
  failed_sources: number;
}

export interface KnowledgeEmbeddingRebuildResult {
  project_id: string;
  source_id?: string;
  provider: KnowledgeEmbeddingProviderId | string;
  model: string;
  scanned_chunks: number;
  rebuilt_chunks: number;
  skipped_chunks: number;
  failed_chunks: Array<{ chunk_id: string; source_id: string; error: string }>;
}

export interface KnowledgeEmbeddingSettingsPatch {
  provider: KnowledgeEmbeddingProviderId;
  model?: string | null;
  dimensions?: number | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
}

export interface WorkspaceSearchResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export interface WorkspaceSearchResponse {
  entries: WorkspaceSearchResult[];
  truncated: boolean;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number | null;
  mimeType: string | null;
  language: string | null;
}

export interface WorkspaceDirectoryResponse {
  path: string;
  entries: WorkspaceDirectoryEntry[];
}

export interface WorkspaceFilePreview {
  path: string;
  size: number;
  mimeType: string;
  language: string | null;
  content: string;
  truncated: boolean;
  mtimeMs: number;
}

export interface WorkspaceEntryMutationResponse {
  entry: WorkspaceDirectoryEntry;
}

export interface WorkspaceRenameEntryResponse {
  oldPath: string;
  newPath: string;
  entry: WorkspaceDirectoryEntry;
}

export type WorkspaceFileViewerKind = 'text' | 'image' | 'unsupported';

export interface SystemSettings extends EffectiveSettings {
  active_ai_config_id: string | null;
  ai_configs: AiConfig[];
  langchain_planner_model: string | null;
  openai_base_url: string | null;
  openai_api_key_set: boolean;
  openai_api_key_preview: string | null;
  knowledge_embedding_provider: KnowledgeEmbeddingProviderId;
  knowledge_embedding_model: string | null;
  knowledge_embedding_dimensions: number | null;
  knowledge_embedding_base_url: string | null;
  knowledge_embedding_api_key_env_var: string | null;
  global_session_prompt: string | null;
}

export interface AiConfig {
  id: string;
  name: string;
  langchain_planner_model: string;
  openai_base_url: string;
  openai_api_key_set: boolean;
  openai_api_key_preview: string | null;
  created_at: number;
  updated_at: number;
}

export type ProviderSyncStatus = 'idle' | 'success' | 'failed';
export type ProviderRuntimeConfigSource = 'managed_profile' | 'discovered_snapshot' | 'cli_default';
export type ProviderApiKeyEnvVar = 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';

export interface ProviderConfigSource {
  provider: AcpBackend;
  config_dir: string | null;
  use_default_config_dir: boolean;
  auto_sync_enabled: boolean;
  last_sync_at: number | null;
  last_sync_status: ProviderSyncStatus;
  last_sync_error: string | null;
  updated_at: number;
}

export interface ProviderDiscoveredSnapshot {
  provider: AcpBackend;
  config_dir: string;
  config_file: string | null;
  detected_model: string | null;
  detected_base_url: string | null;
  api_key_set: boolean;
  api_key_preview: string | null;
  api_key_env_var: ProviderApiKeyEnvVar;
  reasoning_effort: string | null;
  raw_summary_json: string;
  synced_at: number;
}

export interface ManagedProviderProfile {
  id: string;
  name: string;
  provider: AcpBackend;
  model: string | null;
  base_url: string | null;
  api_key_set: boolean;
  api_key_preview: string | null;
  api_key_env_var: ProviderApiKeyEnvVar;
  reasoning_effort: string | null;
  run_overrides_enabled: boolean;
  is_active: boolean;
  created_from_snapshot_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderRuntimeConfig {
  provider: AcpBackend;
  source: ProviderRuntimeConfigSource;
  profile_id: string | null;
  model: string | null;
  base_url: string | null;
  api_key_set: boolean;
  api_key_preview: string | null;
  api_key_env_var: ProviderApiKeyEnvVar;
  reasoning_effort: string | null;
  run_overrides_enabled: boolean;
}

export interface ProviderConfigList {
  sources: ProviderConfigSource[];
  snapshots: ProviderDiscoveredSnapshot[];
  profiles: ManagedProviderProfile[];
  runtime: ProviderRuntimeConfig[];
}

export interface SettingsResolution {
  system: SystemSettings;
  project: ScopedSettings | null;
  room: ScopedSettings | null;
  effective: EffectiveSettings;
  sources: {
    message_routing: SettingsScope;
    interaction_mode: SettingsScope;
    auto_distill: SettingsScope;
    default_workflow_definition: SettingsScope;
    superpowers_bootstrap_owner: SettingsScope;
    session_planner_acp_backend: SettingsScope | 'inherit';
  };
}

export interface Room {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: number;
  last_opened_at?: number | null;
  pinned_at?: number | null;
  sort_order?: number | null;
}

export type RoomSearchMode = 'semantic' | 'keyword';
export type RoomSearchMatchedField =
  | 'room_name'
  | 'room_description'
  | 'message'
  | 'task_title'
  | 'task_description';

export interface RoomSearchResult {
  room: Room;
  score: number;
  matchedFields: RoomSearchMatchedField[];
  highlights: string[];
}

export interface RoomSearchResponse {
  query: string;
  mode: RoomSearchMode;
  degraded: boolean;
  degradationReason: string | null;
  total: number;
  results: RoomSearchResult[];
}

export interface RoomAgent {
  id: string;
  room_id: string;
  global_agent_id: string | null;
  agent_id: string;
  agent_name: string;
  agent_role: string | null;
  preferred_user_name: string | null;
  personality: string | null;
  rules: string | null;
  responsibilities: string | null;
  workflow_role: WorkflowRole | null;
  capabilities: string[];
  default_runtime: 'acp' | 'openclaw' | 'none';
  runtime_backend: AgentRuntimeBackend | null;
  tool_policy: AgentToolPolicy | null;
  workspace_policy: AgentWorkspacePolicy | null;
  memory_scope: AgentMemoryScope | null;
  joined_at: number;
  left_at: number | null;
  acp_enabled: 0 | 1;
  acp_backend: AcpBackend | null;
  acp_session_id: string | null;
  acp_session_label: string | null;
  acp_permission_mode: AcpPermissionMode;
  acp_writable_dirs: string[];
}

export type AgentRunStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface AgentRun {
  id: string;
  room_id: string;
  room_agent_id: string;
  agent_id: string;
  backend: 'openclaw' | AcpBackend;
  status: AgentRunStatus;
  session_key: string | null;
  acp_session_id: string | null;
  task_id: string | null;
  workflow_run_id: string | null;
  workflow_step_id: string | null;
  workflow_stage: WorkflowStage | null;
  prompt: string;
  stdout: string;
  stderr: string;
  activity_log: string;
  error: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface MessageAttachmentMetadata {
  id: string;
  fileId?: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  isImage: boolean;
  deleted?: boolean;
}

export interface MessageReplyMetadata {
  message_id: string;
  sender_type: 'user' | 'agent' | 'system';
  sender_id: string;
  sender_name: string | null;
  excerpt: string;
}

export interface ProjectFile {
  id: string;
  project_id: string;
  source_type: ResourceType;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  url: string;
  storage_path?: string;
  uploaded_by_id: string | null;
  uploaded_by_name: string | null;
  source_message_id: string | null;
  source_room_id: string | null;
  source_agent_id: string | null;
  source_task_id: string | null;
  content: string | null;
  created_at: number;
  deleted_at: number | null;
  reference_count: number;
  last_referenced_at: number | null;
  last_referenced_message_id: string | null;
  last_referenced_room_id: string | null;
  last_referenced_room_name: string | null;
}

export type ImageGenerationWorkflow = 'generate' | 'image-to-image';
export type ImageGenerationStatus = 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'canceled';
export type ImageJobGroupBy = 'prompt' | 'task' | 'session';
export type ImageProviderCompatProfileId = 'openai' | 'openai-sdk' | 'images-edits' | 'chat-completions';

export interface ImageProviderProfile {
  id: string;
  project_id: string;
  name: string;
  base_url: string;
  model: string;
  compat_profile_id: ImageProviderCompatProfileId;
  supports_count_parameter: 0 | 1;
  active: 0 | 1;
  has_api_key: 0 | 1;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ImageProviderProfileInput {
  name: string;
  base_url: string;
  api_key?: string | null;
  model: string;
  compat_profile_id?: ImageProviderCompatProfileId;
  supports_count_parameter?: boolean;
}

export interface ImageProviderModel {
  id: string;
  category: 'image' | 'other';
}

export interface ImageProviderModelsResponse {
  normalized_base_url: string;
  models: ImageProviderModel[];
  warning: string | null;
}

export interface ImageGenerationJob {
  id: string;
  project_id: string;
  room_id: string | null;
  session_id: string | null;
  source_message_id: string | null;
  source_agent_id: string | null;
  source_task_id: string | null;
  provider_profile_id: string;
  workflow: ImageGenerationWorkflow;
  prompt: string;
  count: number;
  quality: string;
  size: string;
  status: ImageGenerationStatus;
  message: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

export interface ImageJobGroup {
  key: string;
  label: string;
  count: number;
  latest_job_id: string;
  latest_updated_at: number;
}

export interface ImageGenerationOutput {
  id: string;
  job_id: string;
  file_id: string;
  slot: number;
  name: string;
  url: string;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface ImageGenerationSourceImage {
  id: string;
  job_id: string;
  file_id: string;
  slot: number;
  url: string;
  origin_job_id: string | null;
  origin_output_id: string | null;
  created_at: number;
}

export interface ImageJobCreateInput {
  room_id?: string | null;
  session_id?: string | null;
  source_message_id?: string | null;
  source_agent_id?: string | null;
  source_task_id?: string | null;
  provider_profile_id?: string | null;
  workflow: ImageGenerationWorkflow;
  prompt: string;
  count: number;
  quality?: string;
  size?: string;
  source_file_ids?: string[];
}

export interface ImageJobListFilters {
  sessionId?: string;
  roomId?: string;
  status?: ImageGenerationStatus;
}

export interface ImageJobListResponse {
  jobs: ImageGenerationJob[];
}

export interface ImageJobDetailResponse {
  job: ImageGenerationJob;
  outputs: ImageGenerationOutput[];
  source_images: ImageGenerationSourceImage[];
}

export interface ImageJobCreateResponse {
  job: ImageGenerationJob;
  outputs: ImageGenerationOutput[];
}

export interface ImagePromptPreset {
  id: string;
  project_id: string;
  title: string;
  prompt: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ImagePromptPresetInput {
  title: string;
  prompt: string;
}

export type ResourceType = 'uploaded_file' | 'agent_document' | 'unknown';

export interface ResourceSourceInfo {
  type: 'user_upload' | 'agent';
  label: string;
  display_name: string | null;
  agent_id: string | null;
  user_id: string | null;
  message_id: string | null;
  room_id: string | null;
  task_id: string | null;
  context: {
    id: string;
    type: 'room' | 'task';
    name: string | null;
  } | null;
}

export interface ResourceCapabilities {
  preview: boolean;
  download: boolean;
  markdown: boolean;
  delete: boolean;
}

export interface ResourceListItem {
  id: string;
  project_id: string;
  asset_type: ResourceType;
  resource_type: ResourceType;
  group_key: 'uploaded_files' | 'agent_documents';
  title: string;
  name: string;
  mime_type: string | null;
  size: number | null;
  url: string | null;
  file_id: string | null;
  source_message_id: string | null;
  source_room_id: string | null;
  source_agent_id: string | null;
  source_task_id: string | null;
  source_display_name: string | null;
  source_label: string;
  source_context_id: string | null;
  source_context_name: string | null;
  source_context_type: 'room' | 'task' | null;
  source: ResourceSourceInfo;
  capabilities: ResourceCapabilities;
  preview_url: string | null;
  download_url: string | null;
  reference_count?: number;
  last_referenced_at?: number | null;
  last_referenced_message_id?: string | null;
  last_referenced_room_id?: string | null;
  last_referenced_room_name?: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ResourceDetail {
  id: string;
  project_id: string;
  asset_type: ResourceType;
  resource_type: ResourceType;
  group_key: 'uploaded_files' | 'agent_documents';
  title: string;
  name: string;
  content: string | null;
  mime_type: string | null;
  size: number | null;
  url: string | null;
  file_id: string | null;
  source_message_id: string | null;
  source_room_id: string | null;
  source_agent_id: string | null;
  source_task_id: string | null;
  source_display_name: string | null;
  source_label: string;
  source_context_id: string | null;
  source_context_name: string | null;
  source_context_type: 'room' | 'task' | null;
  source: ResourceSourceInfo;
  capabilities: ResourceCapabilities;
  preview_url: string | null;
  download_url: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface MessageMetadata {
  attachments: MessageAttachmentMetadata[];
  image_generation_job_id?: string;
  image_generation_status?: ImageGenerationStatus;
  reply_to?: MessageReplyMetadata;
  intent_result?: MessageIntentResult;
  task_execution?: TaskExecutionDecision;
  trace?: MessageTrace;
  acp_enabled?: boolean;
  acp_backend?: AcpBackend | null;
  acp_session_id?: string | null;
  internal?: boolean;
  task_id?: string;
  task_title?: string;
  message_id?: string;
  workflow_run_id?: string;
  workflow_step_id?: string;
  agent_run_id?: string;
  event_type?: TaskEventType;
  origin?: TaskCreatedFrom;
  timeline_type?: string;
  timeline_status?: 'running' | 'completed' | 'failed';
  risk_assessment?: TaskRiskAssessment;
  approval_card?: ApprovalCardMetadata;
  session_approval?: SessionApprovalMetadata;
  agent_event?: StructuredAgentEventMetadata;
  source_message_id?: string;
  fallback_agent_id?: string;
  collaboration_decision?: CollaborationDecision;
  route_result?: RouteResult;
  task_readiness?: TaskReadinessMetadata;
  pending_action?: PendingActionMetadata;
  pending_action_decision?: PendingActionDecisionMetadata;
  choice_options?: MessageChoiceOption[];
  choice_option_selection?: MessageChoiceOptionSelection;
  brainstorming_options?: BrainstormingOption[];
  brainstorming_option_selection?: BrainstormingOptionSelection;
}

export interface RouteResult {
  taskId: string | null;
  action: 'append_to_task' | 'switch_task' | 'create_task' | 'ask_user' | 'reply_in_chat';
  confidence: number;
  reason: string;
  reason_code?: RouteReasonCode;
  pending_action_context?: PendingActionRouteContext;
  reply_context?: {
    message_id: string;
    reason: 'short_confirmation_to_recent_agent';
  };
}

export type RouteReasonCode =
  | 'explicit_task'
  | 'explicit_task_terminal'
  | 'explicit_task_not_found'
  | 'reply_to_task'
  | 'create_task_intent'
  | 'confirm_previous_action'
  | 'confirm_previous_not_actionable'
  | 'reply_in_chat';

export type MessageIntent = 'chat' | 'light_task' | 'debugger' | 'brainstorming' | 'workflow';
export type MessageIntentSource = 'rule' | 'classifier' | 'user_override';
export type MessageIntentSuggestedAction =
  | 'reply_in_chat'
  | 'create_light_task'
  | 'start_debugger'
  | 'start_brainstorming'
  | 'start_workflow'
  | 'ask_user';

export interface MessageIntentResult {
  intent: MessageIntent;
  source?: MessageIntentSource;
  suggestedAction: MessageIntentSuggestedAction;
  confidence: number;
  reason: string;
  signals?: string[];
}

export type TaskExecutionState =
  | 'ready_to_execute'
  | 'needs_choice'
  | 'needs_boundary_confirmation'
  | 'analysis_only'
  | 'blocked';

export interface TaskExecutionStep {
  agent_id: string;
  goal: string;
}

export interface TaskExecutionDecision {
  state: TaskExecutionState;
  status: 'suggested' | 'dispatching' | 'completed' | 'blocked' | 'needs_fix';
  summary: string;
  reason?: string;
  next_steps: TaskExecutionStep[];
}

export type TaskActionKind =
  | 'start_execution'
  | 'auto_advance'
  | 'route_skills'
  | 'brainstorming'
  | 'writing_plans'
  | 'subagent_execution'
  | 'systematic_debugging'
  | 'verification'
  | 'finish_branch';

export type TaskActionStatus = 'idle' | 'queued' | 'running' | 'failed' | 'completed' | 'blocked';

export interface TaskActionState {
  status: TaskActionStatus;
  detail?: string;
  evidence?: Record<string, unknown>;
  reviewFindings?: TaskReviewFinding[];
  reviewFixRounds?: number;
}

export interface TaskReviewFinding {
  severity: 'critical' | 'important' | 'minor';
  summary: string;
  file?: string;
  line?: number;
}

export interface TaskActionStartResult {
  action: TaskActionKind;
  status: Exclude<TaskActionStatus, 'idle'>;
  run_ids: string[];
  message_id?: string;
  blocked_reason?: string;
}

export type AgentRunRetryResult =
  | { retry_type: 'agent_run'; run: AgentRun }
  | { retry_type: 'task_action'; result: TaskActionStartResult };

export interface MessageTraceThinking {
  text: string;
}

export interface MessageTraceToolCall {
  name: string;
  input: string;
  output?: string;
}

export interface MessageTraceCommand {
  command: string;
  output?: string;
}

export type AgentTimelineEventType =
  | 'thinking'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'command'
  | 'command_output'
  | 'file_diff'
  | 'plan_update'
  | 'runtime_event'
  | 'subagent_started'
  | 'subagent_progress'
  | 'subagent_completed'
  | 'subagent_failed'
  | 'web_search'
  | 'permission_request'
  | 'error'
  | 'raw';

export type AgentTimelineEventStatus = 'started' | 'delta' | 'completed' | 'failed';

export type AgentTimelinePayload = Record<string, unknown>;

export interface AgentTimelineEvent {
  id: string;
  message_id: string;
  run_id: string;
  agent_id: string;
  seq: number;
  type: AgentTimelineEventType;
  status: AgentTimelineEventStatus;
  title: string;
  payload: AgentTimelinePayload;
  raw?: Record<string, unknown>;
  created_at: number;
}

export interface MessageTrace {
  thinking?: MessageTraceThinking[];
  tool_calls?: MessageTraceToolCall[];
  commands?: MessageTraceCommand[];
  events?: AgentTimelineEvent[];
  events_total?: number;
  events_omitted?: number;
}

export type CollaborationIntent = 'question' | 'analysis' | 'implementation';
export type CollaborationMode = 'chat_collaboration' | 'formal_workflow';
export type CollaborationProblemArea = 'frontend' | 'backend' | 'fullstack' | 'unknown';
export type CollaborationStage = 'execute' | 'review' | 'acceptance' | 'summary';
export type TaskExecutionIntent =
  | 'analysis_only'
  | 'planning_only'
  | 'documentation_only'
  | 'implementation'
  | 'debug_fix'
  | 'review_only';

export interface CollaborationStagePlan {
  stage: CollaborationStage;
  agentIds: string[];
  parallel: boolean;
  goal: string;
}

export interface CollaborationDecision {
  intent: CollaborationIntent;
  recommendedMode: CollaborationMode;
  problemArea: CollaborationProblemArea;
  summary: string;
  rationale: string;
  needsUserChoice: boolean;
  proposedAgents: {
    executors: string[];
    reviewers: string[];
    testers: string[];
    acceptors: string[];
  };
  stages: CollaborationStagePlan[];
}

export interface TaskReadinessMetadata {
  ready: boolean;
  confidence: number;
  title: string;
  description: string;
  missing_questions: string[];
  recommended_mode: CollaborationMode;
  execution_intent?: TaskExecutionIntent;
  source_message_id?: string;
}

export interface PendingActionMetadata {
  id: string;
  kind: 'create_task_from_analysis';
  status: 'awaiting_confirmation';
  source_message_id: string;
  title: string;
  description: string;
  risk_level: 'low' | 'normal' | 'high';
}

export interface PendingActionDecisionMetadata {
  action_id: string;
  source_message_id: string;
  decision: 'approve' | 'reject' | 'clarify';
}

export interface PendingActionRouteContext {
  action_id: string;
  planner_message_id: string;
}

export type BrainstormingOptionMaturity = 'exploratory' | 'boundary_needed' | 'actionable';
export type MessageChoiceOptionMaturity = BrainstormingOptionMaturity;

export interface BrainstormingOption {
  id: string;
  title: string;
  summary: string;
  benefits: string[];
  risks: string[];
  maturity: BrainstormingOptionMaturity;
  recommended?: boolean;
}

export type MessageChoiceOption = BrainstormingOption;

export interface MessageChoiceOptionSelection {
  selected_option_id: string;
  selected_option_title: string;
  selected_option_maturity: MessageChoiceOptionMaturity;
  source_message_id: string;
  source_type: 'message_option' | 'brainstorming_option';
}

export interface BrainstormingOptionSelection {
  selected_option_id: string;
  selected_option_title: string;
  selected_option_maturity: BrainstormingOptionMaturity;
  source_message_id: string;
  source_type: 'brainstorming_option';
}

export interface CollaborationRunSummary {
  id: string;
  room_id: string;
  source_message_id: string;
  status: 'running' | 'completed' | 'blocked';
}

export interface Message {
  id: string;
  room_id: string;
  sender_type: 'user' | 'agent' | 'system';
  sender_id: string;
  sender_name: string | null;
  content: string;
  message_type: 'text' | 'task' | 'system' | 'code' | 'agent_stream';
  layer?: MessageLayer;
  metadata: string | null;
  created_at: number;
}

export type MessageLayer = 'chat' | 'activity' | 'timeline' | 'runtime' | 'diff';

export interface TaskEvent {
  id: string;
  task_id: string;
  room_id: string;
  seq: number;
  type: TaskEventType;
  layer: MessageLayer;
  payload: Record<string, unknown>;
  source_run_id: string | null;
  created_at: number;
}

export interface TaskEventReplayState {
  task_id: string;
  room_id: string;
  title: string | null;
  description: string | null;
  status: Task['status'] | null;
  priority: Task['priority'] | null;
  interaction_mode: TaskInteractionMode | null;
  assigned_agent_id: string | null;
  source_message_id: string | null;
  created_from: TaskCreatedFrom | null;
  deleted: boolean;
  created_event_id: string | null;
  last_event_id: string | null;
  last_seq: number;
}

export interface TaskEventListResponse {
  events: TaskEvent[];
  replay?: TaskEventReplayState | null;
}

export interface TaskExecutorListItem {
  id: string;
  task_id: string;
  room_id: string;
  room_agent_id: string;
  agent_id: string;
  agent_name: string | null;
  acp_backend: AcpBackend | null;
  acp_session_id: string | null;
  status: 'idle' | 'running' | 'blocked' | 'failed';
  acp_session_handoff_pending: 0 | 1;
  acp_session_handoff_reason: AcpSessionHandoffReason | null;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: string;
  room_id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'review' | 'done' | 'failed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  interaction_mode: TaskInteractionMode;
  assigned_agent_id: string | null;
  source_message_id: string | null;
  created_from: TaskCreatedFrom | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  deleted_at: number | null;
}

export interface WorkflowRun {
  id: string;
  room_id: string;
  project_id: string;
  task_id: string;
  status: WorkflowStatus;
  current_stage: WorkflowStage | null;
  approval_required: 0 | 1;
  approved_at: number | null;
  approved_by: string | null;
  openclaw_flow_id: string | null;
  graph_version: string | null;
  graph_state: string | null;
  workflow_definition_id: string | null;
  workflow_definition_version: number | null;
  workflow_definition_snapshot: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  error: string | null;
}

export interface WorkflowStep {
  id: string;
  workflow_run_id: string;
  task_id: string;
  stage: WorkflowStage;
  node_name: GraphNodeName | null;
  status: WorkflowStepStatus;
  room_agent_id: string | null;
  assigned_room_agent_id: string | null;
  agent_run_id: string | null;
  scope_read: string[];
  scope_write: string[];
  prompt: string;
  result: string;
  result_message_id: string | null;
  openclaw_child_task_id: string | null;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface TaskArtifact {
  id: string;
  task_id: string;
  workflow_run_id: string;
  workflow_step_id: string | null;
  artifact_type: TaskArtifactType;
  title: string;
  content: string;
  metadata: string | null;
  created_at: number;
}

export interface MemoryEntry {
  id: string;
  project_id: string | null;
  room_id: string | null;
  room_agent_id: string | null;
  task_id: string | null;
  scope: MemoryScope;
  memory_type: MemoryType;
  title: string;
  content: string;
  source_type: MemorySourceType;
  source_id: string | null;
  pinned: 0 | 1;
  archived: 0 | 1;
  created_at: number;
  updated_at: number;
}

export interface MemorySearchResult extends MemoryEntry {
  room_name: string | null;
}

export interface MemoryInput {
  scope: MemoryScope;
  memory_type: MemoryType;
  title: string;
  content: string;
  room_id?: string | null;
  room_agent_id?: string | null;
  task_id?: string | null;
  source_type?: MemorySourceType;
  source_id?: string | null;
  pinned?: boolean;
}

export type GlobalChatRole = 'user' | 'assistant' | 'system';
export type GlobalChatMessageStatus = 'completed' | 'failed';

export interface GlobalChatMemoryRef {
  id: string;
  title: string;
  scope: MemoryScope;
  project_id: string | null;
  room_id?: string | null;
  task_id?: string | null;
}

export interface GlobalChatMessageMetadata {
  memory_refs?: GlobalChatMemoryRef[];
  config_refs?: string[];
  error?: string;
  model_chat?: boolean;
  [key: string]: unknown;
}

export interface GlobalChatSession {
  id: string;
  title: string;
  archived: 0 | 1;
  created_at: number;
  updated_at: number;
}

export interface GlobalChatMessage {
  id: string;
  session_id: string;
  role: GlobalChatRole;
  content: string;
  status: GlobalChatMessageStatus;
  metadata: GlobalChatMessageMetadata;
  created_at: number;
}

export interface GlobalChatSendResponse {
  userMessage: GlobalChatMessage;
  assistantMessage: GlobalChatMessage;
}

export interface WorkflowDetail {
  run: WorkflowRun;
  steps: WorkflowStep[];
  artifacts: TaskArtifact[];
}

export interface CliSession {
  backend: AcpBackend;
  sessionId: string;
  title: string;
  cwd: string;
  messageCount: number;
  lastActivity: number;
  firstUserMessage?: string;
}

export interface BuiltInAgentTemplate {
  id: string;
  name: string;
  description: string;
  workflow_role: WorkflowRole;
  acp_enabled: true;
  acp_backend: AcpBackend;
  capabilities: string[];
}

export interface RoomCrewTemplate {
  id: string;
  name: string;
  description: string;
  agent_template_ids: string[];
  default: boolean;
}
