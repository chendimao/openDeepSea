import { taskRepo } from './repos/tasks.js';
import type { RouteResult, Task } from './types.js';

const explicitTaskPatterns = [
  /@task:([\p{L}\p{N}_-]+)/iu,
  /#task:([\p{L}\p{N}_-]+)/iu,
];

const createTaskPatterns = [
  /(?:新建|创建|新增)\s*任务[:：]/u,
  /^\/task\b/u,
];

export function routeMessage(input: {
  roomId: string;
  message: string;
  activeTaskId?: string | null;
}): RouteResult {
  const message = input.message.trim();
  const explicitTaskId = extractExplicitTaskId(message);
  if (explicitTaskId) {
    const task = taskRepo.get(explicitTaskId);
    if (task && task.room_id === input.roomId) {
      if (!isRoutableTask(task)) {
        return {
          taskId: null,
          action: 'ask_user',
          confidence: 0,
          reason: `显式任务引用不可接收新消息：${task.id}（${task.status}）`,
          reason_code: 'explicit_task_terminal',
        };
      }
      const shouldSwitchTask = Boolean(input.activeTaskId && input.activeTaskId !== task.id && isRoutableTask(task));
      return {
        taskId: task.id,
        action: shouldSwitchTask ? 'switch_task' : 'append_to_task',
        confidence: 1,
        reason: shouldSwitchTask ? `显式任务引用，切换到任务：${task.id}` : `显式任务引用：${task.id}`,
        reason_code: 'explicit_task',
      };
    }
    return {
      taskId: null,
      action: 'ask_user',
      confidence: 0,
      reason: `显式任务引用不存在或不属于当前房间：${explicitTaskId}`,
      reason_code: 'explicit_task_not_found',
    };
  }

  if (input.activeTaskId) {
    const activeTask = taskRepo.get(input.activeTaskId);
    if (activeTask && activeTask.room_id === input.roomId && isRoutableTask(activeTask)) {
      return {
        taskId: activeTask.id,
        action: 'append_to_task',
        confidence: 0.9,
        reason: `使用当前激活任务：${activeTask.title}`,
        reason_code: 'active_task',
      };
    }
  }

  const matched = findBestTaskMatch(input.roomId, message);
  if (matched && matched.confidence >= 0.65) {
    return {
      taskId: matched.task.id,
      action: 'append_to_task',
      confidence: matched.confidence,
      reason: `标题匹配任务：${matched.task.title}`,
      reason_code: 'title_match',
    };
  }

  if (looksLikeCreateTaskIntent(message)) {
    return {
      taskId: null,
      action: 'create_task',
      confidence: 0.8,
      reason: '消息表达了明确的新任务意图',
      reason_code: 'create_task_intent',
    };
  }

  return {
    taskId: null,
    action: 'ask_user',
    confidence: 0,
    reason: '无法确定消息应归属哪个任务',
    reason_code: 'ambiguous',
  };
}

function extractExplicitTaskId(message: string): string | null {
  for (const pattern of explicitTaskPatterns) {
    const match = pattern.exec(message);
    if (match?.[1]) return match[1];
  }
  return null;
}

function findBestTaskMatch(roomId: string, message: string): { task: Task; confidence: number } | null {
  const messageTokens = tokenize(message);
  if (messageTokens.length === 0) return null;

  let best: { task: Task; confidence: number } | null = null;
  for (const task of taskRepo.listByRoom(roomId)) {
    if (!isRoutableTask(task)) continue;
    const titleTokens = tokenize(task.title);
    if (titleTokens.length === 0) continue;
    const hitCount = titleTokens.filter((token) => messageTokens.includes(token)).length;
    if (hitCount === 0) continue;
    const confidence = Math.min(0.95, 0.55 + hitCount / titleTokens.length);
    if (!best || confidence > best.confidence) {
      best = { task, confidence };
    }
  }
  return best;
}

function isRoutableTask(task: Task): boolean {
  return task.status === 'todo' || task.status === 'in_progress' || task.status === 'review';
}

function tokenize(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const wordTokens = normalized
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return [...new Set([...wordTokens, ...cjkBigrams(normalized.replace(/\s+/gu, ''))])];
}

function cjkBigrams(value: string): string[] {
  if (!/[\p{Script=Han}]/u.test(value)) return [];
  const chars = Array.from(value);
  const grams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = `${chars[index]}${chars[index + 1]}`;
    if (/[\p{Script=Han}]/u.test(gram)) grams.push(gram);
  }
  return grams;
}

function looksLikeCreateTaskIntent(message: string): boolean {
  return createTaskPatterns.some((pattern) => pattern.test(message)) && extractCreateTaskTitle(message) !== null;
}

export function extractCreateTaskTitle(message: string): string | null {
  const trimmed = message.trim();
  const chinese = /(?:新建|创建|新增)\s*任务[:：]\s*([^\r\n]+)/u.exec(trimmed);
  if (chinese?.[1]?.trim()) return truncateTaskTitle(firstContentLine(chinese[1]));
  const slash = /^\/task\b\s*([^\r\n]+)/u.exec(trimmed);
  if (slash?.[1]?.trim()) return truncateTaskTitle(firstContentLine(slash[1]));
  return null;
}

function firstContentLine(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

function truncateTaskTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157).trimEnd()}...`;
}
