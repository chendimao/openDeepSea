export interface HistorySummaryResult {
  title: string;
  summary: string;
  resumeBrief: string;
  keyDecisions: string[];
}

export function buildHistorySummary(input: {
  goal: string | null;
  messages: Array<{ role: string; content: string }>;
  changedFiles: string[];
  verificationSummary: string | null;
}): HistorySummaryResult {
  const firstUser = input.messages.find((message) => message.role === 'user')?.content.trim() ?? '';
  const title = truncateLine(input.goal || firstUser || '未命名会话', 60);
  const changed = input.changedFiles.length > 0 ? `变更文件：${input.changedFiles.join(', ')}` : '变更文件：无';
  const verification = input.verificationSummary ?? '最近验证：未知';
  const summary = [truncateLine(firstUser, 180), changed, verification].filter(Boolean).join('\n');
  const resumeBrief = [
    `目标：${input.goal ?? title}`,
    `已完成：${summary}`,
    '未完成：请先运行 /status 对齐当前状态。',
    `优先读取文件：${input.changedFiles.slice(0, 8).join(', ') || '无'}`,
  ].join('\n');
  return { title, summary, resumeBrief, keyDecisions: [] };
}

export function truncateLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
