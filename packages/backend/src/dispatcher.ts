import { nanoid } from 'nanoid';
import { getAdapter } from './acp/index.js';
import { gatewayClient } from './openclaw/gateway.js';
import { messageRepo } from './repos/messages.js';
import { projectRepo } from './repos/projects.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { roomAgentRepo as _roomAgentRepo } from './repos/rooms.js';
import { wsHub } from './ws-hub.js';
import type { Message, RoomAgent } from './types.js';

void _roomAgentRepo;

/**
 * Dispatch an incoming user message to all relevant agents in the room.
 * - Mentioned agents (or all agents when no mentions) are notified.
 * - ACP-enabled agents call their CLI; others go through the OpenClaw gateway.
 */
export async function dispatchUserMessage(args: {
  roomId: string;
  userMessage: Message;
  mentionedAgentRoomIds?: string[];
}): Promise<void> {
  const { roomId, userMessage } = args;
  const room = roomRepo.get(roomId);
  if (!room) return;
  const project = projectRepo.get(room.project_id);
  if (!project) return;
  const allAgents = roomAgentRepo.listByRoom(roomId);
  const targets =
    args.mentionedAgentRoomIds && args.mentionedAgentRoomIds.length > 0
      ? allAgents.filter((a) => args.mentionedAgentRoomIds!.includes(a.id))
      : allAgents;

  // Fan out concurrently
  await Promise.all(
    targets.map((agent) =>
      respondAsAgent({
        agent,
        projectPath: project.path,
        roomId,
        prompt: userMessage.content,
      }).catch((err) => {
        const errMsg = messageRepo.create({
          room_id: roomId,
          sender_type: 'system',
          sender_id: 'system',
          sender_name: 'System',
          content: `Agent ${agent.agent_name} failed: ${(err as Error).message}`,
          message_type: 'system',
        });
        wsHub.broadcast(roomId, { type: 'message:new', roomId, message: errMsg });
      }),
    ),
  );
}

async function respondAsAgent(args: {
  agent: RoomAgent;
  projectPath: string;
  roomId: string;
  prompt: string;
}): Promise<void> {
  const { agent, projectPath, roomId, prompt } = args;

  // Create a placeholder agent message that will be filled by streaming chunks.
  const placeholder = messageRepo.create({
    room_id: roomId,
    sender_type: 'agent',
    sender_id: agent.agent_id,
    sender_name: agent.agent_name,
    content: '',
    message_type: 'agent_stream',
    metadata: {
      acp_enabled: !!agent.acp_enabled,
      acp_backend: agent.acp_backend,
      acp_session_id: agent.acp_session_id,
    },
  });
  wsHub.broadcast(roomId, { type: 'message:new', roomId, message: placeholder });

  const onChunk = (chunk: string): void => {
    messageRepo.appendChunk(placeholder.id, chunk);
    wsHub.broadcast(roomId, {
      type: 'message:stream',
      roomId,
      messageId: placeholder.id,
      chunk,
      done: false,
    });
  };

  if (agent.acp_enabled && agent.acp_backend) {
    const adapter = getAdapter(agent.acp_backend);
    const result = await adapter.invoke({
      projectPath,
      sessionId: agent.acp_session_id,
      prompt,
      onChunk,
    });
    if (result.exitCode !== 0 && result.stderr) onChunk(`\n[stderr] ${result.stderr}`);
    // Persist newly minted session id if previously null
    if (!agent.acp_session_id && result.sessionId) {
      roomAgentRepo.setAcp(agent.id, {
        acp_enabled: true,
        acp_backend: agent.acp_backend,
        acp_session_id: result.sessionId,
        acp_session_label: agent.acp_session_label,
      });
    }
  } else {
    // Send through OpenClaw Gateway
    const sessionKey = `agent:${agent.agent_id}:room-${roomId}`;
    try {
      await gatewayClient.sendToAgent({
        agentId: agent.agent_id,
        sessionKey,
        text: prompt,
      });
      onChunk(`(message dispatched to OpenClaw agent ${agent.agent_name}; awaiting streamed response)`);
    } catch (err) {
      onChunk(`\n[gateway error] ${(err as Error).message}`);
    }
  }

  wsHub.broadcast(roomId, {
    type: 'message:stream',
    roomId,
    messageId: placeholder.id,
    chunk: '',
    done: true,
  });
}

/** Forward gateway agent messages back into the appropriate room. */
export function bindGatewayEvents(): void {
  gatewayClient.onEvent(({ event, payload }) => {
    if (event !== 'agent.message' && event !== 'sessions.message') return;
    const p = payload as Record<string, unknown> | null;
    if (!p) return;
    const sessionKey = String(p['sessionKey'] ?? '');
    const m = sessionKey.match(/^agent:[^:]+:room-([^:]+)$/);
    if (!m) return;
    const roomId = m[1];
    const text = typeof p['text'] === 'string' ? (p['text'] as string) : JSON.stringify(p);
    const agentId = String(p['agentId'] ?? 'unknown');
    const message = messageRepo.create({
      room_id: roomId!,
      sender_type: 'agent',
      sender_id: agentId,
      sender_name: agentId,
      content: text,
      message_type: 'text',
    });
    wsHub.broadcast(roomId!, { type: 'message:new', roomId: roomId!, message });
  });
}

export function newRequestId(): string {
  return nanoid(12);
}
