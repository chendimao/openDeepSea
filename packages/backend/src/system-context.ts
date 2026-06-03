import { basename } from 'node:path';
import { projectRepo } from './repos/projects.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { taskRepo } from './repos/tasks.js';
import { fileRepo } from './repos/files.js';
import { messageRepo } from './repos/messages.js';
import { workflowRepo } from './repos/workflows.js';
import type {
  AcpBackend,
  Message,
  Project,
  ProjectFileWithRefs,
  Room,
  RoomAgent,
  Task,
  TaskPriority,
  TaskStatus,
  WorkflowStatus,
} from './types.js';

export interface SystemContextScope {
  project_id?: string;
  room_id?: string;
  task_id?: string;
}

export interface SystemContextCitation {
  type: string;
  id: string;
  title?: string;
}

export interface SystemContextResponse<T> {
  source: string;
  scope: SystemContextScope;
  generated_at: number;
  counts?: Record<string, number>;
  results: T;
  citations?: SystemContextCitation[];
  warnings?: string[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  path_label: string;
  message_routing_mode: Project['message_routing_mode'];
  fallback_agent_id: string | null;
  created_at: number;
  updated_at: number;
  stats: ReturnType<typeof projectRepo.stats>;
}

export interface RoomSummary {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: number;
  last_opened_at: number | null;
  stats?: {
    tasks: number;
    agents: number;
    files: number;
    workflows: number;
  };
}

export interface TaskSummary {
  id: string;
  room_id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_agent_id: string | null;
  source_message_id: string | null;
  created_from: Task['created_from'];
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface RoomAgentSummary {
  id: string;
  room_id: string;
  global_agent_id: string | null;
  agent_id: string;
  agent_name: string;
  agent_role: string | null;
  responsibilities: string | null;
  workflow_role: RoomAgent['workflow_role'];
  acp_enabled: boolean;
  acp_backend: AcpBackend | null;
  acp_permission_mode: RoomAgent['acp_permission_mode'];
  runtime_backend: RoomAgent['runtime_backend'];
  memory_scope: RoomAgent['memory_scope'];
  joined_at: number;
  left_at: number | null;
}

export interface FileSummary {
  id: string;
  project_id: string;
  name: string;
  source_type: ProjectFileWithRefs['source_type'];
  mime_type: string;
  size: number;
  source_label: string;
  source_display_name: string | null;
  source_room_id: string | null;
  source_task_id: string | null;
  source_context_name: string | null;
  source_context_type: ProjectFileWithRefs['source_context_type'];
  reference_count: number;
  last_referenced_at: number | null;
  last_referenced_message_id: string | null;
  created_at: number;
}

export interface MessageSummary {
  id: string;
  room_id: string;
  sender_type: Message['sender_type'];
  sender_id: string;
  sender_name: string | null;
  message_type: Message['message_type'];
  layer: Message['layer'];
  content: string;
  created_at: number;
}

export interface WorkflowSummary {
  id: string;
  room_id: string;
  project_id: string;
  task_id: string;
  status: WorkflowStatus;
  current_stage: string | null;
  approval_required: boolean;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SystemOverviewResult {
  projects: ProjectSummary[];
}

export interface ProjectOverviewResult {
  project: ProjectSummary;
  rooms: RoomSummary[];
  tasks: TaskSummary[];
  files: FileSummary[];
}

export interface RoomOverviewResult {
  project: ProjectSummary;
  room: RoomSummary;
  tasks: TaskSummary[];
  agents: RoomAgentSummary[];
  files: FileSummary[];
  workflows: WorkflowSummary[];
  recent_messages: MessageSummary[];
}

interface FileFilters {
  sourceType?: ProjectFileWithRefs['source_type'];
  query?: string;
}

const RECENT_MESSAGE_LIMIT = 12;

export function getSystemOverview(): SystemContextResponse<SystemOverviewResult> {
  const projects = projectRepo.list().map(toProjectSummary);
  const roomCount = projects.reduce((count, project) => count + project.stats.rooms, 0);
  const taskCount = projects.reduce((count, project) => count + project.stats.tasks, 0);
  const files = fileRepo.list();
  return buildResponse({
    source: 'openclaw.system_context.system_overview',
    scope: {},
    counts: {
      projects: projects.length,
      rooms: roomCount,
      tasks: taskCount,
      files: files.length,
    },
    results: {
      projects,
    },
    citations: projects.map((project) => ({ type: 'project', id: project.id, title: project.name })),
  });
}

export function getProjectOverview(projectId: string): SystemContextResponse<ProjectOverviewResult> {
  const project = requireProject(projectId);
  const rooms = roomRepo.listByProject(project.id).map(toRoomSummaryWithStats);
  const tasks = taskRepo.listByProject(project.id).map(toTaskSummary);
  const files = fileRepo.listByProject(project.id).map(toFileSummary);
  return buildResponse({
    source: 'openclaw.system_context.project_overview',
    scope: { project_id: project.id },
    counts: {
      rooms: rooms.length,
      tasks: tasks.length,
      files: files.length,
    },
    results: {
      project: toProjectSummary(project),
      rooms,
      tasks,
      files,
    },
    citations: [
      { type: 'project', id: project.id, title: project.name },
      ...rooms.map((room) => ({ type: 'room', id: room.id, title: room.name })),
    ],
  });
}

export function getRoomOverview(roomId: string): SystemContextResponse<RoomOverviewResult> {
  const room = requireRoom(roomId);
  const project = requireProject(room.project_id);
  const tasks = taskRepo.listByRoom(room.id).map(toTaskSummary);
  const agents = roomAgentRepo.listByRoom(room.id).map(toRoomAgentSummary);
  const files = fileRepo.list({ projectId: project.id, roomId: room.id }).map(toFileSummary);
  const workflows = workflowRepo.listByRoom(room.id).map(toWorkflowSummary);
  const recentMessages = messageRepo
    .listByRoom(room.id, RECENT_MESSAGE_LIMIT)
    .slice(-RECENT_MESSAGE_LIMIT)
    .map(toMessageSummary);
  return buildResponse({
    source: 'openclaw.system_context.room_overview',
    scope: { project_id: project.id, room_id: room.id },
    counts: {
      tasks: tasks.length,
      agents: agents.length,
      files: files.length,
      workflows: workflows.length,
      recent_messages: recentMessages.length,
    },
    results: {
      project: toProjectSummary(project),
      room: toRoomSummary(room, { tasks: tasks.length, agents: agents.length, files: files.length, workflows: workflows.length }),
      tasks,
      agents,
      files,
      workflows,
      recent_messages: recentMessages,
    },
    citations: [
      { type: 'project', id: project.id, title: project.name },
      { type: 'room', id: room.id, title: room.name },
      ...tasks.map((task) => ({ type: 'task', id: task.id, title: task.title })),
    ],
  });
}

export function listRoomTasks(roomId: string): TaskSummary[] {
  requireRoom(roomId);
  return taskRepo.listByRoom(roomId).map(toTaskSummary);
}

export function listRoomAgents(roomId: string): RoomAgentSummary[] {
  requireRoom(roomId);
  return roomAgentRepo.listByRoom(roomId).map(toRoomAgentSummary);
}

export function listProjectFiles(projectId: string, filters: FileFilters = {}): FileSummary[] {
  requireProject(projectId);
  return fileRepo.listByProject(projectId, filters).map(toFileSummary);
}

export function listRoomFiles(roomId: string, filters: FileFilters = {}): FileSummary[] {
  const room = requireRoom(roomId);
  return fileRepo.list({ ...filters, projectId: room.project_id, roomId }).map(toFileSummary);
}

function buildResponse<T>(input: {
  source: string;
  scope: SystemContextScope;
  counts?: Record<string, number>;
  results: T;
  citations?: SystemContextCitation[];
  warnings?: string[];
}): SystemContextResponse<T> {
  return {
    source: input.source,
    scope: input.scope,
    generated_at: Date.now(),
    ...(input.counts ? { counts: input.counts } : {}),
    results: input.results,
    ...(input.citations?.length ? { citations: input.citations } : {}),
    ...(input.warnings?.length ? { warnings: input.warnings } : {}),
  };
}

function requireProject(projectId: string): Project {
  const project = projectRepo.get(projectId);
  if (!project) throw new Error('project not found');
  return project;
}

function requireRoom(roomId: string): Room {
  const room = roomRepo.get(roomId);
  if (!room) throw new Error('room not found');
  return room;
}

function toProjectSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    path_label: basename(project.path),
    message_routing_mode: project.message_routing_mode,
    fallback_agent_id: project.fallback_agent_id,
    created_at: project.created_at,
    updated_at: project.updated_at,
    stats: projectRepo.stats(project.id),
  };
}

function toRoomSummaryWithStats(room: Room): RoomSummary {
  const tasks = taskRepo.listByRoom(room.id);
  const agents = roomAgentRepo.listByRoom(room.id);
  const files = fileRepo.list({ projectId: room.project_id, roomId: room.id });
  const workflows = workflowRepo.listByRoom(room.id);
  return toRoomSummary(room, {
    tasks: tasks.length,
    agents: agents.length,
    files: files.length,
    workflows: workflows.length,
  });
}

function toRoomSummary(room: Room, stats?: NonNullable<RoomSummary['stats']>): RoomSummary {
  return {
    id: room.id,
    project_id: room.project_id,
    name: room.name,
    description: room.description,
    created_at: room.created_at,
    last_opened_at: room.last_opened_at,
    ...(stats ? { stats } : {}),
  };
}

function toTaskSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    room_id: task.room_id,
    project_id: task.project_id,
    parent_task_id: task.parent_task_id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigned_agent_id: task.assigned_agent_id,
    source_message_id: task.source_message_id,
    created_from: task.created_from,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
  };
}

