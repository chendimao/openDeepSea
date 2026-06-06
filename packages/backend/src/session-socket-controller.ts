import type { WebSocket } from 'ws';
import { z } from 'zod';
import { projectRepo } from './repos/projects.js';
import {
  DEFAULT_SESSION_AGENT_ID,
  sessionAgentEventRepo,
  sessionRepo,
  sessionRunRepo,
} from './repos/sessions.js';
import { sessionEvidenceRepo } from './repos/session-evidence.js';
import { runRegistry } from './run-registry.js';
import { dispatchSessionUserMessage } from './session-message-dispatch.js';
import { retrySessionAgentRun, runSessionAgent } from './session-runtime.js';
import { buildWorkspacePayload } from './session.routes.js';
import { wsHub } from './ws-hub.js';
import type { SessionRun, WsClientEvent, WsServerEvent } from './types.js';

const socketEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.workspace.request'),
    projectId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal('session.message.send'),
    sessionId: z.string().trim().min(1),
    content: z.string().trim().min(1),
    agentId: z.string().trim().min(1).optional(),
    mode: z.enum(['ask', 'plan', 'code', 'debug', 'review']).optional(),
  }),
  z.object({
    type: z.literal('agent.run.pause'),
    sessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('agent.run.resume'),
    sessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    content: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal('agent.run.cancel'),
    sessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('agent.run.retry'),
    sessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
  }),
]);

export function handleSessionSocketEvent(socket: WebSocket, event: WsClientEvent): boolean {
  const parsed = socketEventSchema.safeParse(event);
  if (!parsed.success) return false;
  try {
    if (parsed.data.type === 'session.workspace.request') {
      sendSessionWorkspaceSnapshot(socket, parsed.data.projectId, parsed.data.sessionId);
      return true;
    }
    if (parsed.data.type === 'session.message.send') {
      dispatchSessionUserMessage({
        sessionId: parsed.data.sessionId,
        content: parsed.data.content,
        agentId: parsed.data.agentId,
        mode: parsed.data.mode,
      });
      return true;
    }
    if (parsed.data.type === 'agent.run.pause') return pauseRun(parsed.data.runId);
    if (parsed.data.type === 'agent.run.resume') return resumeRun(parsed.data.runId, parsed.data.content);
    if (parsed.data.type === 'agent.run.cancel') return cancelRun(parsed.data.runId);
    if (parsed.data.type === 'agent.run.retry') return retryRun(parsed.data.runId);
    return false;
  } catch (error) {
    const sessionId = 'sessionId' in parsed.data && typeof parsed.data.sessionId === 'string' ? parsed.data.sessionId : '';
    send(socket, { type: 'session_error', sessionId, error: (error as Error).message });
    return true;
  }
}

function sendSessionWorkspaceSnapshot(socket: WebSocket, projectId: string, sessionId?: string): void {
  const project = projectRepo.get(projectId);
  if (!project) throw new Error('project not found');
  const requested = sessionId ? sessionRepo.get(sessionId) : undefined;
  if (sessionId && (!requested || requested.project_id !== project.id)) throw new Error('session not found');
  const activeSession = requested ??
    sessionRepo.listByProject(project.id).find((session) => session.status === 'active') ??
    sessionRepo.create({
      project_id: project.id,
      title: 'New Session',
      mode: 'ask',
      provider: 'codex',
      workspace_path: project.path,
    });
  send(socket, {
    type: 'session_workspace:snapshot',
    projectId: project.id,
    sessionId: activeSession.id,
    payload: buildWorkspacePayload(project, activeSession),
  });
}

function pauseRun(runId: string): boolean {
  const run = requireActiveRun(runId, ['queued', 'running', 'retrying']);
  runRegistry.pause(run.id);
  const updated = sessionRunRepo.updateStatus(run.id, 'paused', { error: 'Session run paused' });
  if (!updated) throw new Error('run not found');
  broadcastRunStopped(updated, 'paused');
  return true;
}

function cancelRun(runId: string): boolean {
  const run = requireActiveRun(runId, ['queued', 'running', 'retrying', 'paused']);
  runRegistry.cancel(run.id);
  const updated = sessionRunRepo.updateStatus(run.id, 'cancelled', { error: 'Session run cancelled' });
  if (!updated) throw new Error('run not found');
  broadcastRunStopped(updated, 'cancelled');
  return true;
}

function retryRun(runId: string): boolean {
  const run = sessionRunRepo.get(runId);
  if (!run) throw new Error('run not found');
  retrySessionAgentRun(run.id);
  const event = sessionEvidenceRepo.create({
    session_id: run.session_id,
    event_type: 'status',
    title: 'Run retry requested',
    payload: { source_run_id: run.id, agent_id: run.agent_id },
  });
  wsHub.broadcastSession(run.session_id, { type: 'session_evidence:new', sessionId: run.session_id, event });
  return true;
}

function resumeRun(runId: string, content?: string): boolean {
  const run = sessionRunRepo.get(runId);
  if (!run) throw new Error('run not found');
  if (run.status !== 'paused') throw new Error('run is not paused');
  void runSessionAgent({
    sessionId: run.session_id,
    agentId: run.agent_id || DEFAULT_SESSION_AGENT_ID,
    prompt: content ?? '继续刚才暂停的任务。',
    provider: run.provider,
    model: run.model,
  });
  return true;
}

function requireActiveRun(runId: string, statuses: SessionRun['status'][]): SessionRun {
  const run = sessionRunRepo.get(runId);
  if (!run) throw new Error('run not found');
  if (!statuses.includes(run.status)) throw new Error('run is not active');
  return run;
}

function broadcastRunStopped(run: SessionRun, status: 'paused' | 'cancelled'): void {
  wsHub.broadcastSession(run.session_id, {
    type: 'session_run:updated',
    sessionId: run.session_id,
    run,
  });
  const finalEvent = sessionAgentEventRepo.create({
    session_id: run.session_id,
    agent_id: run.agent_id,
    run_id: run.id,
    channel: 'event',
    event_type: `run_${status}`,
    content: '',
    payload: { status },
  });
  wsHub.broadcastSession(run.session_id, {
    type: 'session_run:stream',
    sessionId: run.session_id,
    agentId: run.agent_id,
    runId: run.id,
    seq: finalEvent.seq,
    chunk: '',
    channel: 'event',
    done: true,
  });
}

function send(socket: WebSocket, event: WsServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}
