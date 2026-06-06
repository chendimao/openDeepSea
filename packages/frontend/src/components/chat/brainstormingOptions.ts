import type { BrainstormingOption, BrainstormingOptionMaturity, Message, MessageMetadata } from '../../lib/types';

const fencePattern = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
const brainstormingOptionMaturities = new Set<BrainstormingOptionMaturity>([
  'exploratory',
  'boundary_needed',
  'actionable',
]);

export function getBrainstormingOptionsForMessage(
  message: Message,
  metadata: MessageMetadata,
): BrainstormingOption[] {
  if (message.sender_type !== 'agent') return [];
  if (metadata.choice_options && metadata.choice_options.length > 0) {
    return metadata.choice_options;
  }
  if (metadata.brainstorming_options && metadata.brainstorming_options.length > 0) {
    return metadata.brainstorming_options;
  }
  return extractChoiceOptionsFromMessageContent(message.content);
}

function extractChoiceOptionsFromMessageContent(content: string): BrainstormingOption[] {
  fencePattern.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(content)) !== null) {
    if (!isFinalStructuredJsonFence(content, match)) continue;
    const { language, extra } = splitFenceInfo(match[1]);
    if (!isJsonLanguage(language)) continue;

    try {
      const parsed = JSON.parse(extra + (match[2] ?? '')) as unknown;
      const options = sanitizeChoiceOptionsFromJson(parsed);
      if (options.length > 0) return options;
    } catch {
      continue;
    }
  }

  return [];
}

function isFinalStructuredJsonFence(content: string, match: RegExpExecArray): boolean {
  const trailing = content.slice(match.index + match[0].length).trim();
  return trailing.length === 0;
}

function splitFenceInfo(rawInfo: string | undefined): { language: string; extra: string } {
  const info = rawInfo ?? '';
  const langMatch = info.match(/^\s*([A-Za-z0-9_.+#/-]+)/);
  if (!langMatch) return { language: normalizeFenceLanguage(info), extra: '' };
  const afterLang = info.slice(langMatch[0].length);
  const gluedMatch = afterLang.match(/^\S+/);
  return { language: normalizeFenceLanguage(langMatch[1]), extra: gluedMatch?.[0] ?? '' };
}

function normalizeFenceLanguage(rawLanguage: string | undefined): string {
  return rawLanguage?.trim().split(/\s+/)[0].toLowerCase() || 'text';
}

function isJsonLanguage(language: string): boolean {
  return language === 'json' || language === 'application/json';
}

function sanitizeChoiceOptionsFromJson(value: unknown): BrainstormingOption[] {
  if (!isRecord(value)) return [];
  const topLevelOptions = sanitizeBrainstormingOptions(value.choice_options);
  if (topLevelOptions.length > 0) return topLevelOptions;

  if (!isRecord(value.superpowers)) return [];
  return sanitizeBrainstormingOptions(value.superpowers.choice_options);
}

function sanitizeBrainstormingOptions(value: unknown): BrainstormingOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(sanitizeBrainstormingOption)
    .filter((option): option is BrainstormingOption => option !== null)
    .slice(0, 6);
}

function sanitizeBrainstormingOption(value: unknown): BrainstormingOption | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    !isBrainstormingOptionMaturity(value.maturity)
  ) {
    return null;
  }

  return {
    id: value.id.trim().slice(0, 120),
    title: value.title.trim().slice(0, 120),
    summary: value.summary.trim().slice(0, 360),
    benefits: sanitizeBoundedStringList(value.benefits, 3, 180),
    risks: sanitizeBoundedStringList(value.risks, 3, 180),
    maturity: value.maturity,
    recommended: value.recommended === true,
  };
}

function sanitizeBoundedStringList(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, limit);
}

function isBrainstormingOptionMaturity(value: unknown): value is BrainstormingOptionMaturity {
  return typeof value === 'string' && brainstormingOptionMaturities.has(value as BrainstormingOptionMaturity);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
