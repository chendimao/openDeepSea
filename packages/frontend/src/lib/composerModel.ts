import type { RoomAgent } from './types';

export const MAX_MESSAGE_FILES = 5;
export const MAX_MESSAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const TYPED_MENTION_PATTERN = /@([\p{L}\p{N}_.-]+)/gu;

export type ComposerNode =
  | {
    type: 'text';
    text: string;
  }
  | {
    type: 'mention';
    roomAgentId: string;
    agentName: string;
  };

export interface PendingAttachment {
  id: string;
  file: File;
}

export interface SerializedComposer {
  content: string;
  roomAgentIds: string[];
}

export function createEmptyComposerNodes(): ComposerNode[] {
  return [{ type: 'text', text: '' }];
}

export function serializeComposerNodes(nodes: ComposerNode[]): SerializedComposer {
  let content = '';
  const mentionSet = new Set<string>();

  for (const node of nodes) {
    if (node.type === 'text') {
      content += node.text;
      continue;
    }
    content += `@${node.agentName}`;
    mentionSet.add(node.roomAgentId);
  }

  return {
    content,
    roomAgentIds: [...mentionSet],
  };
}

export function findUniqueAgentMention(token: string, agents: RoomAgent[]): RoomAgent | null {
  const normalizedToken = token.trim().toLocaleLowerCase();
  if (!normalizedToken) return null;

  const matched = agents.filter((agent) => {
    const name = agent.agent_name.toLocaleLowerCase();
    const id = agent.agent_id.toLocaleLowerCase();
    return name === normalizedToken || id === normalizedToken;
  });

  if (matched.length !== 1) return null;
  return matched[0];
}

export function normalizeTypedMentions(nodes: ComposerNode[], agents: RoomAgent[]): ComposerNode[] {
  const normalized: ComposerNode[] = [];

  for (const node of nodes) {
    if (node.type === 'mention') {
      normalized.push(node);
      continue;
    }

    let lastIndex = 0;
    const text = node.text;

    TYPED_MENTION_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(TYPED_MENTION_PATTERN)) {
      const mentionText = match[0];
      const token = match[1];
      const matchIndex = match.index ?? 0;

      if (matchIndex > lastIndex) {
        normalized.push({ type: 'text', text: text.slice(lastIndex, matchIndex) });
      }

      const agent = findUniqueAgentMention(token, agents);
      if (agent) {
        normalized.push({
          type: 'mention',
          roomAgentId: agent.id,
          agentName: agent.agent_name,
        });
      } else {
        normalized.push({ type: 'text', text: mentionText });
      }

      lastIndex = matchIndex + mentionText.length;
    }

    if (lastIndex < text.length) {
      normalized.push({ type: 'text', text: text.slice(lastIndex) });
    }
  }

  const merged = mergeAdjacentTextNodes(normalized);
  return merged.length > 0 ? merged : createEmptyComposerNodes();
}

export function mergeAdjacentTextNodes(nodes: ComposerNode[]): ComposerNode[] {
  const merged: ComposerNode[] = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      if (!node.text) continue;
      const prev = merged[merged.length - 1];
      if (prev?.type === 'text') {
        prev.text += node.text;
      } else {
        merged.push({ type: 'text', text: node.text });
      }
      continue;
    }
    merged.push(node);
  }

  return merged;
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function validatePendingFiles(
  existingCount: number,
  files: File[],
  messages: {
    maxFiles: (count: number) => string;
    fileTooLarge: (name: string, size: string) => string;
  },
): string | null {
  if (existingCount + files.length > MAX_MESSAGE_FILES) {
    return messages.maxFiles(MAX_MESSAGE_FILES);
  }

  for (const file of files) {
    if (file.size > MAX_MESSAGE_FILE_SIZE_BYTES) {
      return messages.fileTooLarge(file.name, formatFileSize(MAX_MESSAGE_FILE_SIZE_BYTES));
    }
  }

  return null;
}
