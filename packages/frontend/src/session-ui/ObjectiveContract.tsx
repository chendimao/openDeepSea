import React from 'react';
import type { Session, SessionPlanItem } from '../lib/types';

export function ObjectiveContract({
  session,
  planItems,
}: {
  session: Session;
  planItems: SessionPlanItem[];
}): JSX.Element {
  const visibleItems = planItems.slice(0, 6);
  return (
    <section className="session-objective" aria-label="Objective contract">
      <div>
        <span className="session-label">Goal</span>
        <h3>{session.current_goal ?? '尚未设置目标'}</h3>
      </div>
      <dl>
        <div>
          <dt>Mode</dt>
          <dd>{session.mode}</dd>
        </div>
        <div>
          <dt>Phase</dt>
          <dd>{session.phase}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{session.branch_name ?? 'default'}</dd>
        </div>
      </dl>
      {visibleItems.length > 0 && (
        <ol className="session-plan-list">
          {visibleItems.map((item) => (
            <li key={item.id} data-status={item.status}>
              <span>{item.title}</span>
              <small>{item.status}</small>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
