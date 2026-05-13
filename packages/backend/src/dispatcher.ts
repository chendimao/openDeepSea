import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import { getAdapter } from './acp/index.js';
import { gatewayClient } from './openclaw/gateway.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { messageRepo } from './repos/messages.js';
import { projectRepo } from './repos/projects.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { runRegistry } from './run-registry.js';
import { wsHub } from './ws-hub.js';
import type { AgentRun, AgentRunStatus, Message, RoomAgent, WorkflowStage } from './types.js';

const OPENCLAW_RESPONSE_TIMEOUT_MS = 120000;

/**
 * Dispatch an incoming user message to the agents selected by project routing.
 * - Mentioned agents are notified directly.
 * - Messages without mentions either stay silent or go to the configured fallback agent.
 * - ACP-enabled agents call their CLI; others go through the OpenClaw gateway.
 */
export async function dispatchUserMessage(args: {
  roomId: string;
  userMessage: Message;
  mentionedAgentRoomIds?: string[];
}): Promise<void> {
  const { roomId, userMessage } = args;
  const room = roomRepo.get(roomId);
  if (!room) return;
  const project = projectRepo.get(room.project_id);
  if (!project) return;
  const allAgents = roomAgentRepo.listByRoom(roomId);
  const mentionedIds = new Set(args.mentionedAgentRoomIds ?? []);
  const explicitlyMentionedAgents = allAgents.filter((agent) => mentionedIds.has(agent.id));
  const routing = resolveInitialTargets({
    allAgents,
    explicitlyMentionedAgents,
    fallbackAgentId: project.fallback_agent_id,
    mode: project.message_routing_mode,
    prompt: userMessage.content,
  });
  if (routing.targets.length === 0) return;

  const responses = await runTargets({
    targets: routing.targets,
    projectPath: project.path,
    roomId,
  });

  const fallbackTarget = routing.targets[0];
  const fallbackResponse = responses[0]?.content;
  if (routing.after === 'route_from_fallback' && fallbackTarget && fallbackResponse) {
    const selectedAgents = selectAgentsFromFallbackResponse(fallbackResponse, allAgents, fallbackTarget.agent);
    if (selectedAgents.length === 0) return;
    const handoffPrompt = buildFallbackHandoffPrompt({
      userPrompt: userMessage.content,
      fallbackAgentName: fallbackTarget.agent.agent_name,
      fallbackResponse,
    });
    await runTargets({
      targets: selectedAgents.map((agent) => ({ agent, prompt: handoffPrompt })),
      projectPath: project.path,
      roomId,
    });
  }
}

async function runTargets(args: {
  targets: { agent: RoomAgent; prompt: string }[];
  projectPath: string;
  roomId: string;
}): Promise<Array<Message | undefined>> {
  return Promise.all(
    args.targets.map(async (target) => {
      let finalMessage: Message | undefined;
      await respondAsAgent({
        agent: target.agent,
        projectPath: args.projectPath,
        roomId: args.roomId,
        prompt: target.prompt,
        onFinished: ({ message }) => {
          finalMessage = message;
        },
      }).catch((err) => {
        const errMsg = messageRepo.create({
          room_id: args.roomId,
          sender_type: 'system',
          sender_id: 'system',
          sender_name: 'System',
          content: `Agent ${target.agent.agent_name} failed: ${(err as Error).message}`,
          message_type: 'system',
        });
        wsHub.broadcast(args.roomId, { type: 'message:new', roomId: args.roomId, message: errMsg });
        finalMessage = undefined;
      });
      return finalMessage;
    }),
  );
}

function resolveInitialTargets(args: {
  allAgents: RoomAgent[];
  explicitlyMentionedAgents: RoomAgent[];
  fallbackAgentId: string | null;
  mode: 'mentions_only' | 'fallback_reply' | 'fallback_route';
  prompt: string;
}): { targets: { agent: RoomAgent; prompt: string }[]; after?: 'route_from_fallback' } {
  if (args.explicitlyMentionedAgents.length > 0) {
    return {
      targets: args.explicitlyMentionedAgents.map((agent) => ({ agent, prompt: args.prompt })),
    };
  }
  if (args.mode === 'mentions_only' || !args.fallbackAgentId) return { targets: [] };
  const fallbackAgent = args.allAgents.find((agent) => agent.agent_id === args.fallbackAgentId);
  if (!fallbackAgent) return { targets: [] };
  const prompt =
    args.mode === 'fallback_route'
      ? buildFallbackRoutingPrompt(args.prompt, args.allAgents, fallbackAgent)
      : args.prompt;
  return {
    targets: [{ agent: fallbackAgent, prompt }],
    after: args.mode === 'fallback_route' ? 'route_from_fallback' : undefined,
  };
}

