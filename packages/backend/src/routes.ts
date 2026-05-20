import { Router, type NextFunction, type Request, type Response } from 'express';
import { unlink } from 'node:fs/promises';
import { isAbsolute, resolve, sep, win32 } from 'node:path';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getAdapter } from './acp/index.js';
import { listBuiltInAgentTemplates } from './agent-templates.js';
import type { CollaborationDecision } from './collaboration-decision.js';
import { runCollaborationStages as defaultRunCollaborationStages } from './collaboration-runner.js';
import { getDefaultRoomCrewTemplate, getRoomCrewTemplate, listRoomCrewTemplates } from './crew-templates.js';
import { db } from './db.js';
import { dispatchUserMessage } from './dispatcher.js';
import {
  sendGlobalChatMessage,
  type GlobalChatInvoker,
  type SafeGlobalChatSettingsSummary,
} from './global-chat.js';
import { validateLocalAccess } from './local-access.js';
import { resolveMentionedAgentRoomIds } from './mentions.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { agentRepo } from './repos/agents.js';
import { fileRepo } from './repos/files.js';
import { globalChatRepo } from './repos/global-chat.js';
import { memoryRepo } from './repos/memory.js';
import { messageRepo } from './repos/messages.js';
import { projectRepo } from './repos/projects.js';
import { resourceAssetRepo } from './repos/resource-assets.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { settingsRepo } from './repos/settings.js';
import { taskRepo } from './repos/tasks.js';
import { workflowContextRepo } from './repos/workflow-context.js';
import { workflowDefinitionRepo } from './repos/workflow-definitions.js';
import { searchProjectRooms } from './room-search.js';
import { skillsRouter } from './skills/routes.js';
import { pickDirectory } from './system-dialogs.js';
import { createTaskWithConversation, recordTaskEvent } from './task-conversation.js';
import { workflowRepo } from './repos/workflows.js';
import { runRegistry } from './run-registry.js';
import {
  MAX_MESSAGE_FILES,
  buildAttachmentMetadata,
  buildAttachmentMetadataFromProjectFile,
  buildProjectFileRecordInput,
  cleanupProjectUploadedFiles,
  cleanupUploadedFiles,
  messageUpload,
  projectFileUpload,
  projectFileUploadRoot,
  roomProjectFileUpload,
} from './uploads.js';
import {
  type WorkspaceFileErrorCode,
  WorkspaceFileError,
  listWorkspaceDirectory,
  readWorkspaceFilePreview,
  searchWorkspaceFiles,
} from './workspace-files.js';
import {
  approveWorkflowPlanWithConversation,
  startWorkflowWithConversation,
} from './workflows/conversation.js';
import { getLangGraphWorkflowConfig } from './workflows/graph/runtime-config.js';
import { workflowOrchestrator } from './workflows/orchestrator.js';
import { wsHub } from './ws-hub.js';
import {
  COLLABORATION_STAGES,
  type AcpBackend,
  type CollaborationRunStatus,
  type AgentMemoryScope,
  type AgentRuntimeBackend,
  type AgentToolPolicy,
  type AgentWorkspacePolicy,
  type MemoryScope,
  type MessageMetadata,
  type MessageRoutingMode,
  type ProjectFile,
  type ResourceAssetGroupKey,
  type ResourceAssetType,
  type TaskExecutionIntent,
  type TaskInteractionMode,
  type WorkflowRole,
} from './types.js';

export const router = Router();
router.use('/skills', skillsRouter);

interface CollaborationRouteDeps {
  runCollaborationStages?: typeof defaultRunCollaborationStages;
}

interface GlobalChatRouteDeps {
  invoker?: GlobalChatInvoker;
  settingsSummary?: SafeGlobalChatSettingsSummary;
}

let collaborationRouteDeps: CollaborationRouteDeps = {};
let globalChatRouteDeps: GlobalChatRouteDeps = {};
const collaborationRunsBySource = new Map<string, {
  id: string;
  room_id: string;
  source_message_id: string;
  status: CollaborationRunStatus;
}>();

export function setCollaborationRouteDeps(deps: CollaborationRouteDeps): void {
  collaborationRouteDeps = deps;
  collaborationRunsBySource.clear();
}

export function setGlobalChatRouteDeps(deps: GlobalChatRouteDeps): void {
  globalChatRouteDeps = deps;
}

function workflowErrorStatus(error: Error): number {
  const message = error.message.toLowerCase();
  if (message.includes('not found')) return 404;
  if (
    message.includes('already has an active workflow') ||
    message.includes('already has an active agent run') ||
    message.includes('already has a running step') ||
    message.includes('already running') ||
    message.includes('not awaiting approval') ||
    message.includes('no failed step') ||
    message.includes('no current stage')
  ) {
    return 409;
  }
  return 400;
}

const WORKSPACE_FILE_NOT_FOUND_CODES: WorkspaceFileErrorCode[] = [
  'WORKSPACE_PATH_NOT_FOUND',
];

function workspaceFileErrorStatus(error: WorkspaceFileError): number {
  if (WORKSPACE_FILE_NOT_FOUND_CODES.includes(error.code)) {
    return 404;
  }
  return 400;
}

function requireLocalAccess(req: Request, res: Response): boolean {
  const auth = validateLocalAccess(req);
  if (auth.ok) return true;
  res.status(auth.status).json({ error: auth.error });
  return false;
}

// ---------- Health ----------
router.get('/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

router.get('/agent-templates', (_req, res) => {
  res.json({ templates: listBuiltInAgentTemplates() });
});

router.get('/crew-templates', (_req, res) => {
  res.json({ templates: listRoomCrewTemplates() });
});

const settingsPatchShape = {
  message_routing_mode: z.enum(['mentions_only', 'fallback_reply']).nullable().optional(),
  fallback_agent_id: z.string().min(1).nullable().optional(),
  interaction_mode: z.enum(['ask_user', 'auto_recommended']).nullable().optional(),
  auto_distill_enabled: z.boolean().nullable().optional(),
  default_workflow_definition_id: z.string().min(1).nullable().optional(),
};

const nullableTrimmedStringSchema = z.union([z.string(), z.null()]).optional().transform((value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
});

const agentInputSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1),
  description: nullableTrimmedStringSchema,
  preferred_user_name: nullableTrimmedStringSchema,
  personality: nullableTrimmedStringSchema,
  rules: nullableTrimmedStringSchema,
  responsibilities: nullableTrimmedStringSchema,
  default_acp_backend: z.enum(['claudecode', 'opencode', 'codex']).nullable().optional(),
  default_acp_permission_mode: z.enum(['bypass', 'workspace-write', 'read-only']).nullable().optional(),
});

const agentPatchSchema = agentInputSchema.partial();

const settingsPatchSchema = z
  .object(settingsPatchShape)
  .refine(
    (value) =>
      value.message_routing_mode === undefined ||
      value.message_routing_mode === null ||
      value.message_routing_mode === 'mentions_only' ||
      Boolean(value.fallback_agent_id),
    { message: 'fallback_agent_id is required unless message_routing_mode is mentions_only' },
  );

const systemSettingsPatchSchema = z
  .object({
    ...settingsPatchShape,
    langchain_planner_model: nullableTrimmedStringSchema,
    openai_api_key: nullableTrimmedStringSchema,
    openai_base_url: nullableTrimmedStringSchema,
  })
  .refine(
    (value) =>
      value.message_routing_mode === undefined ||
      value.message_routing_mode === null ||
      value.message_routing_mode === 'mentions_only' ||
      Boolean(value.fallback_agent_id),
    { message: 'fallback_agent_id is required unless message_routing_mode is mentions_only' },
  );

const aiConfigInputSchema = z.object({
  name: z.string().trim().min(1),
  langchain_planner_model: z.string().trim().min(1),
  openai_base_url: z.string().trim().min(1).url(),
  openai_api_key: nullableTrimmedStringSchema,
  activate: z.boolean().optional(),
});

const aiConfigPatchSchema = aiConfigInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'at least one field is required' },
);

const agentToolCapabilitySchema = z.enum([
  'read_files',
  'write_files',
  'run_shell',
  'browser',
  'search',
  'image_input',
  'commit',
]);

function normalizeWorkspaceBoundaryPath(value: string): string {
  const path = value.trim();
  if (!path) {
    throw new Error('workspace path cannot be empty');
  }
  if (isAbsolute(path) || win32.isAbsolute(path)) {
    throw new Error('workspace path cannot be absolute');
  }
  if (path.split(/[\\/]+/).includes('..')) {
    throw new Error('workspace path cannot contain .. segments');
  }
  return path;
}

const workspaceBoundaryPathSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeWorkspaceBoundaryPath(value);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
    return z.NEVER;
  }
});

const roomAgentRuntimeBoundarySchema = z.object({
  runtime_backend: z.enum(['acp', 'model', 'none']).nullable().optional(),
  tool_policy: z.object({
    allowed: z.array(agentToolCapabilitySchema),
  }).nullable().optional(),
  workspace_policy: z.object({
    read: z.array(workspaceBoundaryPathSchema),
    write: z.array(workspaceBoundaryPathSchema),
  }).nullable().optional(),
  memory_scope: z.enum(['project', 'room', 'agent', 'task', 'none']).nullable().optional(),
  memory_max_context_chars: z.number().int().positive().nullable().optional(),
});

// ---------- Global agents ----------
router.get('/agents', (_req, res) => {
  res.json(agentRepo.list());
});

router.post('/agents', (req, res) => {
  const parsed = agentInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const agent = agentRepo.create({
      agent_id: parsed.data.agent_id,
      name: parsed.data.name,
      description: parsed.data.description,
      preferred_user_name: parsed.data.preferred_user_name,
      personality: parsed.data.personality,
      rules: parsed.data.rules,
      responsibilities: parsed.data.responsibilities,
      default_acp_backend: parsed.data.default_acp_backend ?? null,
      default_acp_permission_mode: parsed.data.default_acp_permission_mode ?? 'bypass',
    });
    res.status(201).json(agent);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/agents/:agentId', (req, res) => {
  const agent = agentRepo.get(req.params.agentId);
  if (!agent) return res.status(404).json({ error: 'not found' });
  res.json(agent);
});

