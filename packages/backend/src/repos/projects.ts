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
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
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

  update(id: string, patch: Partial<Pick<Project, 'name' | 'description'>>): Project | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...patch, updated_at: now() };
    db.prepare(
      `UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
    ).run(next.name, next.description, next.updated_at, id);
    return this.get(id);
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
