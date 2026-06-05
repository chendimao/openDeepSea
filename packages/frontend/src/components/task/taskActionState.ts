import type { Task, TaskActionKind, TaskActionState, TaskEvent, TaskReviewFinding } from '../../lib/types';

const ACTIONS: TaskActionKind[] = [
  'start_execution',
  'auto_advance',
  'route_skills',
  'brainstorming',
  'writing_plans',
  'subagent_execution',
  'systematic_debugging',
  'verification',
  'finish_branch',
];

export type SuperpowersTaskStage =
  | 'unrouted'
  | 'routing'
  | 'routed'
  | 'brainstorming'
  | 'spec_ready'
  | 'planning'
  | 'plan_ready'
  | 'executing'
  | 'debugging'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'blocked';

export function createTaskActionStates(
  events: TaskEvent[],
  pendingKey: string | null,
): Partial<Record<TaskActionKind, TaskActionState>> {
  const states: Partial<Record<TaskActionKind, TaskActionState>> = {};
  for (const event of [...events].sort(compareTaskActionEvents)) {
    const action = getTaskActionKind(event.payload.task_action ?? event.payload.action);
    if (!action) continue;
    const status = getTaskActionStatus(event.payload.task_action_status ?? event.payload.status);
    if (!status) continue;
    states[action] = {
      status,
      detail: getTaskActionDetail(event.payload),
      evidence: getTaskActionEvidence(event.payload),
      reviewFindings: getReviewFindings(event.payload),
      reviewFixRounds: getReviewFixRounds(event.payload),
    };
  }

  if (pendingKey) {
    const [, action] = splitPendingKey(pendingKey);
    if (action) {
      states[action] = {
        status: 'running',
        detail: '运行中',
      };
    }
  }

  return states;
}

export function deriveSuperpowersTaskStage(
  states: Partial<Record<TaskActionKind, TaskActionState>>,
  taskStatus?: Task['status'],
): SuperpowersTaskStage {
  if (taskStatus === 'failed') return 'failed';
  if (hasStatus(states, 'failed')) return 'failed';
  if (hasStatus(states, 'blocked')) return 'blocked';

  const runningAction = findActionByStatus(states, ['queued', 'running']);
  if (runningAction) return stageForRunningAction(runningAction);

  if (taskStatus === 'done') return 'done';
  if (isCompleted(states.finish_branch) || isCompleted(states.verification)) return 'done';
  if (hasEvidence(states.writing_plans, 'implementationPlanPath')) return 'plan_ready';
  if (hasEvidence(states.brainstorming, 'designDocPath')) return 'spec_ready';
  if (hasRoutingEvidence(states)) return 'routed';
  return 'unrouted';
}

function compareTaskActionEvents(a: TaskEvent, b: TaskEvent): number {
  if (a.task_id === b.task_id && a.seq !== b.seq) return a.seq - b.seq;
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id.localeCompare(b.id);
}

export function createTaskActionPendingKey(taskId: string, action: TaskActionKind): string {
  return `${taskId}:${action}`;
}

function splitPendingKey(value: string): [string, TaskActionKind | null] {
  const [taskId, rawAction] = value.split(':');
  return [taskId ?? '', getTaskActionKind(rawAction)];
}

function getTaskActionKind(value: unknown): TaskActionKind | null {
  return typeof value === 'string' && ACTIONS.includes(value as TaskActionKind)
    ? value as TaskActionKind
    : null;
}

function getTaskActionStatus(value: unknown): TaskActionState['status'] | null {
  return value === 'queued' ||
    value === 'running' ||
    value === 'failed' ||
    value === 'completed' ||
    value === 'blocked'
    ? value
    : null;
}

function getTaskActionDetail(payload: Record<string, unknown>): string | undefined {
  const blockedReason = payload.blocked_reason;
  if (typeof blockedReason === 'string' && blockedReason.trim()) return blockedReason.trim();
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  const content = payload.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  return undefined;
}

function getTaskActionEvidence(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const evidence = payload.evidence;
  const result: Record<string, unknown> = isRecord(evidence) ? { ...evidence } : {};
  if (isRecord(payload.superpowers_routing)) {
    result.superpowers_routing = payload.superpowers_routing;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function getReviewFindings(payload: Record<string, unknown>): TaskReviewFinding[] | undefined {
  const value = payload.review_findings;
  if (!Array.isArray(value)) return undefined;
  const findings = value.map(normalizeReviewFinding).filter((finding): finding is TaskReviewFinding => finding !== null);
  return findings.length > 0 ? findings : undefined;
}

function normalizeReviewFinding(value: unknown): TaskReviewFinding | null {
  if (!isRecord(value)) return null;
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (!summary) return null;
  const severity = value.severity === 'critical' || value.severity === 'important' || value.severity === 'minor'
    ? value.severity
    : 'important';
  const file = typeof value.file === 'string' && value.file.trim() ? value.file.trim() : undefined;
  const line = typeof value.line === 'number' && Number.isFinite(value.line) && value.line > 0
    ? Math.floor(value.line)
    : undefined;
  return { severity, summary, file, line };
}

function getReviewFixRounds(payload: Record<string, unknown>): number | undefined {
  const value = payload.review_fix_rounds;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function hasStatus(
  states: Partial<Record<TaskActionKind, TaskActionState>>,
  status: TaskActionState['status'],
): boolean {
  return Object.values(states).some((state) => state?.status === status);
}

function findActionByStatus(
  states: Partial<Record<TaskActionKind, TaskActionState>>,
  statuses: TaskActionState['status'][],
): TaskActionKind | null {
  for (const action of ACTIONS) {
    const status = states[action]?.status;
    if (status && statuses.includes(status)) return action;
  }
  return null;
}

function stageForRunningAction(action: TaskActionKind): SuperpowersTaskStage {
  if (action === 'auto_advance' || action === 'route_skills') return 'routing';
  if (action === 'brainstorming') return 'brainstorming';
  if (action === 'writing_plans') return 'planning';
  if (action === 'subagent_execution' || action === 'start_execution') return 'executing';
  if (action === 'systematic_debugging') return 'debugging';
  return 'verifying';
}

function isCompleted(state: TaskActionState | undefined): boolean {
  return state?.status === 'completed';
}

function hasRoutingEvidence(states: Partial<Record<TaskActionKind, TaskActionState>>): boolean {
  return hasEvidence(states.auto_advance, 'superpowers_routing') ||
    hasEvidence(states.route_skills, 'superpowers_routing') ||
    hasEvidence(states.auto_advance, 'next_action') ||
    hasEvidence(states.route_skills, 'next_action');
}

function hasEvidence(state: TaskActionState | undefined, key: string): boolean {
  if (!state || state.status !== 'completed' || !state.evidence) return false;
  const value = state.evidence[key];
  if (typeof value === 'string') return value.trim().length > 0;
  return Boolean(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
