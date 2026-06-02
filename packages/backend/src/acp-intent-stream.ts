import type { MessageIntentResult, MessageIntentSuggestedAction } from './types.js';

const START_TAG = '<openclaw_intent_json>';
const END_TAG = '</openclaw_intent_json>';

export interface AcpIntentStreamFilter {
  push(chunk: string): string;
  finish(): string;
  intentResult(): MessageIntentResult | null;
}

export function createAcpIntentStreamFilter(): AcpIntentStreamFilter {
  let visibleBuffer = '';
  let hiddenBuffer = '';
  let insideControlBlock = false;
  let parsedIntent: MessageIntentResult | null = null;

  const emitSafeVisible = (force = false): string => {
    if (!visibleBuffer) return '';
    if (force) {
      const output = visibleBuffer;
      visibleBuffer = '';
      return output;
    }
    const keepLength = longestSuffixPrefix(visibleBuffer, START_TAG);
    if (visibleBuffer.length <= keepLength) return '';
    const output = visibleBuffer.slice(0, visibleBuffer.length - keepLength);
    visibleBuffer = visibleBuffer.slice(visibleBuffer.length - keepLength);
    return output;
  };

  const push = (chunk: string): string => {
    if (!chunk) return '';
    let output = '';
    let pending = chunk;

    while (pending) {
      if (!insideControlBlock) {
        visibleBuffer += pending;
        const startIndex = visibleBuffer.indexOf(START_TAG);
        if (startIndex < 0) {
          output += emitSafeVisible(false);
          pending = '';
          continue;
        }

        output += visibleBuffer.slice(0, startIndex);
        pending = visibleBuffer.slice(startIndex + START_TAG.length);
        visibleBuffer = '';
        hiddenBuffer = '';
        insideControlBlock = true;
        continue;
      }

      hiddenBuffer += pending;
      const endIndex = hiddenBuffer.indexOf(END_TAG);
      if (endIndex < 0) {
        pending = '';
        continue;
      }

      parsedIntent = parseAcpIntentControlBlock(hiddenBuffer.slice(0, endIndex));
      pending = hiddenBuffer.slice(endIndex + END_TAG.length);
      hiddenBuffer = '';
      insideControlBlock = false;
    }

    return output;
  };

  return {
    push,
    finish() {
      if (insideControlBlock) {
        insideControlBlock = false;
        hiddenBuffer = '';
        return '';
      }
      return emitSafeVisible(true);
    },
    intentResult() {
      return parsedIntent;
    },
  };
}

export function parseAcpIntentControlBlock(raw: string): MessageIntentResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim()) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const intent = readIntent(parsed.intent);
  const suggestedAction = readSuggestedAction(parsed.suggestedAction);
  if (!intent || !suggestedAction) return null;

  const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 1;
  const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
    ? parsed.reason.trim()
    : 'ACP provided intent result';
  const signals = Array.isArray(parsed.signals)
    ? parsed.signals
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : [];

  return {
    intent,
    confidence,
    source: 'classifier',
    suggestedAction,
    reason,
    ...(signals.length > 0 ? { signals } : {}),
  };
}

function longestSuffixPrefix(value: string, token: string): number {
  const maxLength = Math.min(value.length, token.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.slice(-length) === token.slice(0, length)) return length;
  }
  return 0;
}

function readIntent(value: unknown): MessageIntentResult['intent'] | null {
  if (
    value === 'chat' ||
    value === 'light_task' ||
    value === 'debugger' ||
    value === 'brainstorming' ||
    value === 'workflow'
  ) {
    return value;
  }
  return null;
}

function readSuggestedAction(value: unknown): MessageIntentSuggestedAction | null {
  if (
    value === 'reply_in_chat' ||
    value === 'create_light_task' ||
    value === 'start_debugger' ||
    value === 'start_brainstorming' ||
    value === 'start_workflow' ||
    value === 'ask_user'
  ) {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
