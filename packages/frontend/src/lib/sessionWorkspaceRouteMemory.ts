const LAST_SESSION_WORKSPACE_HREF_KEY = 'opendeepsea.lastSessionWorkspaceHref.v1';
const DEFAULT_SESSION_WORKSPACE_HREF = '/';

type Listener = (href: string) => void;
type SessionWorkspaceRouteMemoryInput = {
  active: boolean;
  projectId: string;
  sessionId?: string;
};

const listeners = new Set<Listener>();

export function rememberLastSessionWorkspaceRoute(route: SessionWorkspaceRouteMemoryInput): void {
  if (!route.active || !route.projectId || !route.sessionId) return;
  const href = buildSessionWorkspaceHref(route.projectId, route.sessionId);
  const previous = readLastSessionWorkspaceHref();
  writeLastSessionWorkspaceHref(href);
  if (href === previous) return;
  for (const listener of listeners) listener(href);
}

export function getLastSessionWorkspaceHref(): string {
  return readLastSessionWorkspaceHref() ?? DEFAULT_SESSION_WORKSPACE_HREF;
}

export function subscribeLastSessionWorkspaceHref(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function buildSessionWorkspaceHref(projectId: string, sessionId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

function readLastSessionWorkspaceHref(): string | null {
  const href = readStoredHref();
  if (!href) return null;
  return isConcreteSessionWorkspaceHref(href) ? href : null;
}

function isConcreteSessionWorkspaceHref(href: string): boolean {
  return /^\/projects\/[^/]+\/sessions\/[^/]+\/?$/.test(href);
}

function readStoredHref(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_SESSION_WORKSPACE_HREF_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeLastSessionWorkspaceHref(href: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_SESSION_WORKSPACE_HREF_KEY, href);
  } catch {
    // localStorage may be unavailable in restricted browser contexts.
  }
}
