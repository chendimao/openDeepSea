import { gatewayClient } from '../openclaw/gateway.js';
import { memoryRepo } from '../repos/memory.js';
import { messageRepo } from '../repos/messages.js';
import type { MemoryScope, MemoryType, Message } from '../types.js';

const DISTILL_SESSION_PREFIX = 'system:distill:room-';
const MAX_CONTEXT_MESSAGES = 12;
const MAX_TASK_MESSAGES = 50;
const DISTILL_RESPONSE_TIMEOUT_MS = 120_000;

interface CandidateMemory {
  scope: MemoryScope;
  memory_type: MemoryType;
  title: string;
  content: string;
}

const REPLY_DISTILL_PROMPT = `你是记忆提取助手。请从以下对话中提取值得长期记住的信息。

规则：
1. 仅提取新的、有价值的信息（决策、经验教训、技术事实、用户偏好）
2. 不要提取日常问候、确认、无信息量的内容
3. 如果没有值得记忆的内容，返回空数组
4. scope 判断：如果信息对整个项目有用，用 "project"；如果仅与当前聊天室相关，用 "room"
5. memory_type 取值：decision（决策）、fact（事实）、preference（偏好）、lesson（经验）
6. 每条记忆 title 不超过 50 字，content 不超过 300 字
7. 最多返回 3 条

已有记忆（避免重复）：
{existingMemories}

最近对话：
{conversation}

请以 JSON 格式返回，不要包含其他内容：
[{"scope": "project"|"room", "memory_type": "decision"|"fact"|"preference"|"lesson", "title": "...", "content": "..."}]

如果没有值得记忆的内容，返回：[]`;

const TASK_DISTILL_PROMPT = `你是记忆提取助手。一个编码任务刚完成验收，请从任务的完整对话中提取值得长期记住的关键信息。

规则：
1. 提取架构决策、技术选型、经验教训、重要事实
2. 不要提取重复内容或无信息量的确认
3. scope 判断：如果信息对整个项目有用（如架构决策、技术选型），用 "project"；仅与当前任务或聊天室相关，用 "room"
4. memory_type 取值：decision（决策）、fact（事实）、preference（偏好）、lesson（经验）
5. 每条记忆 title 不超过 50 字，content 不超过 300 字
6. 最多返回 5 条

任务标题：{taskTitle}
任务总结：{taskSummary}

已有记忆（避免重复）：
{existingMemories}

任务对话：
{conversation}

请以 JSON 格式返回，不要包含其他内容：
[{"scope": "project"|"room", "memory_type": "decision"|"fact"|"preference"|"lesson", "title": "...", "content": "..."}]

如果没有值得记忆的内容，返回：[]`;

function formatMessages(messages: Message[], limit: number): string {
  const recent = messages.slice(-limit);
  return recent
    .map((m) => `[${m.sender_name ?? m.sender_id}] ${(m.content ?? '').slice(0, 500)}`)
    .join('\n');
}

function formatExistingMemories(projectId: string, roomId: string): string {
  try {
    const existing = memoryRepo.list({
      projectId,
      roomId,
      limit: 20,
    });
    if (existing.length === 0) return '（暂无）';
    return existing.map((e) => `- [${e.memory_type}] ${e.title}`).join('\n');
  } catch {
    return '（加载失败）';
  }
}

function parseCandidates(raw: string): CandidateMemory[] {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item: unknown): item is CandidateMemory =>
          typeof item === 'object' &&
          item !== null &&
          'scope' in item &&
          'memory_type' in item &&
          'title' in item &&
          'content' in item &&
          ['project', 'room'].includes((item as CandidateMemory).scope) &&
          ['decision', 'fact', 'preference', 'lesson'].includes((item as CandidateMemory).memory_type),
      )
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function callDistillLLM(prompt: string, roomId: string): Promise<string> {
  const sessionKey = `${DISTILL_SESSION_PREFIX}${roomId}`;
  try {
    await gatewayClient.connect();
    const agents = await gatewayClient.listAgents();
    const agent = agents[0];
    if (!agent) {
      throw new Error('No agents available for distillation');
    }
    const agentId = agent.id;
    await gatewayClient.spawnSession({ agentId, sessionKey }).catch(() => {
      // session may already exist
    });
    return await collectDistillResponse({ agentId, sessionKey, prompt });
  } catch (err) {
    console.warn(`[distill] LLM call failed: ${(err as Error).message}`);
    return '';
  }
}

