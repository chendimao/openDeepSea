import { getAdapter } from './acp/index.js';
import type { AcpStreamChannel, AcpStreamChunk, SessionAdapter } from './acp/types.js';
import { projectRepo } from './repos/projects.js';
import { sessionEvidenceRepo } from './repos/session-evidence.js';
import { sessionRunRepo } from './repos/sessions.js';
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
import { sessionRepo } from './repos/sessions.js';

const STREAM_PAYLOAD_LIMIT = 8000;
const MAX_EVIDENCE_LINES = 200;

let adapterOverride: SessionAdapter | undefined;

export function setSessionRuntimeAdapterForTest(adapter?: SessionAdapter): void {
  adapterOverride = adapter;
}

export async function runSessionAgent(input: {
  sessionId: string;
  prompt: string;
  provider: AcpBackend;
  model?: string | null;
  permissionMode?: AcpPermissionMode | null;
  imagePaths?: string[];
}): Promise<SessionRun> {
  const session = requireSession(input.sessionId);
  const project = projectRepo.get(session.project_id);
  if (!project) throw new Error(`Project not found for session ${session.id}`);

  const run = sessionRunRepo.create({
    session_id: session.id,
    provider: input.provider,
    model: input.model ?? null,
    mode: session.mode,
    phase: session.phase,
    prompt: input.prompt,
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
        const updated = sessionRunRepo.updateStatus(run.id, 'running', { acp_session_id: acpSessionId });
        if (updated) {
          wsHub.broadcastSession(session.id, { type: 'session_run:updated', sessionId: session.id, run: updated });
        }
      },
      onChunk: (chunk) => recordSessionChunk({ sessionId: session.id, runId: run.id, chunk }),
      signal: controller.signal,
    });
    if (result.sessionId) {
      const updated = sessionRunRepo.updateStatus(run.id, 'running', { acp_session_id: result.sessionId });
      if (updated) {
        wsHub.broadcastSession(session.id, { type: 'session_run:updated', sessionId: session.id, run: updated });
      }
    }
    return finishSessionRun(run.id, controller.signal.aborted ? 'cancelled' : result.exitCode === 0 ? 'completed' : 'failed', result.stderr || null);
  } catch (err) {
    return finishSessionRun(run.id, controller.signal.aborted ? 'cancelled' : 'failed', (err as Error).message);
  } finally {
    runRegistry.remove(run.id);
  }
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

function finishSessionRun(runId: string, status: SessionRunStatus, error?: string | null): SessionRun {
  const run = sessionRunRepo.get(runId);
  if (run && error) {
    sessionRunRepo.appendStderr(runId, error);
  }
  const updated = sessionRunRepo.updateStatus(runId, status, { error: status === 'failed' ? error ?? null : null });
  if (!updated) throw new Error(`Session run ${runId} not found`);
  wsHub.broadcastSession(updated.session_id, {
    type: 'session_run:updated',
    sessionId: updated.session_id,
    run: updated,
  });
  wsHub.broadcastSession(updated.session_id, {
    type: 'session_run:stream',
    sessionId: updated.session_id,
    runId,
    chunk: '',
    channel: 'answer',
    done: true,
  });
  if (status === 'failed') {
    const event = sessionEvidenceRepo.create({
      session_id: updated.session_id,
      event_type: 'blocker',
      severity: 'error',
      source_run_id: updated.id,
      title: 'Session runtime failed',
      summary: error ?? updated.error,
      payload: { run_id: updated.id },
    });
    wsHub.broadcastSession(updated.session_id, { type: 'session_evidence:new', sessionId: updated.session_id, event });
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
