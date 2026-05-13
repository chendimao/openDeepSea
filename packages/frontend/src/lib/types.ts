export type AcpBackend = 'claudecode' | 'opencode' | 'codex';

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
  created_at: number;
  updated_at: number;
  stats?: ProjectStats;
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
  joined_at: number;
  acp_enabled: 0 | 1;
  acp_backend: AcpBackend | null;
  acp_session_id: string | null;
  acp_session_label: string | null;
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
  assigned_agent_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
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
