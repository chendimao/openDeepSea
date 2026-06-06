import { getAdapter } from './acp/index.js';
import type { AcpStreamChannel, AcpStreamChunk, SessionAdapter } from './acp/types.js';
import { projectRepo } from './repos/projects.js';
import { sessionEvidenceRepo } from './repos/session-evidence.js';
import {
  DEFAULT_SESSION_AGENT_ID,
  sessionAgentRuntimeRepo,
  sessionRepo,
  sessionRunRepo,
} from './repos/sessions.js';
import { runRegistry } from './run-registry.js';
import { wsHub } from './ws-hub.js';
import type {
  AcpBackend,
  AcpPermissionMode,
  Session,
  SessionEvidenceType,
  SessionRun,
  SessionRunStatus,
} from './types.js';

const STREAM_PAYLOAD_LIMIT = 8000;
const MAX_EVIDENCE_LINES = 200;

let adapterOverride: SessionAdapter | undefined;

export function setSessionRuntimeAdapterForTest(adapter?: SessionAdapter): void {
  adapterOverride = adapter;
}

export async function runSessionAgent(input: {
  sessionId: string;
  agentId?: string;
  prompt: string;
  provider: AcpBackend;
  model?: string | null;
  permissionMode?: AcpPermissionMode | null;
  imagePaths?: string[];
}): Promise<SessionRun> {
  const session = requireSession(input.sessionId);
  const project = projectRepo.get(session.project_id);
  if (!project) throw new Error(`Project not found for session ${session.id}`);
  const agentId = normalizeAgentId(input.agentId);
  const existingRuntime = sessionAgentRuntimeRepo.getByAgent(session.id, agentId, input.provider);
  const reusableAcpSessionId = existingRuntime?.provider_session_id ??
    sessionRunRepo.findReusableAcpSessionId({
      session_id: session.id,
      agent_id: agentId,
      provider: input.provider,
    });

  const run = sessionRunRepo.create({
    session_id: session.id,
    agent_id: agentId,
    provider: input.provider,
    model: input.model ?? null,
    mode: session.mode,
    phase: session.phase,
    prompt: input.prompt,
    acp_session_id: reusableAcpSessionId,
  });
  sessionAgentRuntimeRepo.upsert({
    session_id: session.id,
    agent_id: agentId,
    provider: input.provider,
    model: input.model ?? null,
    provider_session_id: reusableAcpSessionId,
    status: 'running',
    current_run_id: run.id,
  });
  const controller = runRegistry.create(run.id);
  wsHub.broadcastSession(session.id, { type: 'session_run:created', sessionId: session.id, run });

  try {
    const result = await resolveAdapter(input.provider).invoke({
      projectPath: session.worktree_path ?? session.workspace_path ?? project.path,
      sessionId: run.acp_session_id,
      prompt: input.prompt,
      acpPermissionMode: input.permissionMode ?? 'read-only',
      imagePaths: input.imagePaths ?? [],
      onSession: (acpSessionId) => {
        persistProviderSession({
          runId: run.id,
          sessionId: session.id,
          agentId,
          provider: input.provider,
          model: input.model ?? null,
          providerSessionId: acpSessionId,
          status: 'running',
        });
      },
      onChunk: (chunk) => recordSessionChunk({ sessionId: session.id, runId: run.id, chunk }),
      signal: controller.signal,
    });
    if (result.sessionId) {
      persistProviderSession({
        runId: run.id,
        sessionId: session.id,
        agentId,
        provider: input.provider,
        model: input.model ?? null,
        providerSessionId: result.sessionId,
        status: 'running',
      });
    }
    return finishSessionRun({
      runId: run.id,
      agentId,
      provider: input.provider,
      model: input.model ?? null,
      status: controller.signal.aborted ? 'cancelled' : result.exitCode === 0 ? 'completed' : 'failed',
      error: result.stderr || null,
    });
  } catch (err) {
    return finishSessionRun({
      runId: run.id,
      agentId,
      provider: input.provider,
      model: input.model ?? null,
      status: controller.signal.aborted ? 'cancelled' : 'failed',
      error: (err as Error).message,
    });
  } finally {
    runRegistry.remove(run.id);
  }
}

export function retrySessionAgentRun(runId: string): void {
  const run = sessionRunRepo.get(runId);
  if (!run) throw new Error(`Session run ${runId} not found`);
  void runSessionAgent({
    sessionId: run.session_id,
    agentId: run.agent_id,
    prompt: run.prompt,
    provider: run.provider,
    model: run.model,
  }).catch((error) => {
    const event = sessionEvidenceRepo.create({
      session_id: run.session_id,
      event_type: 'blocker',
      severity: 'error',
      title: 'Session retry failed',
      summary: (error as Error).message,
      payload: { source_run_id: run.id, agent_id: run.agent_id },
    });
    wsHub.broadcastSession(run.session_id, { type: 'session_evidence:new', sessionId: run.session_id, event });
  });
}

export function recordSessionChunk(input: {
  sessionId: string;
  runId: string;
  chunk: AcpStreamChunk;
}): void {
  const text = input.chunk.text ?? '';
  const channel = normalizeStreamChannel(input.chunk.channel);
  if (input.chunk.stream === 'stderr') {
    sessionRunRepo.appendStderr(input.runId, text);
  } else if (input.chunk.channel === 'activity') {
    sessionRunRepo.appendActivity(input.runId, text);
  } else {
    sessionRunRepo.appendStdout(input.runId, text);
  }

  wsHub.broadcastSession(input.sessionId, {
    type: 'session_run:stream',
    sessionId: input.sessionId,
    runId: input.runId,
    chunk: text,
    channel,
    done: false,
  });

  const evidenceType = resolveEvidenceType(input.chunk);
  if (!evidenceType) return;
  const event = sessionEvidenceRepo.create({
    session_id: input.sessionId,
    event_type: evidenceType,
    source_run_id: input.runId,
    title: buildEvidenceTitle(input.chunk),
    summary: trimEvidenceText(text),
    payload: {
      channel,
      rawType: input.chunk.rawType ?? null,
      text: trimEvidenceText(text),
      run_id: input.runId,
      event: input.chunk.event ?? null,
      trace: input.chunk.trace ?? null,
      rawEvent: input.chunk.rawEvent ?? null,
    },
  });
  wsHub.broadcastSession(input.sessionId, { type: 'session_evidence:new', sessionId: input.sessionId, event });
}

