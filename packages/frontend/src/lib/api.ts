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
  SettingsResolution,
  Task,
  TaskInteractionMode,
  WorkflowDetail,
  WorkflowRole,
  WorkflowRun,
} from './types';

const BASE = '/api';

export interface OpenClawGatewayStatus {
  ok: boolean;
  running: boolean;
  pid: number | null;
  rpcOk: boolean;
  capability: string | null;
  error?: string;
}

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
  health: () =>
    request<{
      ok: boolean;
      gateway: boolean;
      gatewayStatus: OpenClawGatewayStatus;
      gatewayRpcConnected: boolean;
    }>('/health'),
  listGatewayAgents: () =>
    request<{ agents: OpenClawAgent[]; connected: boolean; error?: string }>('/gateway/agents'),

  getSystemSettings: () => request<SettingsResolution['system']>('/settings/system'),
  updateSystemSettings: (input: {
    message_routing_mode?: MessageRoutingMode;
    fallback_agent_id?: string | null;
    interaction_mode?: TaskInteractionMode;
  }) =>
    request<SettingsResolution['system']>('/settings/system', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  getProjectSettings: (projectId: string) =>
    request<SettingsResolution>(`/projects/${projectId}/settings`),
  updateProjectSettings: (
    projectId: string,
    input: {
      message_routing_mode?: MessageRoutingMode | null;
      fallback_agent_id?: string | null;
      interaction_mode?: TaskInteractionMode | null;
    },
  ) =>
    request<SettingsResolution>(`/projects/${projectId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  getRoomSettings: (roomId: string) =>
    request<SettingsResolution>(`/rooms/${roomId}/settings`),
  updateRoomSettings: (
    roomId: string,
    input: {
      message_routing_mode?: MessageRoutingMode | null;
      fallback_agent_id?: string | null;
      interaction_mode?: TaskInteractionMode | null;
    },
  ) =>
    request<SettingsResolution>(`/rooms/${roomId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

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
  setAgentWorkflowRole: (roomId: string, agentId: string, workflow_role: WorkflowRole | null) =>
    request<RoomAgent>(`/rooms/${roomId}/agents/${agentId}/workflow-role`, {
      method: 'PATCH',
      body: JSON.stringify({ workflow_role }),
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
      interaction_mode?: Task['interaction_mode'];
      assigned_agent_id?: string;
      parent_task_id?: string;
    },
  ) => request<Task>(`/rooms/${roomId}/tasks`, { method: 'POST', body: JSON.stringify(input) }),
  updateTask: (
    id: string,
    patch: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'interaction_mode' | 'assigned_agent_id' | 'status'>>,
  ) =>
    request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),

  startWorkflow: (taskId: string) =>
    request<WorkflowRun>(`/tasks/${taskId}/workflows`, { method: 'POST' }),
  listTaskWorkflows: (taskId: string) =>
    request<WorkflowRun[]>(`/tasks/${taskId}/workflows`),
  getWorkflow: (id: string) =>
    request<WorkflowDetail>(`/workflows/${id}`),
  approveWorkflowPlan: (id: string) =>
    request<WorkflowRun>(`/workflows/${id}/approve-plan`, { method: 'POST' }),
  submitWorkflowDecisions: (
    id: string,
    answers: Array<{ decisionId: string; optionId: string }>,
  ) =>
    request<WorkflowRun>(`/workflows/${id}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),
  retryWorkflowStep: (id: string) =>
    request<WorkflowRun>(`/workflows/${id}/retry-step`, { method: 'POST' }),
  cancelWorkflow: (id: string) =>
    request<WorkflowRun>(`/workflows/${id}/cancel`, { method: 'POST' }),
};
