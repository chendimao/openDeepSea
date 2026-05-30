import type { AgentRun, Message } from '../../lib/types';

export function pairRunsWithAgentMessages(messages: Message[], runs: AgentRun[]): Map<string, AgentRun> {
  const result = new Map<string, AgentRun>();
  const usedRunIds = new Set<string>();
  const sortedRuns = [...runs].sort((a, b) => a.started_at - b.started_at);

  for (const message of messages) {
    if (message.sender_type !== 'agent' || message.message_type !== 'agent_stream') continue;
    const run = sortedRuns.find((candidate) => {
      if (usedRunIds.has(candidate.id)) return false;
      if (candidate.agent_id !== message.sender_id) return false;
      const distance = Math.abs(candidate.started_at - message.created_at);
      return distance <= 5000;
    });
    if (!run) continue;
    result.set(message.id, run);
    usedRunIds.add(run.id);
  }

  return result;
}

export function findPreviousUserMessage(messages: Message[], beforeIndex: number): Message | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.sender_type === 'user' && message.content.trim()) return message;
  }
  return null;
}

export function shouldUseStreamingDisplayForMessage(
  message: Message,
  run: AgentRun | undefined,
  hasLocalStreamingState: boolean,
): boolean {
  if (message.sender_type === 'user' || message.message_type !== 'agent_stream') return false;
  if (run && isTerminalAgentRunStatus(run.status)) return false;
  if (run && (run.status === 'running' || run.status === 'queued' || run.status === 'retrying')) return true;
  return hasLocalStreamingState;
}

function isTerminalAgentRunStatus(status: AgentRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}
