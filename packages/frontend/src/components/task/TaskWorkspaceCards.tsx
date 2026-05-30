import type { LucideIcon } from 'lucide-react';

export function TaskMetaCell({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="active-task-meta-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function TaskWorkspacePanelTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <div className="task-detail-card-title">
      <Icon className="h-4 w-4" strokeWidth={1.85} />
      <div className="min-w-0">
        <h4>{title}</h4>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

export function TaskResourceMetric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="resource-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
