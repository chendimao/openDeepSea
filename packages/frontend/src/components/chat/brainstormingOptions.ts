import type {
  BrainstormingOption,
  BrainstormingOptionMaturity,
  Message,
  MessageMetadata,
} from '../../lib/types';

const OPTION_HEADING_PATTERN = /^(推荐方案|备选轻量方案|备选方案|不推荐方案|方案\s*[A-CＡ-Ｃ一二三1-3])[:：]\s*(.+)$/;

interface DraftOption {
  title: string;
  summaryParts: string[];
  bullets: string[];
}

export function getBrainstormingOptionsForMessage(
  message: Message,
  metadata: MessageMetadata,
): BrainstormingOption[] {
  if (message.sender_type !== 'agent') return [];
  if (metadata.brainstorming_options && metadata.brainstorming_options.length > 0) {
    return metadata.brainstorming_options;
  }
  return parseBrainstormingOptionsFromMarkdown(message.content);
}

export function parseBrainstormingOptionsFromMarkdown(content: string): BrainstormingOption[] {
  if (!content.includes('方案')) return [];

  const lines = content.split(/\r?\n/);
  const options: BrainstormingOption[] = [];
  let current: DraftOption | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = OPTION_HEADING_PATTERN.exec(line);
    if (match) {
      if (current) options.push(finalizeDraftOption(current, options.length));
      current = {
        title: normalizeOptionTitle(match[1]),
        summaryParts: [stripMarkdown(match[2])],
        bullets: [],
      };
      continue;
    }

    if (!current || !line) continue;
    if (isMarkdownSectionHeading(line)) {
      options.push(finalizeDraftOption(current, options.length));
      current = null;
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      current.bullets.push(stripMarkdown(bullet[1]));
      continue;
    }

    current.summaryParts.push(stripMarkdown(line));
  }

  if (current) options.push(finalizeDraftOption(current, options.length));
  return options.filter((option) => option.summary.length > 0).slice(0, 6);
}

function finalizeDraftOption(draft: DraftOption, index: number): BrainstormingOption {
  const summary = draft.summaryParts.join(' ').replace(/\s+/g, ' ').trim();
  const benefits = draft.bullets.slice(0, 3);
  const risks = inferRisks(draft);

  return {
    id: createOptionId(draft.title, index),
    title: draft.title,
    summary: summary.slice(0, 360),
    benefits,
    risks,
    maturity: inferMaturity(draft.title),
    ...(draft.title === '推荐方案' ? { recommended: true } : {}),
  };
}

function normalizeOptionTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function inferMaturity(title: string): BrainstormingOptionMaturity {
  if (title === '推荐方案' || title === '备选方案') return 'boundary_needed';
  if (title === '备选轻量方案') return 'actionable';
  if (title === '不推荐方案') return 'exploratory';
  return 'boundary_needed';
}

function inferRisks(draft: DraftOption): string[] {
  return draft.summaryParts
    .map((part) => /^(风险|问题|缺点|注意)[:：]\s*(.+)$/.exec(part)?.[2]?.trim())
    .filter((part): part is string => Boolean(part))
    .slice(0, 2);
}

function createOptionId(title: string, index: number): string {
  const base = title
    .replace(/\s+/g, '-')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9-]/g, '')
    .toLowerCase();
  return `${base || 'option'}-${index + 1}`;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function isMarkdownSectionHeading(line: string): boolean {
  return /^#{1,6}\s+\S+/.test(line) || /^\*\*[^*]+\*\*$/.test(line);
}
