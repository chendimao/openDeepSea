import { ClipboardList, Loader2, PenLine, Play, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TaskActionKind, TaskActionState } from '../../lib/types';
import { cn } from '../../lib/utils';

interface TaskActionDefinition {
  id: TaskActionKind;
  label: string;
  description: string;
  icon: LucideIcon;
}

const ACTIONS: TaskActionDefinition[] = [
  { id: 'start_execution', label: '开始执行', description: '固定完整编队并执行', icon: Play },
  { id: 'brainstorming', label: '头脑风暴', description: '澄清需求并产出 spec', icon: PenLine },
  { id: 'writing_plans', label: '编写计划', description: '基于 spec 编写 plan', icon: ClipboardList },
  { id: 'subagent_execution', label: '子代理执行', description: '按 plan 派发子代理', icon: Workflow },
];

export function TaskActionStrip({
  states,
  onStartAction,
  compact = false,
  disabled = false,
}: {
  states: Partial<Record<TaskActionKind, TaskActionState>>;
  onStartAction: (action: TaskActionKind) => void;
  compact?: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className={cn('task-action-strip', compact && 'is-compact')}>
      {ACTIONS.map((action) => {
        const state = states[action.id];
        const status = state?.status ?? 'idle';
        const running = status === 'queued' || status === 'running';
        const actionDisabled = disabled || running;
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            type="button"
            className={cn('task-action-button', `is-${status}`)}
            disabled={actionDisabled}
            onClick={() => onStartAction(action.id)}
            title={state?.detail ?? action.description}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Icon className="h-3.5 w-3.5" />
            )}
            <span>
              <strong>{action.label}</strong>
              {!compact && <small>{state?.detail ?? action.description}</small>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
