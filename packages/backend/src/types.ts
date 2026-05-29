export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  message_routing_mode: MessageRoutingMode;
  fallback_agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export type MessageRoutingMode = 'mentions_only' | 'fallback_reply';
export type SettingsScope = 'system' | 'project' | 'room';
export type {
  Skill,
  SkillBinding,
  SkillBindingScope,
  SkillExecutableRuntime,
  SkillPermissions,
  SkillRun,
  SkillRunInvoker,
  SkillRunStatus,
  SkillRuntimeScope,
  SkillSourceType,
  SkillTriggerMode,
  SkillUpdateApplyMode,
  SkillUpdateCheckMode,
} from './skills/types.js';

export interface Room {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: number;
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

export type AcpBackend = 'claudecode' | 'opencode' | 'codex';
export type AcpPermissionMode = 'bypass' | 'workspace-write' | 'read-only';
export type AcpSessionHandoffReason =
  | 'manual_new_session'
  | 'first_session'
  | 'resume_unavailable'
  | 'automatic_rotation'
  | 'automatic_rotation_after_events';
export type AgentDefaultRuntime = 'acp' | 'openclaw' | 'none';
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

export interface ResolvedAgentRuntimeProfile {
  runtimeBackend: AgentRuntimeBackend;
  acpBackend: AcpBackend | null;
  acpPermissionMode: AcpPermissionMode;
  readableDirs: string[];
  writableDirs: string[];
  toolPolicy: AgentToolPolicy;
  memoryScope: AgentMemoryScope;
  contextBudget: number | null;
  warnings: string[];
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
export type WorkflowIncidentType =
  | 'backend_restart_interrupted'
  | 'agent_run_stale'
  | 'step_without_active_run'
  | 'child_task_failed'
  | 'executor_unavailable'
  | 'runtime_boundary_mismatch'
  | 'planner_output_invalid'
  | 'unknown';
export type WorkflowIncidentStatus = 'open' | 'deciding' | 'executing' | 'resolved' | 'blocked' | 'ignored';
export type WorkflowIncidentSeverity = 'info' | 'warning' | 'critical';
export type WorkflowRecoveryAction =
  | 'retry_same_agent'
  | 'retry_with_global_agent'
  | 'reassign_agent'
  | 'split_task'
  | 'ask_user'
  | 'mark_blocked';
export type WorkflowRecoveryActionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
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
export interface WorkflowIncident {
  id: string;
  room_id: string;
  project_id: string;
  workflow_run_id: string;
  workflow_step_id: string | null;
  task_id: string;
  child_task_id: string | null;
  agent_run_id: string | null;
  room_agent_id: string | null;
  incident_type: WorkflowIncidentType;
  status: WorkflowIncidentStatus;
  severity: WorkflowIncidentSeverity;
  fingerprint: string;
  error: string | null;
  context_json: string;
  decision_json: string | null;
  action: WorkflowRecoveryAction | null;
  action_status: WorkflowRecoveryActionStatus | null;
  attempt_count: number;
  last_message_id: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}
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

export interface ProjectFile {
  id: string;
  project_id: string;
  source_type: ResourceAssetType;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  url: string;
  storage_path: string;
  uploaded_by_id: string | null;
  uploaded_by_name: string | null;
  source_message_id: string | null;
  source_room_id: string | null;
  source_agent_id: string | null;
  source_task_id: string | null;
  source_display_name: string | null;
  source_label: string;
  source_context_id: string | null;
  source_context_name: string | null;
  source_context_type: 'room' | 'task' | null;
  content: string | null;
  created_at: number;
  deleted_at: number | null;
}

export type ProjectFileCreateInput = Omit<
  ProjectFile,
  | 'id'
  | 'source_type'
  | 'source_message_id'
  | 'source_room_id'
  | 'source_agent_id'
  | 'source_task_id'
  | 'source_display_name'
  | 'source_label'
  | 'source_context_id'
  | 'source_context_name'
  | 'source_context_type'
  | 'content'
  | 'created_at'
  | 'deleted_at'
>;

export interface ProjectFileWithRefs extends ProjectFile {
  reference_count: number;
  last_referenced_at: number | null;
  last_referenced_message_id: string | null;
  last_referenced_room_id: string | null;
  last_referenced_room_name: string | null;
}

export type ResourceAssetType = 'uploaded_file' | 'agent_document';
export type ResourceAssetGroupKey = 'uploaded_files' | 'agent_documents';

export interface ResourceAsset {
  id: string;
  project_id: string;
  asset_type: ResourceAssetType;
  group_key: ResourceAssetGroupKey;
  title: string;
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
  metadata: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export type ResourceAssetListItem = Omit<ResourceAsset, 'content'> & {
  content?: never;
  reference_count?: number;
  last_referenced_at?: number | null;
  last_referenced_message_id?: string | null;
  last_referenced_room_id?: string | null;
  last_referenced_room_name?: string | null;
};

export type ResourceSourceType = 'user_upload' | 'agent';

export interface ResourceSourceInfo {
  type: ResourceSourceType;
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

export type ResourceAction = 'preview' | 'download' | 'view_markdown' | 'delete';

export interface ResourceActorInfo {
  id: string | null;
  name: string | null;
  type: 'user' | 'agent';
}

export interface ResourceListItem extends ResourceAssetListItem {
  resource_type: ResourceAssetType;
  name: string;
  created_by: ResourceActorInfo;
  source_summary: string;
  source: ResourceSourceInfo;
  capabilities: ResourceCapabilities;
  available_actions: ResourceAction[];
  preview_url: string | null;
  download_url: string | null;
}

export interface ResourceDetail extends ResourceAsset {
  resource_type: ResourceAssetType;
  name: string;
  created_by: ResourceActorInfo;
  source_summary: string;
  source: ResourceSourceInfo;
  capabilities: ResourceCapabilities;
  available_actions: ResourceAction[];
  preview_url: string | null;
  download_url: string | null;
}

export type WorkspaceEntryType = 'file' | 'directory';

export interface WorkspacePathResolution {
  projectRealPath: string;
  relativePath: string;
  absolutePath: string;
  symlinkTargetRelativePath: string | null;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  type: WorkspaceEntryType;
  size: number | null;
  mimeType: string | null;
  language: string | null;
}

export interface WorkspaceFilePreview {
  path: string;
  size: number;
  mimeType: string;
  language: string | null;
  content: string;
  truncated: boolean;
}

export interface WorkspaceFileReference {
  path: string;
  size: number;
  mimeType: string;
  language: string | null;
  isBinary: boolean;
  content: string | null;
  truncated: boolean;
  bytes: Buffer;
}

export interface WorkspaceSearchResult {
  path: string;
  name: string;
  type: Extract<WorkspaceEntryType, 'file'>;
}

export interface WorkspaceSearchResponse {
  entries: WorkspaceSearchResult[];
  truncated: boolean;
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
  joined_at: number;
  left_at: number | null;
  acp_enabled: 0 | 1;
  acp_backend: AcpBackend | null;
  acp_session_id: string | null;
  acp_session_label: string | null;
  acp_session_handoff_pending: 0 | 1;
  acp_session_handoff_reason: AcpSessionHandoffReason | null;
  acp_permission_mode: AcpPermissionMode;
  acp_writable_dirs: string[];
  capabilities: string[];
  default_runtime: AgentDefaultRuntime;
  runtime_backend: AgentRuntimeBackend | null;
  tool_policy: AgentToolPolicy | null;
  workspace_policy: AgentWorkspacePolicy | null;
  memory_scope: AgentMemoryScope | null;
  memory_max_context_chars: number | null;
}

export type AgentRunStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export const COLLABORATION_STAGES = ['execute', 'review', 'acceptance', 'summary'] as const;
export type CollaborationStage = typeof COLLABORATION_STAGES[number];
export type CollaborationRunStatus = 'running' | 'completed' | 'blocked';
export type CollaborationStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

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
  collaboration_run_id: string | null;
  collaboration_stage: CollaborationStage | null;
  superpowers_bootstrap_owner: SuperpowersBootstrapOwner | null;
  superpowers_bootstrap_injected: 0 | 1;
  superpowers_bootstrap_skill: string | null;
  superpowers_bootstrap_skip_reason: string | null;
  prompt: string;
  stdout: string;
  stderr: string;
  activity_log: string;
  error: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface CollaborationStepResult {
  id: string;
  collaboration_run_id: string;
  stage: CollaborationStage;
  status: CollaborationStepStatus;
  room_agent_id: string | null;
  agent_id: string;
  agent_run_id: string | null;
  result_message_id: string | null;
  result_content: string | null;
  prompt: string;
  error: string | null;
  sort_order: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface CollaborationRunResult {
  id: string;
  room_id: string;
  source_message_id: string;
  status: CollaborationRunStatus;
  steps: CollaborationStepResult[];
  error: string | null;
  started_at: number;
  completed_at: number | null;
}

export type MessageType = 'text' | 'task' | 'system' | 'code' | 'agent_stream';
export type SenderType = 'user' | 'agent' | 'system';
export type TaskCreatedFrom = 'manual' | 'chat_plan' | 'slash_command' | 'workflow_assignment';
export type TaskEventType =
  | 'plan_proposed'
  | 'task_created'
  | 'task_updated'
  | 'task_status_changed'
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

export interface MessageTaskEventMetadata {
  task_id?: string;
  task_title?: string;
  workflow_run_id?: string;
  workflow_step_id?: string;
  event_type?: TaskEventType;
  origin?: TaskCreatedFrom;
  [key: string]: unknown;
}

export interface MessageReplyMetadata {
  message_id: string;
  sender_type: SenderType;
  sender_id: string;
  sender_name: string | null;
  excerpt: string;
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

export type TaskExecutionIntent =
  | 'analysis_only'
  | 'planning_only'
  | 'documentation_only'
  | 'implementation'
  | 'debug_fix'
  | 'review_only';

export interface MessageMetadata extends MessageTaskEventMetadata {
  attachments?: MessageAttachmentMetadata[];
  reply_to?: MessageReplyMetadata;
  source_message_id?: string;
  planner_decision?: PlannerDecision;
  trace?: MessageTrace;
  acp_enabled?: boolean;
  acp_backend?: AcpBackend | null;
  acp_session_id?: string | null;
  internal?: boolean;
  task_readiness?: {
    ready: boolean;
    confidence: number;
    title: string;
    description: string;
    missing_questions: string[];
    recommended_mode: 'formal_workflow' | 'chat_collaboration';
    execution_intent?: TaskExecutionIntent;
    source_message_id?: string;
  };
}

export interface Message {
  id: string;
  room_id: string;
  sender_type: SenderType;
  sender_id: string;
  sender_name: string | null;
  content: string;
  message_type: MessageType;
  metadata: string | null;
  created_at: number;
}

export type GlobalChatRole = 'user' | 'assistant' | 'system';
export type GlobalChatMessageStatus = 'completed' | 'failed';

export interface GlobalChatSession {
  id: string;
  title: string;
  archived: 0 | 1;
  created_at: number;
  updated_at: number;
}

export interface GlobalChatMessageMetadata {
  memory_refs?: Array<{
    id: string;
    title: string;
    scope: MemoryScope;
    project_id: string | null;
    room_id?: string | null;
    task_id?: string | null;
  }>;
  config_refs?: string[];
  error?: string;
  model_chat?: boolean;
  [key: string]: unknown;
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

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'failed';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskInteractionMode = 'ask_user' | 'auto_recommended';
export type SuperpowersBootstrapOwner = 'project' | 'provider' | 'disabled';

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

export interface LangChainPlannerSettings {
  langchain_planner_model: string | null;
  openai_api_key: string | null;
  openai_base_url: string | null;
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

export interface Task {
  id: string;
  room_id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  interaction_mode: TaskInteractionMode;
  assigned_agent_id: string | null;
  source_message_id: string | null;
  created_from: TaskCreatedFrom | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface WorkflowRun {
  id: string;
  room_id: string;
  project_id: string;
  task_id: string;
  status: WorkflowStatus;
  current_stage: WorkflowStage | null;
  graph_version: string | null;
  graph_state: string | null;
  approval_required: 0 | 1;
  approved_at: number | null;
  approved_by: string | null;
  openclaw_flow_id: string | null;
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
  scope_read: string[];
  scope_write: string[];
  agent_run_id: string | null;
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

export type WorkflowContextSourceType = 'agent_run' | 'workflow_step' | 'artifact' | 'verification' | 'system';
export type WorkflowContextEntryType =
  | 'summary'
  | 'handoff'
  | 'decision'
  | 'verification'
  | 'file_change'
  | 'issue'
  | 'open_question';

export interface WorkflowContextEntry {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string | null;
  task_id: string;
  room_agent_id: string | null;
  agent_run_id: string | null;
  source_type: WorkflowContextSourceType;
  source_id: string;
  entry_type: WorkflowContextEntryType;
  title: string;
  content: string;
  metadata: string | null;
  raw_char_count: number;
  summary_char_count: number;
  token_estimate: number;
  version: number;
  created_at: number;
}

export interface WorkflowDetail {
  run: WorkflowRun;
  steps: WorkflowStep[];
  artifacts: TaskArtifact[];
}

export interface CliSessionSummary {
  backend: AcpBackend;
  sessionId: string;
  title: string;
  cwd: string;
  messageCount: number;
  lastActivity: number;
  firstUserMessage?: string;
}

export type WsServerEvent =
  | { type: 'message:new'; roomId: string; message: Message }
  | {
      type: 'message:stream';
      roomId: string;
      messageId: string;
      chunk: string;
      done: boolean;
      seq?: number;
      runId?: string;
      channel?: 'answer' | 'thinking' | 'tool' | 'command' | 'event';
      event?: AgentTimelineEvent;
      status?: 'streaming' | AgentRunStatus;
      error?: string | null;
      message?: Message;
    }
  | { type: 'agent_run:created'; roomId: string; run: AgentRun }
  | { type: 'agent_run:updated'; roomId: string; run: AgentRun }
  | { type: 'room:agent_joined'; roomId: string; agent: RoomAgent }
  | { type: 'room:agent_left'; roomId: string; roomAgentId: string }
  | { type: 'workflow:created'; roomId: string; workflow: WorkflowRun }
  | { type: 'workflow:updated'; roomId: string; workflow: WorkflowRun }
  | { type: 'workflow_step:created'; roomId: string; step: WorkflowStep }
  | { type: 'workflow_step:updated'; roomId: string; step: WorkflowStep }
  | { type: 'workflow_artifact:created'; roomId: string; artifact: TaskArtifact }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:created'; task: Task }
  | { type: 'task:deleted'; taskId: string };

export type WsClientEvent =
  | { type: 'subscribe'; roomId: string }
  | { type: 'unsubscribe'; roomId: string }
  | { type: 'message:send'; roomId: string; content: string; mentions?: string[] };
