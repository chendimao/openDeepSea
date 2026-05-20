import type {
  AcpBackend,
  Agent,
  AgentInput,
  AgentRun,
  AgentMemoryScope,
  AgentRuntimeBackend,
  AgentToolCapability,
  AgentToolPolicy,
  AgentWorkspacePolicy,
  BuiltInAgentTemplate,
  CliSession,
  CollaborationDecision,
  CollaborationRunSummary,
  GlobalChatMessage,
  GlobalChatSendResponse,
  GlobalChatSession,
  MemoryEntry,
  MemoryInput,
  MemorySearchResult,
  Message,
  MessageRoutingMode,
  ProjectFile,
  Project,
  Room,
  RoomAgent,
  RoomCrewTemplate,
  RoomSearchResponse,
  SettingsResolution,
  Skill,
  SkillBinding,
  SkillBindingScope,
  SkillRun,
  SkillPreviewResponse,
  SkillsShSearchResult,
  SkillsShUpdateResult,
  SkillUpdateApplyMode,
  SkillUpdateCheckMode,
  SkillRuntimeScope,
  SkillTriggerMode,
  Task,
  TaskInteractionMode,
  WorkflowDetail,
  WorkflowDefinition,
  WorkflowDefinitionGraph,
  WorkflowDefinitionScope,
  WorkflowDefinitionStatus,
  WorkflowRole,
  WorkflowRun,
} from './types';

const BASE = '/api';
const LOCAL_ACCESS_TOKEN_STORAGE_KEY = 'opendeepsea.localToken';

type WorkflowDefinitionListFilters = {
  scope?: WorkflowDefinitionScope;
  status?: WorkflowDefinitionStatus;
  projectId?: string;
  roomId?: string;
  includeArchived?: boolean;
};

type QueryFunctionContextLike = {
  queryKey: unknown;
  signal?: AbortSignal;
  meta?: unknown;
  pageParam?: unknown;
  direction?: unknown;
  client?: unknown;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isFormData = init.body instanceof FormData;
  const headers = new Headers(init.headers);
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(formatApiError(res.status, text));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function formatApiError(status: number, text: string): string {
  const fallback = text.trim() || '请求失败';
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // Non-JSON responses keep the original body for diagnostics.
  }
  return `${status}: ${fallback}`;
}

function getWorkspaceLocalToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = window.localStorage.getItem(LOCAL_ACCESS_TOKEN_STORAGE_KEY);
  const trimmed = token?.trim();
  return trimmed || null;
}

function buildWorkspaceHeaders(headers: HeadersInit = {}): Headers {
  const merged = new Headers(headers);
  const token = getWorkspaceLocalToken();
  if (token && !merged.has('X-OpenDeepSea-Local-Token')) {
    merged.set('X-OpenDeepSea-Local-Token', token);
  }
  return merged;
}

export async function workspaceRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const workspacePath = path.startsWith('/') ? path : `/${path}`;
  return request<T>(workspacePath, {
    ...init,
    headers: buildWorkspaceHeaders(init.headers),
  });
}

function isQueryFunctionContextLike(value: WorkflowDefinitionListFilters | QueryFunctionContextLike): value is QueryFunctionContextLike {
  return typeof value === 'object' && value !== null && 'queryKey' in value;
}

