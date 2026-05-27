export type StreamingChunkMode = 'typewriter' | 'block';

export type StreamingDisplayState = {
  displayed: string;
  queue: string[];
};

const BLOCK_CHUNK_LENGTH = 240;
const BLOCK_NEWLINE_COUNT = 4;
const logLikePattern = /(^\s*\[error\]|^\s*(stdout|stderr)(\s|:)|^\s*[-+]\s|^diff --git|^\$\s|^>\s)/m;

export function createStreamingDisplayState(displayed = ''): StreamingDisplayState {
  return {
    displayed,
    queue: [],
  };
}

export function classifyStreamingChunk(currentDisplayed: string, chunk: string): StreamingChunkMode {
  if (!chunk) return 'typewriter';
  if (isInsideFencedCodeBlock(currentDisplayed)) return 'block';
  if (chunk.includes('```')) return 'block';
  const logLike = logLikePattern.test(chunk);
  if (logLike) return 'block';
  if (chunk.length > BLOCK_CHUNK_LENGTH && looksLikeStructuredOutput(chunk)) return 'block';
  if (countNewlines(chunk) >= BLOCK_NEWLINE_COUNT && looksLikeStructuredOutput(chunk)) return 'block';
  return 'typewriter';
}

export function enqueueStreamingChunk(
  state: StreamingDisplayState,
  chunk: string,
): StreamingDisplayState {
  if (!chunk) return state;
  return {
    displayed: `${state.displayed}${state.queue.join('')}${chunk}`,
    queue: [],
  };
}

export function tickStreamingDisplay(state: StreamingDisplayState): StreamingDisplayState {
  if (state.queue.length === 0) return state;
  return {
    displayed: `${state.displayed}${state.queue.join('')}`,
    queue: [],
  };
}

export function flushStreamingDisplay(
  _state: StreamingDisplayState,
  fullContent: string,
): StreamingDisplayState {
  return {
    displayed: fullContent,
    queue: [],
  };
}

export function resolveStreamingDisplayContent(
  state: StreamingDisplayState | undefined,
  committedContent: string,
): string {
  if (!state) return committedContent;
  if (!state.displayed) return '';
  if (committedContent.startsWith(state.displayed)) return state.displayed;
  if (state.displayed.startsWith(committedContent)) return state.displayed;
  return state.displayed.length >= committedContent.length ? state.displayed : committedContent;
}

export function hasQueuedStreamingContent(state: StreamingDisplayState): boolean {
  return state.queue.length > 0;
}

export function shouldRetainStreamingDisplayState(
  state: StreamingDisplayState,
  done: boolean,
): boolean {
  return !done || hasQueuedStreamingContent(state);
}

function isInsideFencedCodeBlock(text: string): boolean {
  const matches = text.match(/```/g);
  return Boolean(matches && matches.length % 2 === 1);
}

function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

function looksLikeStructuredOutput(text: string): boolean {
  return /^[\s\S]*(\n\s{2,}\S|\n\t+\S|^[\s]*[}\]\)]\s*$|;\s*$|={3,}|-{3,}|\|)/m.test(text);
}
