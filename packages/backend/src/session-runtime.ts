import { getAdapter } from './acp/index.js';
import type { AcpStreamChannel, AcpStreamChunk, SessionAdapter } from './acp/types.js';
import { providerConfigService } from './provider-configs/service.js';
import { projectRepo } from './repos/projects.js';
import { sessionEvidenceRepo } from './repos/session-evidence.js';
import { sessionTokenUsageRepo } from './repos/session-token-usage.js';
import {
  DEFAULT_SESSION_AGENT_ID,
  sessionAgentEventRepo,
  sessionAgentRuntimeRepo,
  sessionRepo,
  sessionRunRepo,
} from './repos/sessions.js';
import { runRegistry } from './run-registry.js';
import { broadcastActiveSessionUpsert } from './session-active-broadcast.js';
import type { SessionAgentEventChannel } from './session-types.js';
import { buildSessionBottomStatus, buildSessionInspectorSnapshot } from './session-workspace-view-model.js';
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
  runtimeProfileSnapshot?: string | null;
  imagePaths?: string[];
}): Promise<SessionRun> {
  const session = requireSession(input.sessionId);
  const project = projectRepo.get(session.project_id);
  if (!project) throw new Error(`Project not found for session ${session.id}`);
  const agentId = normalizeAgentId(input.agentId);
  const existingRuntime = sessionAgentRuntimeRepo.getByAgent(session.id, agentId, input.provider);
  const providerRuntimeConfig = providerConfigService.resolveProviderRuntimeConfig(input.provider);
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
    runtime_profile_snapshot: input.runtimeProfileSnapshot ?? null,
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
  broadcastActiveSessionUpsert(session.id);

  try {
    const result = await resolveAdapter(input.provider).invoke({
      projectPath: session.worktree_path ?? session.workspace_path ?? project.path,
      sessionId: run.acp_session_id,
      prompt: input.prompt,
      acpPermissionMode: input.permissionMode ?? 'read-only',
      imagePaths: input.imagePaths ?? [],
      providerRuntimeConfig,
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
      onChunk: (chunk) => recordSessionChunk({ sessionId: session.id, agentId, runId: run.id, chunk }),
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
      status: controller.signal.aborted
        ? resolveAbortedRunStatus(run.id)
        : result.exitCode === 0
          ? 'completed'
          : 'failed',
      error: result.stderr || null,
    });
  } catch (err) {
    return finishSessionRun({
      runId: run.id,
      agentId,
      provider: input.provider,
      model: input.model ?? null,
      status: controller.signal.aborted ? resolveAbortedRunStatus(run.id) : 'failed',
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
    runtimeProfileSnapshot: run.runtime_profile_snapshot,
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
    broadcastActiveSessionUpsert(run.session_id);
  });
}

export function recordSessionChunk(input: {
  sessionId: string;
  agentId: string;
  runId: string;
  chunk: AcpStreamChunk;
}): void {
  const text = input.chunk.text ?? '';
  const channel = normalizeStreamChannel(input.chunk.channel);
  const streamEvent = sessionAgentEventRepo.create({
    session_id: input.sessionId,
    agent_id: input.agentId,
    run_id: input.runId,
    channel,
    event_type: input.chunk.rawType ?? input.chunk.event?.type ?? channel,
    content: text,
    payload: {
      rawType: input.chunk.rawType ?? null,
      event: input.chunk.event ?? null,
      trace: input.chunk.trace ?? null,
      rawEvent: input.chunk.rawEvent ?? null,
    },
  });

  const isActivityChannel =
    channel === 'activity' ||
    channel === 'thinking' ||
    channel === 'tool' ||
    channel === 'command' ||
    channel === 'event';

  if (isActivityChannel) {
    sessionRunRepo.appendActivity(input.runId, text);
  } else if (input.chunk.stream === 'stderr') {
    sessionRunRepo.appendStderr(input.runId, text);
  } else {
    sessionRunRepo.appendStdout(input.runId, text);
  }

  wsHub.broadcastSession(input.sessionId, {
    type: 'session_run:stream',
    sessionId: input.sessionId,
    agentId: input.agentId,
    runId: input.runId,
    seq: streamEvent.seq,
    chunk: text,
    channel,
    done: false,
    agentEvent: streamEvent,
  });

  recordTokenUsageSnapshot(input);

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
  broadcastActiveSessionUpsert(input.sessionId);
  if (shouldBroadcastInspectorSnapshot(evidenceType)) {
    broadcastSessionInspectorSnapshot(input.sessionId);
  }
}

function recordTokenUsageSnapshot(input: {
  sessionId: string;
  agentId: string;
  runId: string;
  chunk: AcpStreamChunk;
}): void {
  const usage = extractTokenUsageFromChunk(input.chunk);
  if (!usage) return;
  const run = sessionRunRepo.get(input.runId);
  sessionTokenUsageRepo.create({
    session_id: input.sessionId,
    run_id: input.runId,
    agent_id: run?.agent_id ?? input.agentId,
    provider: run?.provider ?? null,
    model: run?.model ?? null,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    cached_input_tokens: usage.cachedInputTokens,
    reasoning_tokens: usage.reasoningTokens,
    source: usage.source,
    is_final: usage.isFinal,
    raw_payload: usage.rawPayload,
  });
  broadcastSessionBottomStatus(input.sessionId);
}

function extractTokenUsageFromChunk(chunk: AcpStreamChunk): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  isFinal: boolean;
  source: string;
  rawPayload: Record<string, unknown>;
} | null {
  const candidate = findUsageCandidate([
    chunk.event?.payload,
    chunk.event,
    chunk.rawEvent,
  ]);
  if (!candidate) return null;
  const contextUsedTokens = firstTokenNumber(candidate, ['used']);
  const contextSizeTokens = firstTokenNumber(candidate, ['size']);
  if (contextUsedTokens !== null && contextSizeTokens !== null) {
    return {
      inputTokens: contextUsedTokens,
      outputTokens: 0,
      totalTokens: contextUsedTokens,
      cachedInputTokens: null,
      reasoningTokens: null,
      isFinal: false,
      source: 'provider_context_usage',
      rawPayload: {
        rawType: chunk.rawType ?? null,
        usage: candidate,
      },
    };
  }
  const inputTokens = firstTokenNumber(candidate, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'input']);
  const outputTokens = firstTokenNumber(candidate, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'output']);
  const totalTokens = firstTokenNumber(candidate, ['total_tokens', 'totalTokens', 'total']);
  const inputDetails = record(candidate['input_tokens_details']) ?? record(candidate['inputTokenDetails']);
  const outputDetails = record(candidate['output_tokens_details']) ?? record(candidate['outputTokenDetails']);
  const cacheReadInputTokens = firstTokenNumber(candidate, [
    'cache_read_input_tokens',
    'cacheReadInputTokens',
  ]);
  const cacheCreationInputTokens = firstTokenNumber(candidate, [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
  ]);
  const cachedInputTokens = firstTokenNumber(candidate, [
    'cached_input_tokens',
    'cachedInputTokens',
  ]) ?? sumTokenNumbers([cacheReadInputTokens, cacheCreationInputTokens])
    ?? firstTokenNumber(inputDetails, ['cached_tokens', 'cachedTokens']);
  const reasoningTokens = firstTokenNumber(candidate, ['reasoning_tokens', 'reasoningTokens'])
    ?? firstTokenNumber(outputDetails, ['reasoning_tokens', 'reasoningTokens']);
  const normalizedInput = normalizeInputTokens(inputTokens, cacheReadInputTokens, cacheCreationInputTokens);
  const normalizedOutput = outputTokens ?? 0;
  const normalizedTotal = totalTokens ?? normalizedInput + normalizedOutput;
  if (normalizedTotal <= 0) return null;
  const source = chunk.rawType === 'usage_update' ? 'provider_context_usage' : 'provider_usage';

  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: normalizedTotal,
    cachedInputTokens,
    reasoningTokens,
    isFinal: source === 'provider_usage' && (
      candidate['is_final'] === true ||
      candidate['isFinal'] === true ||
      candidate['final'] === true
    ),
    source,
    rawPayload: {
      rawType: chunk.rawType ?? null,
      usage: candidate,
    },
  };
}

