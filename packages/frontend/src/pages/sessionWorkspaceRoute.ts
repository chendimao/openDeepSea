export interface SessionWorkspaceRouteParams {
  active: boolean;
  projectId: string;
  sessionId?: string;
}

export function isSessionWorkspacePath(pathname: string): boolean {
  return getSessionWorkspaceRouteParams(pathname).active;
}

export function getSessionWorkspaceRouteParams(pathname: string): SessionWorkspaceRouteParams {
  const cleanPath = pathname.split(/[?#]/, 1)[0] || '/';
  if (cleanPath === '/') {
    return { active: true, projectId: '', sessionId: undefined };
  }

  const match = cleanPath.match(/^\/projects\/([^/]+)(?:\/sessions\/([^/]+))?\/?$/);
  if (!match) return { active: false, projectId: '', sessionId: undefined };

  return {
    active: true,
    projectId: decodeURIComponent(match[1] ?? ''),
    sessionId: match[2] ? decodeURIComponent(match[2]) : undefined,
  };
}