function buildFallbackRoutingPrompt(
  userPrompt: string,
  allAgents: RoomAgent[],
  fallbackAgent: RoomAgent,
): string {
  const agents = allAgents
    .filter((agent) => agent.id !== fallbackAgent.id)
    .map((agent) => {
      const role = agent.agent_role?.trim() ? `职责：${agent.agent_role.trim()}` : '职责：未填写';
      return `- @${agent.agent_name} (${agent.agent_id})：${role}`;
    })
    .join('\n');
  const agentList = agents || '- 当前聊天室没有其他可路由的智能体。';

  return [
    '你是当前项目聊天室的兜底调度智能体。',
    '请先判断用户消息是否需要其他智能体参与。',
    '如果问题可以由你直接回答，请直接回答，并说明你没有转派。',
    '如果需要转派，请在回复开头列出应当 @ 的智能体，格式为“建议协作：@AgentA @AgentB”，然后给出每个智能体应处理的具体事项。',
    '系统会读取“建议协作”里的 @ 智能体并启动它们；不要伪造其他智能体的回复。',
    '',
    '可用智能体：',
    agentList,
    '',
    '用户消息：',
    userPrompt,
  ].join('\n');
}

function selectAgentsFromFallbackResponse(
  fallbackResponse: string,
  allAgents: RoomAgent[],
  fallbackAgent: RoomAgent,
): RoomAgent[] {
  const firstLines = fallbackResponse.split('\n').slice(0, 6).join('\n');
  const mentionedNames = new Set(
    Array.from(firstLines.matchAll(/@([\p{L}\p{N}_.-]+)/gu)).map((match) => match[1]),
  );
  if (mentionedNames.size === 0) return [];
  const selected = allAgents.filter(
    (agent) =>
      agent.id !== fallbackAgent.id &&
      (mentionedNames.has(agent.agent_name) || mentionedNames.has(agent.agent_id)),
  );
  return selected.filter((agent, index) => selected.findIndex((item) => item.id === agent.id) === index);
}

function buildFallbackHandoffPrompt(args: {
  userPrompt: string;
  fallbackAgentName: string;
  fallbackResponse: string;
}): string {
  return [
    `${args.fallbackAgentName} 已将这条用户消息分派给你协作处理。`,
    '请只围绕你的职责给出回答、方案或执行建议；如果这是开发任务，请明确你负责的部分、改动边界和需要与其他智能体对齐的接口。',
    '',
    '用户原始消息：',
    args.userPrompt,
    '',
    `${args.fallbackAgentName} 的调度说明：`,
    args.fallbackResponse,
  ].join('\n');
}

