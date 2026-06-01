import { existsSync, statSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { MessageRoutingMode, Project } from '../types.js';

export type DeleteProjectResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | {
      ok: false;
      reason: 'active_runs';
      activeAgentRunCount: number;
      activeWorkflowRunCount: number;
    };

const ACTIVE_WORKFLOW_STATUSES = ['draft', 'running', 'awaiting_decision', 'awaiting_approval', 'blocked'];

export const projectRepo = {
  list(): Project[] {
    return db
      .prepare(`
        SELECT * FROM projects
        ORDER BY
          pinned_at IS NULL ASC,
          sort_order IS NULL ASC,
          sort_order ASC,
          created_at DESC
      `)
      .all() as Project[];
  },

  get(id: string): Project | undefined {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  },

  create(input: { name: string; path: string; description?: string }): Project {
    if (!existsSync(input.path) || !statSync(input.path).isDirectory()) {
      throw new Error(`Path does not exist or is not a directory: ${input.path}`);
    }
    const id = nanoid(12);
    const ts = now();
    db.prepare(
      `INSERT INTO projects (
        id, name, path, description, message_routing_mode, fallback_agent_id, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.name, input.path, input.description ?? null, 'fallback_reply', 'planner', ts, ts);
    return this.get(id)!;
  },

  update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description' | 'pinned_at' | 'sort_order'>>,
  ): Project | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.name !== undefined) {
      setClauses.push('name = ?');
      values.push(patch.name);
    }
    if (patch.description !== undefined) {
      setClauses.push('description = ?');
      values.push(patch.description);
    }
    if (patch.pinned_at !== undefined) {
      setClauses.push('pinned_at = ?');
      values.push(patch.pinned_at);
    }
    if (patch.sort_order !== undefined) {
      setClauses.push('sort_order = ?');
      values.push(patch.sort_order);
    }
    if (setClauses.length === 0) return existing;

    setClauses.push('updated_at = ?');
    values.push(now());

    db.prepare(`UPDATE projects SET ${setClauses.join(', ')} WHERE id = ?`).run(...values, id);
    return this.get(id);
  },

  reorder(ids: string[], pinned: boolean): Project[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error('duplicate project ids');
    if (uniqueIds.length === 0) return this.list();

    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT id, pinned_at FROM projects WHERE id IN (${placeholders})`).all(...uniqueIds) as Array<{
      id: string;
      pinned_at: number | null;
    }>;
    if (rows.length !== uniqueIds.length) throw new Error('project not found');
    for (const row of rows) {
      if ((row.pinned_at !== null) !== pinned) throw new Error('project layer mismatch');
    }

    const updateOrder = db.transaction((orderedIds: string[]) => {
      const updatedAt = now();
      orderedIds.forEach((id, index) => {
        db.prepare('UPDATE projects SET sort_order = ?, updated_at = ? WHERE id = ?').run(index + 1, updatedAt, id);
      });
    });
    updateOrder(uniqueIds);
    return this.list();
  },

  updateRouting(
    id: string,
    patch: { message_routing_mode: MessageRoutingMode; fallback_agent_id: string | null },
  ): Project | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    db.prepare(
      `UPDATE projects
       SET message_routing_mode = ?, fallback_agent_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(patch.message_routing_mode, patch.fallback_agent_id, now(), id);
    return this.get(id);
  },

  delete(id: string): DeleteProjectResult {
    if (!this.get(id)) return { ok: false, reason: 'not_found' };

    const activeAgentRunCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM agent_runs
           JOIN rooms ON rooms.id = agent_runs.room_id
           WHERE rooms.project_id = ?
             AND agent_runs.status IN ('running', 'queued', 'retrying')`,
        )
        .get(id) as { count: number }
    ).count;
    const activeWorkflowRunCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workflow_runs
           WHERE project_id = ?
             AND status IN (${ACTIVE_WORKFLOW_STATUSES.map(() => '?').join(', ')})`,
        )
        .get(id, ...ACTIVE_WORKFLOW_STATUSES) as { count: number }
    ).count;

    if (activeAgentRunCount > 0 || activeWorkflowRunCount > 0) {
      return {
        ok: false,
        reason: 'active_runs',
        activeAgentRunCount,
        activeWorkflowRunCount,
      };
    }

    const removeProject = db.transaction((projectId: string) => {
      db.prepare(
        `DELETE FROM settings
         WHERE scope = 'room'
           AND scope_id IN (SELECT id FROM rooms WHERE project_id = ?)`,
      ).run(projectId);
      db.prepare("DELETE FROM settings WHERE scope = 'project' AND scope_id = ?").run(projectId);
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    });

    removeProject(id);
    return { ok: true };
  },

  stats(id: string): { rooms: number; tasks: number; tasksDone: number; tasksInProgress: number } {
    const rooms = db.prepare('SELECT COUNT(*) as c FROM rooms WHERE project_id = ?').get(id) as { c: number };
    const tasks = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE project_id = ?').get(id) as { c: number };
    const done = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE project_id = ? AND status = ?').get(id, 'done') as { c: number };
    const ip = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE project_id = ? AND status = ?').get(id, 'in_progress') as { c: number };
    return { rooms: rooms.c, tasks: tasks.c, tasksDone: done.c, tasksInProgress: ip.c };
  },
};
