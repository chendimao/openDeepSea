import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { MemoryEntry, MemoryScope, MemorySourceType, MemoryType } from '../types.js';

export interface MemoryListFilters {
  projectId?: string;
  roomId?: string;
  roomAgentId?: string;
  taskId?: string;
  limit?: number;
}

export const memoryRepo = {
  list(filters: MemoryListFilters): MemoryEntry[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filters.projectId) {
      clauses.push('project_id = ?');
      params.push(filters.projectId);
    }
    if (filters.roomId) {
      clauses.push('(room_id = ? OR scope = ?)');
      params.push(filters.roomId, 'project');
    }
    if (filters.roomAgentId) {
      clauses.push('(room_agent_id = ? OR room_agent_id IS NULL)');
      params.push(filters.roomAgentId);
    }
    if (filters.taskId) {
      clauses.push('(task_id = ? OR task_id IS NULL)');
      params.push(filters.taskId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 200));
    return db
      .prepare(
        `SELECT * FROM memory_entries ${where}
         ORDER BY pinned DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as MemoryEntry[];
  },

  listForRoomContext(args: {
    projectId: string;
    roomId: string;
    roomAgentId?: string | null;
    taskId?: string | null;
    limit?: number;
  }): MemoryEntry[] {
    const limit = Math.max(1, Math.min(args.limit ?? 12, 30));
    return db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE project_id = ?
           AND (
             scope = 'project'
             OR (scope = 'room' AND room_id = ?)
             OR (? IS NOT NULL AND room_agent_id = ?)
             OR (? IS NOT NULL AND task_id = ?)
           )
         ORDER BY pinned DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(
        args.projectId,
        args.roomId,
        args.roomAgentId ?? null,
        args.roomAgentId ?? null,
        args.taskId ?? null,
        args.taskId ?? null,
        limit,
      ) as MemoryEntry[];
  },

  get(id: string): MemoryEntry | undefined {
    return db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as MemoryEntry | undefined;
  },

  create(input: {
    project_id: string;
    room_id?: string | null;
    room_agent_id?: string | null;
    task_id?: string | null;
    scope: MemoryScope;
    memory_type: MemoryType;
    title: string;
    content: string;
    source_type?: MemorySourceType;
    source_id?: string | null;
    pinned?: boolean;
  }): MemoryEntry {
    const id = nanoid(16);
    const ts = now();
    db.prepare(
      `INSERT INTO memory_entries (
        id, project_id, room_id, room_agent_id, task_id, scope, memory_type, title,
        content, source_type, source_id, pinned, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.project_id,
      input.room_id ?? null,
      input.room_agent_id ?? null,
      input.task_id ?? null,
      input.scope,
      input.memory_type,
      input.title,
      input.content,
      input.source_type ?? 'manual',
      input.source_id ?? null,
      input.pinned ? 1 : 0,
      ts,
      ts,
    );
    return this.get(id)!;
  },

  update(
    id: string,
    patch: Partial<Pick<MemoryEntry, 'memory_type' | 'title' | 'content'>> & { pinned?: boolean },
  ): MemoryEntry | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next = {
      ...existing,
      ...patch,
      pinned: patch.pinned === undefined ? existing.pinned : patch.pinned ? 1 : 0,
      updated_at: now(),
    };
    db.prepare(
      `UPDATE memory_entries
       SET memory_type = ?, title = ?, content = ?, pinned = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next.memory_type, next.title, next.content, next.pinned, next.updated_at, id);
    return this.get(id);
  },

  upsertTaskSummary(input: {
    project_id: string;
    room_id: string;
    task_id: string;
    title: string;
    content: string;
    source_id: string;
  }): MemoryEntry {
    const existing = db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE task_id = ? AND source_type = 'workflow' AND source_id = ?`,
      )
      .get(input.task_id, input.source_id) as MemoryEntry | undefined;
    if (existing) {
      return this.update(existing.id, {
        title: input.title,
        content: input.content,
        memory_type: 'task_summary',
      })!;
    }
    return this.create({
      project_id: input.project_id,
      room_id: input.room_id,
      task_id: input.task_id,
      scope: 'task',
      memory_type: 'task_summary',
      title: input.title,
      content: input.content,
      source_type: 'workflow',
      source_id: input.source_id,
    });
  },

  delete(id: string): boolean {
    return db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id).changes > 0;
  },
};
