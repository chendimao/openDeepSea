import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '../lib/utils';
import { SessionWorkspacePage } from './SessionWorkspacePage';
import {
  getSessionWorkspaceRouteParams,
  type SessionWorkspaceRouteParams,
} from './sessionWorkspaceRoute';

export function SessionWorkspaceKeepAliveHost(): JSX.Element {
  const location = useLocation();
  const routeParams = getSessionWorkspaceRouteParams(location.pathname);
  const [lastSessionRoute, setLastSessionRoute] = useState<SessionWorkspaceRouteParams | null>(
    routeParams.active ? routeParams : null,
  );

  useEffect(() => {
    if (routeParams.active) setLastSessionRoute(routeParams);
  }, [routeParams.active, routeParams.projectId, routeParams.sessionId]);

  const active = routeParams.active;
  const pageParams = active ? routeParams : lastSessionRoute;

  return (
    <div
      data-testid="session-workspace-keep-alive"
      data-active={active ? 'true' : 'false'}
      className={cn('h-full min-h-0', !active && 'hidden')}
      aria-hidden={active ? undefined : true}
    >
      {pageParams && (
        <SessionWorkspacePage
          projectIdOverride={pageParams.projectId}
          sessionIdOverride={pageParams.sessionId}
          navigationEnabled={active}
        />
      )}
    </div>
  );
}
