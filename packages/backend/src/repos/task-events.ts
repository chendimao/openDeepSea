import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { MessageLayer, TaskActionKind, TaskEvent, TaskEventType } from '../types.js';

interface TaskEventRow {
  id: string;
  task_id: string;
  room_id: string;
  seq: number;
  type: TaskEventType;
  layer: MessageLayer;
  payload: string;
  source_run_id: string | null;
  created_at: number;
}

export const taskEventRepo = {
  create(input: {
    task_id: string;
    room_id: string;
    type: TaskEventType;
    layer: MessageLayer;
    payload?: Record<string, unknown>;
    source_run_id?: string | null;
  }): TaskEvent {
    const insert = db.transaction(() => {
      const nextSeq = db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_events WHERE task_id = ?')
        .get(input.task_id) as { seq: number };
      const id = nanoid(16);
      db.prepare(
        `INSERT INTO task_events (id, task_id, room_id, seq, type, layer, payload, source_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.task_id,
        input.room_id,
        nextSeq.seq,
        input.type,
        input.layer,
        JSON.stringify(input.payload ?? {}),
        input.source_run_id ?? null,
        now(),
      );
      return id;
    });

    return this.get(insert())!;
  },

  createOnceByPayloadString(
    payloadKey: string,
    input: {
      task_id: string;
      room_id: string;
      type: TaskEventType;
      layer: MessageLayer;
      payload: Record<string, unknown>;
      source_run_id?: string | null;
    },
  ): TaskEvent {
    if (!isSimpleJsonObjectKey(payloadKey)) return this.create(input);
    const payloadValue = input.payload[payloadKey];
    if (typeof payloadValue !== 'string' || !payloadValue.trim()) return this.create(input);
    const existing = this.findByPayloadString({
      taskId: input.task_id,
      type: input.type,
      layer: input.layer,
      payloadKey,
      payloadValue,
    });
    if (existing) return existing;
    return this.create(input);
  },

  get(id: string): TaskEvent | undefined {
    const row = db.prepare('SELECT * FROM task_events WHERE id = ?').get(id) as TaskEventRow | undefined;
    return row ? parseTaskEventRow(row) : undefined;
  },

  findByPayloadString(input: {
    taskId: string;
    type: TaskEventType;
    layer: MessageLayer;
    payloadKey: string;
    payloadValue: string;
  }): TaskEvent | undefined {
    const row = db
      .prepare(
        `SELECT * FROM task_events
         WHERE task_id = ?
           AND type = ?
           AND layer = ?
           AND json_valid(payload)
           AND json_extract(payload, ?) = ?
         ORDER BY seq ASC
         LIMIT 1`,
      )
      .get(
        input.taskId,
        input.type,
        input.layer,
        `$.${input.payloadKey}`,
        input.payloadValue,
      ) as TaskEventRow | undefined;
    return row ? parseTaskEventRow(row) : undefined;
  },

  findCompletedTaskActionEvidence(input: {
    taskId: string;
    action: TaskActionKind;
    evidenceKey: string;
  }): string | null {
    if (!isSimpleJsonObjectKey(input.evidenceKey)) return null;
    const evidencePath = `$.evidence.${input.evidenceKey}`;
    const row = db
      .prepare(
        `SELECT json_extract(payload, ?) AS evidence_value
         FROM task_events
         WHERE task_id = ?
           AND type = 'task_updated'
           AND layer = 'timeline'
           AND json_valid(payload)
           AND json_extract(payload, '$.action') = ?
           AND json_extract(payload, '$.status') = 'completed'
           AND (
             json_type(payload, '$.task_action') IS NULL
             OR json_extract(payload, '$.task_action') = ?
           )
           AND (
             json_type(payload, '$.task_action_status') IS NULL
             OR json_extract(payload, '$.task_action_status') = 'completed'
           )
           AND json_type(payload, ?) = 'text'
           AND length(trim(json_extract(payload, ?))) > 0
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(evidencePath, input.taskId, input.action, input.action, evidencePath, evidencePath) as
        | { evidence_value: string }
        | undefined;
    return typeof row?.evidence_value === 'string' ? row.evidence_value : null;
  },

  listByTask(taskId: string, input?: { layer?: MessageLayer; limit?: number }): TaskEvent[] {
    const limit = input?.limit ?? 500;
    const rows = input?.layer
      ? db
          .prepare(
            `SELECT * FROM (
               SELECT * FROM task_events
               WHERE task_id = ? AND layer = ?
               ORDER BY seq DESC
               LIMIT ?
             ) ORDER BY seq ASC`,
          )
          .all(taskId, input.layer, limit) as TaskEventRow[]
      : db
          .prepare(
            `SELECT * FROM (
               SELECT * FROM task_events
               WHERE task_id = ?
               ORDER BY seq DESC
               LIMIT ?
             ) ORDER BY seq ASC`,
          )
          .all(taskId, limit) as TaskEventRow[];
    return rows.map(parseTaskEventRow);
  },

  listByRoom(roomId: string, input?: { layer?: MessageLayer; limit?: number }): TaskEvent[] {
    const limit = input?.limit ?? 500;
    const rows = input?.layer
      ? db
          .prepare(
            `SELECT * FROM (
               SELECT task_events.*, rowid AS row_order FROM task_events
               WHERE room_id = ? AND layer = ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?
             ) ORDER BY created_at ASC, row_order ASC`,
          )
          .all(roomId, input.layer, limit) as TaskEventRow[]
      : db
          .prepare(
            `SELECT * FROM (
               SELECT task_events.*, rowid AS row_order FROM task_events
               WHERE room_id = ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?
             ) ORDER BY created_at ASC, row_order ASC`,
          )
          .all(roomId, limit) as TaskEventRow[];
    return rows.map(parseTaskEventRow);
  },

  hasCompletedTaskActionEvidence(input: {
    taskId: string;
    action: TaskActionKind;
    evidenceKey: string;
  }): boolean {
    return this.findCompletedTaskActionEvidence(input) !== null;
  },
};

function parseTaskEventRow(row: TaskEventRow): TaskEvent {
  return {
    ...row,
    payload: parsePayload(row.payload),
  };
}

function parsePayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isSimpleJsonObjectKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}
