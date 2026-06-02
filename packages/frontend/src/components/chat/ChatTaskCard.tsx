import { AlertTriangle, CheckCircle2, ChevronRight, Circle, ClipboardList, Loader2, MousePointer2, Play } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Message, MessageMetadata, RoomAgent, Task, TaskEventType, WorkflowRun } from '../../lib/types';
import { useI18n } from '../../lib/i18n';
import { cn } from '../../lib/utils';

interface ChatTaskCardProps {
  message: Message;
  metadata: MessageMetadata;
  task?: Task;
  roomAgents: RoomAgent[];
  active: boolean;
  workflow?: WorkflowRun;
  startingWorkflow?: boolean;
  onSelectTask?: (task: Task) => void;
  onStartWorkflow?: (task: Task) => void;
}

const eventLabels: Partial<Record<TaskEventType, string>> = {
  message_routed: '已路由到任务',
  message_route_uncertain: '等待确认路由',
  message_intent_uncertain: '等待确认意图',
  plan_proposed: '已生成任务方案',
  task_created: '任务已创建',
  task_updated: '任务已更新',
  task_status_changed: '任务状态更新',
  task_deleted: '任务已删除',
  workflow_started: 'Workflow 已启动',
  workflow_stage_changed: 'Workflow 阶段更新',
  workflow_plan_ready: 'Workflow 计划就绪',
  workflow_assignment_created: 'Workflow 已分配',
  workflow_blocked: 'Workflow 阻塞',
  workflow_recovery_decided: 'Workflow 已恢复',
  workflow_completed: 'Workflow 已完成',
  workflow_cancelled: 'Workflow 已取消',
  workflow_failed: 'Workflow 失败',
  workflow_memory_written: 'Workflow 已写入记忆',
};

const statusMeta: Record<Task['status'], { label: string; progress: number; icon: LucideIcon; tone: string }> = {
  todo: { label: '待处理', progress: 14, icon: Circle, tone: 'muted' },
  in_progress: { label: '进行中', progress: 54, icon: Loader2, tone: 'primary' },
  review: { label: '待验收', progress: 78, icon: MousePointer2, tone: 'review' },
  done: { label: '已完成', progress: 100, icon: CheckCircle2, tone: 'success' },
  failed: { label: '失败', progress: 100, icon: AlertTriangle, tone: 'danger' },
};

const priorityLabels: Record<Task['priority'], string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急',
};

const ACTIVE_WORKFLOW_STATUSES = new Set<WorkflowRun['status']>([
  'draft',
  'running',
  'awaiting_decision',
  'awaiting_approval',
  'blocked',
]);

