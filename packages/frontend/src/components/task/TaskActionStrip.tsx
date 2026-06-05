import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bug, ChevronDown, ClipboardList, Loader2, MoreHorizontal, PenLine, Rocket, Route, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TaskActionKind, TaskActionState, TaskExecutionDecision } from '../../lib/types';
import { cn } from '../../lib/utils';
import { deriveSuperpowersTaskStage, type SuperpowersTaskStage } from './taskActionState';

interface TaskActionDefinition {
  id: TaskActionKind;
  label: string;
  description: string;
  icon: LucideIcon;
}

const MENU_ACTIONS: TaskActionDefinition[] = [
  { id: 'route_skills', label: '重新运行路由判断', description: '让 planner 重新判断下一步 skill', icon: Route },
  { id: 'brainstorming', label: '强制头脑风暴', description: '由 planner 澄清需求并产出 spec', icon: PenLine },
  { id: 'writing_plans', label: '强制编写计划', description: '基于已有 spec 编写 plan', icon: ClipboardList },
  { id: 'subagent_execution', label: '强制执行计划', description: '按 implementation plan 派发执行', icon: Workflow },
  { id: 'systematic_debugging', label: '强制诊断/调试', description: '按 systematic-debugging 排查失败', icon: Bug },
];

const BUSY_ACTIONS: TaskActionKind[] = [
  'auto_advance',
  'route_skills',
  'brainstorming',
  'writing_plans',
  'subagent_execution',
  'systematic_debugging',
  'verification',
  'finish_branch',
  'start_execution',
];