function finishSessionRun(input: {
  runId: string;
  agentId: string;
  provider: AcpBackend;
  model: string | null;
  status: SessionRunStatus;
  error?: string | null;
}): SessionRun {
  const run = sessionRunRepo.get(input.runId);
  if (run && input.error) {
    sessionRunRepo.appendStderr(input.runId, input.error);
  }
  const updated = sessionRunRepo.updateStatus(input.runId, input.status, {
    error: input.status === 'failed' ? input.error ?? null : null,
  });
  if (!updated) throw new Error(`Session run ${input.runId} not found`);
  sessionAgentRuntimeRepo.upsert({
    session_id: updated.session_id,
    agent_id: input.agentId,
    provider: input.provider,
    model: input.model,
    provider_session_id: updated.acp_session_id,
    status: input.status === 'paused'
      ? 'paused'
      : input.status === 'failed'
        ? 'failed'
        : input.status === 'completed'
          ? 'completed'
          : 'idle',
    current_run_id: ['running', 'queued', 'retrying', 'paused'].includes(input.status) ? updated.id : null,
  });
  wsHub.broadcastSession(updated.session_id, {
    type: 'session_run:updated',
    sessionId: updated.session_id,
    run: updated,
  });
  wsHub.broadcastSession(updated.session_id, {
    type: 'session_run:stream',
    sessionId: updated.session_id,
    runId: input.runId,
    chunk: '',
    channel: 'answer',
    done: true,
  });
  if (input.status === 'failed') {
    const event = sessionEvidenceRepo.create({
      session_id: updated.session_id,
      event_type: 'blocker',
      severity: 'error',
      source_run_id: updated.id,
      title: 'Session runtime failed',
      summary: input.error ?? updated.error,
      payload: { run_id: updated.id },
    });
    wsHub.broadcastSession(updated.session_id, { type: 'session_evidence:new', sessionId: updated.session_id, event });
  }
  return updated;
}

function normalizeAgentId(agentId: string | null | undefined): string {
  const normalized = agentId?.trim();
  return normalized || DEFAULT_SESSION_AGENT_ID;
}

function persistProviderSession(input: {
  runId: string;
  sessionId: string;
  agentId: string;
  provider: AcpBackend;
  model: string | null;
  providerSessionId: string;
  status: 'idle' | 'running' | 'paused' | 'failed' | 'completed';
}): SessionRun | undefined {
  const updated = sessionRunRepo.updateStatus(input.runId, 'running', {
    acp_session_id: input.providerSessionId,
  });
  sessionAgentRuntimeRepo.upsert({
    session_id: input.sessionId,
    agent_id: input.agentId,
    provider: input.provider,
    model: input.model,
    provider_session_id: input.providerSessionId,
    status: input.status,
    current_run_id: input.runId,
  });
  if (updated) {
    wsHub.broadcastSession(input.sessionId, {
      type: 'session_run:updated',
      sessionId: input.sessionId,
      run: updated,
    });
  }
  return updated;
}

function requireSession(sessionId: string): Session {
  const session = sessionRepo.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  return session;
}

function resolveAdapter(provider: AcpBackend): SessionAdapter {
  if (adapterOverride && adapterOverride.backend === provider) return adapterOverride;
  return getAdapter(provider);
}

function normalizeStreamChannel(channel: AcpStreamChannel | undefined): 'answer' | 'thinking' | 'tool' | 'command' | 'event' {
  if (channel === 'thinking' || channel === 'tool' || channel === 'command' || channel === 'event') return channel;
  return 'answer';
}

function resolveEvidenceType(chunk: AcpStreamChunk): SessionEvidenceType | null {
  if (chunk.event || chunk.rawEvent || chunk.channel === 'event') return 'status';
  if (chunk.channel === 'tool' || chunk.trace?.kind === 'tool') {
    return chunk.rawType === 'tool_result' ? 'tool_result' : 'tool_call';
  }
  if (chunk.channel === 'command' || chunk.trace?.kind === 'command') return 'tool_call';
  if (chunk.rawType === 'file_diff') return 'file_diff';
  if (chunk.rawType === 'file_read') return 'file_read';
  if (chunk.rawType === 'test') return 'test';
  if (chunk.rawType === 'build') return 'build';
  return null;
}

function buildEvidenceTitle(chunk: AcpStreamChunk): string {
  if (chunk.trace?.kind === 'tool') return `Tool: ${chunk.trace.name}`;
  if (chunk.trace?.kind === 'command') return `Command: ${chunk.trace.command}`;
  if (chunk.event?.title) return chunk.event.title;
  if (chunk.rawType) return chunk.rawType;
  if (chunk.channel) return `Session ${chunk.channel}`;
  return 'Session event';
}

function trimEvidenceText(text: string): string {
  const lines = text.split('\n').slice(0, MAX_EVIDENCE_LINES).join('\n');
  return lines.length > STREAM_PAYLOAD_LIMIT ? lines.slice(0, STREAM_PAYLOAD_LIMIT) : lines;
}
