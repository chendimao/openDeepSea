export type SessionCommandKind = 'message' | 'new' | 'compact' | 'status' | 'context' | 'resume' | 'fork' | 'checkpoint';

export interface ParsedSessionCommand {
  kind: SessionCommandKind;
  raw: string;
  body: string;
  args: Record<string, string | true>;
}

const SESSION_COMMAND_KINDS = new Set<Exclude<SessionCommandKind, 'message'>>([
  'new',
  'compact',
  'status',
  'context',
  'resume',
  'fork',
  'checkpoint',
]);

export function parseSessionCommand(input: string): ParsedSessionCommand {
  const raw = input.trim();
  if (!raw.startsWith('/')) return { kind: 'message', raw, body: raw, args: {} };
  const [head = '', ...rest] = raw.split(/\s+/);
  const command = head.slice(1).toLowerCase();
  if (!isSessionCommandKind(command)) {
    return { kind: 'message', raw, body: raw, args: {} };
  }
  const body = rest.join(' ').trim();
  return { kind: command, raw, body, args: parseCommandArgs(body) };
}

function isSessionCommandKind(value: string): value is Exclude<SessionCommandKind, 'message'> {
  return SESSION_COMMAND_KINDS.has(value as Exclude<SessionCommandKind, 'message'>);
}

function parseCommandArgs(body: string): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  const trimmed = body.trim();
  if (!trimmed) return args;

  const markers = [...trimmed.matchAll(/(^|\s)([A-Za-z][\w-]*)\s*:\s*/g)];
  if (markers.length === 0) {
    for (const flag of trimmed.split(/\s+/).filter(Boolean)) {
      args[normalizeArgKey(flag)] = true;
    }
    return args;
  }

  const firstMarkerIndex = markers[0]?.index ?? 0;
  const leadingFlags = trimmed.slice(0, firstMarkerIndex).trim();
  for (const flag of leadingFlags.split(/\s+/).filter(Boolean)) {
    args[normalizeArgKey(flag)] = true;
  }

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    const next = markers[index + 1];
    const key = normalizeArgKey(marker[2] ?? '');
    if (!key) continue;
    const valueStart = (marker.index ?? 0) + marker[0].length;
    const valueEnd = next?.index ?? trimmed.length;
    const value = trimmed.slice(valueStart, valueEnd).trim();
    args[key] = value || true;
  }

  return args;
}

function normalizeArgKey(value: string): string {
  return value.trim().replace(/^-+/, '').replace(/-/g, '_');
}
