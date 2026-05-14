import type { RoomAgent } from './types.js';

const MENTION_PATTERN = /@([\p{L}\p{N}_.-]+)/gu;

export function extractMentionTokens(content: string): string[] {
  return Array.from(content.matchAll(MENTION_PATTERN), (match) => match[1] ?? '');
}

export function resolveMentionedAgentRoomIds(args: {
  content: string;
  agents: RoomAgent[];
  explicitRoomAgentIds?: string[];
}): string[] {
  const selected = new Set<string>();
  for (const id of args.explicitRoomAgentIds ?? []) {
    selected.add(id);
  }

  const tokens = new Set(extractMentionTokens(args.content));
  if (tokens.size === 0) return Array.from(selected);

  for (const agent of args.agents) {
    if (tokens.has(agent.agent_name) || tokens.has(agent.agent_id)) {
      selected.add(agent.id);
    }
  }

  return Array.from(selected);
}
