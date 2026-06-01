import { taskRepo } from './repos/tasks.js';
import type { RouteResult, Task } from './types.js';

const explicitTaskPatterns = [
  /@task:([\p{L}\p{N}_-]+)/iu,
  /#task:([\p{L}\p{N}_-]+)/iu,
  /(^|[\s([{（【])#([\p{L}\p{N}_-]{4,})\b/iu,
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
  const explicitTaskId = extractExplicitTaskId(message, input.roomId);
  if (explicitTaskId.reference) {
    const task = explicitTaskId.taskId ? taskRepo.get(explicitTaskId.taskId) : null;
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
      return {
        taskId: task.id,
        action: 'append_to_task',
        confidence: 1,
        reason: `显式任务引用：${task.id}`,
        reason_code: 'explicit_task',
      };
    }
    return {
      taskId: null,
      action: 'ask_user',
      confidence: 0,
      reason: `显式任务引用不存在、不唯一或不属于当前房间：${explicitTaskId.reference}`,
      reason_code: 'explicit_task_not_found',
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
  if (looksLikeCreateTaskCommand(message)) {
    return {
      taskId: null,
      action: 'ask_user',
      confidence: 0,
      reason: '新任务命令缺少任务标题',
      reason_code: 'create_task_intent',
    };
  }

  return {
    taskId: null,
    action: 'reply_in_chat',
    confidence: 0,
    reason: '未显式引用任务，按全局聊天回复',
    reason_code: 'reply_in_chat',
  };
}

function extractExplicitTaskId(message: string, roomId: string): { reference: string | null; taskId: string | null } {
  for (const pattern of explicitTaskPatterns) {
    const match = pattern.exec(message);
    const reference = match?.[2] ?? match?.[1];
    if (reference) {
      return {
        reference,
        taskId: resolveExplicitTaskId(roomId, reference),
      };
    }
  }
  return { reference: null, taskId: null };
}

function resolveExplicitTaskId(roomId: string, reference: string): string | null {
  const exact = taskRepo.get(reference);
  if (exact?.room_id === roomId) return exact.id;
  const matches = taskRepo.listByRoom(roomId).filter((task) => task.id.startsWith(reference));
  return matches.length === 1 ? matches[0]!.id : null;
}

function isRoutableTask(task: Task): boolean {
  return task.status === 'todo' || task.status === 'in_progress' || task.status === 'review';
}

function looksLikeCreateTaskIntent(message: string): boolean {
  return looksLikeCreateTaskCommand(message) && extractCreateTaskTitle(message) !== null;
}

function looksLikeCreateTaskCommand(message: string): boolean {
  return createTaskPatterns.some((pattern) => pattern.test(message));
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
