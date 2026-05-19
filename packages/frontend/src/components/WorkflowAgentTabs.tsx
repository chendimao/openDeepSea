import * as Tabs from '@radix-ui/react-tabs';
import { Bot, FileText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';
import type { RoomAgent, TaskArtifact, WorkflowPlanJson, WorkflowPlanTaskJson } from '../lib/types';
import { truncate } from '../lib/utils';

interface AgentTaskGroup {
  key: string;
  label: string;
  tasks: WorkflowPlanTaskJson[];
}

export function WorkflowAgentTabs({
  plan,
  agents,
  artifacts,
}: {
  plan: WorkflowPlanJson;
  agents: RoomAgent[];
  artifacts: TaskArtifact[];
}) {
  const { t } = useI18n();
  const groups = useMemo(() => groupTasksByAgent(plan, agents, t('workflowPlan.unassigned')), [agents, plan, t]);
  const artifactMap = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts]);
  const [activeKey, setActiveKey] = useState<string | null>(groups[0]?.key ?? null);

  useEffect(() => {
    if (!groups.some((group) => group.key === activeKey)) {
      setActiveKey(groups[0]?.key ?? null);
    }
  }, [activeKey, groups]);

  if (groups.length === 0 || !activeKey) {
    return null;
  }

  return (
    <Tabs.Root value={activeKey} onValueChange={setActiveKey} className="workflow-agent-tabs">
      <Tabs.List className="workflow-agent-tab-list" aria-label={t('workflowPlan.agentTabsAria')}>
        {groups.map((group) => (
          <Tabs.Trigger key={group.key} value={group.key} className="workflow-agent-tab-trigger">
            <Bot className="h-3 w-3" />
            <span className="truncate">{group.label}</span>
            <span className="font-mono text-[9.5px] opacity-70">{group.tasks.length}</span>
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {groups.map((group) => (
        <Tabs.Content key={group.key} value={group.key} className="workflow-agent-tab-panel">
          <div className="space-y-2">
            {group.tasks.map((task) => {
              const refs = task.result_refs.map((ref) => artifactMap.get(ref)).filter((item): item is TaskArtifact => Boolean(item));
              return (
                <div key={task.id} className="workflow-agent-result">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--color-primary)]" />
                    <div className="min-w-0 flex-1 truncate text-[12px] font-medium">{task.title}</div>
                    <span className="font-mono text-[10px] text-[var(--color-muted)]">{task.status}</span>
                  </div>
                  {refs.length > 0 ? (
                    <div className="mt-2 space-y-1.5">
                      {refs.map((artifact) => (
                        <details key={artifact.id} className="workflow-agent-artifact">
                          <summary className="cursor-pointer truncate text-[11.5px] font-medium">
                            {artifact.title}
                          </summary>
                          <pre className="mt-1 max-h-[140px] overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-[var(--color-fg-muted)]">
                            {truncate(artifact.content, 900)}
                          </pre>
                        </details>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-[11px] text-[var(--color-fg-muted)]">{t('workflowPlan.noResult')}</div>
                  )}
                </div>
              );
            })}
          </div>
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function groupTasksByAgent(plan: WorkflowPlanJson, agents: RoomAgent[], unassignedLabel: string): AgentTaskGroup[] {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent.agent_name]));
  const groups = new Map<string, AgentTaskGroup>();

  for (const task of plan.tasks) {
    const key = task.agent_id ?? 'unassigned';
    const label = task.agent_id ? agentMap.get(task.agent_id) ?? task.agent_id : unassignedLabel;
    const existing = groups.get(key);
    if (existing) {
      existing.tasks.push(task);
    } else {
      groups.set(key, { key, label, tasks: [task] });
    }
  }

  return [...groups.values()];
}