function toRoomAgentSummary(agent: RoomAgent): RoomAgentSummary {
  return {
    id: agent.id,
    room_id: agent.room_id,
    global_agent_id: agent.global_agent_id,
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    agent_role: agent.agent_role,
    responsibilities: agent.responsibilities,
    workflow_role: agent.workflow_role,
    acp_enabled: Boolean(agent.acp_enabled),
    acp_backend: agent.acp_backend,
    acp_permission_mode: agent.acp_permission_mode,
    runtime_backend: agent.runtime_backend,
    memory_scope: agent.memory_scope,
    joined_at: agent.joined_at,
    left_at: agent.left_at,
  };
}

function toFileSummary(file: ProjectFileWithRefs): FileSummary {
  return {
    id: file.id,
    project_id: file.project_id,
    name: file.original_name,
    source_type: file.source_type,
    mime_type: file.mime_type,
    size: file.size,
    source_label: file.source_label,
    source_display_name: file.source_display_name,
    source_room_id: file.source_room_id ?? file.last_referenced_room_id,
    source_task_id: file.source_task_id,
    source_context_name: file.source_context_name ?? file.last_referenced_room_name,
    source_context_type: file.source_context_type,
    reference_count: file.reference_count,
    last_referenced_at: file.last_referenced_at,
    last_referenced_message_id: file.last_referenced_message_id,
    created_at: file.created_at,
  };
}

function toMessageSummary(message: Message): MessageSummary {
  return {
    id: message.id,
    room_id: message.room_id,
    sender_type: message.sender_type,
    sender_id: message.sender_id,
    sender_name: message.sender_name,
    message_type: message.message_type,
    layer: message.layer,
    content: truncateText(message.content),
    created_at: message.created_at,
  };
}

function toWorkflowSummary(workflow: ReturnType<typeof workflowRepo.listByRoom>[number]): WorkflowSummary {
  return {
    id: workflow.id,
    room_id: workflow.room_id,
    project_id: workflow.project_id,
    task_id: workflow.task_id,
    status: workflow.status,
    current_stage: workflow.current_stage,
    approval_required: Boolean(workflow.approval_required),
    created_at: workflow.created_at,
    updated_at: workflow.updated_at,
    completed_at: workflow.completed_at,
  };
}

function truncateText(value: string, maxChars = 500): string {
  const normalized = value.replace(/\s+$/g, '').trimStart();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}
