import { agentRepo } from '../repos/agents.js';
import { roomAgentRepo } from '../repos/rooms.js';
import type { Agent, RoomAgent } from '../types.js';

export const FULLSTACK_ENGINEER_AGENT_ID = 'fullstack-engineer';

export function getGlobalFullstackEngineer(): Agent | null {
  return agentRepo.getByAgentId(FULLSTACK_ENGINEER_AGENT_ID)
    ?? agentRepo.getByBuiltinKey(FULLSTACK_ENGINEER_AGENT_ID)
    ?? null;
}

export function ensureFullstackEngineerRoomAgent(roomId: string): RoomAgent {
  return roomAgentRepo.ensureBuiltInAgent(roomId, FULLSTACK_ENGINEER_AGENT_ID);
}
