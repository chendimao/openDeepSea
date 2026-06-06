import { sessionRepo } from './repos/sessions.js';
import { buildActiveSessionSummary } from './session-active-view-model.js';
import { wsHub } from './ws-hub.js';
import type { Session } from './types.js';

export function broadcastActiveSessionUpsert(sessionOrId: Session | string): void {
  const session = typeof sessionOrId === 'string' ? sessionRepo.get(sessionOrId) : sessionOrId;
  if (!session) return;
  const summary = buildActiveSessionSummary(session);
  if (!summary) {
    broadcastActiveSessionRemove(session.id);
    return;
  }
  wsHub.broadcastActiveSessions({ type: 'active_session:upsert', session: summary });
}

export function broadcastActiveSessionRemove(sessionId: string): void {
  wsHub.broadcastActiveSessions({ type: 'active_session:remove', sessionId });
}
