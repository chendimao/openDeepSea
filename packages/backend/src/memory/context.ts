import type { MemoryEntry } from '../types.js';

const TYPE_LABEL: Record<MemoryEntry['memory_type'], string> = {
  decision: '决策',
  fact: '事实',
  preference: '偏好',
  lesson: '经验',
  task_summary: '任务总结',
  artifact_summary: '产物摘要',
};

export function formatMemoryContext(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((entry, index) => {
    const pin = entry.pinned ? '；置顶' : '';
    return `${index + 1}. [${TYPE_LABEL[entry.memory_type]}；${entry.scope}${pin}] ${entry.title}\n${entry.content}`;
  });
  return ['项目/聊天室记忆：', ...lines].join('\n');
}

export function appendMemoryContext(prompt: string, entries: MemoryEntry[]): string {
  const memory = formatMemoryContext(entries);
  if (!memory) return prompt;
  return [memory, '', '当前请求：', prompt].join('\n');
}
