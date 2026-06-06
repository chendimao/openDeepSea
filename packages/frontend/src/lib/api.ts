import type {
  AcpBackend,
  AiConfig,
  Agent,
  AgentTimelineEvent,
  AgentInput,
  AgentRun,
  AgentRunRetryResult,
  BrainstormingOptionSelection,
  MessageChoiceOptionSelection,
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
  PlatformSkill,
  PlatformSkillAggregate,
  PlatformSkillInstallMode,
  PlatformSkillProvider,
  PlatformSkillSummary,
  ProviderSuperpowersStatus,
  ProjectFile,
  ResourceDetail,
  ResourceListItem,
  Project,
  Room,
  RoomAgent,
  RoomCrewTemplate,
  RoomSearchResponse,
  SettingsResolution,
  HistoryRecord,
  Session,
  SessionDetail,
  SessionMode,
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
  SuperpowersBootstrapOwner,
  Task,
  TaskActionKind,
  TaskActionStartResult,
  TaskEvent,
  TaskExecutionDecision,
  TaskEventListResponse,
  TaskExecutorListItem,
  TaskInteractionMode,
  WorkflowDetail,
  WorkflowDefinition,
  WorkflowDefinitionGraph,
  WorkflowDefinitionScope,
  WorkflowDefinitionStatus,
  WorkflowRole,
  WorkflowRun,
  WorkspaceSearchResponse,
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

export function resourceListItemToProjectFile(resource: ResourceListItem): ProjectFile {
  const sourceType = normalizeResourceType(resource.resource_type ?? resource.asset_type);
  const sourceContext = resource.source?.context ?? null;
  const fileId = resource.file_id ?? (sourceType === 'uploaded_file' ? stripFilePrefix(resource.id) : null);
  const sourceMessageId = resource.source?.message_id ?? resource.source_message_id;
  const sourceRoomId = resource.source?.room_id ?? resource.source_room_id;

  return {
    id: sourceType === 'uploaded_file' && fileId ? `file:${fileId}` : resource.id,
    project_id: resource.project_id,
    source_type: sourceType,
    original_name: resource.name || resource.title || resource.id,
    stored_name: resource.title || resource.name || resource.id,
    mime_type: resource.mime_type ?? (sourceType === 'agent_document' ? 'text/markdown' : 'application/octet-stream'),
    size: resource.size ?? 0,
    url: resource.url ?? resource.preview_url ?? '',
    storage_path: '',
    uploaded_by_id: sourceType === 'uploaded_file' ? resource.source?.user_id ?? resource.source_agent_id : null,
    uploaded_by_name: sourceType === 'uploaded_file' ? resource.source?.display_name ?? resource.source_display_name : null,
    source_message_id: sourceMessageId,
    source_room_id: sourceRoomId,
    source_agent_id: sourceType === 'agent_document'
      ? resource.source?.agent_id ?? resource.source_agent_id
      : resource.source?.user_id ?? resource.source_agent_id,
    source_task_id: resource.source?.task_id ?? resource.source_task_id,
    content: null,
    created_at: resource.created_at,
    deleted_at: resource.deleted_at,
    reference_count: resource.reference_count ?? (sourceMessageId ? 1 : 0),
    last_referenced_at: resource.last_referenced_at ?? (sourceMessageId ? resource.created_at : null),
    last_referenced_message_id: resource.last_referenced_message_id ?? sourceMessageId,
    last_referenced_room_id: resource.last_referenced_room_id ?? sourceRoomId,
    last_referenced_room_name: resource.last_referenced_room_name
      ?? sourceContext?.name
      ?? resource.source_context_name
      ?? null,
  };
}

function normalizeResourceType(value: unknown): ProjectFile['source_type'] {
  return value === 'uploaded_file' || value === 'agent_document' ? value : 'unknown';
}

function stripFilePrefix(id: string): string {
  return id.startsWith('file:') ? id.slice('file:'.length) : id;
}

export const api = {
  health: () =>
    request<{
      ok: boolean;
    }>('/health'),
  getProviderSuperpowersStatus: () =>
    request<ProviderSuperpowersStatus>('/provider-superpowers/status'),
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
    superpowers_bootstrap_owner?: SuperpowersBootstrapOwner;
    langchain_planner_model?: string | null;
    openai_base_url?: string | null;
    openai_api_key?: string | null;
    workspace_excluded_dirs?: string[];
  }) =>
    request<SettingsResolution['system']>('/settings/system', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  listAiConfigs: () =>
    request<{ active_ai_config_id: string | null; items: AiConfig[] }>('/settings/ai-configs'),
  createAiConfig: (input: {
    name: string;
    langchain_planner_model: string;
    openai_base_url: string;
    openai_api_key?: string | null;
    activate?: boolean;
  }) =>
    request<AiConfig>('/settings/ai-configs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateAiConfig: (
    id: string,
    input: {
      name?: string | null;
      langchain_planner_model?: string | null;
      openai_base_url?: string | null;
      openai_api_key?: string | null;
      activate?: boolean;
    },
  ) =>
    request<AiConfig>(`/settings/ai-configs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  activateAiConfig: (id: string) =>
    request<SettingsResolution['system']>(`/settings/ai-configs/${id}/activate`, { method: 'POST' }),
  deleteAiConfig: (id: string) =>
    request<void>(`/settings/ai-configs/${id}`, { method: 'DELETE' }),
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
      superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
      workspace_excluded_dirs?: string[] | null;
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
      superpowers_bootstrap_owner?: SuperpowersBootstrapOwner | null;
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
  listPlatformSkillSummaries: () =>
    workspaceRequest<PlatformSkillSummary[]>('/platform-skills/platforms'),
  listPlatformSkillAggregates: () =>
    workspaceRequest<PlatformSkillAggregate[]>('/platform-skills'),
  listPlatformSkills: (provider: PlatformSkillProvider) =>
    workspaceRequest<PlatformSkill[]>(`/platform-skills/${provider}`),
  getPlatformSkill: (provider: PlatformSkillProvider, skillName: string) =>
    workspaceRequest<PlatformSkill>(`/platform-skills/${provider}/${encodeURIComponent(skillName)}`),
  searchPlatformSkillMarketplace: (query: string) => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    const search = params.toString();
    return workspaceRequest<SkillsShSearchResult[]>(`/platform-skills/marketplace${search ? `?${search}` : ''}`);
  },
  installPlatformSkill: (input: {
    installLabel: string;
    targets: PlatformSkillProvider[];
    installMode: Exclude<PlatformSkillInstallMode, 'unknown'>;
  }) =>
    workspaceRequest<PlatformSkill[]>('/platform-skills/install', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  importLocalPlatformSkill: (input: {
    path: string;
    targets: PlatformSkillProvider[];
    installMode: Exclude<PlatformSkillInstallMode, 'unknown'>;
  }) =>
    workspaceRequest<PlatformSkill[]>('/platform-skills/import-local', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deletePlatformSkill: (provider: PlatformSkillProvider, skillName: string) =>
    workspaceRequest<void>(`/platform-skills/${provider}/${encodeURIComponent(skillName)}`, { method: 'DELETE' }),
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
  listSessions: (projectId: string, input: { includeArchived?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (input.includeArchived) params.set('includeArchived', '1');
    const query = params.toString();
    return request<Session[]>(`/projects/${projectId}/sessions${query ? `?${query}` : ''}`);
  },
  createSession: (
    projectId: string,
    input: { title?: string; current_goal?: string | null; mode?: SessionMode; provider?: AcpBackend | null; model?: string | null } = {},
  ) =>
    request<Session>(`/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getSession: (sessionId: string) => request<SessionDetail>(`/sessions/${sessionId}`),
  updateSession: (
    sessionId: string,
    input: Partial<Pick<Session, 'title' | 'current_goal' | 'mode' | 'phase' | 'status' | 'provider' | 'model'>>,
  ) =>
    request<Session>(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  getHistoryRecord: (historyRecordId: string) =>
    request<HistoryRecord>(`/history-records/${historyRecordId}`),
  regenerateResumeBrief: (historyRecordId: string) =>
    request<HistoryRecord>(`/history-records/${historyRecordId}/resume-brief/regenerate`, { method: 'POST' }),
  exportHistoryRecord: (historyRecordId: string) =>
    request<{ record: HistoryRecord; sourceSession: SessionDetail | null }>(`/history-records/${historyRecordId}/export`),
  listFiles: (filters: { projectId?: string; roomId?: string; sourceType?: ProjectFile['source_type'] } = {}) => {
    if (filters.projectId && !filters.roomId) {
      return api.listResourceFiles(filters.projectId, { sourceType: filters.sourceType });
    }
    const params = new URLSearchParams();
    if (filters.projectId) params.set('projectId', filters.projectId);
    if (filters.roomId) params.set('roomId', filters.roomId);
    if (filters.sourceType) params.set('sourceType', filters.sourceType);
    const query = params.toString();
    return request<ProjectFile[]>(`/files${query ? `?${query}` : ''}`);
  },
  listResourceFiles: async (
    projectId: string,
    filters: { roomId?: string; sourceType?: ProjectFile['source_type'] } = {},
  ) => {
    const params = new URLSearchParams();
    if (filters.roomId) params.set('roomId', filters.roomId);
    if (filters.sourceType) params.set('resourceType', filters.sourceType);
    const query = params.toString();
    const resources = await request<ResourceListItem[]>(`/projects/${projectId}/resource-assets${query ? `?${query}` : ''}`);
    return resources.map(resourceListItemToProjectFile);
  },
  listProjectFiles: (
    projectId: string,
    filters: { sourceType?: ProjectFile['source_type']; q?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (filters.sourceType) params.set('sourceType', filters.sourceType);
    if (filters.q) params.set('q', filters.q);
    const query = params.toString();
    return request<ProjectFile[]>(`/projects/${projectId}/files${query ? `?${query}` : ''}`);
  },
  searchWorkspaceFiles: (projectId: string, query: string, filters: { path?: string } = {}) => {
    const params = new URLSearchParams({ q: query });
    if (filters.path) params.set('path', filters.path);
    return workspaceRequest<WorkspaceSearchResponse>(
      `/projects/${projectId}/workspace/search?${params.toString()}`,
    );
  },
  getResourceDetail: (assetId: string, filters: { projectId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.projectId) params.set('projectId', filters.projectId);
    const query = params.toString();
    return request<ResourceDetail>(`/resource-assets/${encodeURIComponent(assetId)}${query ? `?${query}` : ''}`);
  },
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
  deleteResourceAsset: (assetId: string) =>
    request<void>(`/resource-assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }),
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
  updateProject: (
    id: string,
    input: { name?: string; description?: string | null; pinned_at?: number | null; sort_order?: number | null },
  ) =>
    request<Project>(`/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  reorderProjects: (input: { ids: string[]; pinned: boolean }) =>
    request<Project[]>(`/projects/reorder`, {
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
  updateRoom: (
    id: string,
    input: { name?: string; last_opened_at?: number | null; pinned_at?: number | null; sort_order?: number | null },
  ) =>
    request<Room>(`/rooms/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  reorderRooms: (projectId: string, input: { ids: string[]; pinned: boolean }) =>
    request<Room[]>(`/projects/${projectId}/rooms/reorder`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
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
  getMessageTraceEvent: (roomId: string, messageId: string, eventId: string) =>
    request<AgentTimelineEvent>(
      `/rooms/${roomId}/messages/${encodeURIComponent(messageId)}/trace-events/${encodeURIComponent(eventId)}`,
    ),
  listAgentRuns: (roomId: string) => request<AgentRun[]>(`/rooms/${roomId}/agent-runs`),
  cancelAgentRun: (id: string) =>
    request<AgentRun>(`/agent-runs/${id}/cancel`, { method: 'POST' }),
  retryAgentRun: (id: string) =>
    request<AgentRunRetryResult>(`/agent-runs/${id}/retry`, { method: 'POST' }),
  sendMessage: (
    roomId: string,
    input: {
      content: string;
      mentions?: string[];
      files?: File[];
      fileIds?: string[];
      fileRefs?: string[];
      replyToMessageId?: string;
      activeTaskId?: string | null;
      choiceOptionSelection?: MessageChoiceOptionSelection;
      brainstormingOptionSelection?: BrainstormingOptionSelection;
    },
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
      if (input.fileRefs && input.fileRefs.length > 0) {
        form.append('fileRefs', JSON.stringify(input.fileRefs));
      }
      if (input.activeTaskId) {
        form.append('active_task_id', input.activeTaskId);
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
        fileRefs: input.fileRefs,
        reply_to_message_id: input.replyToMessageId,
        active_task_id: input.activeTaskId,
        choice_option_selection: input.choiceOptionSelection,
        brainstorming_option_selection: input.brainstormingOptionSelection,
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
  dispatchTaskExecution: (
    roomId: string,
    input: { source_message_id: string; task_execution: TaskExecutionDecision },
  ) =>
    request<{
      accepted: true;
      dispatched: number;
      added_agents: Array<{ agent_id: string; agent_name: string }>;
      deferred_steps: TaskExecutionDecision['next_steps'];
    }>(
      `/rooms/${roomId}/task-execution/dispatch`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  startTaskAction: (
    roomId: string,
    taskId: string,
    input: { action: TaskActionKind; sender_id?: string; sender_name?: string },
  ) =>
    request<TaskActionStartResult>(`/rooms/${roomId}/tasks/${taskId}/actions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listProjectTasks: (projectId: string) => request<Task[]>(`/projects/${projectId}/tasks`),
  listRoomTasks: (roomId: string) => request<Task[]>(`/rooms/${roomId}/tasks`),
  listRoomTaskEvents: (
    roomId: string,
    input: { taskId?: string; layer?: TaskEvent['layer']; limit?: number; replay?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (input.taskId) params.set('taskId', input.taskId);
    if (input.layer) params.set('layer', input.layer);
    if (input.limit) params.set('limit', String(input.limit));
    if (input.replay) params.set('replay', '1');
    const query = params.toString();
    return request<TaskEventListResponse>(`/rooms/${roomId}/task-events${query ? `?${query}` : ''}`);
  },
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
  listTaskExecutors: (taskId: string) =>
    request<TaskExecutorListItem[]>(`/tasks/${taskId}/executors`),
  activateTask: (roomId: string, taskId: string) =>
    request<{ roomId: string; taskId: string }>(`/rooms/${roomId}/tasks/${taskId}/activate`, { method: 'POST' }),
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
  listRoomWorkflows: (roomId: string) =>
    request<WorkflowRun[]>(`/rooms/${roomId}/workflows`),
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