router.patch('/agents/:agentId', (req, res) => {
  const parsed = agentPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const updated = agentRepo.update(req.params.agentId, parsed.data);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete('/agents/:agentId', (req, res) => {
  const result = agentRepo.delete(req.params.agentId);
  if (result.ok) return res.status(204).end();
  if (result.reason === 'not_found') return res.status(404).json({ error: 'not found' });
  if (result.reason === 'builtin') return res.status(409).json({ error: 'builtin agent cannot be deleted' });
  return res.status(409).json({ error: 'agent is in use', references: result.references });
});

router.post('/agents/:agentId/restore-defaults', (req, res) => {
  const restored = agentRepo.restoreBuiltInDefaults(req.params.agentId);
  if (!restored) return res.status(404).json({ error: 'not found' });
  res.json(restored);
});

const memoryInputSchema = z.object({
  scope: z.enum(['project', 'room', 'agent', 'task']),
  memory_type: z.enum(['decision', 'fact', 'preference', 'lesson', 'task_summary', 'artifact_summary']),
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(12000),
  room_id: z.string().nullable().optional(),
  room_agent_id: z.string().nullable().optional(),
  task_id: z.string().nullable().optional(),
  source_type: z.enum(['manual', 'message', 'workflow', 'task']).optional(),
  source_id: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

function validateMemoryScope(input: {
  projectId: string;
  scope: MemoryScope;
  room_id?: string | null;
  room_agent_id?: string | null;
  task_id?: string | null;
}): { ok: true; room_id: string | null } | { ok: false; status: number; error: string } {
  if (!projectRepo.get(input.projectId)) return { ok: false, status: 404, error: 'project not found' };

  if (input.scope === 'project') {
    if (input.room_id || input.room_agent_id || input.task_id) {
      return { ok: false, status: 400, error: 'project scope cannot include narrow foreign keys' };
    }
    return { ok: true, room_id: null };
  }

  if (input.scope === 'room') {
    if (!input.room_id) return { ok: false, status: 400, error: 'room_id is required' };
    if (input.room_agent_id || input.task_id) {
      return { ok: false, status: 400, error: 'room scope can only include room_id' };
    }
    const room = roomRepo.get(input.room_id);
    if (!room || room.project_id !== input.projectId) return { ok: false, status: 400, error: 'room_id is invalid' };
    return { ok: true, room_id: room.id };
  }

  if (input.scope === 'agent') {
    if (!input.room_agent_id) return { ok: false, status: 400, error: 'room_agent_id is required' };
    if (input.task_id) return { ok: false, status: 400, error: 'agent scope cannot include task_id' };
    const agent = roomAgentRepo.get(input.room_agent_id);
    if (!agent) return { ok: false, status: 400, error: 'room_agent_id is invalid' };
    const agentRoom = roomRepo.get(agent.room_id);
    if (!agentRoom || agentRoom.project_id !== input.projectId) {
      return { ok: false, status: 400, error: 'room_agent_id is invalid' };
    }
    if (input.room_id && input.room_id !== agent.room_id) {
      return { ok: false, status: 400, error: 'room_agent_id does not belong to room_id' };
    }
    return { ok: true, room_id: agent.room_id };
  }

  if (!input.task_id) return { ok: false, status: 400, error: 'task_id is required' };
  if (input.room_agent_id) return { ok: false, status: 400, error: 'task scope cannot include room_agent_id' };
  const task = taskRepo.get(input.task_id);
  if (!task || task.project_id !== input.projectId) return { ok: false, status: 400, error: 'task_id is invalid' };
  if (input.room_id && input.room_id !== task.room_id) {
    return { ok: false, status: 400, error: 'task_id does not belong to room_id' };
  }
  return { ok: true, room_id: task.room_id };
}

function isMemoryConflictError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return message.includes('unique constraint') || message.includes('idx_memory_task_source');
}

function isMemoryValidationError(error: Error): boolean {
  const message = error.message;
  return (
    message === 'project_id is invalid' ||
    message === 'room_id does not belong to project_id' ||
    message === 'room_agent_id does not belong to project_id' ||
    message === 'room_agent_id does not belong to room_id' ||
    message === 'task_id does not belong to project_id' ||
    message === 'task_id does not belong to room_id' ||
    message === 'project scope cannot include room_id, room_agent_id, or task_id' ||
    message === 'room scope requires room_id' ||
    message === 'room scope cannot include room_agent_id or task_id' ||
    message === 'agent scope requires room_id' ||
    message === 'agent scope requires room_agent_id' ||
    message === 'agent scope cannot include task_id' ||
    message === 'task scope requires room_id' ||
    message === 'task scope requires task_id' ||
    message === 'task scope cannot include room_agent_id'
  );
}

function logUnexpectedMemoryError(context: string, error: unknown): void {
  console.warn(`[memory-api] ${context}`, error);
}

// ---------- Global Chat ----------
router.get('/global-chat/sessions', (req, res) => {
  res.json(globalChatRepo.listSessions({
    includeArchived: req.query.includeArchived === '1',
  }));
});

router.post('/global-chat/sessions', (req, res) => {
  const schema = z.object({ title: z.string().optional().nullable() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(globalChatRepo.createSession({ title: parsed.data.title }));
});

router.patch('/global-chat/sessions/:id', (req, res) => {
  const schema = z.object({
    title: z.string().optional().nullable(),
    archived: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = globalChatRepo.updateSession(req.params.id, parsed.data);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

router.delete('/global-chat/sessions/:id', (req, res) => {
  const deleted = globalChatRepo.deleteSession(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

router.get('/global-chat/sessions/:id/messages', (req, res) => {
  if (!globalChatRepo.getSession(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(globalChatRepo.listMessages(req.params.id));
});

router.post('/global-chat/sessions/:id/messages', async (req, res) => {
  const schema = z.object({ content: z.string().trim().min(1) });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = await sendGlobalChatMessage({
      sessionId: req.params.id,
      content: parsed.data.content,
      invoker: globalChatRouteDeps.invoker,
      settingsSummary: globalChatRouteDeps.settingsSummary,
    });
    res.status(201).json(result);
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.includes('not found') ? 404 : 400).json({ error: message });
  }
});

router.post('/global-chat/messages/:id/save-memory', (req, res) => {
  const schema = z.object({
    memory_type: z.enum(['decision', 'fact', 'preference', 'lesson']).default('fact'),
    title: z.string().trim().min(1).optional(),
    content: z.string().trim().min(1).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const message = globalChatRepo.getMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'not found' });
  const title = parsed.data.title ?? `${message.role}: ${message.content.slice(0, 80)}`;
  const memory = memoryRepo.upsertGlobalFromMessage({
    message_id: message.id,
    memory_type: parsed.data.memory_type,
    title,
    content: parsed.data.content ?? message.content,
  });
  res.status(201).json(memory);
});

// ---------- Settings ----------
router.get('/settings/system', (_req, res) => {
  res.json(settingsRepo.getSystem());
});

router.patch('/settings/system', (req, res) => {
  const parsed = systemSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (
    parsed.data.default_workflow_definition_id &&
    !workflowDefinitionRepo.isVisibleForSystem(parsed.data.default_workflow_definition_id)
  ) {
    return res.status(400).json({ error: 'default workflow definition is not available for system settings' });
  }
  res.json(settingsRepo.updateSystem({
    message_routing_mode: parsed.data.message_routing_mode ?? undefined,
    fallback_agent_id: parsed.data.fallback_agent_id,
    interaction_mode: parsed.data.interaction_mode ?? undefined,
    auto_distill_enabled: parsed.data.auto_distill_enabled ?? undefined,
    default_workflow_definition_id: parsed.data.default_workflow_definition_id,
    langchain_planner_model: parsed.data.langchain_planner_model,
    openai_api_key: parsed.data.openai_api_key,
    openai_base_url: parsed.data.openai_base_url,
  }));
});

router.get('/settings/ai-configs', (_req, res) => {
  res.json({
    active_ai_config_id: settingsRepo.getSystem().active_ai_config_id,
    items: settingsRepo.listAiConfigs(),
  });
});

router.post('/settings/ai-configs', (req, res) => {
  const parsed = aiConfigInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const config = settingsRepo.createAiConfig(parsed.data);
    res.status(201).json(config);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'invalid AI config' });
  }
});

router.patch('/settings/ai-configs/:configId', (req, res) => {
  const parsed = aiConfigPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const config = settingsRepo.updateAiConfig(req.params.configId, parsed.data);
    if (!config) return res.status(404).json({ error: 'not found' });
    res.json(config);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'invalid AI config' });
  }
});

router.post('/settings/ai-configs/:configId/activate', (req, res) => {
  const config = settingsRepo.setActiveAiConfig(req.params.configId);
  if (!config) return res.status(404).json({ error: 'not found' });
  res.json(settingsRepo.getSystem());
});

router.delete('/settings/ai-configs/:configId', (req, res) => {
  const deleted = settingsRepo.deleteAiConfig(req.params.configId);
  if (!deleted) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

router.get('/projects/:projectId/settings', (req, res) => {
  const resolution = settingsRepo.resolveForProject(req.params.projectId);
  if (!resolution) return res.status(404).json({ error: 'not found' });
  res.json(resolution);
});

router.patch('/projects/:projectId/settings', (req, res) => {
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (
    parsed.data.default_workflow_definition_id &&
    !workflowDefinitionRepo.isVisibleForProject(parsed.data.default_workflow_definition_id, req.params.projectId)
  ) {
    return res.status(400).json({ error: 'default workflow definition is not available for project settings' });
  }
  const updated = settingsRepo.updateProject(req.params.projectId, {
    message_routing_mode: parsed.data.message_routing_mode,
    fallback_agent_id: parsed.data.fallback_agent_id,
    interaction_mode: parsed.data.interaction_mode,
    auto_distill_enabled: parsed.data.auto_distill_enabled,
    default_workflow_definition_id: parsed.data.default_workflow_definition_id,
  });
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(settingsRepo.resolveForProject(req.params.projectId));
});

router.get('/rooms/:roomId/settings', (req, res) => {
  const resolution = settingsRepo.resolveForRoom(req.params.roomId);
  if (!resolution) return res.status(404).json({ error: 'not found' });
  res.json(resolution);
});

router.patch('/rooms/:roomId/settings', (req, res) => {
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (
    parsed.data.default_workflow_definition_id &&
    !workflowDefinitionRepo.isVisibleForRoom(parsed.data.default_workflow_definition_id, req.params.roomId)
  ) {
    return res.status(400).json({ error: 'default workflow definition is not available for room settings' });
  }
  const updated = settingsRepo.updateRoom(req.params.roomId, {
    message_routing_mode: parsed.data.message_routing_mode,
    fallback_agent_id: parsed.data.fallback_agent_id,
    interaction_mode: parsed.data.interaction_mode,
    auto_distill_enabled: parsed.data.auto_distill_enabled,
    default_workflow_definition_id: parsed.data.default_workflow_definition_id,
  });
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(settingsRepo.resolveForRoom(req.params.roomId));
});

const workflowDefinitionGraphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().trim().min(1),
    type: z.enum([
      'context',
      'planning',
      'approval_gate',
      'dispatch',
      'execute',
      'review',
      'repair_decision',
      'verify',
      'acceptance',
      'memory',
    ]),
    label: z.string().trim().min(1),
    stage: z.enum(['analysis', 'planning', 'assignment', 'implementation', 'code_review', 'acceptance']).nullable().optional(),
    role: z.enum(['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor']).nullable().optional(),
    position: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  })).min(1),
  edges: z.array(z.object({
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    condition: z.string().trim().min(1).nullable().optional(),
  })),
});

const workflowDefinitionCreateSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().nullable().optional(),
  scope: z.enum(['system', 'project', 'room']),
  scope_id: z.string().trim().min(1),
  definition: workflowDefinitionGraphSchema,
});

const workflowDefinitionPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  definition: workflowDefinitionGraphSchema.optional(),
});