export function ChatTaskCard({
  message,
  metadata,
  task,
  roomAgents,
  active,
  workflow,
  startingWorkflow,
  onSelectTask,
  onStartWorkflow,
}: ChatTaskCardProps): JSX.Element {
  const { formatRelativeTime, t } = useI18n();
  const status = task ? statusMeta[task.status] : null;
  const StatusIcon = status?.icon ?? ClipboardList;
  const canOpen = Boolean(task && onSelectTask);
  const hasActiveWorkflow = workflow ? ACTIVE_WORKFLOW_STATUSES.has(workflow.status) : false;
  const canStartWorkflow = Boolean(task && onStartWorkflow && !hasActiveWorkflow && task?.status !== 'done');
  const title = task?.title ?? metadata.task_title ?? summarizeTaskTitle(message.content, metadata.task_id);
  const description = summarizeTaskDescription(task?.description, message.content, title);
  const assignee = task?.assigned_agent_id
    ? findAgentName(roomAgents, task.assigned_agent_id)
    : null;
  const eventLabel = metadata.event_type ? eventLabels[metadata.event_type] ?? metadata.event_type : '任务事件';
  const progress = status?.progress ?? progressForEvent(metadata.event_type);
  const taskId = metadata.task_id ?? task?.id ?? message.id;
  const shortTaskId = taskId.length > 10 ? taskId.slice(0, 10) : taskId;

  return (
    <article
      className={cn('chat-task-card', active && 'is-active', canOpen ? 'is-openable' : 'is-disabled')}
      data-status={status?.tone ?? metadata.event_type ?? 'event'}
      data-task-id={metadata.task_id}
    >
      <button
        type="button"
        className="chat-task-card-open"
        disabled={!canOpen}
        onClick={() => {
          if (task && onSelectTask) onSelectTask(task);
        }}
      >
        <span className="chat-task-card-top">
          <span className="chat-task-card-identity">
            <span className="chat-task-card-icon" aria-hidden="true">
              <StatusIcon className="h-3.5 w-3.5" strokeWidth={1.9} />
            </span>
            <span className="chat-task-card-kicker">TASK-{shortTaskId}</span>
          </span>
          {!canStartWorkflow && (
            <span className="chat-task-card-chevron" aria-hidden="true">
              <ChevronRight className="h-4 w-4" />
            </span>
          )}
        </span>

        <span className="chat-task-card-title" title={title}>{title}</span>
        <span className="chat-task-card-description" title={description}>
          {description}
        </span>

        <span className="chat-task-card-progress-label">
          <b>{status?.label ?? eventLabel}</b>
          <strong>{progress}%</strong>
        </span>
        <span className="chat-task-card-progress-track" aria-hidden="true">
          <span className="chat-task-card-progress" style={{ width: `${progress}%` }} />
        </span>

        <span className="chat-task-card-meta">
          <span><b>Owner</b>{assignee ?? '未分配'}</span>
          <span><b>Priority</b>{task ? priorityLabels[task.priority] : '普通'}</span>
          <span><b>Status</b>{status?.label ?? eventLabel}</span>
          <span><b>Time</b>{formatRelativeTime(message.created_at)}</span>
        </span>
      </button>
      {canStartWorkflow && task && (
        <button
          type="button"
          className="chat-task-card-start"
          aria-label={t('taskDetail.startWorkflow')}
          title={t('taskDetail.startWorkflow')}
          disabled={startingWorkflow}
          onClick={() => {
            onStartWorkflow?.(task);
          }}
        >
          {startingWorkflow ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </article>
  );
}

function findAgentName(roomAgents: RoomAgent[], agentId: string): string | null {
  const agent = roomAgents.find((item) => item.id === agentId || item.agent_id === agentId);
  return agent?.agent_name ?? null;
}

function progressForEvent(eventType: TaskEventType | undefined): number {
  if (!eventType) return 18;
  if (eventType === 'task_created' || eventType === 'message_routed') return 18;
  if (eventType === 'workflow_started' || eventType === 'workflow_stage_changed') return 56;
  if (eventType === 'workflow_plan_ready' || eventType === 'workflow_assignment_created') return 72;
  if (eventType === 'workflow_completed') return 100;
  if (eventType === 'workflow_failed' || eventType === 'workflow_cancelled') return 100;
  return 36;
}

function summarizeTaskTitle(content: string, taskId: string | undefined): string {
  const withoutPrefix = content
    .replace(/^已创建任务\s*#[^：:]+[：:]\s*/u, '')
    .replace(/^任务\s*#[^：:]+[：:]\s*/u, '')
    .trim();
  const title = withoutPrefix || taskId || '未命名任务';
  return title.length > 92 ? `${title.slice(0, 89).trimEnd()}...` : title;
}

function summarizeTaskDescription(description: string | null | undefined, content: string, title: string): string {
  const source = description || content;
  const normalized = source
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !line.startsWith('消息模式：') &&
      !line.startsWith('任务意图：') &&
      line !== title
    )
    .join(' ')
    .replace(/^已创建任务\s*#[^：:]+[：:]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = title || '任务详情待补充';
  const result = normalized || fallback;
  return result.length > 150 ? `${result.slice(0, 147).trimEnd()}...` : result;
}
