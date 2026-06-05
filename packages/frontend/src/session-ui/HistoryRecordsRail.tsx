import { Copy, GitFork, RotateCcw } from 'lucide-react';
import React from 'react';
import type { HistoryRecord, Session } from '../lib/types';
import { evidenceTypeLabel, formatSessionAge, sessionStatusTone } from './session-ui-model';

export function HistoryRecordsRail({
  records,
  activeSession,
  onCommand,
}: {
  records: HistoryRecord[];
  activeSession: Session;
  onCommand: (command: string) => void;
}): JSX.Element {
  const now = Date.now();
  return (
    <aside className="session-panel session-history" aria-label="History Records">
      <div className="session-panel-header">
        <div>
          <span className="session-kicker">History Records</span>
          <h2 className="session-title">历史记录</h2>
        </div>
        <span className="session-chip">{records.length}</span>
      </div>
      <div className="session-scroll session-history__list">
        <div className="session-current-marker">
          <span className="session-label">Active Session</span>
          <strong>{activeSession.title}</strong>
        </div>
        {records.length === 0 ? (
          <div className="session-empty">暂无历史记录。使用 New 后会把两段 New 之间的对话归档到这里。</div>
        ) : records.map((record) => (
          <article className="session-history-row" data-status={record.status} key={record.id}>
            <div className="session-history-row__rail" />
            <div className="session-history-row__body">
              <div className="session-history-row__top">
                <h3>{record.title}</h3>
                <span className="session-chip" data-tone={sessionStatusTone(record.status)}>
                  {record.mode}
                </span>
              </div>
              <p>{record.summary}</p>
              <div className="session-history-row__meta">
                <span>{formatSessionAge(now, record.ended_at)}</span>
                <span>{record.changed_files.length} files</span>
                <span>{record.verification_summary ? evidenceTypeLabel('test') : '未验证'}</span>
              </div>
              <div className="session-history-row__actions">
                <button type="button" className="session-icon-button" title="Resume" onClick={() => onCommand(`/resume ${record.id}`)}>
                  <RotateCcw aria-hidden="true" />
                </button>
                <button type="button" className="session-icon-button" title="Fork" onClick={() => onCommand(`/fork history:${record.id}`)}>
                  <GitFork aria-hidden="true" />
                </button>
                <button type="button" className="session-icon-button" title="Copy Brief" onClick={() => copyText(record.resume_brief)}>
                  <Copy aria-hidden="true" />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}

function copyText(value: string): void {
  if (typeof navigator === 'undefined') return;
  void navigator.clipboard?.writeText(value);
}