export function TaskActionStrip({
  states,
  pendingTaskExecution,
  onStartAction,
  compact = false,
  disabled = false,
}: {
  states: Partial<Record<TaskActionKind, TaskActionState>>;
  pendingTaskExecution?: TaskExecutionDecision | null;
  onStartAction: (action: TaskActionKind) => void;
  compact?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const stage = deriveSuperpowersTaskStage(states);
  const busyAction = findBusyAction(states);
  const busy = Boolean(busyAction);
  const awaitingUser = isAwaitingUserTaskExecution(pendingTaskExecution);
  const blocked = stage === 'blocked';
  const failed = stage === 'failed';
  const controlsDisabled = disabled || busy || awaitingUser;
  const mainLabel = awaitingUser
    ? createAwaitingUserLabel(pendingTaskExecution)
    : createPrimaryActionLabel(stage, busy);
  const detail = awaitingUser && pendingTaskExecution
    ? createAwaitingUserDetail(pendingTaskExecution)
    : findStageDetail(states, stage, busyAction);
  const reviewState = findReviewState(states);
  const visualStatus = awaitingUser
    ? 'blocked'
    : createPrimaryVisualStatus(stage, busyAction ? states[busyAction]?.status : undefined);
  const menuContent = (
    <DropdownMenu.Content
      forceMount
      align="end"
      sideOffset={6}
      className="task-action-menu-content"
    >
      {MENU_ACTIONS.map((action) => {
        const Icon = action.icon;
        return (
          <DropdownMenu.Item
            key={action.id}
            className="task-action-menu-item"
            disabled={controlsDisabled}
            onSelect={() => onStartAction(action.id)}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{action.label}</span>
          </DropdownMenu.Item>
        );
      })}
    </DropdownMenu.Content>
  );

  return (
    <div className={cn('task-action-strip', compact && 'is-compact')} data-stage={stage}>
      <button
        type="button"
        className={cn('task-action-button task-action-button-primary', `is-${visualStatus}`, (failed || blocked) && !awaitingUser && 'is-retry')}
        disabled={controlsDisabled}
        onClick={() => onStartAction('auto_advance')}
        title={detail}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Rocket className="h-3.5 w-3.5" />
        )}
        <span>
          <strong>{mainLabel}</strong>
          {!compact && <small>{detail}</small>}
        </span>
      </button>

      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="task-action-button task-action-more-button"
            disabled={controlsDisabled}
            aria-label="更多任务动作"
            title="更多任务动作"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
            <span><strong>更多</strong></span>
            <ChevronDown className="h-3 w-3 task-action-more-chevron" />
          </button>
        </DropdownMenu.Trigger>
        {shouldUseDropdownPortal() ? (
          <DropdownMenu.Portal>{menuContent}</DropdownMenu.Portal>
        ) : (
          menuContent
        )}
      </DropdownMenu.Root>
      {reviewState && (
        <div className="task-action-review-panel">
          <div className="task-action-review-header">
            <strong>审查问题</strong>
            {reviewState.reviewFixRounds ? (
              <span>已自动回派修复 {reviewState.reviewFixRounds} 轮</span>
            ) : null}
          </div>
          <ul>
            {reviewState.reviewFindings.slice(0, 3).map((finding, index) => (
              <li key={`${finding.severity}-${finding.summary}-${index}`}>
                <span className={`task-action-review-severity is-${finding.severity}`}>
                  {reviewSeverityLabel(finding.severity)}
                </span>
                <span className="task-action-review-summary">{finding.summary}</span>
                {finding.file ? (
                  <code>{finding.file}{finding.line ? `:${finding.line}` : ''}</code>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function isAwaitingUserTaskExecution(decision: TaskExecutionDecision | null | undefined): decision is TaskExecutionDecision {
  return decision?.state === 'needs_boundary_confirmation' || decision?.state === 'needs_choice';
}

function createAwaitingUserLabel(decision: TaskExecutionDecision | null | undefined): string {
  if (decision?.state === 'needs_choice') return '等待用户选择方案';
  return '等待用户确认边界';
}

function createAwaitingUserDetail(decision: TaskExecutionDecision): string {
  return decision.summary || decision.reason || '等待用户回复后继续原任务';
}

function createPrimaryActionLabel(stage: SuperpowersTaskStage, busy: boolean): string {
  if (stage === 'failed' || stage === 'blocked') return '重试自动推进';
  if (busy) return STAGE_COPY[stage].runningLabel ?? STAGE_COPY[stage].label;
  return '自动推进';
}

function createPrimaryVisualStatus(
  stage: SuperpowersTaskStage,
  busyStatus: TaskActionState['status'] | undefined,
): TaskActionState['status'] | 'idle' {
  if (stage === 'failed') return 'failed';
  if (stage === 'blocked') return 'blocked';
  if (busyStatus === 'queued' || busyStatus === 'running') return busyStatus;
  if (stage === 'routed' || stage === 'spec_ready' || stage === 'plan_ready' || stage === 'done') return 'completed';
  return 'idle';
}

function findStageDetail(
  states: Partial<Record<TaskActionKind, TaskActionState>>,
  stage: SuperpowersTaskStage,
  busyAction: TaskActionKind | null,
): string {
  const primaryStatus = stage === 'failed' ? 'failed' : stage === 'blocked' ? 'blocked' : null;
  if (primaryStatus) {
    return findDetailByStatus(states, primaryStatus) ?? STAGE_COPY[stage].detail;
  }
  if (busyAction) {
    return states[busyAction]?.detail ?? STAGE_COPY[stage].detail;
  }
  return STAGE_COPY[stage].detail;
}

function findBusyAction(states: Partial<Record<TaskActionKind, TaskActionState>>): TaskActionKind | null {
  for (const action of BUSY_ACTIONS) {
    const status = states[action]?.status;
    if (status === 'queued' || status === 'running') return action;
  }
  return null;
}

function findDetailByStatus(
  states: Partial<Record<TaskActionKind, TaskActionState>>,
  status: TaskActionState['status'],
): string | undefined {
  for (const action of BUSY_ACTIONS) {
    const state = states[action];
    if (state?.status === status && state.detail) return state.detail;
  }
  return undefined;
}

type TaskActionReviewState = TaskActionState & {
  reviewFindings: NonNullable<TaskActionState['reviewFindings']>;
};

function findReviewState(states: Partial<Record<TaskActionKind, TaskActionState>>): TaskActionReviewState | null {
  for (const action of BUSY_ACTIONS) {
    const state = states[action];
    if (state?.reviewFindings?.length) return state as TaskActionReviewState;
  }
  return null;
}

function reviewSeverityLabel(severity: NonNullable<TaskActionState['reviewFindings']>[number]['severity']): string {
  if (severity === 'critical') return 'Critical';
  if (severity === 'important') return 'Important';
  return 'Minor';
}

function shouldUseDropdownPortal(): boolean {
  return typeof document !== 'undefined' && Boolean(document.body);
}

const STAGE_COPY: Record<SuperpowersTaskStage, { label: string; detail: string; runningLabel?: string }> = {
  unrouted: {
    label: '待路由',
    detail: '由 planner 判断下一步 Superpowers 阶段',
  },
  routing: {
    label: '路由中',
    runningLabel: '路由判断中',
    detail: 'planner 正在判断下一步 skill',
  },
  routed: {
    label: '路由完成',
    detail: '路由已完成，可继续自动推进',
  },
  brainstorming: {
    label: '头脑风暴中',
    runningLabel: '头脑风暴中',
    detail: 'planner 正在澄清需求并产出 spec',
  },
  spec_ready: {
    label: 'Spec 已生成',
    detail: 'Spec 已生成，可继续自动推进到编写计划',
  },
  planning: {
    label: '编写计划中',
    runningLabel: '编写计划中',
    detail: 'planner 正在基于 spec 编写 implementation plan',
  },
  plan_ready: {
    label: 'Plan 已生成',
    detail: 'Plan 已生成，可继续自动推进到执行阶段',
  },
  executing: {
    label: '执行中',
    runningLabel: '执行中',
    detail: '执行类智能体正在按 plan 运行',
  },
  debugging: {
    label: '诊断/调试中',
    runningLabel: '诊断/调试中',
    detail: '调试智能体正在按 systematic-debugging 排查',
  },
  verifying: {
    label: '验收中',
    runningLabel: '验收中',
    detail: '正在执行验证、审查或完成分支收尾',
  },
  done: {
    label: '完成',
    detail: '任务动作已完成验证或分支收尾',
  },
  failed: {
    label: '失败',
    detail: '阶段失败，点击重试自动推进',
  },
  blocked: {
    label: '阻塞',
    detail: '阶段阻塞，处理阻塞后可重试自动推进',
  },
};
