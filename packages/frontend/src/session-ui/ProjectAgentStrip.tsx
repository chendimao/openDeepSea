import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, ChevronDown, Settings } from 'lucide-react';
import { ProjectSettingsDialog } from '../components/SettingsDialogs';
import { api } from '../lib/api';
import type { Project, ProjectUsedRoomAgent } from '../lib/types';

export function ProjectAgentStrip({ project }: { project: Project }): JSX.Element {
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ['project-used-agents', project.id],
    queryFn: () => api.getProjectUsedAgents(project.id),
    staleTime: 20_000,
  });
  const agents = data?.agents ?? [];

  return (
    <div className="deepsea-project-agents" aria-label="项目智能体">
      <ProjectSettingsDialog project={project}>
        <button
          type="button"
          className="deepsea-agent-avatar deepsea-agent-avatar--planner"
          title={`Planner · ${backendLabel(data?.planner.effective_acp_backend)}`}
          aria-label="设置会话规划智能体"
        >
          <Bot aria-hidden="true" />
          <span>{initial(data?.planner.name ?? 'Planner')}</span>
        </button>
      </ProjectSettingsDialog>
      {agents.map((agent) => (
        <AgentAvatar
          key={`${agent.global_agent_id ?? agent.agent_id}`}
          agent={agent}
          open={openAgentId === agent.agent_id}
          onToggle={() => setOpenAgentId((current) => current === agent.agent_id ? null : agent.agent_id)}
        />
      ))}
    </div>
  );
}

function AgentAvatar({
  agent,
  open,
  onToggle,
}: {
  agent: ProjectUsedRoomAgent;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const binding = agent.room_bindings[0];
  const hasMultipleBindings = agent.room_bindings.length > 1;
  const title = `${agent.name} · ${backendLabel(agent.acp_backend)}`;

  if (!hasMultipleBindings && binding) {
    return (
      <button
        type="button"
        className="deepsea-agent-avatar"
        title={title}
        aria-label={`设置 ${agent.name}`}
        data-enabled={agent.acp_enabled ? 'true' : undefined}
        onClick={() => openAgentSettings(agent)}
      >
        <span>{initial(agent.name)}</span>
      </button>
    );
  }

  return (
    <div className="deepsea-agent-avatar-wrap">
      <button
        type="button"
        className="deepsea-agent-avatar"
        title={title}
        aria-label={`选择 ${agent.name} 的群聊设置`}
        aria-expanded={open}
        data-enabled={agent.acp_enabled ? 'true' : undefined}
        onClick={onToggle}
      >
        <span>{initial(agent.name)}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div className="deepsea-agent-binding-popover" role="menu" aria-label={`${agent.name} 设置位置`}>
          {agent.room_bindings.map((item) => (
            <button
              type="button"
              key={item.room_agent_id}
              role="menuitem"
              onClick={() => openAgentSettings(agent)}
            >
              <span>
                <strong>{item.room_name}</strong>
                <em>{backendLabel(item.acp_backend)}</em>
              </span>
              <Settings aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function openAgentSettings(agent: ProjectUsedRoomAgent): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (agent.global_agent_id) params.set('agentGlobalId', agent.global_agent_id);
  params.set('agentId', agent.agent_id);
  window.location.assign(`/agents?${params.toString()}`);
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || 'A';
}

function backendLabel(backend: string | null | undefined): string {
  if (backend === 'codex') return 'Codex';
  if (backend === 'claudecode') return 'Claude Code';
  if (backend === 'opencode') return 'OpenCode';
  return '未启用';
}