const workflowDefinitionListSchema = z.object({
  scope: z.enum(['system', 'project', 'room']).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  projectId: z.string().trim().min(1).optional(),
  roomId: z.string().trim().min(1).optional(),
  includeArchived: z.enum(['1']).optional(),
});

const workflowDefinitionDuplicateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  scope: z.enum(['system', 'project', 'room']).optional(),
  scope_id: z.string().trim().min(1).optional(),
});

router.get('/workflow-definitions', (req, res) => {
  const parsed = workflowDefinitionListSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.projectId && !projectRepo.get(parsed.data.projectId)) {
    return res.status(404).json({ error: 'project not found' });
  }
  if (parsed.data.roomId) {
    const room = roomRepo.get(parsed.data.roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (parsed.data.projectId && room.project_id !== parsed.data.projectId) {
      return res.status(400).json({ error: 'room does not belong to project' });
    }
  }
  res.json(workflowDefinitionRepo.list({
    scope: parsed.data.scope,
    status: parsed.data.status,
    projectId: parsed.data.projectId,
    roomId: parsed.data.roomId,
    includeArchived: parsed.data.includeArchived === '1',
  }));
});

router.post('/workflow-definitions', (req, res) => {
  const parsed = workflowDefinitionCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const definition = workflowDefinitionRepo.createDraft(parsed.data);
    res.status(201).json(definition);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.patch('/workflow-definitions/:id', (req, res) => {
  const parsed = workflowDefinitionPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const definition = workflowDefinitionRepo.updateDraft(req.params.id, parsed.data);
    if (!definition) return res.status(404).json({ error: 'not found' });
    res.json(definition);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/workflow-definitions/:id/publish', (req, res) => {
  try {
    const definition = workflowDefinitionRepo.publish(req.params.id);
    if (!definition) return res.status(404).json({ error: 'not found' });
    res.json(definition);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/workflow-definitions/:id/duplicate', (req, res) => {
  const parsed = workflowDefinitionDuplicateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const definition = workflowDefinitionRepo.duplicate(req.params.id, parsed.data);
    if (!definition) return res.status(404).json({ error: 'not found' });
    res.status(201).json(definition);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/workflow-definitions/:id/edit-draft', (req, res) => {
  try {
    if (!workflowDefinitionRepo.get(req.params.id)) return res.status(404).json({ error: 'not found' });
    const definition = workflowDefinitionRepo.createEditDraft(req.params.id);
    if (!definition) return res.status(400).json({ error: 'workflow definition cannot be edited' });
    res.status(201).json(definition);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/workflow-definitions/:id/archive', (req, res) => {
  try {
    const definition = workflowDefinitionRepo.archive(req.params.id);
    if (!definition) return res.status(404).json({ error: 'not found' });
    res.json(definition);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete('/workflow-definitions/:id', (req, res) => {
  try {
    const deleted = workflowDefinitionRepo.deleteDraft(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/rooms/:roomId/workflow-definitions', (req, res) => {
  if (!roomRepo.get(req.params.roomId)) return res.status(404).json({ error: 'not found' });
  res.json(workflowDefinitionRepo.listVisibleForRoom(req.params.roomId));
});

// ---------- Projects ----------
router.post('/system/pick-directory', async (_req, res) => {
  try {
    res.json(await pickDirectory());
  } catch (err) {
    res.status(500).json({ error: `Unable to open folder picker: ${(err as Error).message}` });
  }
});

router.get('/projects', (_req, res) => {
  const projects = projectRepo.list();
  const enriched = projects.map((p) => ({ ...p, stats: projectRepo.stats(p.id) }));
  res.json(enriched);
});

router.post('/projects', (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    description: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const project = projectRepo.create(parsed.data);
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/projects/:id', (req, res) => {
  const project = projectRepo.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  res.json({ ...project, stats: projectRepo.stats(project.id) });
});

router.get('/files', (req, res) => {
  const parsed = z.object({
    projectId: z.string().optional(),
    roomId: z.string().optional(),
    sourceType: z.enum(['uploaded_file', 'agent_document']).optional(),
    q: z.string().trim().min(1).optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { projectId, roomId, sourceType, q } = parsed.data;
  if (projectId && !projectRepo.get(projectId)) {
    return res.status(404).json({ error: 'project not found' });
  }
  if (roomId) {
    const room = roomRepo.get(roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (projectId && room.project_id !== projectId) {
      return res.status(400).json({ error: 'room does not belong to project' });
    }
  }

  res.json(fileRepo.list({ projectId, roomId, sourceType, query: q }));
});

router.get('/projects/:projectId/files', (req, res) => {
  if (!projectRepo.get(req.params.projectId)) return res.status(404).json({ error: 'project not found' });
  const parsed = z.object({
    roomId: z.string().optional(),
    sourceType: z.enum(['uploaded_file', 'agent_document']).optional(),
    q: z.string().trim().min(1).optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.roomId) {
    const room = roomRepo.get(parsed.data.roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (room.project_id !== req.params.projectId) {
      return res.status(400).json({ error: 'room does not belong to project' });
    }
  }
  res.json(fileRepo.listByProject(req.params.projectId, parsed.data));
});

const resourceAssetTypeSchema = z.enum(['uploaded_file', 'agent_document']);
const resourceAssetGroupKeySchema = z.enum(['uploaded_files', 'agent_documents']);
const resourceAssetInputSchema = z.object({
  asset_type: resourceAssetTypeSchema,
  group_key: resourceAssetGroupKeySchema.optional(),
  title: z.string().trim().min(1),
  content: z.string().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  url: z.string().nullable().optional(),
  file_id: z.string().nullable().optional(),
  source_message_id: z.string().nullable().optional(),
  source_room_id: z.string().nullable().optional(),
  source_agent_id: z.string().nullable().optional(),
  source_task_id: z.string().nullable().optional(),
  metadata: z.union([z.record(z.unknown()), z.string(), z.null()]).optional(),
});

router.get('/projects/:projectId/resource-assets', (req, res) => {
  if (!projectRepo.get(req.params.projectId)) return res.status(404).json({ error: 'project not found' });
  const parsed = z.object({
    assetType: resourceAssetTypeSchema.optional(),
    resourceType: resourceAssetTypeSchema.optional(),
    type: resourceAssetTypeSchema.optional(),
    groupKey: resourceAssetGroupKeySchema.optional(),
    roomId: z.string().optional(),
    q: z.string().trim().min(1).optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.roomId) {
    const room = roomRepo.get(parsed.data.roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (room.project_id !== req.params.projectId) {
      return res.status(400).json({ error: 'room does not belong to project' });
    }
  }
  const assetType = resolveResourceAssetTypeFilter(parsed.data);
  if (assetType === 'conflict') {
    return res.status(400).json({ error: 'conflicting resource type filters' });
  }
  res.json(resourceAssetRepo.listResources({
    projectId: req.params.projectId,
    assetType,
    groupKey: parsed.data.groupKey as ResourceAssetGroupKey | undefined,
    roomId: parsed.data.roomId,
    query: parsed.data.q,
  }));
});

function resolveResourceAssetTypeFilter(input: {
  assetType?: ResourceAssetType;
  resourceType?: ResourceAssetType;
  type?: ResourceAssetType;
}): ResourceAssetType | undefined | 'conflict' {
  const filters = [input.assetType, input.resourceType, input.type].filter(
    (value): value is ResourceAssetType => Boolean(value),
  );
  if (filters.length === 0) return undefined;
  const [first] = filters;
  return filters.every((value) => value === first) ? first : 'conflict';
}

router.post('/projects/:projectId/resource-assets', (req, res) => {
  if (!projectRepo.get(req.params.projectId)) return res.status(404).json({ error: 'project not found' });
  const parsed = resourceAssetInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const asset = parsed.data.asset_type === 'agent_document' && parsed.data.source_message_id
      ? resourceAssetRepo.ensure({
          project_id: req.params.projectId,
          asset_type: parsed.data.asset_type,
          group_key: parsed.data.group_key,
          title: parsed.data.title,
          content: parsed.data.content,
          mime_type: parsed.data.mime_type,
          size: parsed.data.size,
          url: parsed.data.url,
          file_id: parsed.data.file_id,
          source_message_id: parsed.data.source_message_id,
          source_room_id: parsed.data.source_room_id,
          source_agent_id: parsed.data.source_agent_id,
          source_task_id: parsed.data.source_task_id,
          metadata: parsed.data.metadata,
          unique_source_message_id: parsed.data.source_message_id,
        })
      : resourceAssetRepo.create({
          project_id: req.params.projectId,
          asset_type: parsed.data.asset_type,
          group_key: parsed.data.group_key,
          title: parsed.data.title,
          content: parsed.data.content,
          mime_type: parsed.data.mime_type,
          size: parsed.data.size,
          url: parsed.data.url,
          file_id: parsed.data.file_id,
          source_message_id: parsed.data.source_message_id,
          source_room_id: parsed.data.source_room_id,
          source_agent_id: parsed.data.source_agent_id,
          source_task_id: parsed.data.source_task_id,
          metadata: parsed.data.metadata,
        });
    const responseAsset = resourceAssetRepo.getResource(asset.id) ?? asset;
    res.status(201).json(responseAsset);
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'project not found') return res.status(404).json({ error: message });
    res.status(400).json({ error: message });
  }
});

router.get('/resource-assets/:assetId', (req, res) => {
  const parsed = z.object({
    projectId: z.string().optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.projectId && !projectRepo.get(parsed.data.projectId)) {
    return res.status(404).json({ error: 'project not found' });
  }
  const asset = resourceAssetRepo.getResource(req.params.assetId);
  if (!asset) return res.status(404).json({ error: 'not found' });
  if (parsed.data.projectId && asset.project_id !== parsed.data.projectId) {
    return res.status(403).json({ error: 'resource does not belong to project' });
  }
  res.json(asset);
});

router.delete('/resource-assets/:assetId', (req, res) => {
  const existing = resourceAssetRepo.get(req.params.assetId);
  if (!existing || existing.asset_type === 'uploaded_file') return res.status(404).json({ error: 'not found' });
  const deleted = resourceAssetRepo.softDelete(req.params.assetId);
  res.status(deleted ? 204 : 404).end();
});

router.get('/projects/:projectId/workspace/tree', async (req, res, next) => {
  if (!requireLocalAccess(req, res)) return;
  const project = projectRepo.get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const parsed = z.object({ path: z.string().optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const workspacePath = parsed.data.path ?? '';

  try {
    const entries = await listWorkspaceDirectory(project.path, workspacePath);
    res.json({ path: workspacePath, entries });
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return res.status(workspaceFileErrorStatus(error)).json({ error: error.code });
    }
    next(error);
  }
});

router.get('/projects/:projectId/workspace/file', async (req, res, next) => {
  if (!requireLocalAccess(req, res)) return;
  const project = projectRepo.get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const parsed = z.object({ path: z.string().min(1) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const preview = await readWorkspaceFilePreview(project.path, parsed.data.path);
    return res.json(preview);
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return res.status(workspaceFileErrorStatus(error)).json({ error: error.code });
    }
    next(error);
  }
});

router.get('/projects/:projectId/workspace/search', async (req, res, next) => {
  if (!requireLocalAccess(req, res)) return;
  const project = projectRepo.get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const parsed = z.object({
    q: z.string().min(1),
    path: z.string().optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await searchWorkspaceFiles(project.path, parsed.data.q, parsed.data.path ?? '');
    res.json(result);
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return res.status(workspaceFileErrorStatus(error)).json({ error: error.code });
    }
    next(error);
  }
});

router.post('/projects/:projectId/files', (req, res, next) => {
  if (!projectRepo.get(req.params.projectId)) return res.status(404).json({ error: 'project not found' });
  projectFileUpload.array('files', MAX_MESSAGE_FILES)(req, res, (err) => {
    if (err) {
      next(err);
      return;
    }
    void handleProjectFilesUpload(req, res).catch(next);
  });
});

router.delete('/files/:fileId', async (req, res, next) => {
  try {
    const file = fileRepo.get(req.params.fileId);
    if (!file) return res.status(404).json({ error: 'not found' });
    const deleted = fileRepo.softDelete(file.id);
    if (!deleted) return res.status(404).json({ error: 'not found' });
    if (file.source_type === 'uploaded_file') {
      messageRepo.markFileAttachmentDeleted(file.id);
    }
    await unlinkProjectFileSafely(file);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

async function handleProjectFilesUpload(req: Request, res: Response): Promise<void> {
  const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
  if (files.length === 0) {
    res.status(400).json({ error: 'files is required' });
    return;
  }

  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
  if (!projectId) {
    await cleanupProjectUploadedFiles(files);
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  const uploaded = files.map((file) => fileRepo.create(buildProjectFileRecordInput(
    projectId,
    file,
    {
      uploaded_by_id: typeof req.body.uploaded_by_id === 'string' ? req.body.uploaded_by_id : null,
      uploaded_by_name: typeof req.body.uploaded_by_name === 'string' ? req.body.uploaded_by_name : null,
    },
  )));
  res.status(201).json(uploaded);
}

async function unlinkProjectFileSafely(file: ProjectFile): Promise<void> {
  const uploadRoot = resolve(projectFileUploadRoot);
  const targetPath = resolve(file.storage_path);
  const isInsideUploadRoot = targetPath !== uploadRoot && targetPath.startsWith(`${uploadRoot}${sep}`);
  if (!isInsideUploadRoot) return;
  try {
    await unlink(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

router.get('/projects/:projectId/memories/search', (req, res) => {
  const schema = z.object({
    query: z.string().optional(),
    roomId: z.string().optional(),
    scope: z.enum(['project', 'room', 'task']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    includeArchived: z.enum(['1', 'true']).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    res.json(memoryRepo.search({
      projectId: req.params.projectId,
      query: parsed.data.query,
      roomId: parsed.data.roomId,
      scope: parsed.data.scope,
      limit: parsed.data.limit,
      includeArchived: Boolean(parsed.data.includeArchived),
    }));
  } catch (err) {
    const error = err as Error;
    if (error.message === 'project_id is invalid') return res.status(404).json({ error: 'project not found' });
    if (!isMemoryValidationError(error)) logUnexpectedMemoryError('search failed', error);
    res.status(400).json({ error: 'invalid memory filters' });
  }
});

router.get('/projects/:projectId/memories', (req, res) => {
  if (!projectRepo.get(req.params.projectId)) return res.status(404).json({ error: 'project not found' });
  try {
    const roomAgentIds = typeof req.query.roomAgentIds === 'string'
      ? req.query.roomAgentIds.split(',').filter(Boolean)
      : undefined;
    res.json(memoryRepo.list({
      projectId: req.params.projectId,
      roomId: typeof req.query.roomId === 'string' ? req.query.roomId : undefined,
      roomAgentId: typeof req.query.roomAgentId === 'string' ? req.query.roomAgentId : undefined,
      roomAgentIds,
      taskId: typeof req.query.taskId === 'string' ? req.query.taskId : undefined,
      includeArchived: req.query.includeArchived === '1',
    }));
  } catch (err) {
    const error = err as Error;
    if (!isMemoryValidationError(error)) logUnexpectedMemoryError('list failed', error);
    res.status(400).json({ error: 'invalid memory filters' });
  }
});

router.post('/projects/:projectId/memories', (req, res) => {
  const parsed = memoryInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const scopeCheck = validateMemoryScope({
    projectId: req.params.projectId,
    scope: parsed.data.scope,
    room_id: parsed.data.room_id,
    room_agent_id: parsed.data.room_agent_id,
    task_id: parsed.data.task_id,
  });
  if (!scopeCheck.ok) return res.status(scopeCheck.status).json({ error: scopeCheck.error });
  try {
    const memory = memoryRepo.create({
      project_id: req.params.projectId,
      room_id: scopeCheck.room_id,
      room_agent_id: parsed.data.room_agent_id ?? null,
      task_id: parsed.data.task_id ?? null,
      scope: parsed.data.scope,
      memory_type: parsed.data.memory_type,
      title: parsed.data.title,
      content: parsed.data.content,
      source_type: parsed.data.source_type ?? 'manual',
      source_id: parsed.data.source_id ?? null,
      pinned: parsed.data.pinned ?? false,
    });
    res.status(201).json(memory);
  } catch (err) {
    const error = err as Error;
    if (isMemoryConflictError(error)) {
      return res.status(409).json({ error: 'memory source already exists' });
    }
    if (isMemoryValidationError(error)) {
      return res.status(400).json({ error: 'invalid memory scope' });
    }
    logUnexpectedMemoryError('create failed', error);
    res.status(500).json({ error: 'failed to create memory' });
  }
});

router.patch('/projects/:projectId/memories/:id', (req, res) => {
  const schema = memoryInputSchema.pick({
    memory_type: true,
    title: true,
    content: true,
    pinned: true,
  }).partial();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const memory = memoryRepo.get(req.params.id);
  if (!memory || memory.project_id !== req.params.projectId) return res.status(404).json({ error: 'not found' });
  const updated = memoryRepo.update(req.params.id, parsed.data);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

router.patch('/projects/:projectId/memories/:id/archive', (req, res) => {
  const memory = memoryRepo.get(req.params.id);
  if (!memory || memory.project_id !== req.params.projectId) return res.status(404).json({ error: 'not found' });
  const archived = req.body.archived !== false;
  const updated = memoryRepo.archive(req.params.id, archived);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

router.delete('/projects/:projectId/memories/:id', (req, res) => {
  const memory = memoryRepo.get(req.params.id);
  if (!memory || memory.project_id !== req.params.projectId) return res.status(404).end();
  const ok = memoryRepo.delete(req.params.id);
  res.status(ok ? 204 : 404).end();
});

router.patch('/memories/:id', (_req, res) => {
  res.status(410).json({ error: 'project-scoped memory route required' });
});

router.delete('/memories/:id', (_req, res) => {
  res.status(410).json({ error: 'project-scoped memory route required' });
});

router.patch('/projects/:id', (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = projectRepo.update(req.params.id, parsed.data);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

router.put('/projects/:id/routing', (req, res) => {
  const schema = z
    .object({
      message_routing_mode: z.enum(['mentions_only', 'fallback_reply']),
      fallback_agent_id: z.string().min(1).nullable().optional(),
    })
    .refine(
      (value) =>
        value.message_routing_mode === 'mentions_only' || Boolean(value.fallback_agent_id),
      { message: 'fallback_agent_id is required unless message_routing_mode is mentions_only' },
    );
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = projectRepo.updateRouting(req.params.id, {
    message_routing_mode: parsed.data.message_routing_mode,
    fallback_agent_id:
      parsed.data.message_routing_mode === 'mentions_only'
        ? null
        : parsed.data.fallback_agent_id ?? null,
  });
  if (!updated) return res.status(404).json({ error: 'not found' });
  settingsRepo.updateProject(req.params.id, {
    message_routing_mode: parsed.data.message_routing_mode,
    fallback_agent_id:
      parsed.data.message_routing_mode === 'mentions_only'
        ? null
        : parsed.data.fallback_agent_id ?? null,
  });
  res.json(updated);
});

router.delete('/projects/:id', (req, res) => {
  const result = projectRepo.delete(req.params.id);
  if (result.ok) return res.status(204).end();
  if (result.reason === 'not_found') return res.status(404).json({ error: 'not found' });
  return res.status(409).json({
    error: 'project has active runs',
    active_agent_run_count: result.activeAgentRunCount,
    active_workflow_run_count: result.activeWorkflowRunCount,
  });
});

// ---------- Rooms ----------
router.get('/projects/:projectId/rooms/search', async (req, res) => {
  const parsed = z.object({
    q: z.string().trim().min(1),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    res.json(await searchProjectRooms({
      projectId: req.params.projectId,
      query: parsed.data.q,
    }));
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'project not found') return res.status(404).json({ error: 'project not found' });
    if (message === 'query is required') return res.status(400).json({ error: 'query is required' });
    res.status(500).json({ error: 'room search failed' });
  }
});

router.get('/projects/:projectId/rooms', (req, res) => {
  res.json(roomRepo.listByProject(req.params.projectId));
});

router.post('/projects/:projectId/rooms', (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    crew_template_id: z.string().min(1).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const crewTemplate = parsed.data.crew_template_id
    ? getRoomCrewTemplate(parsed.data.crew_template_id)
    : getDefaultRoomCrewTemplate();
  if (!crewTemplate) return res.status(404).json({ error: 'crew template not found' });
  const room = roomRepo.create({
    project_id: req.params.projectId,
    name: parsed.data.name,
    description: parsed.data.description,
    ensureDefaultPlanner: false,
  });
  roomAgentRepo.applyCrewTemplate(room.id, crewTemplate);
  res.status(201).json(room);
});

router.get('/rooms/:id', (req, res) => {
  const room = roomRepo.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'not found' });
  res.json(room);
});

router.delete('/rooms/:id', (req, res) => {
  const ok = roomRepo.delete(req.params.id);
  res.status(ok ? 204 : 404).end();
});

// ---------- Room agents ----------
router.get('/rooms/:roomId/agents', (req, res) => {
  res.json(roomAgentRepo.listByRoom(req.params.roomId));
});

router.post('/rooms/:roomId/agents', (req, res) => {
  const schema = z.object({
    global_agent_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    agent_name: z.string().min(1).optional(),
    agent_role: z.string().optional(),
    acp_enabled: z.boolean().optional(),
    acp_backend: z.enum(['claudecode', 'opencode', 'codex']).nullable().optional(),
    acp_session_id: z.string().nullable().optional(),
    acp_session_label: z.string().nullable().optional(),
    acp_permission_mode: z.enum(['bypass', 'workspace-write', 'read-only']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!parsed.data.global_agent_id && !parsed.data.agent_id) {
    return res.status(400).json({ error: 'agent_id is required' });
  }
  if (!roomRepo.get(req.params.roomId)) {
    return res.status(404).json({ error: 'room not found' });
  }
  try {
    const agent = parsed.data.global_agent_id
      ? roomAgentRepo.addFromGlobalAgent({
        room_id: req.params.roomId,
        global_agent_id: parsed.data.global_agent_id,
      })
      : roomAgentRepo.addFromGlobalAgent({
        room_id: req.params.roomId,
        global_agent_id: agentRepo.createOrReuseFromRoomAgent({
          agent_id: parsed.data.agent_id ?? '',
          agent_name: parsed.data.agent_name ?? parsed.data.agent_id ?? '',
          agent_role: parsed.data.agent_role,
          acp_backend: parsed.data.acp_backend ?? null,
          acp_permission_mode: parsed.data.acp_permission_mode ?? 'bypass',
        }).id,
      });
    const result = parsed.data.acp_enabled === undefined
      ? agent
      : roomAgentRepo.setAcp(agent.id, {
        acp_enabled: parsed.data.acp_enabled,
        acp_backend: parsed.data.acp_backend ?? null,
        acp_session_id: parsed.data.acp_session_id ?? null,
        acp_session_label: parsed.data.acp_session_label ?? null,
        acp_permission_mode: parsed.data.acp_permission_mode ?? 'bypass',
        acp_writable_dirs: [],
      }) ?? agent;
    wsHub.broadcast(req.params.roomId, { type: 'room:agent_joined', roomId: req.params.roomId, agent: result });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/rooms/:roomId/agents/batch', (req, res) => {
  const schema = z.object({
    global_agent_ids: z.array(z.string().min(1)).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!roomRepo.get(req.params.roomId)) {
    return res.status(404).json({ error: 'room not found' });
  }
  try {
    const agents = dedupeIds(parsed.data.global_agent_ids).map((globalAgentId) =>
      roomAgentRepo.addFromGlobalAgent({
        room_id: req.params.roomId,
        global_agent_id: globalAgentId,
      }),
    );
    for (const agent of agents) {
      wsHub.broadcast(req.params.roomId, { type: 'room:agent_joined', roomId: req.params.roomId, agent });
    }
    res.status(201).json(agents);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/rooms/:roomId/agents/from-template', (req, res) => {
  const schema = z.object({
    template_id: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const template = listBuiltInAgentTemplates().find((item) => item.id === parsed.data.template_id);
  if (!template) return res.status(404).json({ error: 'template not found' });

  try {
    const globalAgent = agentRepo.createOrReuseFromRoomAgent({
      agent_id: template.id,
      agent_name: template.name,
      agent_role: template.description,
      acp_backend: template.acp_backend,
      acp_permission_mode: 'bypass',
    });
    const agent = roomAgentRepo.addFromGlobalAgent({
      room_id: req.params.roomId,
      global_agent_id: globalAgent.id,
    });
    const result = roomAgentRepo.applyBuiltInTemplate(agent.id, template.id) ?? agent;

    wsHub.broadcast(result.room_id, { type: 'room:agent_joined', roomId: result.room_id, agent: result });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete('/rooms/:roomId/agents/:agentId', (req, res) => {
  const schema = z.object({
    task_action: z.enum(['unassign', 'transfer']).optional(),
    transfer_to_room_agent_id: z.string().min(1).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const agent = roomAgentRepo.get(req.params.agentId);
  if (!agent || agent.room_id !== req.params.roomId) return res.status(404).end();
  if (agent.global_agent_id) {
    const globalAgent = agentRepo.get(agent.global_agent_id);
    if (globalAgent?.builtin_key === 'planner') {
      return res.status(409).json({ error: 'planner agent cannot be removed' });
    }
  }
  const impact = roomAgentRepo.getRemovalImpact(req.params.agentId);
  if (impact.active_run_count > 0) {
    return res.status(409).json({ error: 'agent has active runs', ...impact });
  }
  if (impact.open_task_count > 0) {
    if (!parsed.data.task_action) {
      return res.status(409).json({ error: 'agent has open tasks', ...impact });
    }
    if (parsed.data.task_action === 'unassign') {
      taskRepo.unassignOpenByAgent(req.params.agentId);
    } else {
      const targetId = parsed.data.transfer_to_room_agent_id;
      const target = targetId ? roomAgentRepo.get(targetId) : undefined;
      if (!target || target.room_id !== req.params.roomId || target.left_at) {
        return res.status(400).json({ error: 'transfer target is invalid' });
      }
      taskRepo.transferOpenByAgent(req.params.agentId, target.id);
    }
  }

  const ok = roomAgentRepo.remove(req.params.agentId);
  if (ok) {
    wsHub.broadcast(req.params.roomId, {
      type: 'room:agent_left',
      roomId: req.params.roomId,
      roomAgentId: req.params.agentId,
    });
  }
  res.status(ok ? 204 : 404).end();
});

router.put('/rooms/:roomId/agents/:agentId/acp', (req, res) => {
  const schema = z.object({
    acp_enabled: z.boolean(),
    acp_backend: z.enum(['claudecode', 'opencode', 'codex']).nullable(),
    acp_session_id: z.string().nullable(),
    acp_session_label: z.string().nullable().optional(),
    acp_permission_mode: z.enum(['bypass', 'workspace-write', 'read-only']).optional(),
  }).merge(roomAgentRuntimeBoundarySchema);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const existing = roomAgentRepo.get(req.params.agentId);
  if (!existing || existing.room_id !== req.params.roomId) return res.status(404).json({ error: 'not found' });
  const withAcp = roomAgentRepo.setAcp(req.params.agentId, {
    acp_enabled: parsed.data.acp_enabled,
    acp_backend: parsed.data.acp_backend,
    acp_session_id: parsed.data.acp_session_id,
    acp_session_label: parsed.data.acp_session_label ?? null,
    acp_permission_mode: parsed.data.acp_permission_mode ?? 'bypass',
    acp_writable_dirs: [],
  });
  if (!withAcp) return res.status(404).json({ error: 'not found' });
  const updated = roomAgentRepo.setCapabilitiesAndRuntime(req.params.agentId, {
    capabilities: withAcp.capabilities,
    default_runtime: withAcp.default_runtime,
    runtime_backend: parsed.data.runtime_backend as AgentRuntimeBackend | null | undefined,
    tool_policy: parsed.data.tool_policy as AgentToolPolicy | null | undefined,
    workspace_policy: parsed.data.workspace_policy as AgentWorkspacePolicy | null | undefined,
    memory_scope: parsed.data.memory_scope as AgentMemoryScope | null | undefined,
    memory_max_context_chars: parsed.data.memory_max_context_chars,
  });
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

router.patch('/rooms/:roomId/agents/:agentId/workflow-role', (req, res) => {
  const schema = z.object({
    workflow_role: z.enum(['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor']).nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const existing = roomAgentRepo.get(req.params.agentId);
  if (!existing || existing.room_id !== req.params.roomId) return res.status(404).json({ error: 'not found' });
  const updated = roomAgentRepo.setWorkflowRole(
    req.params.agentId,
    parsed.data.workflow_role as WorkflowRole | null,
  );
  if (!updated) return res.status(404).json({ error: 'not found' });
  wsHub.broadcast(updated.room_id, { type: 'room:agent_joined', roomId: updated.room_id, agent: updated });
  res.json(updated);
});

// ---------- ACP sessions list ----------
router.get('/projects/:projectId/acp-sessions', async (req, res) => {
  const project = projectRepo.get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const backend = req.query.backend as AcpBackend | undefined;
  if (!backend) return res.status(400).json({ error: 'backend query param required' });
  if (!['claudecode', 'opencode', 'codex'].includes(backend))
    return res.status(400).json({ error: 'invalid backend' });
  try {
    const sessions = await getAdapter(backend).listSessions(project.path);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------- Messages ----------
router.get('/rooms/:roomId/messages', (req, res) => {
  res.json(messageRepo.listByRoom(req.params.roomId));
});

router.get('/rooms/:roomId/agent-runs', (req, res) => {
  res.json(agentRunRepo.listByRoom(req.params.roomId));
});

router.post('/agent-runs/:id/cancel', (req, res) => {
  const run = agentRunRepo.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status !== 'running' && run.status !== 'queued') return res.json(run);
  const cancelled = runRegistry.cancel(req.params.id);
  if (!cancelled) return res.status(409).json({ error: 'run is not active' });
  const updated = agentRunRepo.updateStatus(req.params.id, 'cancelled');
  if (updated) {
    wsHub.broadcast(updated.room_id, {
      type: 'agent_run:updated',
      roomId: updated.room_id,
      run: updated,
    });
  }
  res.json(updated);
});

const jsonMessageSchema = z.object({
  content: z.string().default(''),
  sender_id: z.string().default('user'),
  sender_name: z.string().optional(),
  mentions: z.array(z.string()).optional(),
  fileIds: z.array(z.string()).optional(),
  reply_to_message_id: z.string().trim().min(1).optional(),
});

const multipartMessageSchema = z.object({
  content: z.string().default(''),
  sender_id: z.string().default('user'),
  sender_name: z.string().optional(),
  mentions: z.string().optional(),
  fileIds: z.string().optional(),
  reply_to_message_id: z.string().optional(),
});

router.post('/rooms/:roomId/messages', (req, res, next) => {
  if (req.is('multipart/form-data')) {
    const room = roomRepo.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    (req as Request & { projectIdForUpload?: string }).projectIdForUpload = room.project_id;
    roomProjectFileUpload.array('files', MAX_MESSAGE_FILES)(req, res, (err) => {
      if (err) {
        next(err);
        return;
      }
      void handleMultipartMessage(req, res).catch(next);
    });
    return;
  }
  void handleJsonMessage(req, res).catch(next);
});

async function handleJsonMessage(req: Request, res: Response): Promise<void> {
  const roomId = Array.isArray(req.params.roomId) ? req.params.roomId[0] : req.params.roomId;
  if (!roomId) {
    res.status(400).json({ error: 'roomId is required' });
    return;
  }

  const parsed = jsonMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const content = parsed.data.content.trim();
  const fileIds = dedupeIds(parsed.data.fileIds ?? []);
  if (content.length === 0 && fileIds.length === 0) {
    res.status(400).json({ error: 'content or files is required' });
    return;
  }

  const room = roomRepo.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'room not found' });
    return;
  }
  const referencedFiles = resolveActiveProjectFiles(room.project_id, fileIds);
  if (referencedFiles.length !== fileIds.length) {
    res.status(400).json({ error: 'invalid fileIds' });
    return;
  }

  let metadata: MessageMetadata | undefined;
  try {
    metadata = buildUserMessageMetadata({
      roomId,
      attachments: referencedFiles.map(buildAttachmentMetadataFromProjectFile),
      replyToMessageId: parsed.data.reply_to_message_id,
    });
  } catch (err) {
    const error = err as Error & { status?: number };
    res.status(error.status ?? 400).json({ error: error.message });
    return;
  }
  const userMsg = createAndDispatchUserMessage({
    roomId,
    senderId: parsed.data.sender_id,
    senderName: parsed.data.sender_name,
    content,
    mentions: parsed.data.mentions,
    metadata,
  });
  recordMessageFileRefs(room.project_id, roomId, userMsg.id, referencedFiles);
  if (userMsg.commandError) {
    res.status(userMsg.commandError.status).json({ error: userMsg.commandError.message });
    return;
  }
  res.status(201).json(userMsg);
}

async function handleMultipartMessage(req: Request, res: Response): Promise<void> {
  const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
  try {
    const roomId = Array.isArray(req.params.roomId) ? req.params.roomId[0] : req.params.roomId;
    if (!roomId) {
      await cleanupProjectUploadedFiles(files);
      res.status(400).json({ error: 'roomId is required' });
      return;
    }
    const room = roomRepo.get(roomId);
    if (!room) {
      await cleanupProjectUploadedFiles(files);
      res.status(404).json({ error: 'room not found' });
      return;
    }
    const parsed = multipartMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      await cleanupProjectUploadedFiles(files);
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const content = parsed.data.content.trim();
    let fileIds: string[];
    try {
      fileIds = parseMultipartFileIds(parsed.data.fileIds);
    } catch (err) {
      await cleanupProjectUploadedFiles(files);
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    if (content.length === 0 && files.length === 0 && fileIds.length === 0) {
      await cleanupProjectUploadedFiles(files);
      res.status(400).json({ error: 'content or files is required' });
      return;
    }

    const uniqueFileIds = dedupeIds(fileIds);
    if (files.length + uniqueFileIds.length > MAX_MESSAGE_FILES) {
      await cleanupProjectUploadedFiles(files);
      res.status(400).json({ error: 'too many files' });
      return;
    }

    const referencedFiles = resolveActiveProjectFiles(room.project_id, uniqueFileIds);
    if (referencedFiles.length !== uniqueFileIds.length) {
      await cleanupProjectUploadedFiles(files);
      res.status(400).json({ error: 'invalid fileIds' });
      return;
    }
    let mentions: string[] | undefined;
    try {
      mentions = parseMultipartMentions(parsed.data.mentions);
    } catch (err) {
      await cleanupProjectUploadedFiles(files);
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const uploadedFiles = files.map((file) => fileRepo.create(buildProjectFileRecordInput(
      room.project_id,
      file,
      {
        uploaded_by_id: parsed.data.sender_id,
        uploaded_by_name: parsed.data.sender_name ?? 'You',
      },
    )));
    const messageFiles = [...uploadedFiles, ...referencedFiles];
    const replyToMessageId = normalizeOptionalId(parsed.data.reply_to_message_id);
    let metadata: MessageMetadata | undefined;
    try {
      metadata = buildUserMessageMetadata({
        roomId,
        attachments: messageFiles.map(buildAttachmentMetadataFromProjectFile),
        replyToMessageId,
      });
    } catch (err) {
      await cleanupProjectUploadedFiles(files);
      const error = err as Error & { status?: number };
      res.status(error.status ?? 400).json({ error: error.message });
      return;
    }
    const userMsg = createAndDispatchUserMessage({
      roomId,
      senderId: parsed.data.sender_id,
      senderName: parsed.data.sender_name,
      content,
      mentions,
      metadata,
    });
    recordMessageFileRefs(room.project_id, roomId, userMsg.id, messageFiles);
    if (userMsg.commandError) {
      res.status(userMsg.commandError.status).json({ error: userMsg.commandError.message });
      return;
    }
    res.status(201).json(userMsg);
  } catch (err) {
    await cleanupProjectUploadedFiles(files);
    throw err;
  }
}

function resolveActiveProjectFiles(projectId: string, fileIds: string[]): ProjectFile[] {
  if (fileIds.length === 0) return [];
  const files = fileRepo.listActiveByIds(projectId, fileIds);
  const byId = new Map(files.map((file) => [file.id, file]));
  return fileIds.map((id) => byId.get(id)).filter((file): file is ProjectFile => Boolean(file));
}

function recordMessageFileRefs(projectId: string, roomId: string, messageId: string, files: ProjectFile[]): void {
  if (files.length === 0) return;
  fileRepo.addMessageRefs({
    project_id: projectId,
    room_id: roomId,
    message_id: messageId,
    file_ids: files.map((file) => file.id),
  });
}

function buildUserMessageMetadata(input: {
  roomId: string;
  attachments: MessageMetadata['attachments'];
  replyToMessageId?: string;
}): MessageMetadata | undefined {
  const metadata: MessageMetadata = {};
  if (input.attachments && input.attachments.length > 0) {
    metadata.attachments = input.attachments;
  }
  const replyToMessageId = normalizeOptionalId(input.replyToMessageId);
  if (replyToMessageId) {
    const replyTarget = messageRepo.get(replyToMessageId);
    if (!replyTarget || replyTarget.room_id !== input.roomId) {
      const error = new Error('reply_to_message_id not found in room') as Error & { status?: number };
      error.status = 400;
      throw error;
    }
    metadata.reply_to = {
      message_id: replyTarget.id,
      sender_type: replyTarget.sender_type,
      sender_id: replyTarget.sender_id,
      sender_name: replyTarget.sender_name,
      excerpt: summarizeReplyExcerpt(replyTarget.content),
    };
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeOptionalId(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function summarizeReplyExcerpt(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '空消息';
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177).trimEnd()}...`;
}

function createAndDispatchUserMessage(input: {
  roomId: string;
  senderId: string;
  senderName?: string;
  content: string;
  mentions?: string[];
  metadata?: MessageMetadata;
}): ReturnType<typeof messageRepo.create> & { commandError?: { status: number; message: string } } {
  const userMsg = messageRepo.create({
    room_id: input.roomId,
    sender_type: 'user',
    sender_id: input.senderId,
    sender_name: input.senderName ?? 'You',
    content: input.content,
    message_type: 'text',
    metadata: input.metadata as Record<string, unknown> | undefined,
  });
  wsHub.broadcast(input.roomId, { type: 'message:new', roomId: input.roomId, message: userMsg });
  const commandResult = handleChatCommand(input.roomId, userMsg);
  if (commandResult.handled) {
    if (commandResult.error) {
      return { ...userMsg, commandError: commandResult.error };
    }
    return userMsg;
  }
  // 这里是用户消息落库后触发智能体继续回复的最小入口。
  const agents = roomAgentRepo.listByRoom(input.roomId);
  const mentionedAgentRoomIds = resolveMentionedAgentRoomIds({
    content: input.content,
    agents,
    explicitRoomAgentIds: input.mentions,
  });
  // Fire-and-forget dispatch
  void dispatchUserMessage({
    roomId: input.roomId,
    userMessage: userMsg,
    mentionedAgentRoomIds,
  });
  return userMsg;
}

function handleChatCommand(
  roomId: string,
  userMessage: ReturnType<typeof messageRepo.create>,
): { handled: false } | { handled: true; error?: { status: number; message: string } } {
  try {
    const taskTitle = parseTaskCommand(userMessage.content);
    if (taskTitle) {
      createTaskWithConversation({
        roomId,
        origin: 'slash_command',
        createUserMessage: false,
        sourceMessageId: userMessage.id,
        taskInput: { title: taskTitle },
      });
      return { handled: true };
    }

    const taskId = parseStartTaskCommand(userMessage.content);
    if (taskId) {
      startWorkflowWithConversation({
        roomId,
        taskId,
        source: 'chat_command',
        sourceMessageId: userMessage.id,
        content: userMessage.content,
      });
      return { handled: true };
    }
  } catch (err) {
    const error = err as Error & { status?: number };
    return {
      handled: true,
      error: {
        status: error.status ?? workflowErrorStatus(error),
        message: error.message,
      },
    };
  }

  return { handled: false };
}

function parseTaskCommand(content: string): string | null {
  const match = content.match(/^\/task\s+(.+)$/i);
  const title = match?.[1]?.trim();
  return title || null;
}

function parseStartTaskCommand(content: string): string | null {
  const slashMatch = content.match(/^\/start-task\s+(\S+)$/i);
  if (slashMatch?.[1]) return slashMatch[1].trim();

  const chineseMatch = content.match(/^开始任务\s*#?(\S+)$/);
  return chineseMatch?.[1]?.trim() || null;
}

function parseMultipartMentions(rawMentions?: string): string[] | undefined {
  if (rawMentions === undefined) return undefined;
  const trimmed = rawMentions.trim();
  if (!trimmed) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('mentions must be a JSON array');
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('mentions must be a JSON array of strings');
  }
  return parsed;
}

function parseMultipartFileIds(rawFileIds?: string): string[] {
  if (rawFileIds === undefined) return [];
  const trimmed = rawFileIds.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('fileIds must be a JSON array');
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('fileIds must be a JSON array of strings');
  }
  return parsed;
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

const taskCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  interaction_mode: z.enum(['ask_user', 'auto_recommended']).optional(),
  assigned_agent_id: z.string().optional(),
  parent_task_id: z.string().optional(),
});

const conversationTaskCreateSchema = taskCreateSchema.extend({
  origin: z.enum(['manual', 'slash_command', 'chat_plan']).default('manual'),
  sender_id: z.string().default('user'),
  sender_name: z.string().optional(),
  user_message: z.string().optional(),
  source_message_id: z.string().trim().min(1).nullable().optional(),
});

const workflowStartConversationSchema = z.object({
  content: z.string().optional(),
  sender_id: z.string().optional(),
  sender_name: z.string().optional(),
  source_message_id: z.string().trim().min(1).optional(),
  source: z.enum(['chat_command', 'task_button', 'auto_start']),
});

const workflowApprovalConversationSchema = z.object({
  content: z.string().optional(),
  sender_id: z.string().optional(),
  sender_name: z.string().optional(),
  source: z.enum(['approval_button']).default('approval_button'),
});

const collaborationDecisionSchema: z.ZodType<CollaborationDecision> = z.object({
  intent: z.enum(['question', 'analysis', 'implementation']),
  recommendedMode: z.enum(['chat_collaboration', 'formal_workflow']),
  problemArea: z.enum(['frontend', 'backend', 'fullstack', 'unknown']),
  summary: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  needsUserChoice: z.boolean(),
  proposedAgents: z.object({
    executors: z.array(z.string().trim().min(1)),
    reviewers: z.array(z.string().trim().min(1)),
    testers: z.array(z.string().trim().min(1)),
    acceptors: z.array(z.string().trim().min(1)),
  }),
  stages: z.array(z.object({
    stage: z.enum(COLLABORATION_STAGES),
    agentIds: z.array(z.string().trim().min(1)),
    parallel: z.boolean(),
    goal: z.string().trim().min(1),
  })),
});

const collaborationStartSchema = z.object({
  source_message_id: z.string().trim().min(1),
  decision: collaborationDecisionSchema,
});

router.post('/rooms/:roomId/collaborations', (req, res) => {
  const parsed = collaborationStartSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const room = roomRepo.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const project = projectRepo.get(room.project_id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const sourceMessage = messageRepo.get(parsed.data.source_message_id);
  if (!sourceMessage || sourceMessage.room_id !== room.id) {
    return res.status(404).json({ error: 'source message not found' });
  }

  const dedupeKey = `${room.id}:${sourceMessage.id}`;
  const existingRun = collaborationRunsBySource.get(dedupeKey);
  if (existingRun) {
    return res.status(202).json({ run: existingRun });
  }

  const run = {
    id: nanoid(16),
    room_id: room.id,
    source_message_id: sourceMessage.id,
    status: 'running' as const,
  };
  collaborationRunsBySource.set(dedupeKey, run);
  const runCollaborationStages =
    collaborationRouteDeps.runCollaborationStages ?? defaultRunCollaborationStages;

  void runCollaborationStages({
    runId: run.id,
    projectPath: project.path,
    roomId: room.id,
    sourceMessage,
    decision: parsed.data.decision,
  })
    .then((result) => {
      collaborationRunsBySource.set(dedupeKey, {
        id: run.id,
        room_id: room.id,
        source_message_id: sourceMessage.id,
        status: result.status,
      });
    })
    .catch((err) => {
      console.warn(`[collaboration-routes] collaboration ${run.id} failed: ${formatUnknownError(err)}`);
      collaborationRunsBySource.set(dedupeKey, {
        id: run.id,
        room_id: room.id,
        source_message_id: sourceMessage.id,
        status: 'blocked',
      });
    });

  return res.status(202).json({ run });
});

router.post('/rooms/:roomId/messages/:messageId/promote-to-workflow', (req, res) => {
  const room = roomRepo.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const sourceMessage = messageRepo.get(req.params.messageId);
  if (!sourceMessage || sourceMessage.room_id !== room.id) {
    return res.status(404).json({ error: 'source message not found' });
  }

  try {
    const promotion = resolvePromotedTaskSource(room.id, sourceMessage);
    const taskInput = buildPromotedTaskInput(promotion);
    const taskResult = createTaskWithConversation({
      roomId: room.id,
      origin: 'chat_plan',
      sourceMessageId: promotion.taskSourceMessage.id,
      taskInput: {
        title: taskInput.title,
        description: taskInput.description,
        interaction_mode: 'ask_user',
      },
    });
    ensurePromotedTaskCanStart(taskResult.task.id, promotion.taskSourceMessage.id);
    const task = ensurePromotedTaskHasLatestPlannerBackground(taskResult.task.id, taskInput);
    const workflow = startWorkflowWithConversation({
      roomId: room.id,
      taskId: task.id,
      source: 'task_button',
      sourceMessageId: promotion.taskSourceMessage.id,
    });
    return res.status(202).json({ task, workflow });
  } catch (err) {
    const error = err as Error & { status?: number };
    return res.status(error.status ?? workflowErrorStatus(error)).json({ error: error.message });
  }
});

function ensurePromotedTaskCanStart(taskId: string, sourceMessageId: string) {
  const task = taskRepo.get(taskId);
  if (!task) throw workflowPromotionError(404, 'task not found');
  if (isWorkflowStartedBySourceMessage(task.room_id, task.id, sourceMessageId)) return;
  const active = workflowRepo.getActiveByTask(task.id);
  if (active) {
    throw workflowPromotionError(409, 'task already has an active workflow');
  }
  if (task.status === 'done') {
    throw workflowPromotionError(409, 'task is already completed');
  }
}

function isWorkflowStartedBySourceMessage(roomId: string, taskId: string, sourceMessageId: string): boolean {
  const row = db.prepare(
    `SELECT id FROM messages
     WHERE room_id = ?
       AND metadata IS NOT NULL
       AND json_valid(metadata)
       AND json_extract(metadata, '$.event_type') = 'workflow_started'
       AND json_extract(metadata, '$.task_id') = ?
       AND json_extract(metadata, '$.workflow_source_message_id') = ?
     LIMIT 1`,
  ).get(roomId, taskId, sourceMessageId) as { id: string } | undefined;
  return Boolean(row);
}

interface PromotedTaskSource {
  triggerMessage: NonNullable<ReturnType<typeof messageRepo.get>>;
  taskSourceMessage: NonNullable<ReturnType<typeof messageRepo.get>>;
  readiness: Record<string, unknown> | null;
  decision: Record<string, unknown> | null;
}

function ensurePromotedTaskHasLatestPlannerBackground(
  taskId: string,
  taskInput: { title: string; description: string },
) {
  const task = taskRepo.get(taskId);
  if (!task) throw workflowPromotionError(404, 'task not found');
  if (task.description === taskInput.description && task.title === taskInput.title) return task;
  if (!taskInput.description.includes('产品经理方案背景：')) return task;
  const updated = taskRepo.update(task.id, {
    title: taskInput.title,
    description: taskInput.description,
    interaction_mode: 'ask_user',
  });
  return updated ?? task;
}

function resolvePromotedTaskSource(
  roomId: string,
  triggerMessage: NonNullable<ReturnType<typeof messageRepo.get>>,
): PromotedTaskSource {
  const metadata = parseMessageMetadataObject(triggerMessage.metadata);
  const readiness = parseMessageMetadataObject(metadata?.task_readiness);
  const decision = parseMessageMetadataObject(metadata?.collaboration_decision)
    ?? parseMessageMetadataObject(metadata?.decision);
  const readinessSourceMessageId = firstNonEmptyString([readiness?.source_message_id]);
  if (!readinessSourceMessageId) {
    if (!readiness || isFormalWorkflowReadiness(readiness)) {
      return { triggerMessage, taskSourceMessage: triggerMessage, readiness, decision };
    }
    throw workflowPromotionError(
      400,
      'analysis-only readiness cannot be promoted to workflow without an original user source message',
    );
  }

  const taskSourceMessage = messageRepo.get(readinessSourceMessageId);
  if (!taskSourceMessage || taskSourceMessage.room_id !== roomId) {
    throw workflowPromotionError(404, 'source message not found');
  }
  return { triggerMessage, taskSourceMessage, readiness, decision };
}

function buildPromotedTaskInput(promotion: PromotedTaskSource): {
  title: string;
  description: string;
} {
  const { triggerMessage, taskSourceMessage, readiness, decision } = promotion;
  const rawTitle = firstNonEmptyString([
    taskSourceMessage.content.split(/\r?\n/)[0],
    taskSourceMessage.content,
    isFormalWorkflowReadiness(readiness) ? readiness?.title : null,
    decision?.summary,
  ]);
  const title = truncateTitle(rawTitle || '从群聊创建的工作流任务');
  const baseDescription = firstNonEmptyString([taskSourceMessage.content]) ?? title;
  const executionIntent = parseTaskExecutionIntent(readiness?.execution_intent);
  const plannerBackground = isFormalWorkflowReadiness(readiness)
    ? buildPlannerBackground(triggerMessage, readiness)
    : null;
  const description = [
    baseDescription,
    plannerBackground,
    isImplementationIntent(executionIntent) ? `任务意图：${executionIntent}` : null,
  ].filter(Boolean).join('\n\n');
  return { title, description };
}

function buildPlannerBackground(
  triggerMessage: NonNullable<ReturnType<typeof messageRepo.get>>,
  readiness: Record<string, unknown> | null,
): string | null {
  const background = firstNonEmptyString([
    readiness?.description,
    triggerMessage.content,
  ]);
  return background ? `产品经理方案背景：\n${background}` : null;
}

function isFormalWorkflowReadiness(readiness: Record<string, unknown> | null): boolean {
  const executionIntent = parseTaskExecutionIntent(readiness?.execution_intent);
  return readiness?.recommended_mode === 'formal_workflow' || isImplementationIntent(executionIntent);
}

function isImplementationIntent(intent: TaskExecutionIntent | null): boolean {
  return intent === 'implementation' || intent === 'debug_fix';
}

function workflowPromotionError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function parseTaskExecutionIntent(value: unknown): TaskExecutionIntent | null {
  if (
    value === 'analysis_only' ||
    value === 'planning_only' ||
    value === 'documentation_only' ||
    value === 'implementation' ||
    value === 'debug_fix' ||
    value === 'review_only'
  ) {
    return value;
  }
  return null;
}

function parseMessageMetadataObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function truncateTitle(value: string): string {
  return value.length <= 160 ? value : value.slice(0, 157).trimEnd() + '...';
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized) return serialized;
  } catch {
    // Fall through to String() below.
  }
  return String(error);
}

// ---------- Workflows ----------
router.post('/tasks/:id/workflows', async (req, res) => {
  try {
    if (getLangGraphWorkflowConfig().enabled) {
      const task = taskRepo.get(req.params.id);
      if (!task) return res.status(404).json({ error: 'task not found' });
      const workflow = startWorkflowWithConversation({
        roomId: task.room_id,
        taskId: task.id,
        source: 'task_button',
      });
      return res.status(202).json(workflow);
    }
    const workflow = await workflowOrchestrator.start(req.params.id);
    return res.status(201).json(workflow);
  } catch (err) {
    const error = err as Error & { status?: number };
    return res.status(error.status ?? workflowErrorStatus(error)).json({ error: error.message });
  }
});

router.post('/rooms/:roomId/tasks/:taskId/workflows/start-with-conversation', (req, res) => {
  const parsed = workflowStartConversationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const workflow = startWorkflowWithConversation({
      roomId: req.params.roomId,
      taskId: req.params.taskId,
      content: parsed.data.content,
      senderId: parsed.data.sender_id,
      senderName: parsed.data.sender_name,
      sourceMessageId: parsed.data.source_message_id,
      source: parsed.data.source,
    });
    res.status(202).json(workflow);
  } catch (err) {
    const error = err as Error & { status?: number };
    res.status(error.status ?? workflowErrorStatus(error)).json({ error: error.message });
  }
});

router.get('/tasks/:id/workflows', (req, res) => {
  res.json(workflowRepo.listByTask(req.params.id));
});

router.get('/workflows/:id', (req, res) => {
  const detail = workflowOrchestrator.detail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'not found' });
  res.json(detail);
});

router.get('/workflows/:id/context', (req, res) => {
  const workflow = workflowRepo.getRun(req.params.id);
  if (!workflow) return res.status(404).json({ error: 'not found' });
  const entries = workflowContextRepo.listByWorkflow(workflow.id);
  res.json({
    entries,
    total_token_estimate: entries.reduce((sum, entry) => sum + entry.token_estimate, 0),
    total_summary_chars: entries.reduce((sum, entry) => sum + entry.summary_char_count, 0),
  });
});

router.post('/workflows/:id/approve-plan', async (req, res) => {
  try {
    const existing = workflowRepo.getRun(req.params.id);
    if (getLangGraphWorkflowConfig().enabled && existing?.graph_version) {
      const workflow = approveWorkflowPlanWithConversation({
        roomId: existing.room_id,
        workflowId: existing.id,
        source: 'approval_button',
      });
      return res.status(202).json(workflow);
    }
    const workflow = await workflowOrchestrator.approvePlan(req.params.id, 'user');
    return res.json(workflow);
  } catch (err) {
    const error = err as Error & { status?: number };
    return res.status(error.status ?? workflowErrorStatus(error)).json({ error: error.message });
  }
});

router.post('/rooms/:roomId/workflows/:workflowId/approve-plan-with-conversation', (req, res) => {
  const parsed = workflowApprovalConversationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const workflow = approveWorkflowPlanWithConversation({
      roomId: req.params.roomId,
      workflowId: req.params.workflowId,
      content: parsed.data.content,
      senderId: parsed.data.sender_id,
      senderName: parsed.data.sender_name,
      source: parsed.data.source,
    });
    res.status(202).json(workflow);
  } catch (err) {
    const error = err as Error & { status?: number };
    res.status(error.status ?? workflowErrorStatus(error)).json({ error: error.message });
  }
});

router.post('/workflows/:id/decisions', async (req, res) => {
  const schema = z.object({
    answers: z.array(
      z.object({
        decisionId: z.string().min(1),
        optionId: z.string().min(1),
      }),
    ),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const workflow = await workflowOrchestrator.submitDecisions(req.params.id, parsed.data.answers, 'user');
    res.json(workflow);
  } catch (err) {
    const error = err as Error;
    res.status(workflowErrorStatus(error)).json({ error: error.message });
  }
});

router.post('/workflows/:id/retry-step', async (req, res) => {
  try {
    const workflow = await workflowOrchestrator.retryStep(req.params.id);
    res.json(workflow);
  } catch (err) {
    const error = err as Error;
    res.status(workflowErrorStatus(error)).json({ error: error.message });
  }
});

router.post('/workflows/:id/cancel', async (req, res) => {
  try {
    const workflow = await workflowOrchestrator.cancel(req.params.id);
    res.json(workflow);
  } catch (err) {
    const error = err as Error;
    res.status(workflowErrorStatus(error)).json({ error: error.message });
  }
});

// ---------- Tasks ----------
router.get('/projects/:projectId/tasks', (req, res) => {
  res.json(taskRepo.listByProject(req.params.projectId));
});

router.get('/rooms/:roomId/tasks', (req, res) => {
  res.json(taskRepo.listByRoom(req.params.roomId));
});

router.post('/rooms/:roomId/tasks/conversation', (req, res) => {
  const parsed = conversationTaskCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = createTaskWithConversation({
      roomId: req.params.roomId,
      actor: {
        sender_id: parsed.data.sender_id,
        sender_name: parsed.data.sender_name,
      },
      origin: parsed.data.origin,
      sourceMessageId: parsed.data.source_message_id ?? null,
      userFacingContent: parsed.data.user_message,
      taskInput: {
        title: parsed.data.title,
        description: parsed.data.description,
        priority: parsed.data.priority,
        interaction_mode: parsed.data.interaction_mode,
        assigned_agent_id: parsed.data.assigned_agent_id,
        parent_task_id: parsed.data.parent_task_id,
      },
    });
    res.status(201).json(result);
  } catch (err) {
    const message = (err as Error).message;
    res.status(message === 'room not found' ? 404 : 400).json({ error: message });
  }
});

router.post('/rooms/:roomId/tasks', (req, res) => {
  const room = roomRepo.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const parsed = taskCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const task = taskRepo.create({
    room_id: req.params.roomId,
    project_id: room.project_id,
    ...parsed.data,
    interaction_mode:
      parsed.data.interaction_mode ?? settingsRepo.resolveForRoom(req.params.roomId)?.effective.interaction_mode,
  });
  wsHub.broadcast(req.params.roomId, { type: 'task:created', task });
  res.status(201).json(task);
});

router.patch('/tasks/:id', (req, res) => {
  const schema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    interaction_mode: z.enum(['ask_user', 'auto_recommended']).optional(),
    assigned_agent_id: z.string().nullable().optional(),
    status: z.enum(['todo', 'in_progress', 'review', 'done', 'failed']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  let task = taskRepo.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const before = task;
  if (parsed.data.status) task = taskRepo.updateStatus(req.params.id, parsed.data.status);
  const fieldPatch: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) fieldPatch['title'] = parsed.data.title;
  if (parsed.data.description !== undefined) fieldPatch['description'] = parsed.data.description;
  if (parsed.data.priority !== undefined) fieldPatch['priority'] = parsed.data.priority;
  if (parsed.data.interaction_mode !== undefined) fieldPatch['interaction_mode'] = parsed.data.interaction_mode;
  if (parsed.data.assigned_agent_id !== undefined)
    fieldPatch['assigned_agent_id'] = parsed.data.assigned_agent_id;
  if (Object.keys(fieldPatch).length > 0) {
    task = taskRepo.update(req.params.id, fieldPatch as never);
  }
  if (task) wsHub.broadcast(task.room_id, { type: 'task:updated', task });
  if (task && parsed.data.status && before.status !== task.status) {
    try {
      recordTaskEvent({
        roomId: task.room_id,
        taskId: task.id,
        taskTitle: task.title,
        eventType: 'task_status_changed',
        content: `任务「${task.title}」状态变更为 ${task.status}`,
      });
    } catch (error) {
      console.warn('Failed to record task status event', {
        taskId: task.id,
        roomId: task.room_id,
        error,
      });
    }
  }
  res.json(task);
});

router.delete('/tasks/:id', (req, res) => {
  const t = taskRepo.get(req.params.id);
  const ok = taskRepo.delete(req.params.id);
  if (ok && t) wsHub.broadcast(t.room_id, { type: 'task:deleted', taskId: t.id });
  res.status(ok ? 204 : 404).end();
});

router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const multerCode =
    typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
      ? err.code
      : null;

  if (multerCode === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'file too large' });
    return;
  }
  if (multerCode === 'LIMIT_FILE_COUNT' || multerCode === 'LIMIT_UNEXPECTED_FILE') {
    res.status(400).json({ error: 'too many files' });
    return;
  }
  next(err);
});
