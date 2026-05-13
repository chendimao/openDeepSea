import type { ReactNode } from 'react';

interface WorkspaceEmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

export function WorkspaceEmptyState({
  icon,
  title,
  description,
  action,
}: WorkspaceEmptyStateProps): JSX.Element {
  return (
    <div className="workspace-empty surface-1">
      {icon && <div className="workspace-empty-icon">{icon}</div>}
      <div className="font-display text-[15px] font-semibold text-[var(--color-fg)]">{title}</div>
      <p className="mt-2 max-w-md text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
