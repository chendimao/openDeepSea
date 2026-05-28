export type StreamingEventForDedupe = {
  roomId: string;
  messageId: string;
  runId?: string;
  channel?: 'answer' | 'thinking' | 'tool' | 'command' | 'event';
  chunk: string;
  done: boolean;
  seq?: number;
  status?: string;
  error?: string | null;
};

export type StreamingEventTracker = Map<string, number>;

export function createStreamingEventTracker(): StreamingEventTracker {
  return new Map();
}

export function shouldApplyStreamingEvent(
  tracker: StreamingEventTracker,
  event: StreamingEventForDedupe,
): boolean {
  if (event.seq === undefined) return true;
  const streamKey = getStreamKey(event);
  const lastSeq = tracker.get(streamKey) ?? 0;
  if (event.seq <= lastSeq) return false;
  tracker.set(streamKey, event.seq);
  return true;
}

function getStreamKey(event: StreamingEventForDedupe): string {
  return `${event.roomId}:${event.runId ?? event.messageId}:${event.channel ?? 'answer'}`;
}
