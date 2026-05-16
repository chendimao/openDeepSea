import type { RoomAgent } from '../lib/types';
import type { TriggerConfig, TriggerSuggestion } from './prompt-area/types';

export const AGENT_TRIGGER = '@';
export const COMMAND_TRIGGER = '/';

export interface ComposerTriggerLabels {
  mentionMenuAria: string;
  mentionEmpty: string;
  commandMenuAria: string;
  taskCommandDescription: string;
  startTaskCommandDescription: string;
  commandEmpty: string;
}

interface BuildComposerTriggersInput {
  agents: RoomAgent[];
  labels: ComposerTriggerLabels;
}

const CHAT_COMMANDS = [
  {
    value: 'task',
    label: '/task',
    descriptionKey: 'taskCommandDescription',
  },
  {
    value: 'start-task',
    label: '/start-task',
    descriptionKey: 'startTaskCommandDescription',
  },
] satisfies Array<{
  value: string;
  label: string;
  descriptionKey: keyof Pick<ComposerTriggerLabels, 'taskCommandDescription' | 'startTaskCommandDescription'>;
}>;

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
    {
      char: COMMAND_TRIGGER,
      position: 'start',
      mode: 'dropdown',
      chipStyle: 'inline',
      accessibilityLabel: labels.commandMenuAria,
      onSearch: (query) => searchCommands(query, labels),
      onSelect: (suggestion) => suggestion.value,
      emptyMessage: labels.commandEmpty,
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

function searchCommands(query: string, labels: ComposerTriggerLabels): TriggerSuggestion[] {
  const normalized = query.toLowerCase().replace(/^\//, '');
  return CHAT_COMMANDS
    .filter((command) => {
      const haystack = `${command.value} ${command.label}`.toLowerCase();
      return haystack.includes(normalized);
    })
    .map((command) => ({
      value: command.value,
      label: command.label,
      description: labels[command.descriptionKey],
    }));
}
