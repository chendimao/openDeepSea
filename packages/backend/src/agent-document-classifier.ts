export type AgentDocumentDecision = 'auto_archive' | 'suggest_manual_save' | 'do_not_archive';

export interface AgentDocumentClassificationInput {
  content: string;
  senderType: 'user' | 'agent' | 'system';
  messageComplete: boolean;
  projectId?: string | null;
  roomId?: string | null;
  messageId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  userRequest?: string | null;
  alreadyArchived?: boolean;
}

export interface AgentDocumentClassification {
  decision: AgentDocumentDecision;
  score: number;
  reasons: string[];
  title: string | null;
}

const MIN_AUTO_CLASSIFY_LENGTH = 500;
const LONG_CONTENT_LENGTH = 1200;
const MAX_CODE_BLOCK_RATIO = 0.7;

const DOCUMENT_KEYWORDS = [
  '方案',
  '设计',
  '计划',
  '需求',
  'prd',
  '总结',
  '报告',
  '复盘',
  '验收',
  '实施计划',
  '规则',
  '范围',
];

const DOCUMENT_REQUEST_KEYWORDS = [
  '生成文档',
  '写方案',
  '输出计划',
  '整理成需求',
  '形成总结',
  '生成 prd',
  '生成PRD',
  '归档',
  '整理边界案例',
];

const DOCUMENT_ROLE_KEYWORDS = [
  '产品经理',
  'planner',
  '架构师',
  'reviewer',
  '总结',
  '文档',
];

const LOG_PATTERNS = [
  /\bnpm ERR!/i,
  /\bTraceback \(most recent call last\):/i,
  /\b(?:Error|Exception):\s+\S+/,
  /\bat\s+[\w.$<>]+\s*\([^)]*:\d+:\d+\)/,
  /\bProcess exited\b/i,
  /\b(?:stdout|stderr)\b/i,
  /^\[\d{4}-\d{2}-\d{2}[T\s][^\]]+\]/m,
];

export function classifyAgentDocument(input: AgentDocumentClassificationInput): AgentDocumentClassification {
  const content = input.content.trim();
  const reasons: string[] = [];
  const hardExclusion = getHardExclusion(input, content);
  if (hardExclusion) {
    return {
      decision: 'do_not_archive',
      score: 0,
      reasons: [hardExclusion],
      title: extractDocumentTitle(content),
    };
  }

  let score = 0;
  const title = extractDocumentTitle(content);
  if (title) {
    score += 2;
    reasons.push('有明确 Markdown 标题或首行文档标题，+2');
  }

  if (countMarkdownSections(content) >= 2) {
    score += 2;
    reasons.push('包含 2 个及以上章节，+2');
  }

  if (hasDocumentBodyStructure(content)) {
    score += 1;
    reasons.push('包含列表、表格或任务清单等结构，+1');
  }

  if (containsAny(content, DOCUMENT_KEYWORDS)) {
    score += 2;
    reasons.push('包含方案、需求、总结、报告等文档关键词，+2');
  }

  if (content.length > LONG_CONTENT_LENGTH) {
    score += 1;
    reasons.push('内容长度超过 1200 字符，+1');
  }

  if (input.agentName && containsAny(input.agentName, DOCUMENT_ROLE_KEYWORDS)) {
    score += 1;
    reasons.push('智能体角色匹配文档产出，+1');
  }

  if (input.userRequest && containsAny(input.userRequest, DOCUMENT_REQUEST_KEYWORDS)) {
    score += 3;
    reasons.push('用户请求明确要求文档化输出，+3');
  }

  if (score >= 5) {
    return { decision: 'auto_archive', score, reasons, title };
  }
  if (score >= 3) {
    return {
      decision: 'suggest_manual_save',
      score,
      reasons: [...reasons, 'score 3-4 证据不足，默认不自动归档，仅建议手动保存'],
      title,
    };
  }
  return {
    decision: 'do_not_archive',
    score,
    reasons: [...reasons, 'score < 3，文档资产信号弱，不归档'],
    title,
  };
}

function getHardExclusion(input: AgentDocumentClassificationInput, content: string): string | null {
  if (!input.messageComplete) return '消息尚未完整结束，不进入自动归档评估';
  if (input.senderType !== 'agent') return '来源不是智能体消息，不归档';
  if (!input.projectId || !input.roomId || !input.messageId || !input.agentId) {
    return '缺少 project_id、room_id、message_id 或 agent_id，不归档';
  }
  if (input.alreadyArchived) return '同源消息已存在 agent_document，不重复归档';
  if (content.length < MIN_AUTO_CLASSIFY_LENGTH) return '内容长度小于 500 字符，不归档';
  if (getCodeBlockRatio(content) > MAX_CODE_BLOCK_RATIO) return '代码块内容占比超过 70%，不归档';
  if (isLogLikeContent(content)) return '日志、终端输出或错误堆栈特征明显，不归档';
  if (!hasMarkdownStructure(content) && !containsAny(content, DOCUMENT_KEYWORDS)) {
    return '没有 Markdown 结构且没有文档关键词，不归档';
  }
  return null;
}

function extractDocumentTitle(content: string): string | null {
  const markdownTitle = content.match(/^#{1,2}\s+(.+?)\s*$/m)?.[1]?.trim();
  if (markdownTitle) return markdownTitle;

  const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine || firstLine.length > 80) return null;
  return containsAny(firstLine, DOCUMENT_KEYWORDS) ? firstLine.replace(/^[-*]\s+/, '') : null;
}

function countMarkdownSections(content: string): number {
  return content.match(/^#{2,3}\s+\S.+$/gm)?.length ?? 0;
}

function hasMarkdownStructure(content: string): boolean {
  return /^#{1,6}\s+\S.+$/m.test(content)
    || /^(?:-|\*|\d+\.)\s+\S.+$/m.test(content)
    || /^\s*-\s+\[[ xX]\]\s+\S.+$/m.test(content)
    || /^\|.+\|\s*$/m.test(content);
}

function hasDocumentBodyStructure(content: string): boolean {
  return /^(?:-|\*|\d+\.)\s+\S.+$/m.test(content)
    || /^\s*-\s+\[[ xX]\]\s+\S.+$/m.test(content)
    || /^\|.+\|\s*$/m.test(content);
}

function getCodeBlockRatio(content: string): number {
  const matches = [...content.matchAll(/```[\s\S]*?```/g)];
  if (matches.length === 0) return 0;
  const codeLength = matches.reduce((sum, match) => sum + match[0].length, 0);
  return codeLength / content.length;
}

function isLogLikeContent(content: string): boolean {
  return LOG_PATTERNS.some((pattern) => pattern.test(content));
}

function containsAny(value: string, keywords: string[]): boolean {
  const normalized = value.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}
