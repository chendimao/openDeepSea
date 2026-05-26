import type { RoomAgent } from '../lib/types';
import type { TriggerConfig, TriggerSuggestion } from './prompt-area/types';

export const AGENT_TRIGGER = '@';

export interface ComposerTriggerLabels {
  mentionMenuAria: string;
  mentionEmpty: string;
}

interface BuildComposerTriggersInput {
  agents: RoomAgent[];
  labels: ComposerTriggerLabels;
}

export function buildComposerTriggers({
  agents,
  labels,
}: BuildComposerTriggersInput): TriggerConfig[] {
  return [
    {
      char: AGENT_TRIGGER,
      position: 'any',
      mode: 'dropdown',
      accessibilityLabel: labels.mentionMenuAria,
      onSearch: (query) => searchAgents(agents, query),
      onSelect: (suggestion) => suggestion.label,
      emptyMessage: labels.mentionEmpty,
    },
  ];
}

function searchAgents(agents: RoomAgent[], query: string): TriggerSuggestion[] {
  const normalized = query.toLowerCase();
  return agents
    .filter((agent) => {
      const haystack = `${agent.agent_name} ${agent.agent_id}`.toLowerCase();
      return haystack.includes(normalized);
    })
    .slice(0, 6)
    .map((agent) => ({
      value: agent.id,
      label: agent.agent_name,
      data: agent,
    }));
}
