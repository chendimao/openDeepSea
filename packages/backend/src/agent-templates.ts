import type { AcpBackend, WorkflowRole } from './types.js';

export interface BuiltInAgentTemplate {
  id: string;
  name: string;
  description: string;
  workflow_role: WorkflowRole;
  acp_enabled: true;
  acp_backend: AcpBackend;
  capabilities: string[];
}

const BUILT_IN_AGENT_TEMPLATES: BuiltInAgentTemplate[] = [
  {
    id: 'planner',
    name: 'Planner',
    description: '生成结构化计划和任务拆分。',
    workflow_role: 'planner',
    acp_enabled: true,
    acp_backend: 'codex',
    capabilities: ['planning', 'architecture'],
  },
  {
    id: 'backend-executor',
    name: 'Backend Executor',
    description: '执行后端代码修改和测试。',
    workflow_role: 'executor',
    acp_enabled: true,
    acp_backend: 'codex',
    capabilities: ['backend', 'testing'],
  },
  {
    id: 'frontend-executor',
    name: 'Frontend Executor',
    description: '执行前端代码修改和界面验证。',
    workflow_role: 'executor',
    acp_enabled: true,
    acp_backend: 'codex',
    capabilities: ['frontend', 'testing'],
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: '审查代码、风险和验证缺口。',
    workflow_role: 'reviewer',
    acp_enabled: true,
    acp_backend: 'codex',
    capabilities: ['review', 'quality'],
  },
  {
    id: 'acceptor',
    name: 'Acceptor',
    description: '根据验收标准判断任务是否完成。',
    workflow_role: 'acceptor',
    acp_enabled: true,
    acp_backend: 'codex',
    capabilities: ['acceptance'],
  },
];

export function listBuiltInAgentTemplates(): BuiltInAgentTemplate[] {
  return BUILT_IN_AGENT_TEMPLATES.map((template) => ({
    ...template,
    capabilities: [...template.capabilities],
  }));
}
