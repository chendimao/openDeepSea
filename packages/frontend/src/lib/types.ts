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
export type SettingsScope = 'system' | 'project' | 'room';
export type SkillRuntimeScope = 'planner' | 'model_chat' | 'workflow' | 'memory' | 'review';
export type SkillTriggerMode = 'manual' | 'keyword' | 'always_for_scope';
export type SkillBindingScope = 'system' | 'project' | 'room' | 'agent';
export type SkillSourceType = 'local_directory' | 'git_repo' | 'manual' | 'skills_sh';
export type SkillExecutableRuntime = 'node' | 'python' | 'shell';
export type SkillUpdateCheckMode = 'off' | 'startup' | 'manual';
export type SkillUpdateApplyMode = 'prompt';
export type SkillRunInvoker = 'workflow' | 'agent' | 'manual';
export type SkillRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type PlatformSkillProvider = 'codex' | 'claudecode' | 'opencode';
export type PlatformSkillInstallMode = 'copy' | 'symlink' | 'unknown';

export interface SkillPermissions {
  filesystem: 'project';
  network: boolean;
  commands: string[];
}

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  source_type: SkillSourceType;
  source_uri: string | null;
  source_uri_set: boolean;
  manifest_path: string | null;
  runtime_scopes: SkillRuntimeScope[];
  trigger_mode: SkillTriggerMode;
  trigger_keywords: string[];
  enabled: 0 | 1;
  priority: number;
  checksum: string | null;
  package_version: string | null;
  package_revision: string | null;
  runtime_type: SkillExecutableRuntime | null;
  entrypoint: string | null;
  permissions: SkillPermissions | null;
  install_source_label: string | null;
  update_check_mode: SkillUpdateCheckMode;
  update_apply_mode: SkillUpdateApplyMode;
  last_update_checked_at: number | null;
  available_version: string | null;
  available_revision: string | null;
  install_path_set: boolean;
  install_path_label?: string | null;
  created_at: number;
  updated_at: number;
}

export interface SkillBinding {
  id: string;
  skill_id: string;
  scope: SkillBindingScope;
  scope_id: string;
  enabled: 0 | 1;
  priority_override: number | null;
  created_at: number;
  updated_at: number;
}

export interface SkillPreviewResponse {
  skills: Array<{
    id: string;
    name: string;
    reasons: string[];
    effectivePriority: number;
    truncated: boolean;
  }>;
  promptPreview: string;
}

export interface SkillsShSearchResult {
  id: string;
  name: string;
  skillId: string | null;
  source: string | null;
  installLabel: string;
  description: string | null;
  installs: number | null;
  version: string | null;
  revision: string | null;
}

export interface SkillsShUpdateResult {
  skillId: string;
  hasUpdate: boolean;
  currentVersion: string | null;
  currentRevision: string | null;
  availableVersion: string | null;
  availableRevision: string | null;
  checkedAt: number;
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

export interface SkillRun {
  id: string;
  skill_id: string;
  project_id: string | null;
  room_id: string | null;
  agent_id: string | null;
  invoked_by: SkillRunInvoker;
  runtime: SkillExecutableRuntime;
  entrypoint: string;
  input: unknown;
  allowed_paths_count: number;
  allowed_paths_set: boolean;
  network_enabled: 0 | 1;
  status: SkillRunStatus;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  result: unknown;
  error: string | null;
  created_at: number;
  updated_at: number;
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
  message_routing_mode: MessageRoutingMode;
  fallback_agent_id: string | null;
  created_at: number;
  updated_at: number;
  stats?: ProjectStats;
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
  updated_at: number;
}

export interface EffectiveSettings {
  message_routing_mode: MessageRoutingMode;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode;
  auto_distill_enabled: boolean;
  default_workflow_definition_id: string | null;
  superpowers_bootstrap_owner: SuperpowersBootstrapOwner;
}

export interface SystemSettings extends EffectiveSettings {
  active_ai_config_id: string | null;
  ai_configs: AiConfig[];
  langchain_planner_model: string | null;
  openai_base_url: string | null;
  openai_api_key_set: boolean;
  openai_api_key_preview: string | null;
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
  reply_to?: MessageReplyMetadata;
  intent_result?: MessageIntentResult;
  planner_decision?: PlannerDecision;
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
  event_type?: TaskEventType;
  origin?: TaskCreatedFrom;
  source_message_id?: string;
  fallback_agent_id?: string;
  collaboration_decision?: CollaborationDecision;
  route_result?: RouteResult;
  task_readiness?: TaskReadinessMetadata;
}

export interface RouteResult {
  taskId: string | null;
  action: 'append_to_task' | 'switch_task' | 'create_task' | 'ask_user';
  confidence: number;
  reason: string;
  reason_code?: RouteReasonCode;
}

export type RouteReasonCode =
  | 'explicit_task'
  | 'explicit_task_terminal'
  | 'explicit_task_not_found'
  | 'active_task'
  | 'title_match'
  | 'create_task_intent'
  | 'ambiguous';

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

export type PlannerExecutionMode = 'pause_after_suggestion' | 'auto_continue' | 'dispatch_next';

export interface PlannerDecisionStep {
  agent_id: string;
  goal: string;
}

export interface PlannerDecision {
  mode: PlannerExecutionMode;
  status: 'suggested' | 'dispatching' | 'completed' | 'blocked' | 'needs_fix';
  summary: string;
  next_steps: PlannerDecisionStep[];
  awaiting_user_confirmation: boolean;
}

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