async function collectDistillResponse(args: {
  agentId: string;
  sessionKey: string;
  prompt: string;
}): Promise<string> {
  let runId = '';
  let lastSnapshot = '';
  let output = '';
  const normalizedSessionKey = args.sessionKey.toLowerCase();
  const pendingEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      unsubscribe?.();
      unsubscribe = null;
    };

    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const appendSnapshotDelta = (textOrSnapshot: string): void => {
      if (!textOrSnapshot) return;
      if (textOrSnapshot.startsWith(lastSnapshot)) {
        output += textOrSnapshot.slice(lastSnapshot.length);
        lastSnapshot = textOrSnapshot;
        return;
      }
      output += textOrSnapshot;
      lastSnapshot += textOrSnapshot;
    };

    const handleGatewayEvent = ({ event, payload }: { event: string; payload: Record<string, unknown> }): void => {
      if (event === 'agent') {
        const stream = typeof payload.stream === 'string' ? payload.stream : '';
        const data = asRecord(payload.data);
        if (stream !== 'lifecycle') return;

        const phase = typeof data?.phase === 'string' ? data.phase : '';
        if (phase === 'end') settle(output);
        else if (phase === 'error') fail(new Error(extractGatewayText(data ?? payload) || 'OpenClaw distill agent failed'));
        else if (phase === 'abort') settle('');
        return;
      }

      if (event !== 'chat') return;
      const state = typeof payload.state === 'string' ? payload.state : '';
      if (state === 'delta') {
        appendSnapshotDelta(extractGatewayText(payload));
      } else if (state === 'final') {
        appendSnapshotDelta(extractGatewayText(payload));
        settle(output);
      } else if (state === 'error') {
        fail(new Error(extractGatewayText(payload) || 'OpenClaw distill chat failed'));
      }
    };

    const replayPendingEvents = (): void => {
      if (!runId) return;
      const events = pendingEvents.splice(0);
      for (const item of events) {
        const payloadRunId = typeof item.payload.runId === 'string' ? item.payload.runId : '';
        if (payloadRunId === runId) handleGatewayEvent(item);
      }
    };

    timeout = setTimeout(() => {
      settle(output);
    }, DISTILL_RESPONSE_TIMEOUT_MS);

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

      handleGatewayEvent({ event, payload: p });
    });

    gatewayClient
      .sendToAgent({
        agentId: args.agentId,
        sessionKey: args.sessionKey,
        text: args.prompt,
      })
      .then((res) => {
        if (res.runId) runId = res.runId;
        replayPendingEvents();
        if (!runId) settle('');
      })
      .catch(fail);
  });
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

/**
 * Distill memories from a recent conversation after an agent reply completes.
 * Runs asynchronously - does not block the agent response.
 */
export async function distillFromConversation(args: {
  projectId: string;
  roomId: string;
  triggerMessageId: string;
}): Promise<void> {
  const { projectId, roomId, triggerMessageId } = args;
  try {
    const messages = messageRepo.listByRoom(roomId, MAX_CONTEXT_MESSAGES * 2);
    const recent = messages.slice(-MAX_CONTEXT_MESSAGES);
    if (recent.length < 2) return;

    const conversation = formatMessages(recent, MAX_CONTEXT_MESSAGES);
    const existingMemories = formatExistingMemories(projectId, roomId);

    const prompt = REPLY_DISTILL_PROMPT
      .replace('{existingMemories}', existingMemories)
      .replace('{conversation}', conversation);

    const response = await callDistillLLM(prompt, roomId);
    if (!response) return;

    const candidates = parseCandidates(response);
    for (const candidate of candidates) {
      try {
        memoryRepo.create({
          project_id: projectId,
          room_id: candidate.scope === 'room' ? roomId : undefined,
          scope: candidate.scope,
          memory_type: candidate.memory_type,
          title: candidate.title.slice(0, 100),
          content: candidate.content.slice(0, 1200),
          source_type: 'message',
          source_id: triggerMessageId,
        });
      } catch (err) {
        // Likely duplicate - skip
        console.debug(`[distill] skipped candidate: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[distill] conversation distill failed: ${(err as Error).message}`);
  }
}

/**
 * Deep distill from a completed task's full conversation.
 * Called after workflow acceptance.
 */
export async function distillFromTask(args: {
  projectId: string;
  roomId: string;
  taskId: string;
  taskTitle: string;
  taskSummary: string;
  sourceId: string;
}): Promise<void> {
  const { projectId, roomId, taskId, taskTitle, taskSummary, sourceId } = args;
  try {
    const messages = messageRepo.listByRoom(roomId, MAX_TASK_MESSAGES * 2);
    if (messages.length < 3) return;

    const conversation = formatMessages(messages, MAX_TASK_MESSAGES);
    const existingMemories = formatExistingMemories(projectId, roomId);

    const prompt = TASK_DISTILL_PROMPT
      .replace('{taskTitle}', taskTitle)
      .replace('{taskSummary}', taskSummary)
      .replace('{existingMemories}', existingMemories)
      .replace('{conversation}', conversation);

    const response = await callDistillLLM(prompt, roomId);
    if (!response) return;

    const candidates = parseCandidates(response);
    for (const candidate of candidates) {
      try {
        memoryRepo.create({
          project_id: projectId,
          room_id: candidate.scope === 'room' ? roomId : undefined,
          task_id: candidate.scope === 'room' ? taskId : undefined,
          scope: candidate.scope === 'project' ? 'project' : 'task',
          memory_type: candidate.memory_type,
          title: candidate.title.slice(0, 100),
          content: candidate.content.slice(0, 1200),
          source_type: 'workflow',
          source_id: sourceId,
        });
      } catch (err) {
        console.debug(`[distill] skipped task candidate: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[distill] task distill failed: ${(err as Error).message}`);
  }
}
