import * as Tabs from '@radix-ui/react-tabs';
import { Bot, FileText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';
import type { RoomAgent, TaskArtifact, WorkflowPlanJson, WorkflowStage, WorkflowStep } from '../lib/types';
import { cn, truncate } from '../lib/utils';

interface AgentTaskGroup {
  key: string;
  label: string;
  items: AgentExecutionItem[];
  latestActivityAt: number;
}

interface AgentExecutionItem {
  id: string;
  title: string;
  status: string;
  stage: WorkflowStage | null;
  content: string | null;
  createdAt: number;
  source: 'step' | 'artifact' | 'task';
}

export function WorkflowAgentTabs({
  plan,
  agents,
  artifacts,
  steps = [],
  compact = false,
}: {
  plan: WorkflowPlanJson;
  agents: RoomAgent[];
  artifacts: TaskArtifact[];
  steps?: WorkflowStep[];
  compact?: boolean;
}) {
  const { t, workflowStageLabel } = useI18n();
  const groups = useMemo(
    () => groupExecutionsByAgent(plan, agents, artifacts, steps, t('workflowPlan.unassigned')),
    [agents, artifacts, plan, steps, t],
  );
  const defaultActiveKey = useMemo(() => pickDefaultGroup(groups)?.key ?? null, [groups]);
  const [activeKey, setActiveKey] = useState<string | null>(defaultActiveKey);

  useEffect(() => {
    if (!groups.some((group) => group.key === activeKey)) {
      setActiveKey(defaultActiveKey);
    }
  }, [activeKey, defaultActiveKey, groups]);

  if (groups.length === 0 || !activeKey) {
    return null;
  }

  return (
    <Tabs.Root
      value={activeKey}
      onValueChange={setActiveKey}
      className={cn('workflow-agent-tabs', compact && 'is-compact')}
    >
      <Tabs.List className="workflow-agent-tab-list" aria-label={t('workflowPlan.agentTabsAria')}>
        {groups.map((group) => (
          <Tabs.Trigger key={group.key} value={group.key} className="workflow-agent-tab-trigger">
            <Bot className="h-3 w-3" />
            <span className="workflow-agent-tab-label truncate">{group.label}</span>
            <span className="workflow-agent-tab-counts">
              <span>{t('workflowPlan.agentTabReplies', { count: group.items.length })}</span>
            </span>
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {groups.map((group) => (
        <Tabs.Content key={group.key} value={group.key} className="workflow-agent-tab-panel">
          <div className="workflow-agent-panel">
            <div className="workflow-agent-panel-header">
              <div className="workflow-agent-panel-title">{group.label}</div>
              <div className="workflow-agent-panel-meta">
                <span>{t('workflowPlan.agentTabReplies', { count: group.items.length })}</span>
              </div>
            </div>
            <div className="space-y-2">
              {group.items.length > 0 ? group.items.map((item) => (
                <div key={item.id} className="workflow-agent-result">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--color-primary)]" />
                    <div className="min-w-0 flex-1 truncate text-[12px] font-medium">{item.title}</div>
                    <span className="font-mono text-[10px] text-[var(--color-muted)]">{getAgentItemStatusLabel(item.status, t)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-[var(--color-fg-muted)]">
                    {item.stage && <span>{workflowStageLabel(item.stage)}</span>}
                    <span>{t(`workflowPlan.executionSource.${item.source}`)}</span>
                  </div>
                  {item.content ? (
                    <pre className="mt-2 max-h-[140px] overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-[var(--color-fg-muted)]">
                      {truncate(item.content, compact ? 520 : 900)}
                    </pre>
                  ) : (
                    <div className="mt-1 text-[11px] text-[var(--color-fg-muted)]">{t('workflowPlan.noResult')}</div>
                  )}
                </div>
              )) : (
                <div className="workflow-agent-result">
                  <div className="text-[11px] text-[var(--color-fg-muted)]">{t('workflowPlan.noResult')}</div>
                </div>
              )}
            </div>
          </div>
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function groupExecutionsByAgent(
  plan: WorkflowPlanJson,
  agents: RoomAgent[],
  artifacts: TaskArtifact[],
  steps: WorkflowStep[],
  unassignedLabel: string,
): AgentTaskGroup[] {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const stepMap = new Map(steps.map((step) => [step.id, step]));
  const artifactsByStep = new Map<string, TaskArtifact[]>();
  const artifactsByTask = new Map<string, TaskArtifact[]>();

  for (const artifact of artifacts) {
    if (artifact.workflow_step_id) {
      const current = artifactsByStep.get(artifact.workflow_step_id) ?? [];
      current.push(artifact);
      artifactsByStep.set(artifact.workflow_step_id, current);
    }
    const taskArtifacts = artifactsByTask.get(artifact.task_id) ?? [];
    taskArtifacts.push(artifact);
    artifactsByTask.set(artifact.task_id, taskArtifacts);
  }

  const groups = new Map<string, AgentTaskGroup>();

  for (const task of plan.tasks) {
    const key = task.agent_id ?? 'unassigned';
    const agent = task.agent_id ? agentMap.get(task.agent_id) : null;
    const label = agent?.agent_name ?? agent?.workflow_role ?? task.role ?? task.agent_id ?? unassignedLabel;
    let group: AgentTaskGroup | null = null;
    for (const artifact of task.result_refs
      .map((ref) => artifacts.find((candidate) => candidate.id === ref))
      .filter((item): item is TaskArtifact => Boolean(item))) {
      group ??= ensureGroup(groups, key, label);
      addGroupItem(group, createArtifactItem(artifact, stepMap.get(artifact.workflow_step_id ?? ''), task.title));
    }
  }

  for (const step of steps) {
    const key = step.assigned_room_agent_id ?? step.room_agent_id ?? 'unassigned';
    const agent = key !== 'unassigned' ? agentMap.get(key) : null;
    const label = agent?.agent_name ?? agent?.workflow_role ?? key;
    const group = ensureGroup(groups, key, label === 'unassigned' ? unassignedLabel : label);
    const taskTitle = plan.tasks.find((task) => task.id === step.task_id)?.title ?? step.stage;
    addGroupItem(group, createStepItem(step, taskTitle));
    for (const artifact of artifactsByStep.get(step.id) ?? []) {
      addGroupItem(group, createArtifactItem(artifact, step, taskTitle));
    }
  }

  for (const [taskId, taskArtifacts] of artifactsByTask) {
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    const key = task?.agent_id ?? 'unassigned';
    const group = ensureGroup(groups, key, task?.agent_id ? agentMap.get(task.agent_id)?.agent_name ?? task.agent_id : unassignedLabel);
    const knownIds = new Set(group.items.map((item) => item.id));
    for (const artifact of taskArtifacts) {
      if (knownIds.has(`artifact:${artifact.id}`)) continue;
      addGroupItem(group, createArtifactItem(artifact, artifact.workflow_step_id ? stepMap.get(artifact.workflow_step_id) : undefined, task?.title ?? artifact.title));
    }
  }

  return [...groups.values()].map((group) => {
    const items = normalizeGroupItems(group).sort((a, b) => a.createdAt - b.createdAt);
    return {
      ...group,
      items,
      latestActivityAt: Math.max(...items.map((item) => item.createdAt), 0),
    };
  });
}

function ensureGroup(groups: Map<string, AgentTaskGroup>, key: string, label: string): AgentTaskGroup {
  const existing = groups.get(key);
  if (existing) return existing;
  const group = { key, label, items: [], latestActivityAt: 0 };
  groups.set(key, group);
  return group;
}

function addGroupItem(group: AgentTaskGroup, item: AgentExecutionItem): void {
  if (group.items.some((existing) => existing.id === item.id)) return;
  group.items.push(item);
}

function normalizeGroupItems(group: AgentTaskGroup): AgentExecutionItem[] {
  if (group.items.length > 0) return group.items;
  return [];
}

function createStepItem(step: WorkflowStep, taskTitle: string): AgentExecutionItem {
  return {
    id: `step:${step.id}`,
    title: taskTitle,
    status: step.status,
    stage: step.stage,
    content: step.result || step.error || null,
    createdAt: step.completed_at ?? step.started_at ?? step.updated_at ?? step.created_at,
    source: 'step',
  };
}

function createArtifactItem(artifact: TaskArtifact, step: WorkflowStep | undefined, fallbackTitle: string): AgentExecutionItem {
  return {
    id: `artifact:${artifact.id}`,
    title: artifact.title || fallbackTitle,
    status: step?.status ?? artifact.artifact_type,
    stage: step?.stage ?? null,
    content: artifact.content || null,
    createdAt: artifact.created_at,
    source: 'artifact',
  };
}

function pickDefaultGroup(groups: AgentTaskGroup[]): AgentTaskGroup | null {
  const withContent = groups
    .filter((group) => group.items.some((item) => item.content?.trim()))
    .sort((a, b) => b.latestActivityAt - a.latestActivityAt);
  return withContent[0] ?? [...groups].sort((a, b) => b.latestActivityAt - a.latestActivityAt)[0] ?? null;
}

function getAgentItemStatusLabel(status: string, t: ReturnType<typeof useI18n>['t']): string {
  switch (status) {
    case 'completed':
      return t('workflowPlan.status.completed');
    case 'running':
      return t('workflowPlan.status.running');
    case 'pending':
      return t('workflowPlan.status.pending');
    case 'blocked':
      return t('workflowPlan.status.blocked');
    case 'failed':
      return t('workflowPlan.status.failed');
    case 'skipped':
      return t('workflowPlan.status.skipped');
    default:
      return status;
  }
}
