import { useMemo } from 'react';
import type { RoomAgent, TaskArtifact, WorkflowDetail, WorkflowPlanJson } from '../lib/types';
import { WorkflowAgentTabs } from './WorkflowAgentTabs';
import { WorkflowProgressHeader } from './WorkflowProgressHeader';
import { WorkflowTaskTable } from './WorkflowTaskTable';

export function WorkflowTaskBubble({
  detail,
  agents,
  compact = false,
}: {
  detail: WorkflowDetail;
  agents: RoomAgent[];
  compact?: boolean;
}) {
  const workflowPlan = useMemo(() => getWorkflowPlan(detail), [detail]);

  if (!workflowPlan) {
    return null;
  }

  return (
    <div className="workflow-task-bubble" data-source={compact ? 'chat' : 'timeline'}>
      <WorkflowProgressHeader plan={workflowPlan} />
      <WorkflowTaskTable plan={workflowPlan} agents={agents} compact={compact} />
      <WorkflowAgentTabs
        plan={workflowPlan}
        agents={agents}
        artifacts={detail.artifacts}
        steps={detail.steps}
        compact={compact}
      />
    </div>
  );
}

function getWorkflowPlan(detail: WorkflowDetail): WorkflowPlanJson | null {
  const statePlan = parseWorkflowPlanFromGraphState(detail.run.graph_state);
  if (statePlan) return statePlan;

  const artifactPlan = parseWorkflowPlanFromArtifacts(detail.artifacts);
  return artifactPlan;
}

function parseWorkflowPlanFromGraphState(raw: string | null): WorkflowPlanJson | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { workflowPlan?: unknown };
    return isWorkflowPlanJson(parsed.workflowPlan) ? parsed.workflowPlan : null;
  } catch {
    return null;
  }
}

function parseWorkflowPlanFromArtifacts(artifacts: TaskArtifact[]): WorkflowPlanJson | null {
  const planArtifact = [...artifacts].reverse().find((artifact) => artifact.artifact_type === 'plan' && artifact.metadata);
  if (!planArtifact?.metadata) return null;

  try {
    const metadata = JSON.parse(planArtifact.metadata) as { workflow_plan_json?: unknown };
    return isWorkflowPlanJson(metadata.workflow_plan_json) ? metadata.workflow_plan_json : null;
  } catch {
    return null;
  }
}

function isWorkflowPlanJson(value: unknown): value is WorkflowPlanJson {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as WorkflowPlanJson;
  return (
    typeof candidate.workflow_name === 'string' &&
    typeof candidate.source_message_id === 'string' &&
    typeof candidate.goal === 'string' &&
    typeof candidate.summary === 'string' &&
    Array.isArray(candidate.tasks) &&
    candidate.tasks.every((task) => {
      return (
        task &&
        typeof task === 'object' &&
        typeof task.id === 'string' &&
        typeof task.title === 'string' &&
        typeof task.description === 'string' &&
        ['planner', 'executor', 'reviewer', 'acceptor'].includes(task.role) &&
        (typeof task.agent_id === 'string' || task.agent_id === null) &&
        (task.mode === 'parallel' || task.mode === 'serial') &&
        Array.isArray(task.depends_on) &&
        ['pending', 'running', 'completed', 'blocked', 'failed', 'skipped'].includes(task.status) &&
        typeof task.progress === 'number' &&
        Array.isArray(task.result_refs)
      );
    })
  );
}
