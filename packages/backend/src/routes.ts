import { Router } from 'express';
import { z } from 'zod';
import { getAdapter } from './acp/index.js';
import { dispatchUserMessage } from './dispatcher.js';
import { listOpenClawAgentsFromCli } from './openclaw/agents.js';
import { gatewayClient } from './openclaw/gateway.js';
import { getOpenClawGatewayStatus } from './openclaw/status.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { messageRepo } from './repos/messages.js';
import { projectRepo } from './repos/projects.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { taskRepo } from './repos/tasks.js';
import { workflowRepo } from './repos/workflows.js';
import { runRegistry } from './run-registry.js';
import { workflowOrchestrator } from './workflows/orchestrator.js';
import { wsHub } from './ws-hub.js';
import type { AcpBackend, WorkflowRole } from './types.js';

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

router.post('/rooms/:roomId/messages', async (req, res) => {
  const schema = z.object({
    content: z.string().min(1),
    sender_id: z.string().default('user'),
    sender_name: z.string().optional(),
    mentions: z.array(z.string()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userMsg = messageRepo.create({
    room_id: req.params.roomId,
    sender_type: 'user',
    sender_id: parsed.data.sender_id,
    sender_name: parsed.data.sender_name ?? 'You',
    content: parsed.data.content,
    message_type: 'text',
  });
  wsHub.broadcast(req.params.roomId, { type: 'message:new', roomId: req.params.roomId, message: userMsg });
  // Fire-and-forget dispatch
  void dispatchUserMessage({
    roomId: req.params.roomId,
    userMessage: userMsg,
    mentionedAgentRoomIds: parsed.data.mentions,
  });
  res.status(201).json(userMsg);
});

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
