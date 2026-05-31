import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Bot, CircleDot, Clock3, FileDiff, FileText, Gauge, GitBranch, ListChecks, MonitorPlay, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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
  const prefersReducedMotion = useReducedMotion();
  const cardMotion = (delay = 0) => ({
    initial: prefersReducedMotion ? false as const : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    whileHover: prefersReducedMotion ? undefined : { y: -2 },
    transition: { duration: prefersReducedMotion ? 0 : 0.18, delay: prefersReducedMotion ? 0 : delay, ease: [0.16, 1, 0.3, 1] as const },
  });

  return (
    <div className="task-workspace-empty">
      <div className="task-workspace-empty-copy">
        <CircleDot className="h-7 w-7 text-[var(--color-muted)]" strokeWidth={1.7} />
        <div className="mt-3 font-display text-[14px] font-semibold">{title}</div>
        <p className="mt-1 max-w-[32ch] text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{description}</p>
      </div>
      <div className="task-workspace-empty-preview" aria-hidden="true">
        <motion.div className="task-detail-card execution-plan-card" {...cardMotion(0)}>
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
        </motion.div>
        <motion.div className="task-detail-card realtime-status-card" {...cardMotion(0.03)}>
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
        </motion.div>
        <motion.div className="task-detail-card timeline-card" {...cardMotion(0.06)}>
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
        </motion.div>
        <motion.div className="task-detail-card file-changes-card" {...cardMotion(0.09)}>
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
        </motion.div>
        <motion.div className="task-detail-card tool-calls-card" {...cardMotion(0.12)}>
          <TaskWorkspacePanelTitle icon={GitBranch} title="Tool Calls" subtitle="preview" />
          <div className="tool-call-strip">
            {['search_files', 'read_file', 'generate_preview'].map((tool) => {
              const ToolIcon = toolIconForName(tool);

              return (
                <div key={tool} className="tool-call-card" data-status="waiting" data-tool={tool}>
                  <ToolIcon className="h-4 w-4" strokeWidth={1.8} />
                  <strong>{tool}</strong>
                  <span>waiting</span>
                  <time>--:--</time>
                </div>
              );
            })}
          </div>
        </motion.div>
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

function toolIconForName(name: string): LucideIcon {
  if (name === 'read_file') {
    return FileText;
  }

  if (name === 'generate_preview') {
    return MonitorPlay;
  }

  return Search;
}
