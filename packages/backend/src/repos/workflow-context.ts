import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  WorkflowContextEntry,
  WorkflowContextEntryType,
  WorkflowContextSourceType,
} from '../types.js';

const TRUNCATED_MARKER = '...已截断';
const DEFAULT_MAX_ENTRY_CHARS = 1500;
const DEFAULT_MAX_TOTAL_CHARS = 10000;

export interface WorkflowContextCreateInput {
  workflow_run_id: string;
  workflow_step_id?: string | null;
  task_id: string;
  room_agent_id?: string | null;
  agent_run_id?: string | null;
  source_type: WorkflowContextSourceType;
  source_id: string;
  entry_type: WorkflowContextEntryType;
  title: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  raw_char_count?: number;
  summary_char_count?: number;
  token_estimate?: number;
  version?: number;
}

export interface WorkflowContextFormatOptions {
  maxEntryChars?: number;
  maxTotalChars?: number;
}

export const workflowContextRepo = {
  create(input: WorkflowContextCreateInput): WorkflowContextEntry {
    const existing = this.getBySourceVersion({
      workflow_run_id: input.workflow_run_id,
      source_type: input.source_type,
      source_id: input.source_id,
      entry_type: input.entry_type,
      version: input.version ?? 1,
    });
    if (existing) return existing;

    const id = nanoid(14);
    const content = input.content.trim();
    const rawCharCount = Math.max(0, input.raw_char_count ?? content.length);
    const summaryCharCount = Math.max(0, input.summary_char_count ?? content.length);
    const tokenEstimate = Math.max(0, input.token_estimate ?? estimateTokenCount(content));
    db.prepare(
      `INSERT INTO workflow_context_entries (
        id, workflow_run_id, workflow_step_id, task_id, room_agent_id, agent_run_id,
        source_type, source_id, entry_type, title, content, metadata,
        raw_char_count, summary_char_count, token_estimate, version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workflow_run_id,
      input.workflow_step_id ?? null,
      input.task_id,
      input.room_agent_id ?? null,
      input.agent_run_id ?? null,
      input.source_type,
      input.source_id,
      input.entry_type,
      input.title.trim(),
      content,
      input.metadata ? JSON.stringify(input.metadata) : null,
      rawCharCount,
      summaryCharCount,
      tokenEstimate,
      input.version ?? 1,
      now(),
    );
    return this.get(id)!;
  },

  get(id: string): WorkflowContextEntry | undefined {
    return db.prepare('SELECT * FROM workflow_context_entries WHERE id = ?').get(id) as WorkflowContextEntry | undefined;
  },

  getBySourceVersion(input: {
    workflow_run_id: string;
    source_type: WorkflowContextSourceType;
    source_id: string;
    entry_type: WorkflowContextEntryType;
    version: number;
  }): WorkflowContextEntry | undefined {
    return db
      .prepare(
        `SELECT * FROM workflow_context_entries
         WHERE workflow_run_id = ? AND source_type = ? AND source_id = ? AND entry_type = ? AND version = ?
         LIMIT 1`,
      )
      .get(
        input.workflow_run_id,
        input.source_type,
        input.source_id,
        input.entry_type,
        input.version,
      ) as WorkflowContextEntry | undefined;
  },

  listByWorkflow(workflowRunId: string): WorkflowContextEntry[] {
    return db
      .prepare('SELECT * FROM workflow_context_entries WHERE workflow_run_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(workflowRunId) as WorkflowContextEntry[];
  },

  listByStep(workflowStepId: string): WorkflowContextEntry[] {
    return db
      .prepare('SELECT * FROM workflow_context_entries WHERE workflow_step_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(workflowStepId) as WorkflowContextEntry[];
  },
};

export function formatWorkflowContextEntries(
  entries: WorkflowContextEntry[],
  options: WorkflowContextFormatOptions = {},
): string {
  if (entries.length === 0) return '已有工作流上下文：暂无。';

  const maxEntryChars = Math.max(1, options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS);
  const maxTotalChars = Math.max(1, options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS);
  const ordered = [...entries].sort(compareContextEntries);
  const lines: string[] = ['已有工作流上下文：'];
  const rawRefs: string[] = [];

  for (const entry of ordered) {
    const body = truncateText(entry.content, maxEntryChars);
    const line = [
      `${lines.length}. [${entry.entry_type}] ${entry.title}`,
      body,
    ].join('\n');
    const next = [...lines, line].join('\n\n');
    if (next.length > maxTotalChars) break;
    lines.push(line);
    const refs = formatRawRefs(entry);
    if (refs) rawRefs.push(refs);
  }

  if (rawRefs.length > 0) {
    const refsBlock = ['原始输出引用：', ...rawRefs.map((ref) => `- ${ref}`)].join('\n');
    const next = [...lines, refsBlock].join('\n\n');
    if (next.length <= maxTotalChars) lines.push(refsBlock);
  }

  return truncateText(lines.join('\n\n'), maxTotalChars);
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function compareContextEntries(a: WorkflowContextEntry, b: WorkflowContextEntry): number {
  return entryPriority(a.entry_type) - entryPriority(b.entry_type);
}

function entryPriority(type: WorkflowContextEntryType): number {
  if (type === 'handoff') return 0;
  if (type === 'issue') return 1;
  if (type === 'verification') return 2;
  if (type === 'summary') return 3;
  if (type === 'decision') return 4;
  if (type === 'file_change') return 5;
  return 6;
}

function formatRawRefs(entry: WorkflowContextEntry): string {
  const refs = [
    `workflow_step_id=${entry.workflow_step_id ?? 'null'}`,
    `agent_run_id=${entry.agent_run_id ?? 'null'}`,
    `source=${entry.source_type}:${entry.source_id}`,
  ];
  return refs.join(' ');
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATED_MARKER.length) return TRUNCATED_MARKER.slice(0, maxChars);
  return `${text.slice(0, maxChars - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`;
}
