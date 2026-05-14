import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { getAdapter } from './acp/index.js';
import { dispatchUserMessage } from './dispatcher.js';
import { listOpenClawAgentsFromCli } from './openclaw/agents.js';
import { gatewayClient } from './openclaw/gateway.js';
import { getOpenClawGatewayStatus } from './openclaw/status.js';
import { resolveMentionedAgentRoomIds } from './mentions.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { memoryRepo } from './repos/memory.js';
import { messageRepo } from './repos/messages.js';
import { projectRepo } from './repos/projects.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { settingsRepo } from './repos/settings.js';
import { taskRepo } from './repos/tasks.js';
import { workflowRepo } from './repos/workflows.js';
import { runRegistry } from './run-registry.js';
import { buildAttachmentMetadata, cleanupUploadedFiles, messageUpload } from './uploads.js';
import { workflowOrchestrator } from './workflows/orchestrator.js';
import { wsHub } from './ws-hub.js';
import type { AcpBackend, MemoryScope, MessageMetadata, MessageRoutingMode, TaskInteractionMode, WorkflowRole } from './types.js';

export const router = Router();

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

// ---------- Health & Gateway ----------
router.get('/health', async (_req, res) => {
  const gatewayStatus = await getOpenClawGatewayStatus();
  res.json({
    ok: true,
    gateway: gatewayStatus.ok,
    gatewayStatus,
    gatewayRpcConnected: gatewayClient.isConnected(),
  });
});

router.get('/gateway/agents', async (_req, res) => {
  try {
    const agents = await listOpenClawAgentsFromCli();
    res.json({ agents, connected: true, source: 'openclaw-config' });
  } catch (err) {
    res.json({ agents: [], connected: false, error: (err as Error).message });
  }
});

const settingsPatchSchema = z
  .object({
    message_routing_mode: z.enum(['mentions_only', 'fallback_reply', 'fallback_route']).nullable().optional(),
    fallback_agent_id: z.string().min(1).nullable().optional(),
    interaction_mode: z.enum(['ask_user', 'auto_recommended']).nullable().optional(),
  })
  .refine(
    (value) =>
      value.message_routing_mode === undefined ||
      value.message_routing_mode === null ||
      value.message_routing_mode === 'mentions_only' ||
      Boolean(value.fallback_agent_id),
    { message: 'fallback_agent_id is required unless message_routing_mode is mentions_only' },
  );

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

// ---------- Settings ----------
router.get('/settings/system', (_req, res) => {
  res.json(settingsRepo.getSystem());
});

router.patch('/settings/system', (req, res) => {
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(settingsRepo.updateSystem({
    message_routing_mode: parsed.data.message_routing_mode ?? undefined,
    fallback_agent_id: parsed.data.fallback_agent_id,
    interaction_mode: parsed.data.interaction_mode ?? undefined,
  }));
});

router.get('/projects/:projectId/settings', (req, res) => {
  const resolution = settingsRepo.resolveForProject(req.params.projectId);
  if (!resolution) return res.status(404).json({ error: 'not found' });
  res.json(resolution);
});