export async function respondAsAgent(args: {
  agent: RoomAgent;
  projectPath: string;
  roomId: string;
  prompt: string;
  taskId?: string | null;
  workflowRunId?: string | null;
  workflowStepId?: string | null;
  workflowStage?: WorkflowStage | null;
  onRunCreated?: (run: AgentRun) => Promise<void> | void;
  onFinished?: (result: { run: AgentRun; message: Message; status: AgentRunStatus }) => Promise<void> | void;
}): Promise<void> {
  const { agent, projectPath, roomId, prompt } = args;
  const backend = agent.acp_enabled && agent.acp_backend ? agent.acp_backend : 'openclaw';
  const sessionKey = backend === 'openclaw' ? `agent:${agent.agent_id}:room-${roomId}` : null;
  const run = agentRunRepo.create({
    room_id: roomId,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend,
    session_key: sessionKey,
    acp_session_id: agent.acp_session_id,
    task_id: args.taskId,
    workflow_run_id: args.workflowRunId,
    workflow_step_id: args.workflowStepId,
    workflow_stage: args.workflowStage,
    prompt,
  });
  const controller = runRegistry.create(run.id);
  broadcastRun('agent_run:created', run);
  if (args.onRunCreated) {
    try {
      await args.onRunCreated(run);
    } catch (err) {
      console.warn(`[agent-runs] onRunCreated callback failed for ${run.id}: ${(err as Error).message}`);
    }
  }

  // Create a placeholder agent message that will be filled by streaming chunks.
  const placeholder = messageRepo.create({
    room_id: roomId,
    sender_type: 'agent',
    sender_id: agent.agent_id,
    sender_name: agent.agent_name,
    content: '',
    message_type: 'agent_stream',
    metadata: {
      acp_enabled: !!agent.acp_enabled,
      acp_backend: agent.acp_backend,
      acp_session_id: agent.acp_session_id,
    },
  });
  wsHub.broadcast(roomId, { type: 'message:new', roomId, message: placeholder });

  const onStdout = (chunk: string): void => {
    messageRepo.appendChunk(placeholder.id, chunk);
    const updated = agentRunRepo.appendStdout(run.id, chunk);
    if (updated) broadcastRun('agent_run:updated', updated);
    wsHub.broadcast(roomId, {
      type: 'message:stream',
      roomId,
      messageId: placeholder.id,
      chunk,
      done: false,
    });
  };

  const onStderr = (chunk: string): void => {
    const updated = agentRunRepo.appendStderr(run.id, chunk);
    if (updated) broadcastRun('agent_run:updated', updated);
  };

  try {
    if (agent.acp_enabled && agent.acp_backend) {
      const adapter = getAdapter(agent.acp_backend);
      const result = await adapter.invoke({
        projectPath,
        sessionId: agent.acp_session_id,
        prompt,
        onChunk: (chunk) => {
          if (chunk.stream === 'stdout') onStdout(chunk.text);
          else onStderr(chunk.text);
        },
        signal: controller.signal,
      });
      if (result.sessionId) {
        const updated = agentRunRepo.updateStatus(run.id, 'running', {
          acp_session_id: result.sessionId,
        });
        if (updated) broadcastRun('agent_run:updated', updated);
      }
      // Persist newly minted session id if previously null
      if (!agent.acp_session_id && result.sessionId) {
        roomAgentRepo.setAcp(agent.id, {
          acp_enabled: true,
          acp_backend: agent.acp_backend,
          acp_session_id: result.sessionId,
          acp_session_label: agent.acp_session_label,
        });
      }
      if (controller.signal.aborted) {
        finishRun(run.id, 'cancelled');
      } else if (result.exitCode === 0) {
        finishRun(run.id, 'completed');
      } else {
        const error = result.stderr || `Process exited with code ${result.exitCode}`;
        finishRun(run.id, 'failed', error);
      }
    } else {
      await ensureOpenClawSession({
        agentId: agent.agent_id,
        sessionKey: sessionKey!,
      });
      await gatewayClient.subscribeSessionEvents();
      const result = await streamOpenClawResponse({
        agentId: agent.agent_id,
        sessionKey: sessionKey!,
        prompt,
        signal: controller.signal,
        onChunk: onStdout,
        onError: onStderr,
      });
      if (result.status === 'cancelled') {
        finishRun(run.id, 'cancelled');
      } else if (result.status === 'failed') {
        finishRun(run.id, 'failed', result.error);
      } else {
        finishRun(run.id, 'completed');
      }
    }
  } catch (err) {
    const status: AgentRunStatus = controller.signal.aborted ? 'cancelled' : 'failed';
    const message = (err as Error).message;
    if (backend === 'openclaw') onStdout(`\n[gateway error] ${message}`);
    else onStderr(`\n[error] ${message}`);
    finishRun(run.id, status, status === 'failed' ? message : null);
  } finally {
    runRegistry.remove(run.id);
    const finalRun = agentRunRepo.get(run.id);
    const finalMessage = messageRepo.get(placeholder.id);
    try {
      if (finalRun && finalMessage && args.onFinished) {
        try {
          await args.onFinished({ run: finalRun, message: finalMessage, status: finalRun.status });
        } catch (err) {
          console.warn(`[agent-runs] onFinished callback failed for ${finalRun.id}: ${(err as Error).message}`);
        }
      }
    } finally {
      wsHub.broadcast(roomId, {
        type: 'message:stream',
        roomId,
        messageId: placeholder.id,
        chunk: '',
        done: true,
      });
    }
  }

  function broadcastRun(type: 'agent_run:created' | 'agent_run:updated', updatedRun: AgentRun): void {
    wsHub.broadcast(roomId, { type, roomId, run: updatedRun });
  }

  function finishRun(id: string, status: AgentRunStatus, error?: string | null): void {
    const updated = agentRunRepo.updateStatus(id, status, { error: error ?? null });
    if (updated) broadcastRun('agent_run:updated', updated);
  }
}