function findUsageCandidate(values: unknown[]): Record<string, unknown> | null {
  const queue = values
    .map(record)
    .filter((value): value is Record<string, unknown> => value !== null);
  const seen = new Set<Record<string, unknown>>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (hasTokenUsageShape(current)) return current;
    for (const value of Object.values(current)) {
      const child = record(value);
      if (child) queue.push(child);
    }
  }
  return null;
}

function hasTokenUsageShape(value: Record<string, unknown>): boolean {
  if (firstTokenNumber(value, ['used']) !== null && firstTokenNumber(value, ['size']) !== null) {
    return true;
  }
  return firstTokenNumber(value, [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
    'total_tokens',
    'totalTokens',
  ]) !== null;
}

function firstTokenNumber(recordValue: Record<string, unknown> | null, keys: string[]): number | null {
  if (!recordValue) return null;
  for (const key of keys) {
    const value = recordValue[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return null;
}

function normalizeInputTokens(
  inputTokens: number | null,
  cacheReadInputTokens: number | null,
  cacheCreationInputTokens: number | null,
): number {
  const baseInputTokens = inputTokens ?? 0;
  const anthropicCacheTokens = sumTokenNumbers([cacheReadInputTokens, cacheCreationInputTokens]) ?? 0;
  return baseInputTokens + anthropicCacheTokens;
}

function sumTokenNumbers(values: Array<number | null>): number | null {
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return total > 0 ? total : null;
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
  broadcastActiveSessionUpsert(updated.session_id);
  const finalEvent = sessionAgentEventRepo.create({
    session_id: updated.session_id,
    agent_id: input.agentId,
    run_id: updated.id,
    channel: 'event',
    event_type: `run_${input.status}`,
    content: '',
    payload: { status: input.status },
  });
  wsHub.broadcastSession(updated.session_id, {
    type: 'session_run:stream',
    sessionId: updated.session_id,
    agentId: input.agentId,
    runId: updated.id,
    seq: finalEvent.seq,
    chunk: '',
    channel: 'event',
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
    broadcastActiveSessionUpsert(updated.session_id);
  }
  return updated;
}

function normalizeAgentId(agentId: string | null | undefined): string {
  const normalized = agentId?.trim();
  return normalized || DEFAULT_SESSION_AGENT_ID;
}

function resolveAbortedRunStatus(runId: string): 'cancelled' | 'paused' {
  return runRegistry.getAbortReason(runId) === 'paused' ? 'paused' : 'cancelled';
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
    broadcastActiveSessionUpsert(input.sessionId);
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

function normalizeStreamChannel(channel: AcpStreamChannel | undefined): SessionAgentEventChannel {
  if (
    channel === 'activity' ||
    channel === 'thinking' ||
    channel === 'tool' ||
    channel === 'command' ||
    channel === 'event'
  ) {
    return channel;
  }
  return 'answer';
}

function resolveEvidenceType(chunk: AcpStreamChunk): SessionEvidenceType | null {
  const evidenceType = normalizeEvidenceRawType(chunk.rawType) ?? normalizeEvidenceRawType(chunk.event?.type);
  if (evidenceType) return evidenceType;
  if (chunk.channel === 'tool' || chunk.trace?.kind === 'tool') {
    return chunk.rawType === 'tool_result' ? 'tool_result' : 'tool_call';
  }
  if (chunk.channel === 'command' || chunk.trace?.kind === 'command') return 'tool_call';
  if (chunk.event || chunk.rawEvent || chunk.channel === 'event') return 'status';
  return null;
}

function normalizeEvidenceRawType(rawType: string | undefined): SessionEvidenceType | null {
  if (rawType === 'tool_call' || rawType === 'tool_call_update') return 'tool_call';
  if (rawType === 'tool_result') return 'tool_result';
  if (rawType === 'file_diff') return 'file_diff';
  if (rawType === 'file_read') return 'file_read';
  if (rawType === 'test') return 'test';
  if (rawType === 'build') return 'build';
  if (rawType === 'browser_check') return 'browser_check';
  return null;
}

function shouldBroadcastInspectorSnapshot(eventType: SessionEvidenceType): boolean {
  return eventType === 'status' ||
    eventType === 'tool_call' ||
    eventType === 'tool_result' ||
    eventType === 'file_read' ||
    eventType === 'file_diff' ||
    eventType === 'test' ||
    eventType === 'build' ||
    eventType === 'browser_check';
}

function broadcastSessionBottomStatus(sessionId: string): void {
  const runs = sessionRunRepo.listBySession(sessionId);
  const evidence = sessionEvidenceRepo.listBySession(sessionId);
  const bottomStatus = buildSessionBottomStatus(runs, evidence, sessionTokenUsageRepo.summarizeBySession(sessionId));
  wsHub.broadcastSession(sessionId, {
    type: 'session_bottom_status:snapshot',
    sessionId,
    bottomStatus,
  });
}

function broadcastSessionInspectorSnapshot(sessionId: string): void {
  const runs = sessionRunRepo.listBySession(sessionId);
  const evidence = sessionEvidenceRepo.listBySession(sessionId);
  const agentEvents = runs.flatMap((run) => sessionAgentEventRepo.listByRun(run.id));
  const snapshot = buildSessionInspectorSnapshot(sessionId, evidence, agentEvents);
  wsHub.broadcastSession(sessionId, {
    type: 'session_inspector:snapshot',
    sessionId,
    ...snapshot,
  });
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
