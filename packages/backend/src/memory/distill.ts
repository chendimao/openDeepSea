import { memoryRepo } from '../repos/memory.js';
import { messageRepo } from '../repos/messages.js';
import type { MemoryScope, MemoryType, Message } from '../types.js';

const MAX_CONTEXT_MESSAGES = 12;
const MAX_TASK_MESSAGES = 50;

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

function buildDistillSourceId(sourceId: string, index: number): string {
  return `${sourceId}#distill-${index + 1}`;
}

async function callDistillLLM(_prompt: string, _roomId: string): Promise<string> {
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
    for (const [index, candidate] of candidates.entries()) {
      try {
        memoryRepo.create({
          project_id: projectId,
          room_id: candidate.scope === 'room' ? roomId : undefined,
          scope: candidate.scope,
          memory_type: candidate.memory_type,
          title: candidate.title.slice(0, 100),
          content: candidate.content.slice(0, 1200),
          source_type: 'message',
          source_id: buildDistillSourceId(triggerMessageId, index),
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
    for (const [index, candidate] of candidates.entries()) {
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
          source_id: buildDistillSourceId(sourceId, index),
        });
      } catch (err) {
        console.debug(`[distill] skipped task candidate: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[distill] task distill failed: ${(err as Error).message}`);
  }
}
