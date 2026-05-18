import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { MemoryEntry, MemoryScope, MemorySourceType, MemoryType } from '../types.js';

export interface MemoryListFilters {
  projectId: string;
  roomId?: string;
  roomAgentId?: string;
  roomAgentIds?: string[];
  taskId?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface MemorySearchFilters {
  projectId: string;
  query?: string;
  roomId?: string;
  scope?: Extract<MemoryScope, 'project' | 'room' | 'task'>;
  includeArchived?: boolean;
  limit?: number;
}

export interface MemoryRelevantFilters {
  projectId: string;
  roomId: string;
  prompt: string;
  limit?: number;
}

export interface MemoryGlobalChatContextFilters {
  prompt: string;
  limit?: number;
  includeArchived?: boolean;
}

export type MemorySearchResult = MemoryEntry & {
  room_name: string | null;
};

export function isMemorySourceConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('unique constraint') || message.includes('idx_memory');
}

function requireProject(id: string): void {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id) as { id: string } | undefined;
  if (!project) {
    throw new Error('project_id is invalid');
  }
}

function validateOwnership(input: {
  project_id?: string | null;
  room_id?: string | null;
  room_agent_id?: string | null;
  task_id?: string | null;
}): void {
  if (!input.project_id) {
    if (input.room_id || input.room_agent_id || input.task_id) {
      throw new Error('project_id is required for scoped memory');
    }
    return;
  }
  requireProject(input.project_id);

  if (input.room_id) {
    const room = db
      .prepare('SELECT id, project_id FROM rooms WHERE id = ?')
      .get(input.room_id) as { id: string; project_id: string } | undefined;
    if (!room || room.project_id !== input.project_id) {
      throw new Error('room_id does not belong to project_id');
    }
  }

  if (input.room_agent_id) {
    const agent = db
      .prepare(
        `SELECT room_agents.id, room_agents.room_id, rooms.project_id
         FROM room_agents
         JOIN rooms ON rooms.id = room_agents.room_id
         WHERE room_agents.id = ?`,
      )
      .get(input.room_agent_id) as { id: string; room_id: string; project_id: string } | undefined;
    if (!agent || agent.project_id !== input.project_id) {
      throw new Error('room_agent_id does not belong to project_id');
    }
    if (input.room_id && agent.room_id !== input.room_id) {
      throw new Error('room_agent_id does not belong to room_id');
    }
  }

  if (input.task_id) {
    const task = db
      .prepare('SELECT id, project_id, room_id FROM tasks WHERE id = ?')
      .get(input.task_id) as { id: string; project_id: string; room_id: string } | undefined;
    if (!task || task.project_id !== input.project_id) {
      throw new Error('task_id does not belong to project_id');
    }
    if (input.room_id && task.room_id !== input.room_id) {
      throw new Error('task_id does not belong to room_id');
    }
  }
}

function validateScopeRelations(input: {
  scope: MemoryScope;
  room_id?: string | null;
  room_agent_id?: string | null;
  task_id?: string | null;
}): void {
  if (input.scope === 'global') {
    if (input.room_id || input.room_agent_id || input.task_id) {
      throw new Error('global scope cannot include project, room, agent, or task relations');
    }
    return;
  }

  if (input.scope === 'project') {
    if (input.room_id || input.room_agent_id || input.task_id) {
      throw new Error('project scope cannot include room_id, room_agent_id, or task_id');
    }
    return;
  }

  if (input.scope === 'room') {
    if (!input.room_id) {
      throw new Error('room scope requires room_id');
    }
    if (input.room_agent_id || input.task_id) {
      throw new Error('room scope cannot include room_agent_id or task_id');
    }
    return;
  }

  if (input.scope === 'agent') {
    if (!input.room_id) {
      throw new Error('agent scope requires room_id');
    }
    if (!input.room_agent_id) {
      throw new Error('agent scope requires room_agent_id');
    }
    if (input.task_id) {
      throw new Error('agent scope cannot include task_id');
    }
    return;
  }

  if (!input.room_id) {
    throw new Error('task scope requires room_id');
  }
  if (!input.task_id) {
    throw new Error('task scope requires task_id');
  }
  if (input.room_agent_id) {
    throw new Error('task scope cannot include room_agent_id');
  }
}

