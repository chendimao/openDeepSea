import type { SessionEvidenceType, StatusSnapshot } from '../lib/types';

export function formatSessionAge(now: number, timestamp: number): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function contextPressureLabel(pressure: StatusSnapshot['context']['pressure']): string {
  if (pressure === 'high') return '上下文压力高';
  if (pressure === 'medium') return '上下文压力中';
  return '上下文压力低';
}

export function pressureTone(pressure: StatusSnapshot['context']['pressure']): 'ok' | 'warn' | 'danger' {
  if (pressure === 'high') return 'danger';
  if (pressure === 'medium') return 'warn';
  return 'ok';
}

export function evidenceTypeLabel(type: SessionEvidenceType | string): string {
  const labels: Record<string, string> = {
    message: '消息',
    tool_call: '工具调用',
    tool_result: '工具结果',
    file_read: '文件读取',
    file_diff: '文件变更',
    test: '测试',
    build: '构建',
    browser_check: '浏览器验证',
    review: '审查',
    commit: '提交',
    compact: '压缩',
    checkpoint: '检查点',
    blocker: '阻塞',
    new: '新会话',
    resume: '恢复',
    fork: '分叉',
    status: '状态',
  };
  return labels[type] ?? type;
}

export function sessionStatusTone(status: string): 'ok' | 'warn' | 'danger' | undefined {
  if (status === 'completed' || status === 'active') return 'ok';
  if (status === 'blocked') return 'warn';
  if (status === 'failed') return 'danger';
  return undefined;
}
