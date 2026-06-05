import React from 'react';
import type { SessionEvidenceEvent } from '../lib/types';

export function FilesInspector({ evidence }: { evidence: SessionEvidenceEvent[] }): JSX.Element {
  const files = collectFiles(evidence);
  return (
    <section className="session-inspector-section" aria-label="Files Inspector">
      {files.length === 0 ? (
        <div className="session-empty">暂无文件证据。</div>
      ) : (
        <ul className="session-file-list">
          {files.map((file) => <li key={file}>{file}</li>)}
        </ul>
      )}
    </section>
  );
}

function collectFiles(evidence: SessionEvidenceEvent[]): string[] {
  const files = new Set<string>();
  for (const event of evidence) {
    for (const key of ['path', 'file', 'file_path']) {
      const value = event.payload[key];
      if (typeof value === 'string' && value.trim()) files.add(value.trim());
    }
    const list = event.payload.files;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === 'string' && item.trim()) files.add(item.trim());
      }
    }
  }
  return [...files].sort();
}