export const api = {
  health: () =>
    request<{
      ok: boolean;
    }>('/health'),
  listAgentTemplates: () =>
    request<{ templates: BuiltInAgentTemplate[] }>('/agent-templates'),
  listCrewTemplates: () =>
    request<{ templates: RoomCrewTemplate[] }>('/crew-templates'),

  listGlobalChatSessions: () => request<GlobalChatSession[]>('/global-chat/sessions'),
  createGlobalChatSession: (input: { title?: string | null } = {}) =>
    request<GlobalChatSession>('/global-chat/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateGlobalChatSession: (id: string, input: { title?: string | null; archived?: boolean }) =>
    request<GlobalChatSession>(`/global-chat/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteGlobalChatSession: (id: string) =>
    request<void>(`/global-chat/sessions/${id}`, { method: 'DELETE' }),
  listGlobalChatMessages: (sessionId: string) =>
    request<GlobalChatMessage[]>(`/global-chat/sessions/${sessionId}/messages`),
  sendGlobalChatMessage: (sessionId: string, input: { content: string }) =>
    request<GlobalChatSendResponse>(`/global-chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  saveGlobalChatMessageAsMemory: (
    messageId: string,
    input: { memory_type?: 'decision' | 'fact' | 'preference' | 'lesson'; title?: string; content?: string } = {},
  ) =>
    request<MemoryEntry>(`/global-chat/messages/${messageId}/save-memory`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listAgents: () => request<Agent[]>('/agents'),
  getAgent: (id: string) => request<Agent>(`/agents/${id}`),
  createAgent: (input: AgentInput) =>
    request<Agent>('/agents', { method: 'POST', body: JSON.stringify(input) }),
  updateAgent: (id: string, input: Partial<AgentInput>) =>
    request<Agent>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteAgent: (id: string) =>
    request<void>(`/agents/${id}`, { method: 'DELETE' }),
  restoreAgentDefaults: (id: string) =>
    request<Agent>(`/agents/${id}/restore-defaults`, { method: 'POST' }),

  getSystemSettings: () => request<SettingsResolution['system']>('/settings/system'),
  updateSystemSettings: (input: {
    message_routing_mode?: MessageRoutingMode;
    fallback_agent_id?: string | null;
    interaction_mode?: TaskInteractionMode;
    auto_distill_enabled?: boolean;
    default_workflow_definition_id?: string | null;
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
      default_workflow_definition_id?: string | null;
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
      default_workflow_definition_id?: string | null;
    },
  ) =>
    request<SettingsResolution>(`/rooms/${roomId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  listWorkflowDefinitions: (filters: WorkflowDefinitionListFilters | QueryFunctionContextLike = {}) => {
    const normalizedFilters = isQueryFunctionContextLike(filters) ? {} : filters;
    const params = new URLSearchParams();
    if (normalizedFilters.scope) params.set('scope', normalizedFilters.scope);
    if (normalizedFilters.status) params.set('status', normalizedFilters.status);
    if (normalizedFilters.projectId) params.set('projectId', normalizedFilters.projectId);
    if (normalizedFilters.roomId) params.set('roomId', normalizedFilters.roomId);
    if (normalizedFilters.includeArchived) params.set('includeArchived', '1');
    const query = params.toString();
    return request<WorkflowDefinition[]>(`/workflow-definitions${query ? `?${query}` : ''}`);
  },
  listRoomWorkflowDefinitions: (roomId: string) =>
    request<WorkflowDefinition[]>(`/rooms/${roomId}/workflow-definitions`),
  createWorkflowDefinition: (input: {
    name: string;
    description?: string | null;
    scope: WorkflowDefinitionScope;
    scope_id: string;
    definition: WorkflowDefinitionGraph;
  }) =>
    request<WorkflowDefinition>('/workflow-definitions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateWorkflowDefinition: (
    id: string,
    input: {
      name?: string;
      description?: string | null;
      definition?: WorkflowDefinitionGraph;
    },
  ) =>
    request<WorkflowDefinition>(`/workflow-definitions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  publishWorkflowDefinition: (id: string) =>
    request<WorkflowDefinition>(`/workflow-definitions/${id}/publish`, { method: 'POST' }),
  duplicateWorkflowDefinition: (
    id: string,
    input: {
      name?: string;
      description?: string | null;
      scope?: WorkflowDefinitionScope;
      scope_id?: string;
    } = {},
  ) =>
    request<WorkflowDefinition>(`/workflow-definitions/${id}/duplicate`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  createWorkflowDefinitionEditDraft: (id: string) =>
    request<WorkflowDefinition>(`/workflow-definitions/${id}/edit-draft`, { method: 'POST' }),
  archiveWorkflowDefinition: (id: string) =>
    request<WorkflowDefinition>(`/workflow-definitions/${id}/archive`, { method: 'POST' }),
  deleteWorkflowDefinition: (id: string) =>
    request<void>(`/workflow-definitions/${id}`, { method: 'DELETE' }),

  listSkills: () => workspaceRequest<Skill[]>('/skills'),
  importLocalSkill: (path: string) =>
    workspaceRequest<Skill>('/skills/import/local', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  searchSkillMarketplace: (query: string) => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    const search = params.toString();
    return workspaceRequest<SkillsShSearchResult[]>(`/skills/marketplace${search ? `?${search}` : ''}`);
  },
  importSkillsShSkill: (installLabel: string) =>
    workspaceRequest<Skill>('/skills/import/skills-sh', {
      method: 'POST',
      body: JSON.stringify({ installLabel }),
    }),
  updateSkill: (
    id: string,
    input: {
      name?: string;
      description?: string | null;
      runtime_scopes?: SkillRuntimeScope[];
      trigger_mode?: SkillTriggerMode;
      trigger_keywords?: string[];
      enabled?: boolean;
      priority?: number;
      update_check_mode?: SkillUpdateCheckMode;
      update_apply_mode?: SkillUpdateApplyMode;
    },
  ) =>
    workspaceRequest<Skill>(`/skills/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  listSkillRuns: (filters: { skillId?: string; projectId?: string; roomId?: string; agentId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.skillId) params.set('skillId', filters.skillId);
    if (filters.projectId) params.set('projectId', filters.projectId);
    if (filters.roomId) params.set('roomId', filters.roomId);
    if (filters.agentId) params.set('agentId', filters.agentId);
    const query = params.toString();
    return workspaceRequest<SkillRun[]>(`/skills/runs${query ? `?${query}` : ''}`);
  },
  checkSkillUpdate: (id: string) =>
    workspaceRequest<SkillsShUpdateResult>(`/skills/${id}/updates`),
  deleteSkill: (id: string) =>
    workspaceRequest<void>(`/skills/${id}`, { method: 'DELETE' }),
  listSkillBindings: (filters: { scope?: SkillBindingScope; scopeId?: string; skillId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.scope) params.set('scope', filters.scope);
    if (filters.scopeId) params.set('scopeId', filters.scopeId);
    if (filters.skillId) params.set('skillId', filters.skillId);
    const query = params.toString();
    return workspaceRequest<SkillBinding[]>(`/skills/bindings${query ? `?${query}` : ''}`);
  },
  upsertSkillBinding: (input: {
    id?: string;
    skill_id: string;
    scope: SkillBindingScope;
    scope_id: string;
    enabled?: boolean;
    priority_override?: number | null;
  }) =>
    workspaceRequest<SkillBinding>('/skills/bindings', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteSkillBinding: (id: string) =>
    workspaceRequest<void>(`/skills/bindings/${id}`, { method: 'DELETE' }),
  previewSkillSelection: (input: {
    runtimeScopes: SkillRuntimeScope[];
    projectId?: string | null;
    roomId?: string | null;
    agentId?: string | null;
    message?: string;
    skillIds?: string[];
  }) =>
    workspaceRequest<SkillPreviewResponse>('/skills/preview-selection', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listProjects: () => request<Project[]>('/projects'),
  pickDirectory: () =>
    request<{ canceled: true; path?: undefined } | { canceled: false; path: string }>(
      '/system/pick-directory',
      { method: 'POST' },
    ),
  createProject: (input: { name: string; path: string; description?: string }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  listFiles: (filters: { projectId?: string; roomId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.projectId) params.set('projectId', filters.projectId);
    if (filters.roomId) params.set('roomId', filters.roomId);
    const query = params.toString();
    return request<ProjectFile[]>(`/files${query ? `?${query}` : ''}`);
  },
  listProjectFiles: (projectId: string) => request<ProjectFile[]>(`/projects/${projectId}/files`),
  uploadProjectFiles: (projectId: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    return request<ProjectFile[]>(`/projects/${projectId}/files`, {
      method: 'POST',
      body: form,
    });
  },
  deleteProjectFile: (fileId: string) =>
    request<void>(`/files/${fileId}`, { method: 'DELETE' }),
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
  searchRooms: (projectId: string, input: { query: string }) => {
    const params = new URLSearchParams();
    params.set('q', input.query);
    return request<RoomSearchResponse>(`/projects/${projectId}/rooms/search?${params.toString()}`);
  },
  createRoom: (projectId: string, input: { name: string; description?: string; crew_template_id?: string }) =>
    request<Room>(`/projects/${projectId}/rooms`, { method: 'POST', body: JSON.stringify(input) }),
  getRoom: (id: string) => request<Room>(`/rooms/${id}`),
  deleteRoom: (id: string) => request<void>(`/rooms/${id}`, { method: 'DELETE' }),

  listRoomAgents: (roomId: string) => request<RoomAgent[]>(`/rooms/${roomId}/agents`),
  addRoomAgent: (
    roomId: string,
    input: {
      global_agent_id?: string;
      agent_id?: string;
      agent_name?: string;
      agent_role?: string;
      acp_enabled?: boolean;
      acp_backend?: AcpBackend | null;
      acp_session_id?: string | null;
      acp_session_label?: string | null;
      acp_permission_mode?: 'bypass' | 'workspace-write' | 'read-only';
      runtime_backend?: AgentRuntimeBackend | null;
      tool_policy?: AgentToolPolicy | null;
      workspace_policy?: AgentWorkspacePolicy | null;
      memory_scope?: AgentMemoryScope | null;
    },
  ) => request<RoomAgent>(`/rooms/${roomId}/agents`, { method: 'POST', body: JSON.stringify(input) }),
  addRoomAgentsBatch: (roomId: string, global_agent_ids: string[]) =>
    request<RoomAgent[]>(`/rooms/${roomId}/agents/batch`, {
      method: 'POST',
      body: JSON.stringify({ global_agent_ids }),
    }),
  addRoomAgentFromTemplate: (roomId: string, template_id: string) =>
    request<RoomAgent>(`/rooms/${roomId}/agents/from-template`, {
      method: 'POST',
      body: JSON.stringify({ template_id }),
    }),
  removeRoomAgent: (
    roomId: string,
    agentId: string,
    input?: { task_action?: 'unassign' | 'transfer'; transfer_to_room_agent_id?: string },
  ) =>
    request<void>(`/rooms/${roomId}/agents/${agentId}`, {
      method: 'DELETE',
      body: input ? JSON.stringify(input) : undefined,
    }),
  setAgentAcp: (
    roomId: string,
    agentId: string,
    config: {
      acp_enabled: boolean;
      acp_backend: AcpBackend | null;
      acp_session_id: string | null;
      acp_session_label?: string | null;
      acp_permission_mode?: 'bypass' | 'workspace-write' | 'read-only';
      runtime_backend?: AgentRuntimeBackend | null;
      tool_policy?: { allowed: AgentToolCapability[] } | null;
      workspace_policy?: { read: string[]; write: string[] } | null;
      memory_scope?: AgentMemoryScope | null;
      memory_max_context_chars?: number | null;
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
    input: { content: string; mentions?: string[]; files?: File[]; fileIds?: string[]; replyToMessageId?: string },
  ) => {
    if (input.files && input.files.length > 0) {
      const form = new FormData();
      form.append('content', input.content);
      if (input.replyToMessageId) {
        form.append('reply_to_message_id', input.replyToMessageId);
      }
      if (input.mentions && input.mentions.length > 0) {
        form.append('mentions', JSON.stringify(input.mentions));
      }
      if (input.fileIds && input.fileIds.length > 0) {
        form.append('fileIds', JSON.stringify(input.fileIds));
      }
      input.files.forEach((file) => form.append('files', file));
      return request<Message>(`/rooms/${roomId}/messages`, {
        method: 'POST',
        body: form,
      });
    }
    return request<Message>(`/rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: input.content,
        mentions: input.mentions,
        fileIds: input.fileIds,
        reply_to_message_id: input.replyToMessageId,
      }),
    });
  },
  startCollaboration: (
    roomId: string,
    input: { source_message_id: string; decision: CollaborationDecision },
  ) =>
    request<{ run: CollaborationRunSummary }>(`/rooms/${roomId}/collaborations`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  promoteMessageToWorkflow: (
    roomId: string,
    messageId: string,
    input: { decision?: CollaborationDecision } = {},
  ) =>
    request<{ task: Task; workflow: WorkflowRun }>(`/rooms/${roomId}/messages/${messageId}/promote-to-workflow`, {
      method: 'POST',
      body: JSON.stringify(input),
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
  startWorkflowWithConversation: (
    roomId: string,
    taskId: string,
    input: {
      content?: string;
      sender_id?: string;
      sender_name?: string;
      source_message_id?: string;
      source?: 'chat_command' | 'task_button' | 'auto_start';
    } = {},
  ) =>
    request<WorkflowRun>(`/rooms/${roomId}/tasks/${taskId}/workflows/start-with-conversation`, {
      method: 'POST',
      body: JSON.stringify({ ...input, source: input.source ?? 'task_button' }),
    }),
  listTaskWorkflows: (taskId: string) =>
    request<WorkflowRun[]>(`/tasks/${taskId}/workflows`),
  getWorkflow: (id: string) =>
    request<WorkflowDetail>(`/workflows/${id}`),
  approveWorkflowPlan: (id: string) =>
    request<WorkflowRun>(`/workflows/${id}/approve-plan`, { method: 'POST' }),
  approveWorkflowPlanWithConversation: (
    roomId: string,
    workflowId: string,
    input: {
      content?: string;
      sender_id?: string;
      sender_name?: string;
      source?: 'approval_button';
    } = {},
  ) =>
    request<WorkflowRun>(`/rooms/${roomId}/workflows/${workflowId}/approve-plan-with-conversation`, {
      method: 'POST',
      body: JSON.stringify({ ...input, source: input.source ?? 'approval_button' }),
    }),
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
