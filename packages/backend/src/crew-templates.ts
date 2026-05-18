import { listBuiltInAgentTemplates, type BuiltInAgentTemplate } from './agent-templates.js';

export interface RoomCrewTemplate {
  id: string;
  name: string;
  description: string;
  agent_template_ids: string[];
  default: boolean;
}

const ROOM_CREW_TEMPLATES: RoomCrewTemplate[] = [
  {
    id: 'discussion-only',
    name: '只讨论',
    description: '仅加入 Planner，适合需求澄清、方案讨论和非执行型群聊。',
    agent_template_ids: ['planner'],
    default: false,
  },
  {
    id: 'light-implementation',
    name: '轻量实现',
    description: 'Planner + Backend Executor + Reviewer，适合大多数小型实现和修复任务。',
    agent_template_ids: ['planner', 'backend-executor', 'reviewer'],
    default: true,
  },
  {
    id: 'fullstack-collaboration',
    name: '前后端协作',
    description: 'Planner + Frontend Executor + Backend Executor + Reviewer + Acceptor，适合跨端任务。',
    agent_template_ids: ['planner', 'frontend-executor', 'backend-executor', 'reviewer', 'acceptor'],
    default: false,
  },
];

export function listRoomCrewTemplates(): RoomCrewTemplate[] {
  return ROOM_CREW_TEMPLATES.map((template) => ({
    ...template,
    agent_template_ids: [...template.agent_template_ids],
  }));
}

export function getRoomCrewTemplate(id: string | null | undefined): RoomCrewTemplate | undefined {
  return ROOM_CREW_TEMPLATES.find((template) => template.id === id);
}

export function getDefaultRoomCrewTemplate(): RoomCrewTemplate {
  return ROOM_CREW_TEMPLATES.find((template) => template.default) ?? ROOM_CREW_TEMPLATES[0]!;
}

export function getBuiltInAgentTemplate(id: string): BuiltInAgentTemplate | undefined {
  return listBuiltInAgentTemplates().find((template) => template.id === id);
}
