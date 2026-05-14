import type { MemoryEntry } from '../types.js';

export const MAX_MEMORY_ENTRY_CHARS = 1200;
export const MAX_MEMORY_CONTEXT_CHARS = 6000;

const TYPE_LABEL: Record<MemoryEntry['memory_type'], string> = {
  decision: '决策',
  fact: '事实',
  preference: '偏好',
  lesson: '经验',
  task_summary: '任务总结',
  artifact_summary: '产物摘要',
};

const TRUNCATED_MARKER = '...已截断';

export function formatMemoryContext(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((entry, index) => {
    const pin = entry.pinned ? '；置顶' : '';
    const body = truncateText(`${entry.title}\n${entry.content}`, MAX_MEMORY_ENTRY_CHARS);
    return `${index + 1}. [${TYPE_LABEL[entry.memory_type]}；${entry.scope}${pin}] ${body}`;
  });
  return truncateText(['项目/聊天室记忆：', ...lines].join('\n'), MAX_MEMORY_CONTEXT_CHARS);
}

export function appendMemoryContext(prompt: string, entries: MemoryEntry[]): string {
  const memory = formatMemoryContext(entries);
  if (!memory) return prompt;
  return [memory, '', '当前请求：', prompt].join('\n');
}

export function appendMemoryContextSafely(args: {
  prompt: string;
  loadEntries: () => MemoryEntry[];
  warn?: (message: string) => void;
}): string {
  try {
    return appendMemoryContext(args.prompt, args.loadEntries());
  } catch (err) {
    args.warn?.(`[memory] failed to load memory context: ${(err as Error).message}`);
    return args.prompt;
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - TRUNCATED_MARKER.length))}${TRUNCATED_MARKER}`;
}