export const memoryRepo = {
  list(filters: MemoryListFilters): MemoryEntry[] {
    validateOwnership({
      project_id: filters.projectId,
      room_id: filters.roomId,
      room_agent_id: filters.roomAgentId,
      task_id: filters.taskId,
    });

    const scopeClauses: string[] = ["scope = 'project'"];
    const params: Array<string | number> = [filters.projectId];
    if (filters.roomId) {
      scopeClauses.push("(scope = 'room' AND room_id = ?)");
      params.push(filters.roomId);
    }
    if (filters.roomAgentId) {
      scopeClauses.push("(scope = 'agent' AND room_agent_id = ?)");
      params.push(filters.roomAgentId);
    }
    if (filters.roomAgentIds && filters.roomAgentIds.length > 0) {
      const placeholders = filters.roomAgentIds.map(() => '?').join(', ');
      scopeClauses.push(`(scope = 'agent' AND room_agent_id IN (${placeholders}))`);
      params.push(...filters.roomAgentIds);
    }
    if (filters.taskId) {
      scopeClauses.push("(scope = 'task' AND task_id = ?)");
      params.push(filters.taskId);
    }
    const archivedClause = filters.includeArchived ? '' : ' AND archived = 0';
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 200));
    return db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE project_id = ? AND (${scopeClauses.join(' OR ')})${archivedClause}
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
    maxChars?: number | null;
  }): MemoryEntry[] {
    validateOwnership({
      project_id: args.projectId,
      room_id: args.roomId,
      room_agent_id: args.roomAgentId,
      task_id: args.taskId,
    });

    const totalLimit = Math.max(1, Math.min(args.limit ?? 12, 30));
    const scopeQuota = Math.max(1, Math.ceil(totalLimit / 4));

    const projectEntries = db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE project_id = ? AND scope = 'project' AND archived = 0
         ORDER BY pinned DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(args.projectId, scopeQuota) as MemoryEntry[];

    const roomEntries = db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE project_id = ? AND scope = 'room' AND room_id = ? AND archived = 0
         ORDER BY pinned DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(args.projectId, args.roomId, scopeQuota) as MemoryEntry[];

    let agentEntries: MemoryEntry[] = [];
    if (args.roomAgentId) {
      agentEntries = db
        .prepare(
          `SELECT * FROM memory_entries
           WHERE project_id = ? AND scope = 'agent' AND room_agent_id = ? AND archived = 0
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(args.projectId, args.roomAgentId, scopeQuota) as MemoryEntry[];
    }

    let taskEntries: MemoryEntry[] = [];
    if (args.taskId) {
      taskEntries = db
        .prepare(
          `SELECT * FROM memory_entries
           WHERE project_id = ? AND scope = 'task' AND task_id = ? AND archived = 0
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(args.projectId, args.taskId, scopeQuota) as MemoryEntry[];
    }

    const merged = [...projectEntries, ...taskEntries, ...agentEntries, ...roomEntries];
    merged.sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned - a.pinned;
      return b.updated_at - a.updated_at;
    });
    return merged.slice(0, totalLimit);
  },

  get(id: string): MemoryEntry | undefined {
    return db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as MemoryEntry | undefined;
  },

  search(filters: MemorySearchFilters): MemorySearchResult[] {
    requireProject(filters.projectId);
    if (filters.roomId) {
      validateOwnership({
        project_id: filters.projectId,
        room_id: filters.roomId,
      });
    }

    const clauses = ['memory_entries.project_id = ?'];
    const params: Array<string | number> = [filters.projectId];
    const query = filters.query?.trim();
    if (query) {
      const pattern = `%${query}%`;
      clauses.push('(memory_entries.title LIKE ? OR memory_entries.content LIKE ?)');
      params.push(pattern, pattern);
    }
    if (filters.roomId) {
      clauses.push('memory_entries.room_id = ?');
      params.push(filters.roomId);
    }
    if (filters.scope) {
      clauses.push('memory_entries.scope = ?');
      params.push(filters.scope);
    }
    if (!filters.includeArchived) {
      clauses.push('memory_entries.archived = 0');
    }

    const limit = Math.max(1, Math.min(filters.limit ?? 20, 100));
    return db
      .prepare(
        `SELECT memory_entries.*, rooms.name AS room_name
         FROM memory_entries
         LEFT JOIN rooms ON rooms.id = memory_entries.room_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY memory_entries.pinned DESC, memory_entries.updated_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as MemorySearchResult[];
  },

  listRelevantForPrompt(filters: MemoryRelevantFilters): MemoryEntry[] {
    validateOwnership({
      project_id: filters.projectId,
      room_id: filters.roomId,
    });

    const terms = extractMemorySearchTerms(filters.prompt).slice(0, 12);
    if (terms.length === 0) return [];

    const clauses = [
      'project_id = ?',
      'archived = 0',
      "(scope IN ('room', 'task') AND room_id IS NOT NULL AND room_id <> ?)",
    ];
    const params: Array<string | number> = [filters.projectId, filters.roomId];
    const termClauses = terms.map(() => '(title LIKE ? OR content LIKE ?)');
    clauses.push(`(${termClauses.join(' OR ')})`);
    for (const term of terms) {
      const pattern = `%${term}%`;
      params.push(pattern, pattern);
    }

    const candidates = db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE ${clauses.join(' AND ')}
         ORDER BY pinned DESC, updated_at DESC
         LIMIT 100`,
      )
      .all(...params) as MemoryEntry[];

    const limit = Math.max(1, Math.min(filters.limit ?? 6, 20));
    return candidates
      .map((entry) => ({
        entry,
        score: scoreMemoryRelevance(entry, terms),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.entry.pinned !== b.entry.pinned) return b.entry.pinned - a.entry.pinned;
        return b.entry.updated_at - a.entry.updated_at;
      })
      .slice(0, limit)
      .map((item) => item.entry);
  },

  listForGlobalChatContext(filters: MemoryGlobalChatContextFilters): MemoryEntry[] {
    const limit = Math.max(1, Math.min(filters.limit ?? 20, 60));
    const terms = extractMemorySearchTerms(filters.prompt).slice(0, 12);
    const clauses = ['archived = 0'];
    const params: Array<string | number> = [];
    if (filters.includeArchived) clauses[0] = '1 = 1';
    if (terms.length > 0) {
      const termClauses = terms.map(() => '(title LIKE ? OR content LIKE ?)');
      clauses.push(`(scope = 'global' OR ${termClauses.join(' OR ')})`);
      for (const term of terms) {
        const pattern = `%${term}%`;
        params.push(pattern, pattern);
      }
    }
    const candidates = db.prepare(
      `SELECT * FROM memory_entries
       WHERE ${clauses.join(' AND ')}
       ORDER BY pinned DESC, updated_at DESC
       LIMIT 200`,
    ).all(...params) as MemoryEntry[];

    return candidates
      .map((entry) => ({
        entry,
        score: entry.scope === 'global' && entry.pinned ? terms.length + 2 : scoreMemoryRelevance(entry, terms),
      }))
      .filter((item) => terms.length === 0 || item.entry.scope === 'global' || item.score > 0)
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.entry.pinned !== b.entry.pinned) return b.entry.pinned - a.entry.pinned;
        return b.entry.updated_at - a.entry.updated_at;
      })
      .slice(0, limit)
      .map((item) => item.entry);
  },

  create(input: {
    project_id?: string | null;
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
    validateScopeRelations(input);
    if (input.scope !== 'global') {
      validateOwnership(input);
    }

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
      input.project_id ?? null,
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

  upsertGlobalFromMessage(input: {
    message_id: string;
    memory_type: Exclude<MemoryType, 'task_summary' | 'artifact_summary'>;
    title: string;
    content: string;
  }): MemoryEntry {
    const existing = db.prepare(
      `SELECT * FROM memory_entries
       WHERE scope = 'global' AND source_type = 'message' AND source_id = ?`,
    ).get(input.message_id) as MemoryEntry | undefined;
    if (existing) {
      return this.update(existing.id, {
        memory_type: input.memory_type,
        title: input.title,
        content: input.content,
      })!;
    }
    return this.create({
      scope: 'global',
      memory_type: input.memory_type,
      title: input.title,
      content: input.content,
      source_type: 'message',
      source_id: input.message_id,
    });
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
    validateOwnership(input);

    const existing = db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE project_id = ? AND room_id = ? AND task_id = ? AND source_type = 'workflow' AND source_id = ?`,
      )
      .get(input.project_id, input.room_id, input.task_id, input.source_id) as MemoryEntry | undefined;
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

  archive(id: string, archived: boolean): MemoryEntry | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const ts = now();
    db.prepare('UPDATE memory_entries SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, ts, id);
    return this.get(id);
  },

  delete(id: string): boolean {
    return db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id).changes > 0;
  },
};

function extractMemorySearchTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    terms.add(match[0]);
  }
  for (const match of text.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const value = match[0];
    for (let index = 0; index <= value.length - 2; index += 1) {
      terms.add(value.slice(index, index + 2));
    }
  }
  return Array.from(terms).filter((term) => !MEMORY_STOP_TERMS.has(term));
}

function scoreMemoryRelevance(entry: MemoryEntry, terms: string[]): number {
  const haystack = `${entry.title}\n${entry.content}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

const MEMORY_STOP_TERMS = new Set([
  '这个',
  '那个',
  '什么',
  '如何',
  '处理',
  '参考',
  '之前',
  '开发',
  '经验',
  '记忆',
]);
