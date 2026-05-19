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
export type GraphNodeName =
  | 'context'
  | 'planning'
  | 'approval'
  | 'dispatch'
  | 'execute'
  | 'review'
  | 'repair_decision'
  | 'verify'
  | 'acceptance'
  | 'memory';
export type WorkflowDefinitionScope = 'system' | 'project' | 'room';
export type WorkflowDefinitionStatus = 'draft' | 'published' | 'archived';
export type WorkflowDefinitionNodeType =
  | 'context'
  | 'planning'
  | 'approval_gate'
  | 'dispatch'
  | 'execute'
  | 'review'
  | 'repair_decision'
  | 'verify'
  | 'acceptance'
  | 'memory';
export interface WorkflowDefinitionNode {
  id: string;
  type: WorkflowDefinitionNodeType;
  label: string;
  stage?: WorkflowStage | null;
  role?: WorkflowRole | null;
  position?: { x: number; y: number } | null;
}
export interface WorkflowDefinitionEdge {
  from: string;
  to: string;
  condition?: string | null;
}
export interface WorkflowDefinitionGraph {
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
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
export type SettingsScope = 'system' | 'project' | 'room';
export type SkillRuntimeScope = 'planner' | 'model_chat' | 'workflow' | 'memory' | 'review';
export type SkillTriggerMode = 'manual' | 'keyword' | 'always_for_scope';
export type SkillBindingScope = 'system' | 'project' | 'room' | 'agent';
export type SkillSourceType = 'local_directory' | 'git_repo' | 'manual';

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  source_type: SkillSourceType;
  manifest_path: string | null;
  runtime_scopes: SkillRuntimeScope[];
  trigger_mode: SkillTriggerMode;
  trigger_keywords: string[];
  enabled: 0 | 1;
  priority: number;
  checksum: string | null;
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

export interface ScopedSettings {
  scope: SettingsScope;
  scope_id: string;
  message_routing_mode: MessageRoutingMode | null;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode | null;
  auto_distill_enabled: 0 | 1 | null;
  default_workflow_definition_id: string | null;
  updated_at: number;
}

export interface EffectiveSettings {
  message_routing_mode: MessageRoutingMode;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode;
  auto_distill_enabled: boolean;
  default_workflow_definition_id: string | null;
}

export interface SystemSettings extends EffectiveSettings {
  langchain_planner_model: string | null;
  openai_base_url: string | null;
  openai_api_key_set: boolean;
  openai_api_key_preview: string | null;
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
  };
}

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

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

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

export interface ProjectFile {
  id: string;
  project_id: string;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  url: string;
  storage_path?: string;
  uploaded_by_id: string | null;
  uploaded_by_name: string | null;
  created_at: number;
  deleted_at: number | null;
  reference_count: number;
  last_referenced_at: number | null;
  last_referenced_message_id: string | null;
  last_referenced_room_id: string | null;
  last_referenced_room_name: string | null;
}

export interface MessageMetadata {
  attachments: MessageAttachmentMetadata[];
  task_id?: string;
  task_title?: string;
  workflow_run_id?: string;
  workflow_step_id?: string;
  event_type?: TaskEventType;
  origin?: TaskCreatedFrom;
  source_message_id?: string;
  fallback_agent_id?: string;
  collaboration_decision?: CollaborationDecision;
  task_readiness?: TaskReadinessMetadata;
}

export type CollaborationIntent = 'question' | 'analysis' | 'implementation';
export type CollaborationMode = 'chat_collaboration' | 'formal_workflow';
export type CollaborationProblemArea = 'frontend' | 'backend' | 'fullstack' | 'unknown';
export type CollaborationStage = 'execute' | 'review' | 'acceptance' | 'summary';

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
  metadata: string | null;
  created_at: number;
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
