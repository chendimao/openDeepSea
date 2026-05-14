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

export interface Room {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: number;
}

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
export type WorkflowStepStatus = 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type TaskArtifactType =
  | 'analysis'
  | 'decision_request'
  | 'decision_response'
  | 'plan'
  | 'assignment'
  | 'implementation_summary'
  | 'review'
  | 'acceptance';

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

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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

export type MessageType = 'text' | 'task' | 'system' | 'code' | 'agent_stream';
export type SenderType = 'user' | 'agent' | 'system';

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