async function ensureOpenClawSession(args: {
  agentId: string;
  sessionKey: string;
}): Promise<void> {
  try {
    await gatewayClient.spawnSession(args);
  } catch (err) {
    const message = (err as Error).message.toLowerCase();
    if (message.includes('already') && message.includes('exist')) return;
    throw err;
  }
}

async function streamOpenClawResponse(args: {
  agentId: string;
  sessionKey: string;
  prompt: string;
  signal: AbortSignal;
  onChunk: (chunk: string) => void;
  onError: (chunk: string) => void;
}): Promise<{ status: 'completed' | 'failed' | 'cancelled'; error?: string }> {
  let runId = '';
  let lastSnapshot = '';
  const normalizedSessionKey = args.sessionKey.toLowerCase();
  const idempotencyKey = randomUUID();
  const pendingEvents: GatewayStreamEvent[] = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      unsubscribe?.();
      unsubscribe = null;
      args.signal.removeEventListener('abort', onAbort);
    };

    const settle = (result: { status: 'completed' | 'failed' | 'cancelled'; error?: string }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = (): void => {
      if (!runId) {
        settle({ status: 'cancelled' });
        return;
      }
      void gatewayClient
        .abortChat({ sessionKey: args.sessionKey, runId })
        .then(() => settle({ status: 'cancelled' }))
        .catch((err) => {
          args.onError(`\n[gateway abort error] ${(err as Error).message}`);
          settle({ status: 'cancelled' });
        });
    };

    timeout = setTimeout(() => {
      settle({ status: 'failed', error: 'OpenClaw response timeout' });
    }, OPENCLAW_RESPONSE_TIMEOUT_MS);

    unsubscribe = gatewayClient.onEvent(({ event, payload }) => {
      const p = asRecord(payload);
      if (!p) return;
      const eventSessionKey = extractSessionKey(p);
      if (eventSessionKey.toLowerCase() !== normalizedSessionKey) return;

      const payloadRunId = typeof p.runId === 'string' ? p.runId : '';
      if (!runId) {
        if (payloadRunId) pendingEvents.push({ event, payload: p });
        return;
      }
      if (payloadRunId !== runId) return;

      handleGatewayStreamEvent({ event, payload: p });
    });

    const handleGatewayStreamEvent = ({ event, payload: p }: GatewayStreamEvent): void => {
      if (event === 'agent') {
        const stream = typeof p.stream === 'string' ? p.stream : '';
        const data = asRecord(p.data);

        if (stream === 'lifecycle') {
          const phase = typeof data?.phase === 'string' ? data.phase : '';
          if (phase === 'end') settle({ status: 'completed' });
          else if (phase === 'error') {
            const error = extractGatewayText(data ?? p) || 'OpenClaw agent run failed';
            settle({ status: 'failed', error });
          } else if (phase === 'abort') {
            settle({ status: 'cancelled' });
          }
        }
        return;
      }

      if (event === 'chat') {
        const state = typeof p.state === 'string' ? p.state : '';
        if (state === 'delta') {
          const text = extractGatewayText(p);
          if (!text) return;
          appendSnapshotDelta(text);
        } else if (state === 'final') {
          const text = extractGatewayText(p);
          if (text) {
            appendSnapshotDelta(text);
          }
          settle({ status: 'completed' });
        } else if (state === 'error') {
          const error = extractGatewayText(p) || 'OpenClaw chat failed';
          settle({ status: 'failed', error });
        }
      }
    };

    const replayPendingEvents = (): void => {
      if (!runId) return;
      const events = pendingEvents.splice(0);
      for (const item of events) {
        const payloadRunId = typeof item.payload.runId === 'string' ? item.payload.runId : '';
        if (payloadRunId === runId) handleGatewayStreamEvent(item);
      }
    };

    args.signal.addEventListener('abort', onAbort, { once: true });

    gatewayClient
      .sendToAgent({
        agentId: args.agentId,
        sessionKey: args.sessionKey,
        text: args.prompt,
        idempotencyKey,
      })
      .then((res) => {
        if (res.runId) runId = res.runId;
        replayPendingEvents();
        if (args.signal.aborted) {
          onAbort();
        } else if (!runId) {
          settle({ status: 'failed', error: 'OpenClaw chat.send did not return runId' });
        }
      })
      .catch(fail);
  });

  function appendSnapshotDelta(textOrSnapshot: string): void {
    if (!textOrSnapshot) return;
    if (textOrSnapshot.startsWith(lastSnapshot)) {
      const delta = textOrSnapshot.slice(lastSnapshot.length);
      if (delta) args.onChunk(delta);
      lastSnapshot = textOrSnapshot;
      return;
    }
    args.onChunk(textOrSnapshot);
    lastSnapshot += textOrSnapshot;
  }
}

