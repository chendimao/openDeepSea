import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { Task, TaskCreatedFrom, TaskInteractionMode, TaskPriority, TaskStatus } from '../types.js';

export const taskRepo = {
  listByProject(projectId: string): Task[] {
    return db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Task[];
  },

  listByRoom(roomId: string): Task[] {
    return db
      .prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at DESC')
      .all(roomId) as Task[];
  },

  listOpenByAssignedAgent(roomAgentId: string): Task[] {
    return db
      .prepare("SELECT * FROM tasks WHERE assigned_agent_id = ? AND status <> 'done' ORDER BY created_at DESC")
      .all(roomAgentId) as Task[];
  },

  listChildren(parentTaskId: string): Task[] {
    return db
      .prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC')
      .all(parentTaskId) as Task[];
  },

  listRootByRoom(roomId: string): Task[] {
    return db
      .prepare('SELECT * FROM tasks WHERE room_id = ? AND parent_task_id IS NULL ORDER BY created_at DESC')
      .all(roomId) as Task[];
  },

  get(id: string): Task | undefined {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  },

  getBySourceMessage(roomId: string, sourceMessageId: string): Task | undefined {
    return db
      .prepare('SELECT * FROM tasks WHERE room_id = ? AND source_message_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(roomId, sourceMessageId) as Task | undefined;
  },

  create(input: {
    room_id: string;
    project_id: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    interaction_mode?: TaskInteractionMode;
    assigned_agent_id?: string;
    parent_task_id?: string;
    source_message_id?: string | null;
    created_from?: TaskCreatedFrom | null;
  }): Task {
    const id = nanoid(12);
    const ts = now();
    db.prepare(
      `INSERT INTO tasks (
        id, room_id, project_id, parent_task_id, title, description, status,
        priority, interaction_mode, assigned_agent_id, source_message_id, created_from, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.room_id,
      input.project_id,
      input.parent_task_id ?? null,
      input.title,
      input.description ?? null,
      input.priority ?? 'normal',
      input.interaction_mode ?? 'ask_user',
      input.assigned_agent_id ?? null,
      input.source_message_id ?? null,
      input.created_from ?? null,
      ts,
      ts,
    );
    return this.get(id)!;
  },

  updateStatus(id: string, status: TaskStatus): Task | undefined {
    const completed_at = status === 'done' ? now() : null;
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
    ).run(status, now(), completed_at, id);
    return this.get(id);
  },

  update(
    id: string,
    patch: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'interaction_mode' | 'assigned_agent_id'>>,
  ): Task | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    db.prepare(
      `UPDATE tasks
       SET title = ?, description = ?, priority = ?, interaction_mode = ?, assigned_agent_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next.title, next.description, next.priority, next.interaction_mode, next.assigned_agent_id, now(), id);
    return this.get(id);
  },

  unassignOpenByAgent(roomAgentId: string): number {
    return db.prepare(
      "UPDATE tasks SET assigned_agent_id = NULL, updated_at = ? WHERE assigned_agent_id = ? AND status <> 'done'",
    ).run(now(), roomAgentId).changes;
  },

  transferOpenByAgent(fromRoomAgentId: string, toRoomAgentId: string): number {
    return db.prepare(
      "UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE assigned_agent_id = ? AND status <> 'done'",
    ).run(toRoomAgentId, now(), fromRoomAgentId).changes;
  },

  delete(id: string): boolean {
    return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
  },
};
