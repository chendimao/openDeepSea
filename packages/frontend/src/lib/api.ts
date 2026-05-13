import type {
  AcpBackend,
  AgentRun,
  CliSession,
  Message,
  MessageRoutingMode,
  OpenClawAgent,
  Project,
  Room,
  RoomAgent,
  Task,
} from './types';

const BASE = '/api';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; gateway: boolean }>('/health'),
  listGatewayAgents: () =>
    request<{ agents: OpenClawAgent[]; connected: boolean; error?: string }>('/gateway/agents'),

  listProjects: () => request<Project[]>('/projects'),
  createProject: (input: { name: string; path: string; description?: string }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  updateProjectRouting: (
    id: string,
    input: { message_routing_mode: MessageRoutingMode; fallback_agent_id: string | null },
  ) =>
    request<Project>(`/projects/${id}/routing`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  listRooms: (projectId: string) => request<Room[]>(`/projects/${projectId}/rooms`),
  createRoom: (projectId: string, input: { name: string; description?: string }) =>
    request<Room>(`/projects/${projectId}/rooms`, { method: 'POST', body: JSON.stringify(input) }),
  getRoom: (id: string) => request<Room>(`/rooms/${id}`),
  deleteRoom: (id: string) => request<void>(`/rooms/${id}`, { method: 'DELETE' }),

  listRoomAgents: (roomId: string) => request<RoomAgent[]>(`/rooms/${roomId}/agents`),
  addRoomAgent: (
    roomId: string,
    input: { agent_id: string; agent_name: string; agent_role?: string },
  ) => request<RoomAgent>(`/rooms/${roomId}/agents`, { method: 'POST', body: JSON.stringify(input) }),
  removeRoomAgent: (roomId: string, agentId: string) =>
    request<void>(`/rooms/${roomId}/agents/${agentId}`, { method: 'DELETE' }),
  setAgentAcp: (
    roomId: string,
    agentId: string,
    config: {
      acp_enabled: boolean;
      acp_backend: AcpBackend | null;
      acp_session_id: string | null;
      acp_session_label?: string | null;
    },
  ) =>
    request<RoomAgent>(`/rooms/${roomId}/agents/${agentId}/acp`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  listAcpSessions: (projectId: string, backend: AcpBackend) =>
    request<CliSession[]>(`/projects/${projectId}/acp-sessions?backend=${backend}`),

  listMessages: (roomId: string) => request<Message[]>(`/rooms/${roomId}/messages`),
  listAgentRuns: (roomId: string) => request<AgentRun[]>(`/rooms/${roomId}/agent-runs`),
  cancelAgentRun: (id: string) =>
    request<AgentRun>(`/agent-runs/${id}/cancel`, { method: 'POST' }),
  sendMessage: (roomId: string, content: string, mentions?: string[]) =>
    request<Message>(`/rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, mentions }),
    }),

  listProjectTasks: (projectId: string) => request<Task[]>(`/projects/${projectId}/tasks`),
  listRoomTasks: (roomId: string) => request<Task[]>(`/rooms/${roomId}/tasks`),
  createTask: (
    roomId: string,
    input: {
      title: string;
      description?: string;
      priority?: Task['priority'];
      assigned_agent_id?: string;
      parent_task_id?: string;
    },
  ) => request<Task>(`/rooms/${roomId}/tasks`, { method: 'POST', body: JSON.stringify(input) }),
  updateTask: (id: string, patch: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'assigned_agent_id' | 'status'>>) =>
    request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
};
