import { getAdapter } from './acp/index.js';
import type { AcpStreamChannel, AcpStreamChunk, SessionAdapter, SessionToolDefinition } from './acp/types.js';
import {
  createGenerateImageSessionTool,
  type GenerateImageToolDeps,
} from './image-generation/tool.js';
import { providerConfigService } from './provider-configs/service.js';
import { now } from './db.js';
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
import { buildSessionPlannerRuntimeSnapshot, resolveSessionPlannerRuntime } from './session-planner-runtime.js';
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
const RETRY_CONTEXT_LIMIT = STREAM_PAYLOAD_LIMIT;
const MAX_RETRY_CONTEXT_LINES = MAX_EVIDENCE_LINES;
const MAX_SESSION_TOOL_BRIDGE_CALLS = 3;
const MAX_SESSION_RUNTIME_AUTO_RETRIES = 1;
const SESSION_TOOL_BRIDGE_OPEN_TAG = '<opendeepsea-tool-call';
const SESSION_TOOL_BRIDGE_OPEN_PATTERN = /<opendeepsea-tool-call\b/i;
const SESSION_TOOL_BRIDGE_PATTERN = /<opendeepsea-tool-call\s+name=(["'])([^"']+)\1\s*>\s*([\s\S]*?)\s*<\/opendeepsea-tool-call>/gi;

let adapterOverride: SessionAdapter | undefined;
let generateImageToolDepsOverride: GenerateImageToolDeps | undefined;

export function setSessionRuntimeAdapterForTest(adapter?: SessionAdapter): void {
  adapterOverride = adapter;
}

export function setSessionRuntimeGenerateImageToolDepsForTest(deps?: GenerateImageToolDeps): void {
  generateImageToolDepsOverride = deps;
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
  const permissionMode = input.permissionMode ?? 'read-only';
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
  const knowledgeEnvOverrides: Record<string, string> = {
    OPENDEEPSEA_SESSION_RUN_ID: run.id,
    OPENDEEPSEA_SESSION_ID: session.id,
    OPENDEEPSEA_PROJECT_ID: session.project_id,
    OPENDEEPSEA_AGENT_ID: agentId,
    OPENDEEPSEA_KNOWLEDGE_REF_TYPE: 'session_run',
  };
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
  const runtimeTools = buildSessionRuntimeTools(session, permissionMode, run.id);

  try {
    let fallbackFailureDiagnostic: string | null = null;
    for (let attempt = 0; ; attempt += 1) {
      const streamedText: string[] = [];
      const bridgeSanitizer = createSessionToolBridgeSanitizer();
      let latestFailureDiagnostic: string | null = null;
      const result = await resolveAdapter(input.provider).invoke({
        projectPath: session.worktree_path ?? session.workspace_path ?? project.path,
        sessionId: sessionRunRepo.get(run.id)?.acp_session_id ?? run.acp_session_id,
        prompt: withSessionToolBridgeInstructions(input.prompt, runtimeTools),
        acpPermissionMode: permissionMode,
        imagePaths: input.imagePaths ?? [],
        providerRuntimeConfig,
        envOverrides: knowledgeEnvOverrides,
        tools: runtimeTools,
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
        onChunk: (chunk) => {
          const diagnostic = extractFailureDiagnosticFromChunk(chunk);
          if (diagnostic) latestFailureDiagnostic = diagnostic;
          if (chunk.stream === 'stdout' && chunk.text) streamedText.push(chunk.text);
          const visibleChunk = sanitizeSessionToolBridgeChunk(chunk, bridgeSanitizer);
          if (visibleChunk.text.length > 0 || visibleChunk.channel !== 'answer') {
            recordSessionChunk({ sessionId: session.id, agentId, runId: run.id, chunk: visibleChunk });
          }
        },
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
      const flushedChunk = flushSessionToolBridgeSanitizer(bridgeSanitizer);
      if (flushedChunk && (flushedChunk.text.length > 0 || flushedChunk.channel !== 'answer')) {
        recordSessionChunk({ sessionId: session.id, agentId, runId: run.id, chunk: flushedChunk });
      }
      if (!controller.signal.aborted && result.exitCode === 0) {
        await executeSessionToolBridgeCalls({
          sessionId: session.id,
          agentId,
          runId: run.id,
          tools: runtimeTools,
          text: streamedText.join(''),
        });
      }
      if (latestFailureDiagnostic) fallbackFailureDiagnostic = latestFailureDiagnostic;
      const failureError = result.stderr ||
        latestFailureDiagnostic ||
        fallbackFailureDiagnostic ||
        (!controller.signal.aborted ? runtimeExitFailureDiagnostic(result.exitCode) : null);
      if (
        !controller.signal.aborted &&
        shouldAutoRetrySessionRun({ attempt, exitCode: result.exitCode, stderr: result.stderr, diagnostic: latestFailureDiagnostic })
      ) {
        recordSessionAutoRetry({ sessionId: session.id, runId: run.id, agentId, attempt, diagnostic: latestFailureDiagnostic });
        continue;
      }
      return finishSessionRun({
        runSnapshot: run,
        runId: run.id,
        agentId,
        provider: input.provider,
        model: input.model ?? null,
        status: controller.signal.aborted
          ? resolveAbortedRunStatus(run.id)
          : result.exitCode === 0
            ? 'completed'
            : 'failed',
        error: failureError || null,
      });
    }
  } catch (err) {
    return finishSessionRun({
      runSnapshot: run,
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

function withSessionToolBridgeInstructions(prompt: string, tools: SessionToolDefinition[]): string {
  if (tools.length === 0) return prompt;
  const toolSpecs = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
  return `${prompt}\n\n<opendeepsea-session-tools>\n` +
    '当前 OpenDeepSea 会话提供以下内部工具。需要调用工具时，请在回复中输出一个独立 XML 标记，格式为：\n' +
    '<opendeepsea-tool-call name="generate_image">\n{"prompt":"...","workflow":"generate","count":1}\n</opendeepsea-tool-call>\n' +
    '只填写 input_schema 中允许的字段；project_id、session_id 与密钥由 OpenDeepSea 自动绑定，不能写入标记。\n' +
    '工具调用会在当前轮回复结束后由 OpenDeepSea 执行，并自动保存结果为项目资源和会话证据。\n' +
    `${JSON.stringify(toolSpecs)}\n` +
    '</opendeepsea-session-tools>';
}

async function executeSessionToolBridgeCalls(input: {
  sessionId: string;
  agentId: string;
  runId: string;
  tools: SessionToolDefinition[];
  text: string;
}): Promise<void> {
  if (input.tools.length === 0 || !input.text.includes('opendeepsea-tool-call')) return;
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  SESSION_TOOL_BRIDGE_PATTERN.lastIndex = 0;
  const matches = [...input.text.matchAll(SESSION_TOOL_BRIDGE_PATTERN)].slice(0, MAX_SESSION_TOOL_BRIDGE_CALLS);
  for (const match of matches) {
    const toolName = match[2]?.trim();
    const rawInput = match[3]?.trim() ?? '';
    if (!toolName) continue;
    const tool = toolsByName.get(toolName);
    if (!tool) continue;
    const parsedInput = parseSessionToolBridgeInput(rawInput, toolName);
    recordSessionChunk({
      sessionId: input.sessionId,
      agentId: input.agentId,
      runId: input.runId,
      chunk: {
        stream: 'stdout',
        channel: 'tool',
        rawType: 'tool_call',
        text: `OpenDeepSea tool call: ${toolName}\n`,
        trace: {
          kind: 'tool',
          name: toolName,
          input: JSON.stringify(parsedInput),
        },
      },
    });
    const result = await tool.execute(parsedInput);
    recordSessionChunk({
      sessionId: input.sessionId,
      agentId: input.agentId,
      runId: input.runId,
      chunk: {
        stream: 'stdout',
        channel: 'tool',
        rawType: 'tool_result',
        text: `OpenDeepSea tool result: ${toolName}\n`,
        trace: {
          kind: 'tool',
          name: toolName,
          input: JSON.stringify(parsedInput),
          output: JSON.stringify(result),
        },
      },
    });
  }
}

function parseSessionToolBridgeInput(rawInput: string, toolName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch (error) {
    throw new Error(`OpenDeepSea session tool ${toolName} input is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenDeepSea session tool ${toolName} input must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

interface SessionToolBridgeSanitizerState {
  buffer: string;
  pendingChunk: AcpStreamChunk | null;
}

function createSessionToolBridgeSanitizer(): SessionToolBridgeSanitizerState {
  return { buffer: '', pendingChunk: null };
}

function sanitizeSessionToolBridgeChunk(
  chunk: AcpStreamChunk,
  state: SessionToolBridgeSanitizerState,
): AcpStreamChunk {
  if (chunk.stream !== 'stdout') return chunk;

  state.buffer += chunk.text;
  const text = drainSessionToolBridgeVisibleText(state, false);
  state.pendingChunk = state.buffer.length > 0 ? { ...chunk, text: '' } : null;
  return { ...chunk, text };
}

function flushSessionToolBridgeSanitizer(state: SessionToolBridgeSanitizerState): AcpStreamChunk | null {
  const text = drainSessionToolBridgeVisibleText(state, true);
  const chunk = state.pendingChunk;
  state.pendingChunk = null;
  if (!text) return null;
  return { ...(chunk ?? { stream: 'stdout', channel: 'answer', text: '' }), text };
}

function drainSessionToolBridgeVisibleText(state: SessionToolBridgeSanitizerState, flush: boolean): string {
  let output = '';

  while (state.buffer.length > 0) {
    const bridgeMatch = firstSessionToolBridgeMatch(state.buffer);
    const openIndex = findSessionToolBridgeOpenIndex(state.buffer);
    if (bridgeMatch && (openIndex === -1 || bridgeMatch.index === openIndex)) {
      output += state.buffer.slice(0, bridgeMatch.index);
      state.buffer = state.buffer.slice(bridgeMatch.index + bridgeMatch[0].length);
      continue;
    }

    if (openIndex >= 0) {
      output += state.buffer.slice(0, openIndex);
      state.buffer = flush ? '' : state.buffer.slice(openIndex);
      break;
    }

    const holdLength = flush ? 0 : partialSessionToolBridgeOpenLength(state.buffer);
    output += state.buffer.slice(0, state.buffer.length - holdLength);
    state.buffer = state.buffer.slice(state.buffer.length - holdLength);
    break;
  }

  return output.replace(/\n{3,}/g, '\n\n');
}

function firstSessionToolBridgeMatch(text: string): RegExpExecArray | null {
  SESSION_TOOL_BRIDGE_PATTERN.lastIndex = 0;
  return SESSION_TOOL_BRIDGE_PATTERN.exec(text);
}

function findSessionToolBridgeOpenIndex(text: string): number {
  const match = SESSION_TOOL_BRIDGE_OPEN_PATTERN.exec(text);
  return match?.index ?? -1;
}

function partialSessionToolBridgeOpenLength(text: string): number {
  const normalized = text.toLowerCase();
  const maxLength = Math.min(SESSION_TOOL_BRIDGE_OPEN_TAG.length - 1, normalized.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (SESSION_TOOL_BRIDGE_OPEN_TAG.startsWith(normalized.slice(-length))) return length;
  }
  return 0;
}

export function buildSessionRuntimeTools(
  session: Pick<Session, 'id' | 'project_id'>,
  permissionMode: AcpPermissionMode,
  runId?: string | null,
): SessionToolDefinition[] {
  if (!canUseProjectTools(permissionMode)) return [];
  const generateImageToolDeps = generateImageToolDepsOverride ?? {};
  return [
    createGenerateImageSessionTool(session, {
      ...generateImageToolDeps,
      onResult: async (result) => {
        await generateImageToolDeps.onResult?.(result);
        const { recordSessionImageGenerationToolResultEvidence } = await import('./session-message-dispatch.js');
        recordSessionImageGenerationToolResultEvidence({
          sessionId: session.id,
          sourceRunId: runId ?? null,
          result,
        });
      },
    }),
  ];
}

function canUseProjectTools(permissionMode: AcpPermissionMode): boolean {
  return permissionMode === 'workspace-write' || permissionMode === 'bypass';
}

export function retrySessionAgentRun(runId: string): void {
  const run = sessionRunRepo.get(runId);
  if (!run) throw new Error(`Session run ${runId} not found`);
  const retryRuntime = resolveRetryRuntime(run);
  void runSessionAgent({
    sessionId: run.session_id,
    agentId: run.agent_id,
    prompt: buildSessionRunRetryPrompt(run),
    provider: retryRuntime.provider,
    model: retryRuntime.model,
    permissionMode: retryRuntime.permissionMode,
    runtimeProfileSnapshot: retryRuntime.runtimeProfileSnapshot,
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

function resolveRetryRuntime(run: SessionRun): {
  provider: AcpBackend;
  model: string | null;
  permissionMode: AcpPermissionMode | null;
  runtimeProfileSnapshot: string | null;
} {
  if (run.agent_id !== DEFAULT_SESSION_AGENT_ID) {
    return {
      provider: run.provider,
      model: run.model,
      permissionMode: parsePermissionModeFromRuntimeSnapshot(run.runtime_profile_snapshot),
      runtimeProfileSnapshot: run.runtime_profile_snapshot,
    };
  }
  const session = requireSession(run.session_id);
  const plannerRuntime = resolveSessionPlannerRuntime(session.project_id);
  return {
    provider: plannerRuntime.backend,
    model: run.model,
    permissionMode: plannerRuntime.permissionMode,
    runtimeProfileSnapshot: buildSessionPlannerRuntimeSnapshot(plannerRuntime),
  };
}

function parsePermissionModeFromRuntimeSnapshot(snapshot: string | null | undefined): AcpPermissionMode | null {
  if (!snapshot) return null;
  try {
    const parsed = JSON.parse(snapshot) as { permission_mode?: unknown };
    const permissionMode = parsed.permission_mode;
    if (permissionMode === 'bypass' || permissionMode === 'workspace-write' || permissionMode === 'read-only') {
      return permissionMode;
    }
  } catch {
    return null;
  }
  return null;
}

function buildSessionRunRetryPrompt(run: SessionRun): string {
  const partialAnswer = run.stdout.trim();
  const wrapupFailure = completedRunWrapupFailureDiagnostic(run);
  if (partialAnswer && wrapupFailure) {
    return [
      '上一轮运行的正文回复已经完成并发送，但后续收尾阶段因服务商或限流错误中断。请不要重新回答原始用户请求，也不要改写已输出内容。',
      '请只重新执行尚未完成的收尾工作，例如自审、必要验证、文档/计划状态同步、提交或最终说明；如果收尾已完成，请简短说明无需重复。',
      '',
      '## 原始用户请求',
      trimRetryContinuationContext(run.prompt),
      '',
      '## 已输出内容',
      trimRetryContinuationContext(partialAnswer),
      '',
      '## 收尾中断信息',
      trimEvidenceText(wrapupFailure),
      '',
      '请从收尾阶段继续。',
    ].join('\n');
  }
  if (run.status !== 'failed' || !partialAnswer) return run.prompt;

  const failure = (run.error || run.stderr).trim();
  return [
    '上一轮运行在已经输出部分回复后失败。请不要重新回答原始用户请求，也不要改写已输出内容。',
    '把下面的“已输出内容”视为已经发送给用户，只从中断点继续完成同一轮回复。',
    '如果失败来自工具、权限或本地环境，请简短说明降级处理，然后继续推进原本的下一步。',
    '',
    '## 原始用户请求',
    trimRetryContinuationContext(run.prompt),
    '',
    '## 已输出内容',
    trimRetryContinuationContext(partialAnswer),
    '',
    '## 失败信息',
    failure ? trimEvidenceText(failure) : '未记录失败信息。',
    '',
    '请从中断点继续。',
  ].join('\n');
}

function completedRunWrapupFailureDiagnostic(run: SessionRun): string | null {
  if (run.status !== 'completed') return null;
  for (const text of [run.error, run.stderr, run.activity_log]) {
    if (looksLikeProviderInterruptDiagnostic(text)) return cleanRunDiagnostic(text);
  }
  return null;
}

function looksLikeProviderInterruptDiagnostic(text: string | null | undefined): text is string {
  return Boolean(text && /(Unhandled error during turn|exceeded retry limit|Too Many Requests|429\b|rate limit|quota exceeded|ResponseTooManyFailedAttempts)/i.test(text));
}

function cleanRunDiagnostic(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
}

function trimRetryContinuationContext(text: string): string {
  const byLines = text.split('\n').slice(-MAX_RETRY_CONTEXT_LINES).join('\n');
  const chars = Array.from(byLines);
  if (chars.length <= RETRY_CONTEXT_LIMIT) return byLines;
  return [
    '...（前文已截断，以下保留末尾上下文）',
    chars.slice(-RETRY_CONTEXT_LIMIT).join(''),
  ].join('\n');
}

function shouldAutoRetrySessionRun(input: {
  attempt: number;
  exitCode: number;
  stderr: string;
  diagnostic: string | null;
}): boolean {
  return input.attempt < MAX_SESSION_RUNTIME_AUTO_RETRIES &&
    input.exitCode !== 0 &&
    !input.stderr.trim() &&
    Boolean(input.diagnostic?.trim());
}

function runtimeExitFailureDiagnostic(exitCode: number): string | null {
  if (exitCode === 0) return null;
  return `Session runtime exited with code ${exitCode} without error output.`;
}

function recordSessionAutoRetry(input: {
  sessionId: string;
  runId: string;
  agentId: string;
  attempt: number;
  diagnostic: string | null;
}): void {
  const updated = sessionRunRepo.updateStatus(input.runId, 'retrying');
  if (updated) {
    wsHub.broadcastSession(input.sessionId, {
      type: 'session_run:updated',
      sessionId: input.sessionId,
      run: updated,
    });
  }
  const event = sessionEvidenceRepo.create({
    session_id: input.sessionId,
    event_type: 'status',
    severity: 'warning',
    source_run_id: input.runId,
    title: 'Session run auto retry',
    summary: input.diagnostic,
    payload: {
      run_id: input.runId,
      agent_id: input.agentId,
      attempt: input.attempt + 1,
      next_attempt: input.attempt + 2,
    },
  });
  wsHub.broadcastSession(input.sessionId, { type: 'session_evidence:new', sessionId: input.sessionId, event });
  broadcastActiveSessionUpsert(input.sessionId);
}

function extractFailureDiagnosticFromChunk(chunk: AcpStreamChunk): string | null {
  const rawDiagnostic = extractFailureDiagnosticFromRawEvent(chunk.rawEvent);
  if (rawDiagnostic) return rawDiagnostic;
  if (chunk.trace?.kind === 'tool' || chunk.trace?.kind === 'command') {
    const output = 'output' in chunk.trace ? chunk.trace.output : null;
    return normalizeFailureDiagnostic(typeof output === 'string' ? output : null, false);
  }
  return normalizeFailureDiagnostic(chunk.stream === 'stderr' ? chunk.text : null, false);
}

function extractFailureDiagnosticFromRawEvent(rawEvent: unknown): string | null {
  const raw = record(rawEvent);
  const permissionDiagnostic = extractPermissionFailureDiagnostic(raw);
  if (permissionDiagnostic) return permissionDiagnostic;
  const params = record(raw?.params);
  const update = record(params?.update);
  const rawOutput = record(update?.rawOutput) ?? record(update?.output);
  const exitCode = firstFiniteNumber(rawOutput?.exit_code, rawOutput?.exitCode);
  const status = firstNonEmptyString(update?.status, rawOutput?.status);
  const text = firstNonEmptyString(
    rawOutput?.stderr,
    rawOutput?.error,
    rawOutput?.output,
    rawOutput?.aggregated_output,
    rawOutput?.formatted_output,
    extractAcpContentText(update?.content),
  );
  const failed = (exitCode !== null && exitCode !== 0) ||
    status === 'failed' ||
    status === 'error' ||
    looksLikeFailureDiagnostic(text);
  return normalizeFailureDiagnostic(text, failed);
}

function extractPermissionFailureDiagnostic(raw: Record<string, unknown> | null): string | null {
  if (!raw || raw.type !== 'permission_request' || raw.outcome !== 'cancelled') return null;
  const reason = firstNonEmptyString(raw.reason) ?? 'cancelled';
  const toolCall = record(raw.toolCall);
  const command = firstNonEmptyString(
    toolCall?.title,
    commandTextFromRawInput(toolCall?.rawInput),
  );
  const detail = command ? `: ${command}` : '';
  return trimEvidenceText(`Permission request cancelled: ${reason}${detail}`);
}

function commandTextFromRawInput(rawInput: unknown): string | null {
  const raw = record(rawInput);
  const command = raw?.command;
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return typeof command === 'string' ? command : null;
}

function extractAcpContentText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractAcpContentText(item))
      .filter((part): part is string => Boolean(part?.trim()));
    return parts.join('\n').trim() || null;
  }
  const item = record(value);
  if (!item) return null;
  return firstNonEmptyString(
    item.text,
    record(item.content)?.text,
    extractAcpContentText(item.content),
    extractAcpContentText(item.output),
  );
}

function normalizeFailureDiagnostic(text: string | null | undefined, failed: boolean): string | null {
  if (!text?.trim()) return null;
  if (!failed && !looksLikeFailureDiagnostic(text)) return null;
  const stripped = text
    .trim()
    .replace(/^```[A-Za-z0-9_-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  return trimEvidenceText(stripped);
}

function looksLikeFailureDiagnostic(text: string | null | undefined): boolean {
  return Boolean(text && /(Error:|Unhandled|Exception|failed|failure|EPERM|EACCES|ENOENT|operation not permitted|exit code [1-9])/i.test(text));
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
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
  runSnapshot: SessionRun;
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
  if (!updated) {
    if (shouldQuietlyFinishDeletedCancelledRun(input.runId, input.status)) {
      return buildDeletedCancelledRunSnapshot(input.runSnapshot, input.error);
    }
    throw new Error(`Session run ${input.runId} not found`);
  }
  if (!sessionRepo.get(updated.session_id)) {
    if (shouldQuietlyFinishDeletedCancelledRun(input.runId, input.status)) {
      return buildDeletedCancelledRunSnapshot(updated, input.error);
    }
    throw new Error(`Session ${updated.session_id} not found for run ${input.runId}`);
  }
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

function shouldQuietlyFinishDeletedCancelledRun(runId: string, status: SessionRunStatus): boolean {
  return status === 'cancelled' && runRegistry.getAbortReason(runId) === 'cancelled';
}

function buildDeletedCancelledRunSnapshot(run: SessionRun, error: string | null | undefined): SessionRun {
  const timestamp = now();
  return {
    ...run,
    status: 'cancelled',
    error: error ?? run.error,
    updated_at: timestamp,
    completed_at: timestamp,
  };
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