interface GatewayStreamEvent {
  event: string;
  payload: Record<string, unknown>;
}

/** Forward gateway agent messages back into the appropriate room. */
export function bindGatewayEvents(): void {
  gatewayClient.onEvent(({ event, payload }) => {
    if (!isGatewayMessageEvent(event)) return;
    const p = payload as Record<string, unknown> | null;
    if (!p) return;
    const sessionKey = extractSessionKey(p);
    const m = sessionKey.match(/^agent:[^:]+:room-([^:]+)$/);
    if (!m) return;
    const roomId = m[1];
    const text = extractGatewayText(p);
    if (!text) return;
    const agentId = String(p['agentId'] ?? p['agent'] ?? 'openclaw');
    const message = messageRepo.create({
      room_id: roomId!,
      sender_type: 'agent',
      sender_id: agentId,
      sender_name: agentId,
      content: text,
      message_type: 'text',
    });
    wsHub.broadcast(roomId!, { type: 'message:new', roomId: roomId!, message });
  });
}

function isGatewayMessageEvent(event: string): boolean {
  return [
    'agent.message',
    'sessions.message',
    'session.message',
    'chat.message',
    'message',
    'chat.delta',
    'session.delta',
  ].includes(event);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function extractSessionKey(payload: Record<string, unknown>): string {
  if (typeof payload.sessionKey === 'string') return payload.sessionKey;
  if (typeof payload.session === 'string') return payload.session;
  const data = payload.data;
  if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).sessionKey === 'string') {
    return (data as Record<string, unknown>).sessionKey as string;
  }
  const message = payload.message;
  if (message && typeof message === 'object') {
    const m = message as Record<string, unknown>;
    if (typeof m.sessionKey === 'string') return m.sessionKey;
  }
  return '';
}

function extractGatewayText(payload: Record<string, unknown>): string {
  if (typeof payload.errorMessage === 'string') return payload.errorMessage;
  if (typeof payload.error === 'string') return payload.error;

  const direct = payload.text ?? payload.content ?? payload.delta;
  if (typeof direct === 'string') return direct;

  const message = payload.message;
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    const m = message as Record<string, unknown>;
    if (typeof m.text === 'string') return m.text;
    if (typeof m.content === 'string') return m.content;
    const content = m.content;
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const block = item as Record<string, unknown>;
          return typeof block.text === 'string' ? block.text : '';
        })
        .filter(Boolean)
        .join('');
    }
  }

  const data = payload.data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (typeof d.text === 'string') return d.text;
    if (typeof d.content === 'string') return d.content;
    if (typeof d.delta === 'string') return d.delta;
    if (typeof d.errorMessage === 'string') return d.errorMessage;
    if (typeof d.error === 'string') return d.error;
  }

  return '';
}

export function newRequestId(): string {
  return nanoid(12);
}
