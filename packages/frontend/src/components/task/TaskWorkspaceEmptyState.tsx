import { ArrowRight, Bot, CircleDot, Clock3, FileDiff, Gauge, GitBranch, ListChecks, Search } from 'lucide-react';
import type { Task } from '../../lib/types';
import { TaskResourceMetric, TaskWorkspacePanelTitle } from './TaskWorkspaceCards';

interface TaskWorkspaceEmptyStateProps {
  tasks: Task[];
  onSelectTask: (task: Task) => void;
  title: string;
  description: string;
}

export function TaskWorkspaceEmptyState({
  tasks,
  onSelectTask,
  title,
  description,
}: TaskWorkspaceEmptyStateProps): JSX.Element {
  return (
    <div className="task-workspace-empty">
      <div className="task-workspace-empty-copy">
        <CircleDot className="h-7 w-7 text-[var(--color-muted)]" strokeWidth={1.7} />
        <div className="mt-3 font-display text-[14px] font-semibold">{title}</div>
        <p className="mt-1 max-w-[32ch] text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{description}</p>
      </div>
      <div className="task-workspace-empty-preview" aria-hidden="true">
        <div className="task-detail-card execution-plan-card">
          <TaskWorkspacePanelTitle icon={ListChecks} title="Execution Plan" subtitle="3 steps" />
          <div className="execution-step-list">
            {[
              ['分析需求与上下文', 'completed'],
              ['生成 UI 预览', 'running'],
              ['等待验证', 'waiting'],
            ].map(([label, state], index) => (
              <div key={label} className="execution-step" data-state={state}>
                <span className="execution-step-node">{index + 1}</span>
                <div className="min-w-0">
                  <strong>{label}</strong>
                  <small>{state}</small>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="task-detail-card realtime-status-card">
          <TaskWorkspacePanelTitle icon={Gauge} title="Realtime Status" subtitle="waiting" />
          <div className="current-agent-row">
            <Bot className="h-7 w-7 text-[var(--color-muted)]" />
            <div className="current-agent-copy">
              <div className="current-status-line">
                <span>Current Agent</span>
                <strong>AI Agent</strong>
              </div>
              <div className="current-status-line">
                <span>Current Step</span>
                <strong>AI 正在生成 UI 预览...</strong>
              </div>
            </div>
            <i />
          </div>
          <div className="resource-metrics">
            <TaskResourceMetric label="Tokens" value="0" />
            <TaskResourceMetric label="Tool Calls" value="0" />
            <TaskResourceMetric label="File Reads" value="0" />
            <TaskResourceMetric label="File Changes" value="0" />
          </div>
        </div>
        <div className="task-detail-card timeline-card">
          <TaskWorkspacePanelTitle icon={Clock3} title="Timeline" subtitle="Activity stream" />
          <div className="workspace-timeline-list">
            {[
              ['21:42:13', '任务启动'],
              ['21:42:18', '分析需求'],
              ['21:42:25', '收集资料'],
            ].map(([time, label]) => (
              <div key={`${time}:${label}`} className="workspace-timeline-row">
                <time>{time}</time>
                <span className="task-event-dot" data-layer="timeline" />
                <strong>{label}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="task-detail-card file-changes-card">
          <TaskWorkspacePanelTitle icon={FileDiff} title="File Changes" subtitle="0 files" />
          <div className="file-change-list">
            <div className="file-change-header" aria-hidden="true">
              <span>File</span>
              <strong>+</strong>
              <strong>-</strong>
            </div>
            <div className="file-change-row is-empty">
              <span>preview.diff</span>
              <strong className="text-[var(--color-success)]">+0</strong>
              <strong className="text-[var(--color-danger)]">-0</strong>
            </div>
          </div>
        </div>
        <div className="task-detail-card tool-calls-card">
          <TaskWorkspacePanelTitle icon={GitBranch} title="Tool Calls" subtitle="preview" />
          <div className="tool-call-strip">
            {['search_files', 'read_file', 'generate_preview'].map((tool) => (
              <div key={tool} className="tool-call-card" data-status="waiting">
                <Search className="h-4 w-4" strokeWidth={1.8} />
                <strong>{tool}</strong>
                <span>waiting</span>
                <time>--:--</time>
              </div>
            ))}
          </div>
        </div>
      </div>
      {tasks.length > 0 && (
        <div className="mt-4 w-full space-y-2">
          {tasks.slice(0, 3).map((task) => (
            <button key={task.id} type="button" className="task-workspace-suggestion" onClick={() => onSelectTask(task)}>
              <span className="truncate">{task.title}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
