import { createHash } from 'node:crypto';
import type {
  Session,
  SessionContextSourceType,
  SessionMessage,
} from './types.js';

export interface ContextSourceDraft {
  source_type: SessionContextSourceType;
  source_ref: string | null;
  title: string;
  included: 0 | 1;
  priority: number;
  token_estimate: number;
  reason: string;
  excerpt: string;
  content_hash: string;
  metadata: Record<string, unknown>;
}

export interface ContextManifestDraft {
  totalTokenEstimate: number;
  sources: ContextSourceDraft[];
}

export function buildContextManifestDraft(input: {
  session: Session;
  agentsText: string | null;
  rtkText: string | null;
  compactSummary: string | null;
  historyBriefs: Array<{ id: string; title: string; resume_brief: string }>;
  recentMessages: SessionMessage[];
  explicitFiles: Array<{ path: string; excerpt: string }>;
  gitDiff: string | null;
}): ContextManifestDraft {
  const sources: ContextSourceDraft[] = [];
  pushSource(sources, 'agents', 'AGENTS.md', input.agentsText, '项目与个人 agent 规则');
  pushSource(sources, 'rtk', 'RTK.md', input.rtkText, '本机 RTK 命令约束');
  pushSource(sources, 'compact', 'Latest Compact', input.compactSummary, '当前 session 已应用 compact');
  for (const history of input.historyBriefs) {
    pushSource(sources, 'history', history.title, history.resume_brief, `恢复历史记录 ${history.id}`, {
      source_ref: history.id,
    });
  }
  for (const message of input.recentMessages.slice(-20)) {
    pushSource(sources, 'user_message', `${message.role}:${message.id}`, message.content, '最近会话消息', {
      source_ref: message.id,
      metadata: { role: message.role },
    });
  }
  for (const file of input.explicitFiles) {
    pushSource(sources, 'file', file.path, file.excerpt, '用户显式引用文件', { source_ref: file.path });
  }
  pushSource(sources, 'diff', 'git diff', input.gitDiff, '当前未提交 diff');
  return {
    totalTokenEstimate: sources.reduce((sum, source) => sum + source.token_estimate, 0),
    sources,
  };
}

function pushSource(
  sources: ContextSourceDraft[],
  sourceType: SessionContextSourceType,
  title: string,
  content: string | null,
  reason: string,
  options: { source_ref?: string | null; metadata?: Record<string, unknown> } = {},
): void {
  const excerpt = content?.trim();
  if (!excerpt) return;
  sources.push({
    source_type: sourceType,
    source_ref: options.source_ref ?? null,
    title,
    included: 1,
    priority: sources.length + 1,
    token_estimate: estimateTokens(excerpt),
    reason,
    excerpt,
    content_hash: hashContent(excerpt),
    metadata: options.metadata ?? {},
  });
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function hashContent(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