router.patch('/projects/:projectId/settings', (req, res) => {
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = settingsRepo.updateProject(req.params.projectId, parsed.data as {
    message_routing_mode?: MessageRoutingMode | null;
    fallback_agent_id?: string | null;
    interaction_mode?: TaskInteractionMode | null;
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
  const updated = settingsRepo.updateRoom(req.params.roomId, parsed.data as {
    message_routing_mode?: MessageRoutingMode | null;
    fallback_agent_id?: string | null;
    interaction_mode?: TaskInteractionMode | null;
  });
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(settingsRepo.resolveForRoom(req.params.roomId));
});

// ---------- Projects ----------
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

router.get('/projects/:projectId/memories', (req, res) => {
  if (!projectRepo.get(req.params.projectId)) return res.status(404).json({ error: 'project not found' });
  try {
    res.json(memoryRepo.list({
      projectId: req.params.projectId,
      roomId: typeof req.query.roomId === 'string' ? req.query.roomId : undefined,
      roomAgentId: typeof req.query.roomAgentId === 'string' ? req.query.roomAgentId : undefined,
      taskId: typeof req.query.taskId === 'string' ? req.query.taskId : undefined,
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
      message_routing_mode: z.enum(['mentions_only', 'fallback_reply', 'fallback_route']),
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
  const ok = projectRepo.delete(req.params.id);
  res.status(ok ? 204 : 404).end();
});

// ---------- Rooms ----------
router.get('/projects/:projectId/rooms', (req, res) => {
  res.json(roomRepo.listByProject(req.params.projectId));
});

router.post('/projects/:projectId/rooms', (req, res) => {
  const schema = z.object({ name: z.string().min(1), description: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const room = roomRepo.create({
    project_id: req.params.projectId,
    name: parsed.data.name,
    description: parsed.data.description,
  });
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
    agent_id: z.string().min(1),
    agent_name: z.string().min(1),
    agent_role: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const agent = roomAgentRepo.add({
      room_id: req.params.roomId,
      ...parsed.data,
    });
    wsHub.broadcast(req.params.roomId, { type: 'room:agent_joined', roomId: req.params.roomId, agent });
    res.status(201).json(agent);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete('/rooms/:roomId/agents/:agentId', (req, res) => {
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
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = roomAgentRepo.setAcp(req.params.agentId, {
    acp_enabled: parsed.data.acp_enabled,
    acp_backend: parsed.data.acp_backend,
    acp_session_id: parsed.data.acp_session_id,
    acp_session_label: parsed.data.acp_session_label ?? null,
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
  content: z.string().min(1),
  sender_id: z.string().default('user'),
  sender_name: z.string().optional(),
  mentions: z.array(z.string()).optional(),
});

const multipartMessageSchema = z.object({
  content: z.string().default(''),
  sender_id: z.string().default('user'),
  sender_name: z.string().optional(),
  mentions: z.string().optional(),
});

router.post('/rooms/:roomId/messages', (req, res, next) => {
  if (req.is('multipart/form-data')) {
    messageUpload.array('files', 5)(req, res, (err) => {
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
  const userMsg = createAndDispatchUserMessage({
    roomId,
    senderId: parsed.data.sender_id,
    senderName: parsed.data.sender_name,
    content: parsed.data.content,
    mentions: parsed.data.mentions,
  });
  res.status(201).json(userMsg);
}

async function handleMultipartMessage(req: Request, res: Response): Promise<void> {
  const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
  try {
    const roomId = Array.isArray(req.params.roomId) ? req.params.roomId[0] : req.params.roomId;
    if (!roomId) {
      await cleanupUploadedFiles(files);
      res.status(400).json({ error: 'roomId is required' });
      return;
    }
    const parsed = multipartMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      await cleanupUploadedFiles(files);
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const content = parsed.data.content.trim();
    if (content.length === 0 && files.length === 0) {
      await cleanupUploadedFiles(files);
      res.status(400).json({ error: 'content or files is required' });
      return;
    }

    let mentions: string[] | undefined;
    try {
      mentions = parseMultipartMentions(parsed.data.mentions);
    } catch (err) {
      await cleanupUploadedFiles(files);
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const metadata: MessageMetadata | undefined = files.length > 0
      ? { attachments: files.map((file) => buildAttachmentMetadata(file)) }
      : undefined;
    const userMsg = createAndDispatchUserMessage({
      roomId,
      senderId: parsed.data.sender_id,
      senderName: parsed.data.sender_name,
      content,
      mentions,
      metadata,
    });
    res.status(201).json(userMsg);
  } catch (err) {
    await cleanupUploadedFiles(files);
    throw err;
  }
}

function createAndDispatchUserMessage(input: {
  roomId: string;
  senderId: string;
  senderName?: string;
  content: string;
  mentions?: string[];
  metadata?: MessageMetadata;
}) {
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

// ---------- Workflows ----------
router.post('/tasks/:id/workflows', async (req, res) => {
  try {
    const workflow = await workflowOrchestrator.start(req.params.id);
    res.status(201).json(workflow);
  } catch (err) {
    const error = err as Error;
    res.status(workflowErrorStatus(error)).json({ error: error.message });
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

router.post('/workflows/:id/approve-plan', async (req, res) => {
  try {
    const workflow = await workflowOrchestrator.approvePlan(req.params.id, 'user');
    res.json(workflow);
  } catch (err) {
    const error = err as Error;
    res.status(workflowErrorStatus(error)).json({ error: error.message });
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

router.post('/rooms/:roomId/tasks', (req, res) => {
  const room = roomRepo.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const schema = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    interaction_mode: z.enum(['ask_user', 'auto_recommended']).optional(),
    assigned_agent_id: z.string().optional(),
    parent_task_id: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
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
