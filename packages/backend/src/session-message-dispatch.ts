import { sessionEvidenceRepo } from './repos/session-evidence.js';
import {
  DEFAULT_SESSION_AGENT_ID,
  sessionMessageRepo,
  sessionRepo,
} from './repos/sessions.js';
import { createContextManifest } from './session.routes.js';
import { runSessionAgent } from './session-runtime.js';
import { wsHub } from './ws-hub.js';
import type { Session, SessionMessage, SessionMode } from './types.js';

export function dispatchSessionUserMessage(input: {
  sessionId: string;
  content: string;
  senderId?: string;
  senderName?: string | null;
  mode?: SessionMode;
  agentId?: string | null;
}): SessionMessage {
  const session = sessionRepo.get(input.sessionId);
  if (!session) throw new Error('session not found');
  const updatedSession = input.mode && input.mode !== session.mode
    ? sessionRepo.update(session.id, { mode: input.mode }) ?? session
    : session;
  const agentId = input.agentId?.trim() || DEFAULT_SESSION_AGENT_ID;
  const message = sessionMessageRepo.create({
    session_id: updatedSession.id,
    role: 'user',
    sender_id: input.senderId ?? 'user',
    sender_name: input.senderName ?? null,
    content: input.content,
    metadata: { target_agent_id: agentId },
  });
  sessionEvidenceRepo.create({
    session_id: updatedSession.id,
    event_type: 'message',
    source_message_id: message.id,
    title: 'User message',
    payload: { message_id: message.id, target_agent_id: agentId },
  });
  wsHub.broadcastSession(updatedSession.id, {
    type: 'session_message:new',
    sessionId: updatedSession.id,
    message,
  });
  void runSessionAgent({
    sessionId: updatedSession.id,
    agentId,
    prompt: buildRuntimePrompt(updatedSession, message.content),
    provider: updatedSession.provider ?? 'codex',
    model: updatedSession.model,
  }).catch((error) => {
    const event = sessionEvidenceRepo.create({
      session_id: updatedSession.id,
      event_type: 'blocker',
      severity: 'error',
      title: 'Session runtime failed',
      summary: (error as Error).message,
    });
    wsHub.broadcastSession(updatedSession.id, { type: 'session_evidence:new', sessionId: updatedSession.id, event });
  });
  return message;
}

export function buildRuntimePrompt(session: Session, content: string): string {
  const manifest = createContextManifest(session);
  const sourceBlocks = manifest.sources
    .filter((source) => source.included === 1 && source.excerpt?.trim())
    .map((source) => [
      `### ${source.title} (${source.source_type})`,
      `Reason: ${source.reason ?? 'session context'}`,
      source.excerpt!.trim(),
    ].join('\n'));
  const goal = session.current_goal?.trim();
  return [
    '本轮 prompt 来源由 SessionOS Context Inspector 记录。',
    goal ? `当前目标：${goal}` : null,
    sourceBlocks.length > 0 ? ['## Context Sources', ...sourceBlocks].join('\n\n') : null,
    '## User Request',
    content,
  ].filter(Boolean).join('\n\n');
}
