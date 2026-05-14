export type AcpBackend = 'claudecode' | 'opencode' | 'codex';
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
  | 'workflow_completed'
  | 'workflow_cancelled';
export type SettingsScope = 'system' | 'project' | 'room';

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

export type MessageRoutingMode = 'mentions_only' | 'fallback_reply' | 'fallback_route';

export interface ScopedSettings {
  scope: SettingsScope;
  scope_id: string;
  message_routing_mode: MessageRoutingMode | null;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode | null;
  updated_at: number;
}

export interface EffectiveSettings {
  message_routing_mode: MessageRoutingMode;
  fallback_agent_id: string | null;
  interaction_mode: TaskInteractionMode;
}

export interface SettingsResolution {
  system: EffectiveSettings;
  project: ScopedSettings | null;
  room: ScopedSettings | null;
  effective: EffectiveSettings;
  sources: {
    message_routing: SettingsScope;
    interaction_mode: SettingsScope;
  };
}

export interface Room {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: number;
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
  error: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface MessageAttachmentMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  isImage: boolean;
}

export interface MessageMetadata {
  attachments: MessageAttachmentMetadata[];
  task_id?: string;
  task_title?: string;
  workflow_run_id?: string;
  workflow_step_id?: string;
  event_type?: TaskEventType;
  origin?: TaskCreatedFrom;
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
  status: WorkflowStepStatus;
  room_agent_id: string | null;
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
  created_at: number;
  updated_at: number;
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

export interface OpenClawAgent {
  id: string;
  name?: string;
  description?: string;
  workspace?: string;
}

export const TASK_STATUS_LABEL: Record<Task['status'], string> = {
  todo: '待办',
  in_progress: '进行中',
  review: '待审查',
  done: '已完成',
  failed: '失败',
};

export const TASK_PRIORITY_LABEL: Record<Task['priority'], string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急',
};

export const TASK_INTERACTION_MODE_LABEL: Record<TaskInteractionMode, string> = {
  ask_user: '需要决策时询问我',
  auto_recommended: '使用推荐选项自动继续',
};

export const MESSAGE_ROUTING_MODE_LABEL: Record<MessageRoutingMode, string> = {
  mentions_only: '只响应 @',
  fallback_reply: '兜底回复',
  fallback_route: '兜底调度',
};

export const MEMORY_SCOPE_LABEL: Record<MemoryScope, string> = {
  project: '项目',
  room: '聊天室',
  agent: '智能体',
  task: '任务',
};

export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  decision: '决策',
  fact: '事实',
  preference: '偏好',
  lesson: '经验',
  task_summary: '任务总结',
  artifact_summary: '产物摘要',
};

export const AGENT_RUN_STATUS_LABEL: Record<AgentRunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export const WORKFLOW_ROLE_LABEL: Record<WorkflowRole, string> = {
  analyst: '分析',
  planner: '规划',
  coordinator: '协调',
  executor: '执行',
  reviewer: '代码审查',
  acceptor: '功能验收',
};

export const WORKFLOW_STATUS_LABEL: Record<WorkflowStatus, string> = {
  draft: '未启动',
  running: '运行中',
  awaiting_decision: '等待决策',
  awaiting_approval: '等待确认',
  blocked: '阻塞',
  cancelled: '已取消',
  completed: '已完成',
  failed: '失败',
};

export const WORKFLOW_STAGE_LABEL: Record<WorkflowStage, string> = {
  analysis: '分析',
  planning: '计划',
  assignment: '分配',
  implementation: '执行',
  code_review: '代码审查',
  acceptance: '功能验收',
};
