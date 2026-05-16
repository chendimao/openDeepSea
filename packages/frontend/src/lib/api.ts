import type {
  AcpBackend,
  AgentRun,
  BuiltInAgentTemplate,
  CliSession,
  MemoryEntry,
  MemoryInput,
  MemorySearchResult,
  Message,
  MessageRoutingMode,
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isFormData = init.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(init.headers ?? {}),
  };
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
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
    }>('/health'),
  listAgentTemplates: () =>
    request<{ templates: BuiltInAgentTemplate[] }>('/agent-templates'),

  getSystemSettings: () => request<SettingsResolution['system']>('/settings/system'),
  updateSystemSettings: (input: {
    message_routing_mode?: MessageRoutingMode;
    fallback_agent_id?: string | null;
    interaction_mode?: TaskInteractionMode;
    auto_distill_enabled?: boolean;
    langchain_planner_model?: string | null;
    openai_base_url?: string | null;
    openai_api_key?: string | null;
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
      auto_distill_enabled?: boolean | null;
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
      auto_distill_enabled?: boolean | null;
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
  listMemories: (
    projectId: string,
    filters: { roomId?: string; roomAgentId?: string; roomAgentIds?: string[]; taskId?: string; includeArchived?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (filters.roomId) params.set('roomId', filters.roomId);
    if (filters.roomAgentId) params.set('roomAgentId', filters.roomAgentId);
    if (filters.roomAgentIds && filters.roomAgentIds.length > 0) params.set('roomAgentIds', filters.roomAgentIds.join(','));
    if (filters.taskId) params.set('taskId', filters.taskId);
    if (filters.includeArchived) params.set('includeArchived', '1');
    const query = params.toString();
    return request<MemoryEntry[]>(`/projects/${projectId}/memories${query ? `?${query}` : ''}`);
  },
  searchMemories: (
    projectId: string,
    filters: { query?: string; roomId?: string; scope?: 'project' | 'room' | 'task'; limit?: number; includeArchived?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (filters.query) params.set('query', filters.query);
    if (filters.roomId) params.set('roomId', filters.roomId);
    if (filters.scope) params.set('scope', filters.scope);
    if (filters.limit) params.set('limit', String(filters.limit));
    if (filters.includeArchived) params.set('includeArchived', '1');
    const query = params.toString();
    return request<MemorySearchResult[]>(`/projects/${projectId}/memories/search${query ? `?${query}` : ''}`);
  },
  createMemory: (projectId: string, input: MemoryInput) =>
    request<MemoryEntry>(`/projects/${projectId}/memories`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateMemory: (
    projectId: string,
    id: string,
    input: Partial<Pick<MemoryInput, 'memory_type' | 'title' | 'content' | 'pinned'>>,
  ) =>
    request<MemoryEntry>(`/projects/${projectId}/memories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  archiveMemory: (projectId: string, id: string, archived: boolean) =>
    request<MemoryEntry>(`/projects/${projectId}/memories/${id}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),
  deleteMemory: (projectId: string, id: string) =>
    request<void>(`/projects/${projectId}/memories/${id}`, { method: 'DELETE' }),
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
    input: {
      agent_id: string;
      agent_name: string;
      agent_role?: string;
      acp_enabled?: boolean;
      acp_backend?: AcpBackend | null;
      acp_session_id?: string | null;
      acp_session_label?: string | null;
      acp_permission_mode?: 'bypass' | 'workspace-write' | 'read-only';
    },
  ) => request<RoomAgent>(`/rooms/${roomId}/agents`, { method: 'POST', body: JSON.stringify(input) }),
  addRoomAgentFromTemplate: (roomId: string, template_id: string) =>
    request<RoomAgent>(`/rooms/${roomId}/agents/from-template`, {
      method: 'POST',
      body: JSON.stringify({ template_id }),
    }),
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
      acp_permission_mode?: 'bypass' | 'workspace-write' | 'read-only';
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
  sendMessage: (
    roomId: string,
    input: { content: string; mentions?: string[]; files?: File[] },
  ) => {
    if (input.files && input.files.length > 0) {
      const form = new FormData();
      form.append('content', input.content);
      if (input.mentions && input.mentions.length > 0) {
        form.append('mentions', JSON.stringify(input.mentions));
      }
      input.files.forEach((file) => form.append('files', file));
      return request<Message>(`/rooms/${roomId}/messages`, {
        method: 'POST',
        body: form,
      });
    }
    return request<Message>(`/rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: input.content, mentions: input.mentions }),
    });
  },

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
  createTaskWithConversation: (
    roomId: string,
    input: {
      title: string;
      description?: string;
      priority?: Task['priority'];
      interaction_mode?: Task['interaction_mode'];
      assigned_agent_id?: string;
      parent_task_id?: string;
      origin?: 'manual' | 'slash_command' | 'chat_plan';
      sender_id?: string;
      sender_name?: string;
      user_message?: string;
      source_message_id?: string | null;
    },
  ) =>
    request<{ task: Task; userMessage: Message | null; systemMessage: Message }>(
      `/rooms/${roomId}/tasks/conversation`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
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
