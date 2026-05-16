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

export type MessageRoutingMode = 'mentions_only' | 'fallback_reply' | 'fallback_route';
export type SettingsScope = 'system' | 'project' | 'room';

export interface Room {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: number;
}

export type AcpBackend = 'claudecode' | 'opencode' | 'codex';
export type AcpPermissionMode = 'bypass' | 'workspace-write' | 'read-only';
export type AgentDefaultRuntime = 'acp' | 'openclaw' | 'none';

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

export type MemoryScope = 'project' | 'room' | 'agent' | 'task';
export type MemoryType = 'decision' | 'fact' | 'preference' | 'lesson' | 'task_summary' | 'artifact_summary';
export type MemorySourceType = 'manual' | 'message' | 'workflow' | 'task';

export interface MemoryEntry {
  id: string;
  project_id: string;
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

export interface RoomAgent {
  id: string;
  room_id: string;
  agent_id: string;
  agent_name: string;
  agent_role: string | null;
  workflow_role: WorkflowRole | null;
  joined_at: number;
  acp_enabled: 0 | 1;
  acp_backend: AcpBackend | null;
  acp_session_id: string | null;
  acp_session_label: string | null;
  acp_permission_mode: AcpPermissionMode;
  acp_writable_dirs: string[];
  capabilities: string[];
  default_runtime: AgentDefaultRuntime;
  memory_max_context_chars: number | null;
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
  | 'workflow_completed'
  | 'workflow_cancelled'
  | 'workflow_failed'
  | 'workflow_memory_written';

export interface MessageAttachmentMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  isImage: boolean;
}

export interface MessageTaskEventMetadata {
  task_id?: string;
  task_title?: string;
  workflow_run_id?: string;
  workflow_step_id?: string;
  event_type?: TaskEventType;
  origin?: TaskCreatedFrom;
}

export interface MessageMetadata extends MessageTaskEventMetadata {
  attachments?: MessageAttachmentMetadata[];
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

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'failed';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskInteractionMode = 'ask_user' | 'auto_recommended';

export interface ScopedSettings {
  scope: SettingsScope;
  scope_id: string;
  message_routing_mode: MessageRoutingMode | null;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode | null;
  auto_distill_enabled: 0 | 1 | null;
  updated_at: number;
}

export interface EffectiveSettings {
  message_routing_mode: MessageRoutingMode;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode;
  auto_distill_enabled: boolean;
}

export interface SystemSettings extends EffectiveSettings {
  langchain_planner_model: string | null;
  openai_base_url: string | null;
  openai_api_key_set: boolean;
  openai_api_key_preview: string | null;
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
  | { type: 'message:stream'; roomId: string; messageId: string; chunk: string; done: boolean }
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
